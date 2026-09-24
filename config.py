"""Defaults for the Dialog-RSN-1 voice agent. Everything here can be overridden in `.env`."""

import os

from dotenv import load_dotenv

load_dotenv()

# Dialog-RSN-1: hears the caller, decides when the turn is over, writes the reply.
DIALOGUE_URL = os.environ.get("DIALOGUE_URL", "wss://api.us.poly.ai/v1/realtime")
DIALOGUE_API_KEY = os.environ.get("DIALOGUE_API_KEY")

# Cartesia: speaks the reply while it's still being written.
CARTESIA_API_KEY = os.environ.get("CARTESIA_API_KEY")
CARTESIA_MODEL = os.environ.get("CARTESIA_MODEL", "sonic-3.6")

# One rate for everything: the page records at it, Dialog-RSN-1 is told it, and Cartesia
# returns audio at it, so the page can play replies without resampling.
SAMPLE_RATE = 24_000

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3000"))

INSTRUCTIONS = """\
You are a friendly voice assistant on a live call.
- Answer in one to three short, spoken-style sentences.
- No lists, markdown, emoji or URLs: everything you write is read aloud.
- Answer general questions from your own knowledge. If you're not sure, say so briefly.
- Ask a follow-up question when it helps the caller move forward.
- If you're cut off, don't repeat yourself. Pick up from what the caller just said."""

# Chained pipelines tune turn-taking with numbers, such as an end-of-turn confidence
# threshold and a timeout. Dialog-RSN-1 has no thresholds to tune: the
# model itself decides when a turn is over, and that decision takes plain-language
# instructions. Each style is one more line appended to INSTRUCTIONS.
TURN_TAKING = {
    "balanced": {
        "label": "Balanced",
        "prompt": "",
    },
    "patient": {
        "label": "Patient: callers read out numbers and think aloud",
        "prompt": "Callers often pause while they read out account numbers, dates or "
                  "addresses, or while they think. Treat those pauses as part of the turn "
                  "and wait until they have clearly finished.",
    },
    "brisk": {
        "label": "Brisk: short answers, quick back-and-forth",
        "prompt": "Callers here give short answers like yes, no, or a single word. As soon "
                  "as a short answer is complete, treat the turn as finished.",
    },
}

VOICES = [
    {"id": "f786b574-daa5-4673-aa0c-cbe3e8534c02", "label": "Katie (US English, female)"},
    {"id": "47c38ca4-5f35-497b-b1a3-415245fb35e1", "label": "Daniel (US English, male)"},
    {"id": "62ae83ad-4f6a-430b-af41-a9bede9286ca", "label": "Gemma (British English, female)"},
    {"id": "ef191366-f52f-447a-a398-ed8c0f2943a1", "label": "Archie (British English, male)"},
    {"id": "12e85709-099c-480a-ba3e-875c41a9611a", "label": "Arlo (Australian English, male)"},
]
