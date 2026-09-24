"""A voice agent on Dialog-RSN-1: the browser talks to this server, and this server talks
to Dialog-RSN-1 and Cartesia.

    browser  --mic PCM-->  /agent  --input_audio_buffer.append-->  Dialog-RSN-1
    browser  <--reply PCM-- /agent  <--audio-- Cartesia <--text deltas-- Dialog-RSN-1

Dialog-RSN-1 hears the caller, decides when the turn is over, and streams the reply as
text. Cartesia turns that text into speech while it's still arriving. The browser plays
it and says how much it played, which goes back to Dialog-RSN-1 as playback reports.

Messages to the browser are Dialog-RSN-1's own events, passed through unchanged, plus a
few of this server's, all named `agent.*`. Binary frames are PCM16 audio both ways.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from pathlib import Path

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
from cartesia_tts import CartesiaTTS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)-5s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("agent")

STATIC = Path(__file__).parent / "static"
app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/settings")
async def settings():
    """What the page's configuration panel offers."""
    return {
        "instructions": config.INSTRUCTIONS,
        "turn_taking": [{"id": k, "label": v["label"], "prompt": v["prompt"]}
                        for k, v in config.TURN_TAKING.items()],
        "voices": config.VOICES,
        "sample_rate": config.SAMPLE_RATE,
    }


@app.websocket("/agent")
async def agent(browser: WebSocket):
    await browser.accept()
    call = Call(browser)
    try:
        await call.run(await browser.receive_json())
    except WebSocketDisconnect:
        pass
    finally:
        await call.close()


def session_update(instructions: str) -> dict:
    return {"type": "session.update", "session": {
        "type": "realtime",
        "instructions": instructions,
        "output_modalities": ["text"],
        "audio": {"input": {
            "format": {"type": "audio/pcm", "rate": config.SAMPLE_RATE},
            # Dialog-RSN-1 decides when the caller has finished, then answers on its own.
            "turn_detection": {"type": "server_vad", "create_response": True},
        }},
    }}


