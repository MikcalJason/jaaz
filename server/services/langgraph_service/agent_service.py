import hashlib
import os
import re
from collections import OrderedDict
from tools.utils.image_generation_core import (
    set_request_quantity,
    clear_request_quantity,
)
from models.tool_model import ToolInfoJson
from services.db_service import db_service
from .StreamProcessor import StreamProcessor
from .agent_manager import AgentManager, AGENT_NAMES
import traceback
from utils.http_client import HttpClient
from langgraph_swarm import create_swarm  # type: ignore
from langchain_openai import ChatOpenAI
from langchain_ollama import ChatOllama
from services.websocket_service import send_to_websocket  # type: ignore
from services.config_service import config_service
from typing import Optional, List, Dict, Any, Tuple, cast, Set, TypedDict
from models.config_model import ModelInfo


class ContextInfo(TypedDict):
    """Context information passed to tools"""
    canvas_id: str
    session_id: str
    model_info: Dict[str, List[ModelInfo]]


def _fix_chat_history(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """修复聊天历史中不完整的工具调用

    根据LangGraph文档建议，移除没有对应ToolMessage的tool_calls
    参考: https://langchain-ai.github.io/langgraph/troubleshooting/errors/INVALID_CHAT_HISTORY/
    """
    if not messages:
        return messages

    fixed_messages: List[Dict[str, Any]] = []
    tool_call_ids: Set[str] = set()

    # 第一遍：收集所有ToolMessage的tool_call_id
    for msg in messages:
        if msg.get('role') == 'tool' and msg.get('tool_call_id'):
            tool_call_id = msg.get('tool_call_id')
            if tool_call_id:
                tool_call_ids.add(tool_call_id)

    # 第二遍：修复AIMessage中的tool_calls
    for msg in messages:
        if msg.get('role') == 'assistant' and msg.get('tool_calls'):
            # 过滤掉没有对应ToolMessage的tool_calls
            valid_tool_calls: List[Dict[str, Any]] = []
            removed_calls: List[str] = []

            for tool_call in msg.get('tool_calls', []):
                tool_call_id = tool_call.get('id')
                if tool_call_id in tool_call_ids:
                    valid_tool_calls.append(tool_call)
                elif tool_call_id:
                    removed_calls.append(tool_call_id)

            # 记录修复信息
            if removed_calls:
                print(
                    f"🔧 修复消息历史：移除了 {len(removed_calls)} 个不完整的工具调用: {removed_calls}")

            # 更新消息
            if valid_tool_calls:
                msg_copy = msg.copy()
                msg_copy['tool_calls'] = valid_tool_calls
                fixed_messages.append(msg_copy)
            elif msg.get('content'):  # 如果没有有效的tool_calls但有content，保留消息
                msg_copy = msg.copy()
                msg_copy.pop('tool_calls', None)  # 移除空的tool_calls
                fixed_messages.append(msg_copy)
            # 如果既没有有效tool_calls也没有content，跳过这条消息
        else:
            # 非assistant消息或没有tool_calls的消息直接保留
            fixed_messages.append(msg)

    return fixed_messages


# 只保留最近 N 轮对话发给模型，其余丢弃以控制输入 token。
# 设为 0 表示不裁剪。
HISTORY_MAX_TURNS = int(os.getenv("CHAT_HISTORY_MAX_TURNS", "10"))

QUANTITY_PATTERN = re.compile(r'<quantity>\s*(\d+)\s*</quantity>', re.IGNORECASE)

# 数量上限，用于兜住异常值（前端滑块上限 30）
MAX_REQUEST_QUANTITY = 100


def _extract_requested_quantity(messages: List[Dict[str, Any]]) -> int:
    """从最近一条用户消息里解析 <quantity>N</quantity>，0 表示未指定"""
    for msg in reversed(messages):
        if msg.get('role') != 'user':
            continue

        content = msg.get('content')
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = ' '.join(
                str(item.get('text') or '') for item in content
                if isinstance(item, dict) and item.get('type') == 'text')
        else:
            continue

        match = QUANTITY_PATTERN.search(text)
        if not match:
            return 0
        # 夹到合理区间：0 会被当成"不限制"，所以下限取 1
        return min(max(int(match.group(1)), 1), MAX_REQUEST_QUANTITY)
    return 0


def _strip_stale_quantity_markers(
    messages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """清掉历史用户消息里的 <quantity> 标记

    只有最后一条用户消息的标记代表本轮数量。旧标记留在上下文里，
    模型会误以为本轮同样要生成那么多张（而本轮配额可能是不限制的）。
    返回新的列表，不改动原消息对象（原始历史还要回传前端）。
    """
    last_user_index = -1
    for i, msg in enumerate(messages):
        if msg.get('role') == 'user':
            last_user_index = i

    cleaned: List[Dict[str, Any]] = []
    for i, msg in enumerate(messages):
        if i == last_user_index or msg.get('role') != 'user':
            cleaned.append(msg)
            continue

        content = msg.get('content')
        if isinstance(content, str):
            if '<quantity>' in content.lower():
                stripped = QUANTITY_PATTERN.sub('', content).strip()
                # 只发标记的消息清完会变成空串，补个占位避免空消息
                cleaned.append({**msg, 'content': stripped or '(previous request)'})
            else:
                cleaned.append(msg)
        elif isinstance(content, list):
            items: List[Any] = []
            changed = False
            for item in content:
                if (isinstance(item, dict) and item.get('type') == 'text'
                        and isinstance(item.get('text'), str)
                        and '<quantity>' in item['text'].lower()):
                    stripped = QUANTITY_PATTERN.sub('', item['text']).strip()
                    items.append({**item, 'text': stripped or '(previous request)'})
                    changed = True
                else:
                    items.append(item)
            cleaned.append({**msg, 'content': items} if changed else msg)
        else:
            cleaned.append(msg)

    return cleaned


def _trim_chat_history(messages: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """裁剪历史消息，只保留最近 N 轮

    返回 (裁剪后的消息, 被丢弃的消息条数)。
    裁剪后在开头插入一条 system 提示，避免模型误以为对话刚开始。
    """
    if HISTORY_MAX_TURNS <= 0:
        return messages, 0

    user_indexes = [i for i, m in enumerate(messages)
                    if m.get('role') == 'user']
    if len(user_indexes) <= HISTORY_MAX_TURNS:
        return messages, 0

    start = user_indexes[-HISTORY_MAX_TURNS]
    # 避免开头是孤立的 tool 结果（理论上 user 为界不会出现，防御性处理）
    while start > 0 and messages[start].get('role') == 'tool':
        start -= 1

    dropped = start
    kept = messages[start:]
    notice = {
        'role': 'system',
        'content': (
            f'[System note] {dropped} earlier messages were omitted to save context. '
            'Previously generated images are already on the canvas.'
        ),
    }
    print(f'✂️ Trimmed chat history: dropped {dropped}, kept {len(kept)}')

    return [notice] + kept, dropped


async def langgraph_multi_agent(
    messages: List[Dict[str, Any]],
    canvas_id: str,
    session_id: str,
    text_model: ModelInfo,
    tool_list: List[ToolInfoJson],
    system_prompt: Optional[str] = None
) -> None:
    """多智能体处理函数

    Args:
        messages: 消息历史
        canvas_id: 画布ID
        session_id: 会话ID
        text_model: 文本模型配置
        tool_list: 工具模型配置列表（图像或视频模型）
        system_prompt: 系统提示词
    """
    # 本轮用户要求的图片数量（0 表示未指定，不做限制）
    quantity = _extract_requested_quantity(messages)
    quota_token = set_request_quantity(session_id, quantity)
    if quantity > 0:
        print(f'🎯 Requested image quantity: {quantity} (session {session_id})')

    try:
        # 0. 修复消息历史
        fixed_messages = _fix_chat_history(messages)

        # 1. 裁剪历史，只把最近 N 轮发给模型
        model_messages, trimmed_count = _trim_chat_history(fixed_messages)

        # 1.1 历史里的数量标记只属于旧轮次，清掉避免模型本轮照着旧数量生成
        model_messages = _strip_stale_quantity_markers(model_messages)

        # 2-4. 复用已编译的智能体图（按模型/工具集合/初始智能体缓存）
        compiled_swarm = _get_compiled_swarm(
            text_model, tool_list, system_prompt or "", fixed_messages)

        # 5. 创建上下文
        context = {
            'canvas_id': canvas_id,
            'session_id': session_id,
            'tool_list': tool_list,
        }

        # 6. 流处理（前端仍需要完整历史，所以把原始消息一并传入）
        processor = StreamProcessor(
            session_id, db_service, send_to_websocket)  # type: ignore
        await processor.process_stream(
            compiled_swarm,
            model_messages,
            context,
            original_messages=fixed_messages,
            trimmed_count=trimmed_count,
        )

    except Exception as e:
        await _handle_error(e, session_id)
    finally:
        # 无论正常结束、异常还是被取消，都清掉本轮配额
        # （带 token：若用户已取消并发起新请求，不能把新请求的配额误删）
        clear_request_quantity(session_id, quota_token)


# 已编译的 LangGraph 图缓存：构建 agent + 编译图是每请求的固定开销
_GRAPH_CACHE: "OrderedDict[str, Any]" = OrderedDict()
_GRAPH_CACHE_MAX = 16
_AGENT_NAMES = AGENT_NAMES


def invalidate_graph_cache() -> None:
    """清除已编译的智能体图缓存（工具/模型配置变更时调用）"""
    if _GRAPH_CACHE:
        _GRAPH_CACHE.clear()
        print('🧹 Agent graph cache cleared')

# 复用的 httpx 客户端：原来每个请求新建且从不关闭，长期运行会泄漏连接池
_sync_http_client: Optional[Any] = None
_async_http_client: Optional[Any] = None


def _get_http_clients() -> tuple[Any, Any]:
    global _sync_http_client, _async_http_client
    if _sync_http_client is None:
        _sync_http_client = HttpClient.create_sync_client()
        print('🔌 Created shared sync HTTP client for LLM')
    if _async_http_client is None:
        _async_http_client = HttpClient.create_async_client()
        print('🔌 Created shared async HTTP client for LLM')
    return _sync_http_client, _async_http_client


# 明显的生图/生视频意图，用于跳过 planner 那一轮规划
GEN_INTENT_KEYWORDS = (
    '生成', '画', '出图', '做一张', '再做', '改成', '换成', '修图', '抠图',
    '放大', '海报', '插画', '图片', '照片', '封面', '风格', '视频',
    'generate', 'create', 'draw', 'image', 'picture', 'poster',
    'illustration', 'render', 'video',
)

# 出现这些词说明任务需要规划，不能跳过 planner
COMPLEX_TASK_MARKERS = (
    '分别', '对比', '分析', '然后', '接着', '步骤', '计划', '方案', '整理', '总结',
)


def _should_skip_planner(
    messages: List[Dict[str, Any]],
    tool_list: List[ToolInfoJson],
) -> bool:
    """判断当前请求是否可以直接交给图像/视频智能体，跳过 planner"""
    if os.getenv("PLANNER_ENABLED", "1").lower() in ("0", "false", "no"):
        return True

    # 没有生成类工具，交给 planner 处理
    if not any(tool.get('type') in ('image', 'video') for tool in tool_list):
        return False

    last_user = next(
        (m for m in reversed(messages) if m.get('role') == 'user'), None)
    if not last_user:
        return False

    content = last_user.get('content')
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = ' '.join(
            item.get('text', '') for item in content
            if isinstance(item, dict) and item.get('type') == 'text')
    else:
        text = ''

    # 带参考图的基本都是图生图/编辑需求
    if '<input_images>' in text:
        return True

    if any(marker in text for marker in COMPLEX_TASK_MARKERS):
        return False

    lowered = text.lower()
    return any(keyword in lowered for keyword in GEN_INTENT_KEYWORDS)


def _get_compiled_swarm(
    text_model: ModelInfo,
    tool_list: List[ToolInfoJson],
    system_prompt: str,
    messages: List[Dict[str, Any]],
) -> Any:
    """按（模型 + 工具集合 + 初始智能体）复用已编译的智能体图"""
    provider = str(text_model.get('provider', ''))
    api_key = str(config_service.app_config.get(provider, {}).get("api_key", ""))

    last_agent = AgentManager.get_last_active_agent(messages, _AGENT_NAMES)
    if last_agent:
        default_agent = last_agent
    elif _should_skip_planner(messages, tool_list):
        # 简单生成请求直接进入执行智能体，省掉 planner 的规划与 handoff 两轮调用
        default_agent = _AGENT_NAMES[1]
        print('⚡ Skipping planner: direct generation intent detected')
    else:
        default_agent = _AGENT_NAMES[0]

    key = '|'.join([
        provider,
        str(text_model.get('model', '')),
        str(text_model.get('url', '')),
        hashlib.sha256(api_key.encode()).hexdigest()[:16],
        ','.join(sorted(str(tool.get('id', '')) for tool in tool_list)),
        hashlib.sha256(system_prompt.encode()).hexdigest()[:16],
        default_agent,
    ])

    cached = _GRAPH_CACHE.get(key)
    if cached is not None:
        _GRAPH_CACHE.move_to_end(key)
        print(f'♻️ Reused compiled agent graph (cache size={len(_GRAPH_CACHE)})')
        return cached

    text_model_instance = _create_text_model(text_model)
    agents = AgentManager.create_agents(
        text_model_instance,
        tool_list,  # 传入所有注册的工具
        system_prompt,
    )
    agent_names = [agent.name for agent in agents]
    print('👇agent_names', agent_names)
    if agent_names != _AGENT_NAMES:
        print(f'⚠️ Agent names changed, expected {_AGENT_NAMES}')
    print('👇last_agent', last_agent)

    swarm = create_swarm(
        agents=agents,  # type: ignore
        default_active_agent=default_agent,
    )
    compiled = swarm.compile()

    _GRAPH_CACHE[key] = compiled
    if len(_GRAPH_CACHE) > _GRAPH_CACHE_MAX:
        _GRAPH_CACHE.popitem(last=False)
    print(f'🧠 Compiled agent graph (cache size={len(_GRAPH_CACHE)})')
    return compiled


DEFAULT_MAX_OUTPUT_TOKENS = 8192


def _resolve_max_tokens(text_model: ModelInfo) -> Optional[int]:
    """解析单次回复的输出上限（None 表示不限制）

    优先级：LLM_MAX_TOKENS 环境变量 > 模型配置 max_tokens > 默认值。
    设为 0 可关闭限制。
    """
    env_value = os.getenv("LLM_MAX_TOKENS")
    if env_value is not None:
        try:
            value = int(env_value)
            return value if value > 0 else None
        except ValueError:
            print(f'⚠️ Invalid LLM_MAX_TOKENS value: {env_value}')

    configured = dict(text_model).get('max_tokens')
    if isinstance(configured, int) and configured > 0:
        return configured

    return DEFAULT_MAX_OUTPUT_TOKENS


def _create_text_model(text_model: ModelInfo) -> Any:
    """创建语言模型实例"""
    model = text_model.get('model')
    provider = text_model.get('provider')
    url = text_model.get('url')
    api_key = config_service.app_config.get(  # type: ignore
        provider, {}).get("api_key", "")

    max_tokens = _resolve_max_tokens(text_model)

    # 流式响应默认不带 usage，开启后 StreamProcessor 才能统计真实 token 用量。
    # 若某个 OpenAI 兼容服务不支持 stream_options，可设 LLM_STREAM_USAGE=0 关闭。
    stream_usage = os.getenv("LLM_STREAM_USAGE", "1").lower() not in ("0", "false", "no")

    if provider == 'ollama':
        return ChatOllama(
            model=model,
            base_url=url,
        )
    else:
        # 复用全局 httpx 客户端，避免每个请求新建连接池且从不关闭
        http_client, http_async_client = _get_http_clients()
        max_tokens_kwargs = {'max_tokens': max_tokens} if max_tokens else {}
        return ChatOpenAI(
            model=model,
            api_key=api_key,  # type: ignore
            timeout=600,
            base_url=url,
            temperature=0,
            stream_usage=stream_usage,
            http_client=http_client,
            http_async_client=http_async_client,
            **max_tokens_kwargs,  # type: ignore
        )


async def _handle_error(error: Exception, session_id: str) -> None:
    """处理错误"""
    print('Error in langgraph_agent', error)
    tb_str = traceback.format_exc()
    print(f"Full traceback:\n{tb_str}")
    traceback.print_exc()

    await send_to_websocket(session_id, cast(Dict[str, Any], {
        'type': 'error',
        'error': str(error)
    }))
