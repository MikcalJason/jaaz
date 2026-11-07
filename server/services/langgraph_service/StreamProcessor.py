# type: ignore[import]
import traceback
from typing import Optional, List, Dict, Any, Callable, Awaitable, Tuple
from langchain_core.messages import AIMessageChunk, ToolCall, convert_to_openai_messages, ToolMessage
from services.websocket_state import get_room_members, session_room
import json


class StreamProcessor:
    """流式处理器 - 负责处理智能体的流式输出"""

    def __init__(self, session_id: str, db_service: Any, websocket_service: Callable[[str, Dict[str, Any]], Awaitable[None]]):
        self.session_id = session_id
        self.db_service = db_service
        self.websocket_service = websocket_service
        self.tool_calls: List[ToolCall] = []
        self.last_saved_message_index = 0
        self.last_streaming_tool_call_id: Optional[str] = None

        # token 用量统计（用于成本分析：每轮对话多少次 LLM 调用、输入/输出各多少）
        self.llm_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

        # 上一次推送给前端的历史快照，用于只发送增量消息
        self._sent_messages: List[Dict[str, Any]] = []

        # 前端传入的完整历史（OpenAI 格式）与被裁剪掉的消息数量，
        # 用于把裁剪后的模型消息还原成完整历史再推给前端
        self.original_messages: List[Dict[str, Any]] = []
        self.trimmed_count = 0

    async def process_stream(
        self,
        compiled_swarm: Any,
        messages: List[Dict[str, Any]],
        context: Dict[str, Any],
        original_messages: Optional[List[Dict[str, Any]]] = None,
        trimmed_count: int = 0,
    ) -> None:
        """处理整个流式响应

        Args:
            compiled_swarm: 已编译的智能体图（由 agent_service 缓存后传入）
            messages: 裁剪后发给模型的消息列表
            context: 上下文信息
            original_messages: 前端传入的完整历史（用于还原给前端展示）
            trimmed_count: 被裁剪掉的历史消息条数
        """
        self.original_messages = original_messages if original_messages is not None else messages
        self.trimmed_count = trimmed_count
        self.last_saved_message_index = len(self.original_messages) - 1

        print(
            f'📊 [LLM USAGE] session={self.session_id} start, '
            f'history={len(self.original_messages)} sent={len(messages)} trimmed={trimmed_count}'
        )

        try:
            async for chunk in compiled_swarm.astream(
                {"messages": messages},
                config=context,
                stream_mode=["messages", "custom", 'values']
            ):
                await self._handle_chunk(chunk)
        finally:
            self._log_usage_summary()

        # 发送完成事件
        await self.websocket_service(self.session_id, {
            'type': 'done'
        })

    def _record_usage(self, message: Any, metadata: Any = None) -> None:
        """累计单次 LLM 调用的 token 用量"""
        usage = getattr(message, 'usage_metadata', None)
        if not usage:
            return

        input_tokens = usage.get('input_tokens') or 0
        output_tokens = usage.get('output_tokens') or 0
        if not input_tokens and not output_tokens:
            return

        self.llm_calls += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens

        node = ''
        if isinstance(metadata, dict):
            node = str(metadata.get('langgraph_node', ''))

        print(
            f'📊 [LLM #{self.llm_calls}] session={self.session_id} '
            f'node={node or "?"} input={input_tokens} output={output_tokens} '
            f'total={input_tokens + output_tokens}'
        )

    def _log_usage_summary(self) -> None:
        """输出本轮对话的 token 汇总，便于评估优化效果"""
        print(
            f'📊 [LLM USAGE] session={self.session_id} end, '
            f'calls={self.llm_calls} input={self.input_tokens} '
            f'output={self.output_tokens} total={self.input_tokens + self.output_tokens}'
        )

    async def _handle_chunk(self, chunk: Any) -> None:
        """处理单个chunk"""
        if not isinstance(chunk, (list, tuple)) or len(chunk) < 2:
            return

        chunk_type = chunk[0]
        payload = chunk[1]

        if chunk_type == 'values':
            await self._handle_values_chunk(payload)
        elif chunk_type == 'messages':
            # payload 形如 (message_chunk, metadata)
            if isinstance(payload, (list, tuple)) and payload:
                message = payload[0]
                metadata = payload[1] if len(payload) > 1 else None
            else:
                message, metadata = payload, None
            self._record_usage(message, metadata)
            await self._handle_message_chunk(message)
        else:
            # custom 等其他模式沿用原有处理方式
            await self._handle_message_chunk(payload[0])

    async def _handle_values_chunk(self, chunk_data: Dict[str, Any]) -> None:
        """处理 values 类型的 chunk"""
        all_messages = chunk_data.get('messages', [])
        oai_messages = convert_to_openai_messages(all_messages)
        # 确保 oai_messages 是列表类型
        if not isinstance(oai_messages, list):
            oai_messages = [oai_messages] if oai_messages else []

        # 若做过历史裁剪，把被丢弃的前缀拼回去，保证前端仍能看到完整历史
        if self.trimmed_count and oai_messages:
            first_is_notice = (
                isinstance(oai_messages[0], dict)
                and oai_messages[0].get('role') == 'system'
            )
            kept = oai_messages[1:] if first_is_notice else oai_messages
            oai_messages = self.original_messages[:self.trimmed_count] + kept

        # 只把新增（或可能被覆盖的尾部）消息发给前端，避免每个节点都重发整段历史。
        # 历史消息在 LangGraph 里只会追加，减少时说明状态被重置，退回全量。
        sent_len = len(self._sent_messages)
        cur_len = len(oai_messages)
        if cur_len < sent_len:
            start = 0
        elif cur_len == sent_len:
            # 数量没变时重发最后一条，兜住“最后一条消息内容被更新”的情况
            start = max(0, cur_len - 1)
        else:
            start = sent_len

        # 没有客户端订阅本会话时（旧版前端不会 join），退回全量语义，
        # 否则旧前端会把增量当成完整历史，丢掉本地已有的消息。
        if not get_room_members(session_room(self.session_id)):
            start = 0

        delta_messages = oai_messages[start:]
        self._sent_messages = oai_messages

        # 没有新增内容时不必推送（历史被清空的极端情况除外）
        if delta_messages or cur_len < sent_len:
            await self.websocket_service(self.session_id, {
                'type': 'all_messages',
                'messages': delta_messages,
                'replace_from': start,
            })

        # 保存新消息到数据库：先收集再一次性写入，避免每条消息一次连接 + 一次提交
        pending_messages: List[Tuple[str, str]] = []
        for i in range(self.last_saved_message_index + 1, len(oai_messages)):
            new_message = oai_messages[i]
            pending_messages.append((
                new_message.get('role', 'user'),
                json.dumps(new_message),
            ))
            self.last_saved_message_index = i

        if pending_messages:
            batch_save = getattr(self.db_service, 'create_messages', None)
            if batch_save is not None:
                await batch_save(self.session_id, pending_messages)
            else:
                for role, message in pending_messages:
                    await self.db_service.create_message(self.session_id, role, message)

    async def _handle_message_chunk(self, ai_message_chunk: AIMessageChunk) -> None:
        """处理消息类型的 chunk"""
        # print('👇ai_message_chunk', ai_message_chunk)
        try:
            content = ai_message_chunk.content

            if isinstance(ai_message_chunk, ToolMessage):
                # 工具调用结果之后会在 values 类型中发送到前端，这里会更快出现一些
                oai_message = convert_to_openai_messages([ai_message_chunk])[0]
                print('👇toolcall res oai_message', oai_message)
                await self.websocket_service(self.session_id, {
                    'type': 'tool_call_result',
                    'id': ai_message_chunk.tool_call_id,
                    'message': oai_message
                })
            elif content:
                # 发送文本内容
                await self.websocket_service(self.session_id, {
                    'type': 'delta',
                    'text': content
                })
            elif hasattr(ai_message_chunk, 'tool_calls') and ai_message_chunk.tool_calls and ai_message_chunk.tool_calls[0].get('name'):
                # 处理工具调用
                await self._handle_tool_calls(ai_message_chunk.tool_calls)

            # 处理工具调用参数流
            if hasattr(ai_message_chunk, 'tool_call_chunks'):
                await self._handle_tool_call_chunks(ai_message_chunk.tool_call_chunks)
        except Exception as e:
            print('🟠error', e)
            traceback.print_stack()

    async def _handle_tool_calls(self, tool_calls: List[ToolCall]) -> None:
        """处理工具调用"""
        self.tool_calls = [tc for tc in tool_calls if tc.get('name')]
        print('😘tool_call event', tool_calls)

        # 需要确认的工具列表
        TOOLS_REQUIRING_CONFIRMATION = {
            # 'generate_video_by_kling_v2_jaaz',
            # 'generate_video_by_seedance_v1_pro_volces',
            # 'generate_video_by_seedance_v1_lite_i2v',
            # 'generate_video_by_seedance_v1_lite_t2v',
            # 'generate_video_by_seedance_v1_jaaz',
            # 'generate_video_by_hailuo_02_jaaz',
            'generate_video_by_veo3_fast_jaaz',
        }

        for tool_call in self.tool_calls:
            tool_name = tool_call.get('name')

            # 检查是否需要确认
            if tool_name in TOOLS_REQUIRING_CONFIRMATION:
                # 对于需要确认的工具，不在这里发送事件，让工具函数自己处理
                print(
                    f'🔄 Tool {tool_name} requires confirmation, skipping StreamProcessor event')
                continue
            else:
                await self.websocket_service(self.session_id, {
                    'type': 'tool_call',
                    'id': tool_call.get('id'),
                    'name': tool_name,
                    'arguments': '{}'
                })

    async def _handle_tool_call_chunks(self, tool_call_chunks: List[Any]) -> None:
        """处理工具调用参数流"""
        for tool_call_chunk in tool_call_chunks:
            if tool_call_chunk.get('id'):
                # 标记新的流式工具调用参数开始
                self.last_streaming_tool_call_id = tool_call_chunk.get('id')
            else:
                if self.last_streaming_tool_call_id:
                    await self.websocket_service(self.session_id, {
                        'type': 'tool_call_arguments',
                        'id': self.last_streaming_tool_call_id,
                        'text': tool_call_chunk.get('args')
                    })
                else:
                    print('🟠no last_streaming_tool_call_id', tool_call_chunk)
