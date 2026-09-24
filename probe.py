"""Check the running agent from a terminal, with no browser or microphone.

    uv run app.py                  # in one terminal
    uv run probe.py                # in another: streams static/sample-caller.wav

The probe does what the page does. It streams a WAV as the caller in real time, pretends
to play the agent's audio at real speed, and sends the same playback progress back.
The sample asks a question and then talks over the answer, so you see a barge-in too.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import wave

import websockets

RATE = 24_000
FRAME = RATE // 10          # 100 ms of samples, the same frame the page sends
TAIL_S = 15                 # silence after the clip, so the last reply can play out


class Player:
    """Plays nothing, but keeps time the way the page's player does."""

    def __init__(self) -> None:
        self.rid: str | None = None
        self.received_ms = 0.0
        self.started_at: float | None = None
        self.ended = False           # the server said no more audio is coming
        self.stopped = False

    def start(self, rid: str) -> None:
        self.__init__()
        self.rid = rid

    def add(self, pcm: bytes) -> None:
        if not self.stopped:
            self.received_ms += len(pcm) / 2 / RATE * 1000
            self.started_at = self.started_at or time.monotonic()

    @property
    def played_ms(self) -> int:
        if self.started_at is None:
            return 0
        return int(min(self.received_ms, (time.monotonic() - self.started_at) * 1000))

    @property
    def finished(self) -> bool:
        return self.ended and self.played_ms >= int(self.received_ms)


async def main(args) -> None:
    with wave.open(args.file, "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, RATE):
            raise SystemExit(f"{args.file} must be mono, 16-bit, {RATE} Hz.")
        audio = wav.readframes(wav.getnframes()) + bytes(RATE * 2 * TAIL_S)

    player = Player()
    t0 = 0.0                         # wall clock of the first audio sample sent
    turn_end = first_text = None     # per turn, wall clock

    async with websockets.connect(args.url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "voice": args.voice}))

        async def send_audio() -> None:
            nonlocal t0
            t0 = time.monotonic()
            for i, offset in enumerate(range(0, len(audio), FRAME * 2)):
                await ws.send(audio[offset:offset + FRAME * 2])
                await asyncio.sleep(max(0.0, t0 + (i + 1) / 10 - time.monotonic()))

        async def report() -> None:
            while True:
                await asyncio.sleep(0.25)
                p = player
                if p.rid and not p.stopped and p.played_ms > 0:
                    p.stopped = p.finished
                    await ws.send(json.dumps({"type": "playback", "response_id": p.rid,
                                              "played_ms": p.played_ms, "finished": p.stopped}))

        async def receive() -> None:
            nonlocal turn_end, first_text
            async for msg in ws:
                if isinstance(msg, bytes):
                    was_silent = player.started_at is None
                    player.add(msg)
                    if was_silent and turn_end:
                        print(f"  first audio {ms(turn_end)} after the caller stopped")
                    continue
                ev = json.loads(msg)
                kind = ev["type"]
                if kind == "input_audio_buffer.speech_started":
                    print("(caller speaking)")
                elif kind == "input_audio_buffer.speech_stopped":
                    turn_end, first_text = t0 + ev["audio_end_ms"] / 1000, None
                    print(f"  turn confirmed {ms(turn_end)} after the caller stopped")
                elif kind == "conversation.item.input_audio_transcription.completed":
                    print(f"Caller: {ev['transcript'].strip()}")
                elif kind == "response.output_text.delta" and first_text is None:
                    first_text = time.monotonic()
                    if turn_end:
                        print(f"  first text  {ms(turn_end)} after the caller stopped")
                elif kind == "response.output_text.done":
                    print(f"Agent:  {ev['text'].strip()}")
                elif kind == "agent.audio_start":
                    player.start(ev["response_id"])
                elif kind == "agent.audio_end" and ev["response_id"] == player.rid:
                    player.ended = True
                elif kind == "agent.flush" and ev["response_id"] == player.rid and not player.stopped:
                    played = player.played_ms
                    dropped = int(player.received_ms) - played
                    player.stopped = True
                    await ws.send(json.dumps({"type": "flushed", "response_id": player.rid,
                                              "played_ms": played, "dropped_ms": dropped}))
                    print(f"(interrupted after {played} ms, {dropped} ms dropped)")
                elif kind == "agent.sent" and ev["event"]["type"] == "poly.output_audio.stopped":
                    print(f"  heard: {ev['event']['spoken_text']!r}")
                elif kind in ("error", "agent.error"):
                    print(f"[{kind}] {ev.get('error') or ev.get('message')}")
                elif kind == "response.done" and ev["response"]["status"] not in ("completed", "cancelled"):
                    print(f"[response {ev['response']['status']}] {ev['response'].get('status_details')}")

        def ms(since: float) -> str:
            return f"{(time.monotonic() - since) * 1000:.0f} ms"

        tasks = [asyncio.create_task(t) for t in (send_audio(), report(), receive())]
        await tasks[0]
        for task in tasks[1:]:
            task.cancel()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stream a WAV through the running voice agent.")
    parser.add_argument("--file", default="static/sample-caller.wav", help="mono PCM16 WAV at 24 kHz")
    parser.add_argument("--url", default="ws://127.0.0.1:3000/agent")
    parser.add_argument("--voice", help="a Cartesia voice id from config.VOICES")
    asyncio.run(main(parser.parse_args()))
