# Dialog-RSN-1 voice agent

A voice agent you talk to in the browser. Dialog-RSN-1 hears the caller, decides when
they've finished, and streams the reply as text. [Cartesia](https://cartesia.ai) speaks
that reply while it's still being written.

It has the usual shape of a browser voice agent: a Python server, a browser page, a microphone
picker and a live event log. The difference is the pipeline. A chained pipeline transcribes the
caller and detects the end of the turn, then an LLM writes the reply, then TTS speaks it. Here
one model does the first two jobs.

```text
browser mic ──PCM──▶ app.py ──input_audio_buffer.append──▶ Dialog-RSN-1
                                                               │ text deltas
browser speakers ◀──PCM── app.py ◀──PCM── Cartesia ◀──────────┘
        │ playback progress
        └──────▶ app.py ──poly.output_audio.*──▶ Dialog-RSN-1
```

```text
$ uv run probe.py
(caller speaking)
  turn confirmed 83 ms after the caller stopped
  first text  389 ms after the caller stopped
  first audio 718 ms after the caller stopped
Caller: Hi, I'm going to Lisbon for a long weekend next month. What should I make sure I see?
Agent:  In Lisbon, you should definitely see the Belém Tower and the Jerónimos Monastery. Don't miss the historic Alfama district either. What kind of activities are you looking for?
(caller speaking)
(interrupted after 5534 ms, 3826 ms dropped)
  heard: "In Lisbon, you should definitely see the Belém Tower and the Jerónimos Monastery. Don't miss the"
  turn confirmed 108 ms after the caller stopped
  first text  390 ms after the caller stopped
  first audio 678 ms after the caller stopped
Caller: Sorry, quick question - is it easy to get around on foot?
Agent:  Yes, the city center is very walkable, especially the historic areas like Alfama and Baixa. What other spots are you hoping to visit?
```

## Run it

You need Python 3.12, [uv](https://docs.astral.sh/uv/), a Dialog-RSN-1 workspace API key
and a Cartesia API key. Cartesia's free tier works.

```bash
cp .env.example .env    # add DIALOGUE_API_KEY and CARTESIA_API_KEY
uv sync
uv run app.py           # then open http://127.0.0.1:3000
```

Click **Start conversation** and talk, or click **Play the sample caller** to hear a recorded
caller ask a question and then talk over the answer. The sample needs no microphone.

Use Chrome, Edge or Safari. **Wear headphones with the microphone:** echo cancellation
helps, but through speakers the mic can still hear the agent and treat it as you
interrupting.

### Check it from a terminal

With the server running, `probe.py` streams `static/sample-caller.wav` through `/agent` the
way the page does, and prints the conversation, the barge-in and the timings:

```bash
uv run probe.py
```

## What's where

| File | What it does |
|---|---|
| `app.py` | The server. One Dialog-RSN-1 socket and one Cartesia socket per browser tab. Forwards the caller's audio, streams reply text to Cartesia, handles barge-in, sends playback reports |
| `cartesia_tts.py` | Cartesia over one websocket, one context per response, word timestamps for `spoken_text` |
| `config.py` | Instructions, turn-taking styles, voices, sample rate |
| `static/app.js` | The page: records the caller, plays the agent, draws the conversation and the event log |
| `static/capture-worklet.js` | Microphone to PCM16 on the audio thread |
| `static/player-worklet.js` | Plays the agent's PCM and counts what actually played |
| `probe.py` | A terminal stand-in for the page |

## How it compares to a chained pipeline

| Chained pipeline | This demo |
|---|---|
| A speech-to-text service for transcripts and an end-of-turn event | Dialog-RSN-1 `input_audio_buffer.speech_stopped`, confirmed by the model |
| An LLM, with the history kept in a `messages` list on the server | Dialog-RSN-1 writes the reply and keeps the history in the session |
| A separate TTS service | Cartesia streams audio from the first words of the reply |
| An end-of-turn confidence threshold and timeout | A turn-taking line in `instructions`: Dialog-RSN-1 has no timing knobs |

## Configuration

Everything the page offers lives in `config.py`:

- **Voice.** Five Cartesia voices. Add any voice id from your Cartesia library.
- **Turn-taking.** Balanced, patient or brisk. Each one appends a line to the instructions,
  because Dialog-RSN-1 decides turn ends itself and takes direction in plain language. The
  realtime schema's `silence_duration_ms`, `threshold` and friends are rejected with
  `unsupported_parameter`.
- **Instructions.** Editable on the page before you start.

`.env` also takes `CARTESIA_MODEL` (default `sonic-3.6`), `DIALOGUE_URL` (default us-1
production) and `PORT` (default 3000).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Dialog-RSN-1 refused the connection (HTTP 401)" | The key is missing, or it's a personal access token | Use a workspace API key from Agent Studio in `DIALOGUE_API_KEY` |
| "Cartesia refused the connection" | `CARTESIA_API_KEY` is missing or wrong | Check the key in the Cartesia dashboard |
| The agent keeps interrupting itself | The mic hears the speakers | Wear headphones |
| Text appears but there's no sound | The tab is muted, or the browser blocked audio | Unmute the tab, click Start again |
| "Microphone unavailable" | The page has no microphone permission | Allow the microphone in the address bar, or use the sample caller |

## License

Apache 2.0. See [LICENSE](LICENSE).
