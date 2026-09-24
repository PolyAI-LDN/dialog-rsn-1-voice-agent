"""Cartesia over one websocket for the whole call, one context per response.

Each Dialog-RSN-1 response gets its own Cartesia context, named after the `response_id`.
Text goes in as the model writes it, marked `continue: true` so Cartesia keeps the
prosody of one sentence across pieces. PCM comes back as it's synthesized and goes
straight to the browser. Cartesia's word timestamps are what `spoken_text` is built from.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Awaitable, Callable

import websockets

URL = "wss://api.cartesia.ai/tts/websocket?cartesia_version=2025-04-16"
# How long Cartesia may wait for more text before it starts speaking what it has.
# Its default favours prosody over latency; the model streams fast enough that 250 ms
# is rarely reached.
MAX_BUFFER_DELAY_MS = 250

log = logging.getLogger("tts")

OnAudio = Callable[[str, bytes], Awaitable[None]]
OnDone = Callable[[str], Awaitable[None]]


class CartesiaTTS:
    def __init__(self, api_key: str, model_id: str, voice_id: str, rate: int,
                 on_audio: OnAudio, on_done: OnDone) -> None:
        self.api_key = api_key
        self.on_audio, self.on_done = on_audio, on_done
        self.base = {
            "model_id": model_id,
            "voice": {"mode": "id", "id": voice_id},
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": rate},
            "language": "en",
            "add_timestamps": True,
            "max_buffer_delay_ms": MAX_BUFFER_DELAY_MS,
        }
        self._ws = None
        self._reader: asyncio.Task | None = None
        self.context: str | None = None     # the response being synthesized
        self._held = ""                      # the end of the text, until a word is complete
        self._opened = False                 # any text of this context sent to Cartesia
        self._cancelled: set[str] = set()
        self._words: dict[str, list[tuple[float, str]]] = {}   # context -> (start ms, word)

    async def connect(self) -> None:
        self._ws = await websockets.connect(URL, max_size=None,
                                            additional_headers={"X-API-Key": self.api_key})
        self._reader = asyncio.create_task(self._read())

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._ws:
            await self._ws.close()

    def start(self, context_id: str) -> None:
        """A new context for a new response. Nothing is sent until its first word."""
        self.context, self._held, self._opened = context_id, "", False
        self._words[context_id] = []

    async def push(self, text: str) -> None:
        """Feed each delta. Only whole words are sent, and nothing before the first letter."""
        if self.context is None or self.context in self._cancelled:
            return
        self._held += text
        cut = max(self._held.rfind(" "), self._held.rfind("\n"))
        if cut < 0:
            return
        ready = self._held[:cut + 1]
        if not self._opened and not any(ch.isalnum() for ch in ready):
            return   # punctuation or whitespace alone: nothing to say yet
        self._held = self._held[cut + 1:]
        await self._send(ready, more=True)

    async def finish(self) -> bool:
        """No more text for this response. Returns False if there was never anything to say."""
        if self.context is None or self.context in self._cancelled:
            return False
        if not self._opened and not any(ch.isalnum() for ch in self._held):
            return False
        await self._send(self._held, more=False)
        self._held = ""
        return True

    async def cancel(self, context_id: str) -> None:
        """Stop synthesizing. Unsent text is dropped; audio already sent isn't recalled."""
        if context_id in self._cancelled:
            return
        self._cancelled.add(context_id)
        if context_id == self.context and self._opened:
            await self._ws.send(json.dumps({"context_id": context_id, "cancel": True}))

    def spoken_text(self, context_id: str, played_ms: int) -> str:
        """The words whose audio had started playing by `played_ms`."""
        return " ".join(word for start, word in self._words.get(context_id, []) if start <= played_ms)

    async def _send(self, transcript: str, more: bool) -> None:
        self._opened = True
        await self._ws.send(json.dumps({**self.base, "context_id": self.context,
                                        "transcript": transcript, "continue": more}))

    async def _read(self) -> None:
        async for raw in self._ws:
            msg = json.loads(raw)
            ctx = msg.get("context_id")
            if ctx in self._cancelled:
                continue   # late audio, or the acknowledgement, for a reply the caller cut off
            kind = msg.get("type")
            if kind == "chunk":
                await self.on_audio(ctx, base64.b64decode(msg["data"]))
            elif kind == "timestamps":
                # Timings count from the start of the context, in seconds.
                ts = msg["word_timestamps"]
                self._words.setdefault(ctx, []).extend(
                    (start * 1000, word) for start, word in zip(ts["start"], ts["words"]))
            elif kind == "done":
                await self.on_done(ctx)
            elif kind == "error":
                log.error("Cartesia: %s", msg.get("message") or msg)
                await self.on_done(ctx)