class Call:
    """One browser tab's conversation: one Dialog-RSN-1 socket, one Cartesia socket."""

    def __init__(self, browser: WebSocket) -> None:
        self.browser = browser
        self.rsn = None
        self.tts: CartesiaTTS | None = None
        self.lock = asyncio.Lock()              # three tasks write to the browser
        self.audio_for: str | None = None       # the response the browser is being sent audio for
        self.reports: dict[str, dict] = {}      # response_id -> playback reports sent so far
        self.reply = ""                         # the current response's text, for the log

    async def run(self, start: dict) -> None:
        instructions = start.get("instructions") or config.INSTRUCTIONS
        style = config.TURN_TAKING.get(start.get("turn_taking"), {}).get("prompt")
        if style:
            instructions += f"\n- {style}"
        voices = {v["id"] for v in config.VOICES}
        voice = start.get("voice") if start.get("voice") in voices else config.VOICES[0]["id"]

        try:
            self.rsn = await websockets.connect(
                config.DIALOGUE_URL, max_size=None,
                additional_headers={"X-API-KEY": config.DIALOGUE_API_KEY})
        except (websockets.InvalidStatus, OSError) as exc:
            return await self.fail("Dialog-RSN-1 refused the connection", exc, "DIALOGUE_API_KEY and DIALOGUE_URL")
        self.tts = CartesiaTTS(config.CARTESIA_API_KEY, config.CARTESIA_MODEL, voice,
                               config.SAMPLE_RATE, self.on_tts_audio, self.on_tts_done)
        try:
            await self.tts.connect()
        except (websockets.InvalidStatus, OSError) as exc:
            return await self.fail("Cartesia refused the connection", exc, "CARTESIA_API_KEY")

        await self.to_rsn(session_update(instructions))
        log.info("call started, voice %s", voice)
        tasks = [asyncio.create_task(self.from_browser()), asyncio.create_task(self.from_rsn())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            if task.exception() and not isinstance(task.exception(), WebSocketDisconnect):
                log.error("call ended: %r", task.exception())
                await self.to_browser({"type": "agent.error", "message": str(task.exception())})
        log.info("call ended")

    async def close(self) -> None:
        if self.tts:
            await self.tts.close()
        if self.rsn:
            await self.rsn.close()

    async def fail(self, what: str, exc: Exception, check: str) -> None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        detail = f"HTTP {status}" if status else str(exc)
        log.error("%s: %s", what, detail)
        await self.to_browser({"type": "agent.error", "message": f"{what} ({detail}). Check {check} in .env."})

    # ---- Browser -> Dialog-RSN-1 ---------------------------------------------------

    async def from_browser(self) -> None:
        while True:
            msg = await self.browser.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes"):
                # The caller's audio, 100 ms at a time, forwarded as it arrives.
                await self.rsn.send(json.dumps({"type": "input_audio_buffer.append",
                                                "audio": base64.b64encode(msg["bytes"]).decode()}))
            elif msg.get("text"):
                event = json.loads(msg["text"])
                if event["type"] == "playback":
                    await self.report(event["response_id"], event["played_ms"], 0, event["finished"])
                elif event["type"] == "flushed":
                    await self.report(event["response_id"], event["played_ms"], event["dropped_ms"], True)

    async def report(self, rid: str, played_ms: int, dropped_ms: int, stopped: bool) -> None:
        """Turn the browser's playback progress into Dialog-RSN-1 playback reports.

        Only the browser knows what the caller has heard. Telling Dialog-RSN-1 keeps its
        barge-in check running for as long as the reply is audible, not just while it's
        being written, and gives it an account of where the caller cut in.
        """
        sent = self.reports.setdefault(rid, {"started": False, "stopped": False, "text": 0})
        if sent["stopped"]:
            return
        if played_ms > 0 and not sent["started"]:
            sent["started"] = True
            await self.to_rsn({"type": "poly.output_audio.started", "response_id": rid})
        if not sent["started"]:
            return
        spoken = self.tts.spoken_text(rid, played_ms)
        if stopped:
            sent["stopped"] = True
            await self.to_rsn({"type": "poly.output_audio.stopped", "response_id": rid,
                               "audio_ms": played_ms, "dropped_ms": dropped_ms, "spoken_text": spoken})
            if dropped_ms:
                log.info("interrupted after %d ms; the caller heard: %r", played_ms, spoken)
        elif len(spoken) > sent["text"]:
            await self.to_rsn({"type": "poly.output_audio.delta", "response_id": rid,
                               "audio_ms": played_ms, "delta": spoken[sent["text"]:]})
            sent["text"] = len(spoken)

    # ---- Dialog-RSN-1 -> Cartesia and the browser ------------------------------------

    async def from_rsn(self) -> None:
        async for raw in self.rsn:
            event = json.loads(raw)
            await self.to_browser(event)
            await self.handle(event)

    async def handle(self, event: dict) -> None:
        kind = event["type"]

        if kind == "response.created":
            # One Cartesia context per response, so a cancelled one can't leak into the next.
            self.tts.start(event["response"]["id"])
            self.reply = ""

        elif kind == "response.output_text.delta":
            # Stream each delta straight on. Don't wait for the whole reply.
            self.reply += event["delta"]
            await self.tts.push(event["delta"])

        elif kind == "response.output_text.done":
            await self.tts.finish()
            log.info("agent:  %s", self.reply.strip())

        elif kind == "conversation.item.input_audio_transcription.completed":
            log.info("caller: %s", event["transcript"].strip())

        elif kind == "input_audio_buffer.speech_started":
            # The caller is talking. Dialog-RSN-1 has already confirmed it's really them,
            # so stop the agent's voice now.
            await self.interrupt()

        elif kind == "response.done":
            status = event["response"]["status"]
            if status == "cancelled":
                await self.interrupt()
            elif status != "completed":
                log.warning("response %s: %s", status, event["response"].get("status_details"))

        elif kind == "error":
            log.error("Dialog-RSN-1: %s: %s", event["error"].get("code"), event["error"].get("message"))

    async def interrupt(self) -> None:
        """Barge-in, in two steps: stop synthesizing, then stop playing."""
        rid = self.tts.context
        if rid is None or self.reports.get(rid, {}).get("stopped"):
            return   # nothing to stop: that reply already played to the end
        await self.tts.cancel(rid)
        if rid == self.audio_for:
            # The browser empties its queue and answers `flushed` with what it played.
            await self.to_browser({"type": "agent.flush", "response_id": rid})

    # ---- Cartesia -> browser -----------------------------------------------------------

    async def on_tts_audio(self, rid: str, pcm: bytes) -> None:
        if rid != self.audio_for:
            self.audio_for = rid
            await self.to_browser({"type": "agent.audio_start", "response_id": rid})
        async with self.lock:
            await self.browser.send_bytes(pcm)

    async def on_tts_done(self, rid: str) -> None:
        await self.to_browser({"type": "agent.audio_end", "response_id": rid})

    # ---- Plumbing ------------------------------------------------------------------------

    async def to_rsn(self, event: dict) -> None:
        await self.rsn.send(json.dumps(event))
        # Echo what we send, so the page's event log shows both directions.
        await self.to_browser({"type": "agent.sent", "event": event})

    async def to_browser(self, message: dict) -> None:
        async with self.lock:
            await self.browser.send_text(json.dumps(message))


def main() -> None:
    import uvicorn

    missing = [name for name in ("DIALOGUE_API_KEY", "CARTESIA_API_KEY") if not getattr(config, name)]
    if missing:
        raise SystemExit(f"{' and '.join(missing)} not set. Copy .env.example to .env and fill it in.")
    log.info("open http://%s:%d", config.HOST, config.PORT)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
