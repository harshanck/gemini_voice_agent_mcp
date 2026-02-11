import os
import json
import base64
import asyncio
from datetime import datetime
from typing import Any, Dict, Optional, List

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from google import genai
from dotenv import load_dotenv
from mcp import ClientSession

try:
    from mcp.client.streamable_http import streamable_http_client
except ImportError:
    from mcp.client.streamable_http import (
        streamablehttp_client as streamable_http_client,
    )


def log_evt(tag: str, msg: str):
    ts = datetime.now().isoformat(timespec="seconds")
    print(f"[{tag}][{ts}] {msg}")


def log_mcp(msg: str):
    log_evt("MCP", msg)


def log_ws(msg: str):
    log_evt("WS", msg)


def log_gemini(msg: str):
    log_evt("Gemini", msg)


def _truncate(s: str, limit: int = 500) -> str:
    if len(s) <= limit:
        return s
    return s[:limit] + f"... <truncated {len(s) - limit} chars>"


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def build_realtime_input_config() -> Dict[str, Any]:
    return {
        "automatic_activity_detection": {
            "disabled": False,
            "start_of_speech_sensitivity": "START_SENSITIVITY_LOW",
            "end_of_speech_sensitivity": "END_SENSITIVITY_LOW",
            "prefix_padding_ms": 20,
            "silence_duration_ms": 100,
        },
        "activity_handling": "START_OF_ACTIVITY_INTERRUPTS",
    }


load_dotenv()

DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
DEFAULT_CONFIG: Dict[str, Any] = {
    "response_modalities": ["AUDIO"],
    "system_instruction": "You are a helpful and friendly salon voice assistant.",
    "realtime_input_config": {
        "automatic_activity_detection": {
            "disabled": False,
        },
        "activity_handling": "START_OF_ACTIVITY_INTERRUPTS",
        "turn_coverage": "TURN_INCLUDES_ALL_INPUT",
    },
}
MCP_SERVER_URL = "http://localhost:8090/mcp"
MCP_REQUIRED = False
CORS_ALLOW_ORIGINS = ["*"]
HOST = "0.0.0.0"
PORT = 8000
DEFAULT_CONFIG["realtime_input_config"] = build_realtime_input_config()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


