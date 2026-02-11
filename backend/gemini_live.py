import asyncio
import base64
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from google import genai

                         
load_dotenv()


def _get_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


@dataclass
class RelayConfig:
    model: str
    response_modalities: List[str]
    system_instruction: str


class GeminiLiveBridge:
    def __init__(
        self,
        *,
        model: str,
        config: Dict[str, Any],
        api_key: Optional[str] = None,
    ):
        self._client = genai.Client(
            api_key=api_key or _get_env("GEMINI_API_KEY")
        )
        self._model = model
        self._config = config
        self._session = None

    async def __aenter__(self):
        self._session = await (
            self._client.aio.live.connect(
                model=self._model,
                config=self._config,
            ).__aenter__()
        )
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self._session is not None:
            await (
                self._client.aio.live.connect(
                    model=self._model,
                    config=self._config,
                ).__aexit__(exc_type, exc, tb)
            )
        self._session = None

    async def send_audio_b64(self, *, data_b64: str, mime_type: str):
        if self._session is None:
            raise RuntimeError("Session not started")
        data = b64d(data_b64)
        await self._session.send_realtime_input(
            audio={"data": data, "mime_type": mime_type}
        )

    async def send_text(self, text: str):
        if self._session is None:
            raise RuntimeError("Session not started")
        await self._session.send_realtime_input(text=text)

    async def interrupt(self):
        if self._session is None:
            return
        try:
            await self._session.send_realtime_input(
                event={"type": "interrupt"}
            )
        except Exception:
            pass

    async def recv_loop(self, out_q: asyncio.Queue):
        if self._session is None:
            raise RuntimeError("Session not started")

        while True:
            turn = self._session.receive()
            async for resp in turn:
                sc = getattr(resp, "server_content", None)
                if sc and getattr(sc, "model_turn", None):
                    parts = getattr(sc.model_turn, "parts", []) or []
                    for part in parts:
                        inline = getattr(part, "inline_data", None)
                        if inline and isinstance(
                            getattr(inline, "data", None),
                            (bytes, bytearray),
                        ):
                            await out_q.put(
                                {
                                    "type": "audio",
                                    "data": b64e(bytes(inline.data)),
                                    "mime_type": "audio/pcm;rate=24000",
                                }
                            )
                        text = getattr(part, "text", None)
                        if isinstance(text, str) and text.strip():
                            await out_q.put(
                                {"type": "text", "text": text}
                            )

                interrupted = getattr(sc, "interrupted", False) if sc else False
                if interrupted:
                    while not out_q.empty():
                        try:
                            out_q.get_nowait()
                        except Exception:
                            break
