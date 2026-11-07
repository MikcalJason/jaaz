"""
HTTP 客户端工厂和管理器

本模块提供了统一的 HTTP 客户端创建和管理功能，支持 httpx 和 aiohttp 库：
- 自动 SSL 证书验证
- 连接池管理和超时控制
- 同步和异步客户端支持
- 支持代理环境变量 (trust_env=True)

使用指南：
1. httpx 客户端：
   async with HttpClient.create() as client:
       response = await client.get("https://api.example.com/data")

2. aiohttp 客户端：
   async with HttpClient.create_aiohttp() as session:
       async with session.get("https://api.example.com/data") as response:
           data = await response.json()

3. 同步请求：使用 HttpClient.create_sync()
   with HttpClient.create_sync() as client:
       response = client.get("https://api.example.com/data")
"""

import asyncio
import ssl
import certifi
import httpx
from typing import Optional, Dict, Any, AsyncGenerator, Generator
from contextlib import asynccontextmanager, contextmanager
import aiohttp


class HttpClient:
    """HTTP 客户端工厂和管理器"""

    _ssl_context: Optional[ssl.SSLContext] = None
    _shared_aiohttp_session: Optional['aiohttp.ClientSession'] = None
    _shared_aiohttp_lock: Optional[asyncio.Lock] = None

    @classmethod
    def _get_ssl_context(cls) -> ssl.SSLContext:
        """获取缓存的 SSL 上下文"""
        if cls._ssl_context is None:
            try:
                cls._ssl_context = ssl.create_default_context(cafile=certifi.where())
            except Exception as e:
                print(f"⚠️ Failed to create SSL context with certifi: {e}")
                cls._ssl_context = ssl.create_default_context()
        return cls._ssl_context

    @classmethod
    def _get_client_config(cls, **kwargs: Any) -> Dict[str, Any]:
        """获取 httpx 客户端配置"""

        config = {
            'verify': cls._get_ssl_context(),
            'timeout': 600,
            'follow_redirects': True,
            'limits': httpx.Limits(
                max_keepalive_connections=20, max_connections=200, keepalive_expiry=30
            ),
            **kwargs,
        }

        return config

    @classmethod
    def _get_aiohttp_config(
        cls, trust_env: bool = True, **kwargs: Any
    ) -> Dict[str, Any]:
        """获取 aiohttp 客户端配置"""
        config = {
            'connector': aiohttp.TCPConnector(
                ssl=cls._get_ssl_context(),
                limit=200,
                limit_per_host=50,
                keepalive_timeout=15,
                enable_cleanup_closed=True,
            ),
            'timeout': aiohttp.ClientTimeout(total=600),
            'trust_env': trust_env,  # 启用环境变量代理支持
            **kwargs,
        }

        return config

    # ========== 工厂方法 ==========

    @classmethod
    @asynccontextmanager
    async def create(
        cls, url: Optional[str] = None, **kwargs: Any
    ) -> AsyncGenerator[httpx.AsyncClient, None]:
        """创建异步客户端上下文管理器"""
        config = cls._get_client_config(**kwargs)
        client = httpx.AsyncClient(**config)
        try:
            yield client
        finally:
            await client.aclose()

    @classmethod
    @contextmanager
    def create_sync(
        cls, url: Optional[str] = None, **kwargs: Any
    ) -> Generator[httpx.Client, None, None]:
        """创建同步客户端上下文管理器"""
        config = cls._get_client_config(**kwargs)
        client = httpx.Client(**config)
        try:
            yield client
        finally:
            client.close()

    @classmethod
    def create_async_client(cls, **kwargs: Any) -> httpx.AsyncClient:
        """直接创建异步客户端（需要手动关闭）"""
        config = cls._get_client_config(**kwargs)
        return httpx.AsyncClient(**config)

    @classmethod
    def create_sync_client(cls, **kwargs: Any) -> httpx.Client:
        """直接创建同步客户端（需要手动关闭）"""
        config = cls._get_client_config(**kwargs)
        return httpx.Client(**config)

    # ========== aiohttp 工厂方法 ==========
    @classmethod
    @asynccontextmanager
    async def create_aiohttp(
        cls, trust_env: bool = True, **kwargs: Any
    ) -> AsyncGenerator['aiohttp.ClientSession', None]:
        """创建 aiohttp 客户端上下文管理器

        Args:
            trust_env: 是否信任环境变量代理设置 (HTTP_PROXY, HTTPS_PROXY, etc.)
            **kwargs: 其他 aiohttp.ClientSession 参数
        """
        config = cls._get_aiohttp_config(trust_env=trust_env, **kwargs)
        session = aiohttp.ClientSession(**config)
        try:
            yield session
        finally:
            await session.close()

    @classmethod
    def create_aiohttp_client(
        cls, trust_env: bool = True, **kwargs: Any
    ) -> 'aiohttp.ClientSession':
        """直接创建 aiohttp 客户端（需要手动关闭）

        Args:
            trust_env: 是否信任环境变量代理设置 (HTTP_PROXY, HTTPS_PROXY, etc.)
            **kwargs: 其他 aiohttp.ClientSession 参数
        """
        config = cls._get_aiohttp_config(trust_env=trust_env, **kwargs)
        return aiohttp.ClientSession(**config)

    # ========== 共享会话 ==========

    @classmethod
    async def get_shared_aiohttp(cls, trust_env: bool = True) -> 'aiohttp.ClientSession':
        """获取可复用的 aiohttp 会话

        批量下载图片时复用同一个连接池，避免每张图都重新建连 + TLS 握手。
        """
        session = cls._shared_aiohttp_session
        if session is not None and not session.closed:
            return session

        if cls._shared_aiohttp_lock is None:
            cls._shared_aiohttp_lock = asyncio.Lock()

        async with cls._shared_aiohttp_lock:
            session = cls._shared_aiohttp_session
            if session is None or session.closed:
                config = cls._get_aiohttp_config(trust_env=trust_env)
                session = aiohttp.ClientSession(**config)
                cls._shared_aiohttp_session = session
            return session

    @classmethod
    async def close_shared_aiohttp(cls) -> None:
        """关闭共享会话（应用退出时调用）"""
        session = cls._shared_aiohttp_session
        cls._shared_aiohttp_session = None
        if session is not None and not session.closed:
            await session.close()