async def mcp_list_tools():
    log_mcp(f"discovery start url={MCP_SERVER_URL}")
    async with streamable_http_client(MCP_SERVER_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            try:
                tools = await session.list_tools()
                tool_names = [t.name for t in getattr(tools, "tools", [])]
                log_mcp(f"discovery ok tools={tool_names}")
                return tools
            except Exception as e:
                log_mcp(f"discovery error {e}")
                raise


async def mcp_call_tool(tool_name: str, arguments: Dict[str, Any]):
    log_mcp(f"call start tool={tool_name} args={arguments}")
    async with streamable_http_client(MCP_SERVER_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            try:
                result = await session.call_tool(tool_name, arguments=arguments)
                structured = getattr(result, "structuredContent", None)
                content = getattr(result, "content", None)
                log_mcp(
                    f"call ok tool={tool_name} structured={structured is not None} content_len={len(content) if content else 0}"
                )
                return result
            except Exception as e:
                log_mcp(f"call error tool={tool_name} err={e}")
                raise


def mcp_result_to_payload(result: Any):
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured

    content = getattr(result, "content", None) or []
    if content:
        first = content[0]
        text = getattr(first, "text", None)
        if isinstance(text, str):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return {"text": text}

    log_mcp("empty/unknown tool response; no structuredContent or content")
    return {"error": "empty_tool_response", "raw": str(result)}


@app.get("/mcp/products")
async def mcp_products():
    result = await mcp_call_tool("list_products", {})
    return mcp_result_to_payload(result)


@app.get("/mcp/products/search")
async def mcp_products_search(q: str):
    result = await mcp_call_tool("search_products", {"query": q})
    return mcp_result_to_payload(result)


@app.get("/mcp/appointments")
async def mcp_appointments(date: str):
    result = await mcp_call_tool("list_appointments_for_date", {"date": date})
    return mcp_result_to_payload(result)


@app.post("/mcp/appointments")
async def mcp_create_appointment(payload: Dict[str, Any] = Body(...)):
    result = await mcp_call_tool("create_appointment", payload)
    return mcp_result_to_payload(result)


@app.patch("/mcp/appointments/{appointment_id}")
async def mcp_update_appointment(
    appointment_id: str, payload: Dict[str, Any] = Body(...)
):
    args = {"id": appointment_id, **payload}
    result = await mcp_call_tool("update_appointment", args)
    return mcp_result_to_payload(result)


async def recv_json(ws: WebSocket) -> Dict[str, Any]:
    raw = await ws.receive_text()
    return json.loads(raw)


async def send_json(ws: WebSocket, obj: Dict[str, Any]):
    encoded = json.dumps(obj, ensure_ascii=False)
    msg_type = obj.get("type")
    if msg_type != "audio":
        log_ws(f"send type={msg_type} len={len(encoded)}")
    await ws.send_text(encoded)


async def gemini_recv_loop(live_session, out_q: asyncio.Queue):
    try:
        while True:
            turn = live_session.receive()
            async for response in turn:
                sc = getattr(response, "server_content", None)
                tool_call = getattr(response, "tool_call", None)

                if tool_call and getattr(tool_call, "function_calls", None):
                    function_calls = getattr(tool_call, "function_calls", []) or []
                    log_gemini(f"recv tool_call count={len(function_calls)}")
                    function_responses: List[Dict[str, Any]] = []
                    for fc in function_calls:
                        fn_name = getattr(fc, "name", None)
                        fn_id = getattr(fc, "id", None)
                        fn_args = getattr(fc, "args", None) or {}
                        if not isinstance(fn_id, str) or not fn_id:
                            log_gemini(
                                f"recv tool_call missing id for name={fn_name}; skipping"
                            )
                            await out_q.put(
                                {
                                    "type": "error",
                                    "message": f"Tool call missing id: {fn_name}",
                                }
                            )
                            continue
                        if not isinstance(fn_name, str) or not fn_name:
                            function_responses.append(
                                {
                                    "id": fn_id,
                                    "name": fn_name or "unknown_tool",
                                    "response": {"error": "missing_function_name"},
                                }
                            )
                            continue
                        if not isinstance(fn_args, dict):
                            fn_args = {}

                        try:
                            mcp_result = await mcp_call_tool(fn_name, fn_args)
                            payload = mcp_result_to_payload(mcp_result)
                            function_responses.append(
                                {
                                    "id": fn_id,
                                    "name": fn_name,
                                    "response": {"output": payload},
                                }
                            )
                        except Exception as e:
                            log_mcp(f"tool dispatch error tool={fn_name} err={e}")
                            function_responses.append(
                                {
                                    "id": fn_id,
                                    "name": fn_name,
                                    "response": {"error": str(e)},
                                }
                            )

                    if function_responses:
                        await live_session.send_tool_response(
                            function_responses=function_responses
                        )
                        log_gemini(
                            f"sent tool_response count={len(function_responses)}"
                        )

                if sc and getattr(sc, "model_turn", None):
                    for part in getattr(sc.model_turn, "parts", []) or []:
                        inline = getattr(part, "inline_data", None)
                        if inline and isinstance(
                            getattr(inline, "data", None), (bytes, bytearray)
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
                            log_gemini(
                                f"recv text len={len(text)} preview={_truncate(text, 200)}"
                            )
                            await out_q.put({"type": "text", "text": text})

                interrupted = getattr(sc, "interrupted", False) if sc else False
                if interrupted:
                    log_gemini("recv interrupted")
                    while not out_q.empty():
                        try:
                            out_q.get_nowait()
                        except Exception:
                            break
                    await out_q.put({"type": "interrupted"})
    except Exception as e:
        log_gemini(f"recv error {e}")
        await out_q.put({"type": "error", "message": f"Gemini receive error: {e}"})


async def handle_client_msg(msg: Dict[str, Any], ws: WebSocket, live_session):
    t = msg.get("type")

    if t == "audio":
        data_b64 = msg.get("data")
        mime_type = msg.get("mime_type", "audio/pcm;rate=16000")
        if isinstance(data_b64, str):
            await live_session.send_realtime_input(
                audio={"data": b64d(data_b64), "mime_type": mime_type}
            )
    elif t == "text":
        text = msg.get("text", "")
        if isinstance(text, str) and text:
            await live_session.send_realtime_input(text=text)
    elif t == "interrupt":
        try:
            log_gemini("send interrupt via activity_end")
            await live_session.send_realtime_input(activity_end={})
        except Exception:
            pass
    elif t == "ping":
        await send_json(ws, {"type": "pong"})
    elif t == "config":
        pass
    else:
        await send_json(ws, {"type": "error", "message": f"Unknown message type: {t}"})


async def client_to_gemini(
    ws: WebSocket, live_session, initial_msg: Optional[Dict[str, Any]] = None
):
    try:
        if initial_msg is not None:
            await handle_client_msg(initial_msg, ws, live_session)

        while True:
            try:
                msg = await recv_json(ws)
            except WebSocketDisconnect:
                return
            except Exception as e:
                try:
                    await send_json(
                        ws, {"type": "error", "message": f"Invalid message: {e}"}
                    )
                except Exception:
                    pass
                return

            await handle_client_msg(msg, ws, live_session)
    except Exception as e:
        log_gemini(f"send error {e}")
        try:
            await send_json(ws, {"type": "error", "message": f"Gemini send error: {e}"})
        except Exception:
            pass


async def gemini_to_client(ws: WebSocket, out_q: asyncio.Queue):
    while True:
        evt = await out_q.get()
        await send_json(ws, evt)


@app.websocket("/ws")
async def ws_handler(ws: WebSocket):
    await ws.accept()
    log_ws("ws accepted")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing env var: GEMINI_API_KEY")
    client = genai.Client(api_key=api_key)

    cfg = dict(DEFAULT_CONFIG)
    model = DEFAULT_MODEL
    log_gemini(f"config model_default={model} cfg={cfg}")

    try:
        tool_names: list[str] = []
        gemini_tools: list[Any] = []
        try:
            tools = await mcp_list_tools()
            tool_names = [t.name for t in getattr(tools, "tools", [])]
            gemini_tools = list(getattr(tools, "tools", []) or [])
            log_mcp(f"discovered tools: {tool_names}")
        except Exception as e:
            log_mcp(f"discovery failed: {e}")
            if MCP_REQUIRED:
                await send_json(
                    ws,
                    {
                        "type": "error",
                        "message": "MCP unavailable; cannot start session.",
                    },
                )
                await ws.close()
                return

        first: Optional[Dict[str, Any]] = None
        try:
            first = await asyncio.wait_for(recv_json(ws), timeout=2.0)
        except Exception:
            first = None

        pending_first_message: Optional[Dict[str, Any]] = None
        if first and first.get("type") == "config":
            if isinstance(first.get("system_instruction"), str):
                cfg["system_instruction"] = first["system_instruction"]
            if isinstance(first.get("response_modalities"), list):
                cfg["response_modalities"] = first["response_modalities"]
            if isinstance(first.get("model"), str) and first["model"].strip():
                model = first["model"].strip()
        elif first is not None:
            pending_first_message = first
            log_ws(
                f"first message type={first.get('type')} (accepted without config)"
            )

        if tool_names:
            cfg["system_instruction"] = (
                f"{cfg.get('system_instruction', '').rstrip()}\n\n"
                f"You can only answer using MCP data. Available tools: {', '.join(tool_names)}. "
                "If the data is not available from MCP, say you don't know."
            )
        if gemini_tools:
            cfg["tools"] = gemini_tools

        out_q: asyncio.Queue = asyncio.Queue()

        connect_ctx = None
        live_session = None
        try:
            log_gemini(f"connect model={model} cfg={cfg}")
            connect_ctx = client.aio.live.connect(model=model, config=cfg)
            live_session = await connect_ctx.__aenter__()
        except Exception as e:
            log_gemini(f"connect failed with full config: {e}")
            minimal_cfg = {
                k: v
                for k, v in cfg.items()
                if k in {"response_modalities", "system_instruction", "tools"}
            }
            log_gemini(f"retry connect with minimal_cfg={minimal_cfg}")
            connect_ctx = client.aio.live.connect(model=model, config=minimal_cfg)
            live_session = await connect_ctx.__aenter__()

        try:
            await send_json(ws, {"type": "ready", "model": model})

            t1 = asyncio.create_task(
                client_to_gemini(ws, live_session, pending_first_message)
            )
            t2 = asyncio.create_task(gemini_recv_loop(live_session, out_q))
            t3 = asyncio.create_task(gemini_to_client(ws, out_q))

            done, pending = await asyncio.wait(
                {t1, t2, t3}, return_when=asyncio.FIRST_COMPLETED
            )
            for p in pending:
                p.cancel()
        finally:
            if connect_ctx is not None:
                await connect_ctx.__aexit__(None, None, None)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await send_json(ws, {"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
