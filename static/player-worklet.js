// Runs on the audio thread. Plays the agent's PCM16 as it arrives, and counts what has
// actually reached the speakers: that count is what the playback reports are built from.
//
// Messages in:  start {id}, audio {id, pcm}, end {id}, flush
// Messages out: started {id}, progress {id, played_ms}, finished {id, played_ms},
//               flushed {id, played_ms, dropped_ms}
const REPORT_EVERY = sampleRate / 4; // samples between progress reports: 250 ms

class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset(null);
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  reset(id) {
    this.id = id;
    this.queue = [];
    this.offset = 0; // into queue[0]
    this.queued = 0; // samples received for this reply
    this.played = 0; // samples played for this reply
    this.lastReport = 0;
    this.ended = false; // the server has sent all the audio
    this.done = false; // started/finished/flushed already posted as needed
    this.started = false;
  }

  onMessage(msg) {
    if (msg.type === "start") this.reset(msg.id);
    else if (msg.type === "audio" && msg.id === this.id && !this.done) {
      const samples = new Int16Array(msg.pcm);
      this.queue.push(samples);
      this.queued += samples.length;
    } else if (msg.type === "end" && msg.id === this.id) this.ended = true;
    else if (msg.type === "flush" && this.id && !this.done) {
      this.port.postMessage({ type: "flushed", id: this.id, played_ms: ms(this.played), dropped_ms: ms(this.queued - this.played) });
      this.done = true;
      this.queue = [];
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const buf = this.queue[0];
      const n = Math.min(out.length - i, buf.length - this.offset);
      for (let k = 0; k < n; k++) out[i + k] = buf[this.offset + k] / 32768;
      i += n;
      this.offset += n;
      this.played += n;
      if (this.offset >= buf.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (this.id && !this.done && this.played > 0) {
      if (!this.started) {
        this.started = true;
        this.port.postMessage({ type: "started", id: this.id });
      }
      if (this.ended && !this.queue.length) {
        this.done = true;
        this.port.postMessage({ type: "finished", id: this.id, played_ms: ms(this.played) });
      } else if (this.played - this.lastReport >= REPORT_EVERY) {
        this.lastReport = this.played;
        this.port.postMessage({ type: "progress", id: this.id, played_ms: ms(this.played) });
      }
    }
    return true;
  }
}

function ms(samples) {
  return Math.round((samples / sampleRate) * 1000);
}

registerProcessor("player", Player);
