// The page: records the caller, plays the agent, and draws the conversation.
//
// It talks only to this demo's server, over one WebSocket at /agent:
//   out: {type: "start", ...} once, then binary PCM16 frames of the caller (100 ms each),
//        plus {type: "playback" | "flushed"} as the agent's audio plays
//   in:  Dialog-RSN-1's own events, unchanged; this server's `agent.*` messages;
//        and binary PCM16 frames of the agent's voice
const $ = (id) => document.getElementById(id);
const QUIET = /^(response\.output_text\.delta|conversation\.item\.input_audio_transcription\.delta|poly\.output_audio\.delta)$/;

let settings = null;
let rate = 24000;
let run = null; // the live conversation, or null when idle
let turns = []; // one per caller turn: {itemId, caller, callerEl, agent, agentEl, end, confirmed, firstText, firstAudio}

// ---- Setup --------------------------------------------------------------------------

init();

async function init() {
  settings = await fetch("/settings").then((r) => r.json());
  rate = settings.sample_rate;
  fill($("voice"), settings.voices.map((v) => [v.id, v.label]));
  fill($("turn-taking"), settings.turn_taking.map((t) => [t.id, t.label]));
  $("instructions").value = settings.instructions;
  await listMicrophones();

  $("start-mic").onclick = () => start("mic");
  $("start-sample").onclick = () => start("sample");
  $("stop").onclick = () => stop("Stopped.");
  $("clear").onclick = clearConversation;
  $("export").onclick = exportConversation;
  $("quiet").onchange = () => $("events").classList.toggle("quiet", $("quiet").checked);
  $("events").classList.toggle("quiet", $("quiet").checked);
}

function fill(select, options) {
  select.innerHTML = "";
  for (const [value, label] of options) select.add(new Option(label, value));
}

async function listMicrophones() {
  const devices = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
  const mics = devices.filter((d) => d.kind === "audioinput" && d.label);
  if (!mics.length) return; // no labels until the page has had microphone permission once
  const chosen = $("mic").value;
  fill($("mic"), [["", "System default"], ...mics.map((d) => [d.deviceId, d.label])]);
  $("mic").value = chosen;
}

// ---- A conversation -----------------------------------------------------------------

async function start(mode) {
  if (run) return;
  hideToast();
  const ctx = new AudioContext({ sampleRate: rate });
  await ctx.resume(); // while the click still counts as a user gesture
  await Promise.all([ctx.audioWorklet.addModule("/static/capture-worklet.js"), ctx.audioWorklet.addModule("/static/player-worklet.js")]);
  const capture = new AudioWorkletNode(ctx, "capture");
  const player = new AudioWorkletNode(ctx, "player", { outputChannelCount: [1] });
  player.connect(ctx.destination);

  let source;
  let stream = null;
  try {
    if (mode === "mic") {
      const id = $("mic").value;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          channelCount: 1,
          echoCancellation: true, // keeps the agent's own voice out of the microphone
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      source = ctx.createMediaStreamSource(stream);
      listMicrophones();
    } else {
      const clip = await fetch("/static/sample-caller.wav").then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
      source = ctx.createBufferSource();
      source.buffer = clip;
      source.connect(ctx.destination); // so you hear the caller too
    }
  } catch (err) {
    ctx.close();
    showToast(mode === "mic" ? `Microphone unavailable: ${err.message}` : `Couldn't load the sample: ${err.message}`);
    return;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/agent`);
  ws.binaryType = "arraybuffer";
  run = { mode, ctx, ws, stream, source, capture, player, frame: new Int16Array(rate / 10), fill: 0, t0: null, audioId: null, responding: false, playing: false, live: false };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "start",
      voice: $("voice").value,
      turn_taking: $("turn-taking").value,
      instructions: $("instructions").value.trim(),
    }));
  };
  ws.onmessage = (e) => (typeof e.data === "string" ? onMessage(JSON.parse(e.data)) : onAudio(e.data));
  ws.onclose = () => run?.ws === ws && stop("The server closed the conversation.");
  capture.port.onmessage = (e) => onCaptured(new Int16Array(e.data));
  player.port.onmessage = (e) => onPlayer(e.data);

  setControls(true);
  setStatus("thinking", "Connecting…");
}

// Audio starts flowing once the session is configured, so every frame is read at the
// right sample rate and the timing below counts from the first one.
function begin() {
  run.live = true;
  run.source.connect(run.capture);
  if (run.mode === "sample") {
    run.source.onended = () => finishWhenQuiet();
    run.source.start();
    setStatus("listening", "Sample caller speaking");
  } else {
    setStatus("listening", "Listening");
  }
}

function stop(reason) {
  if (!run) return;
  const r = run;
  run = null;
  try { r.source.disconnect(); } catch {}
  try { r.source.stop?.(); } catch {}
  r.stream?.getTracks().forEach((t) => t.stop());
  r.ctx.close();
  if (r.ws.readyState <= WebSocket.OPEN) r.ws.close();
  setControls(false);
  setStatus("idle", reason || "Ready");
}

// After the sample ends, keep sending silence until the last reply has played out.
function finishWhenQuiet() {
  const r = run;
  const ended = Date.now();
  const tick = setInterval(() => {
    if (run !== r) return clearInterval(tick);
    sendFrame(new Int16Array(rate / 10));
    const waited = Date.now() - ended;
    if ((waited > 3000 && !r.responding && !r.playing) || waited > 20000) {
      clearInterval(tick);
      stop("Sample finished.");
    }
  }, 100);
}

// ---- Caller audio out --------------------------------------------------------------

// The worklet hands over 128 samples at a time; send them in 100 ms frames.
function onCaptured(block) {
  const r = run;
  if (!r?.live) return;
  let i = 0;
  while (i < block.length) {
    const n = Math.min(block.length - i, r.frame.length - r.fill);
    r.frame.set(block.subarray(i, i + n), r.fill);
    r.fill += n;
    i += n;
    if (r.fill === r.frame.length) {
      sendFrame(r.frame);
      r.frame = new Int16Array(rate / 10);
      r.fill = 0;
    }
  }
}

function sendFrame(frame) {
  if (run.ws.readyState !== WebSocket.OPEN) return;
  // The first frame's first sample was heard 100 ms before it was sent. Every
  // `audio_*_ms` the server reports counts from that sample.
  run.t0 ??= performance.now() - 100;
  run.ws.send(frame.buffer);
}

// ---- Agent audio in ---------------------------------------------------------------

function onAudio(pcm) {
  run?.player.port.postMessage({ type: "audio", id: run.audioId, pcm }, [pcm]);
}

function onPlayer(msg) {
  if (!run) return;
  const send = (m) => run.ws.readyState === WebSocket.OPEN && run.ws.send(JSON.stringify(m));
  if (msg.type === "started") {
    run.playing = true;
    const turn = turnFor(msg.id);
    if (turn && turn.firstAudio == null) {
      turn.firstAudio = performance.now();
      drawTiming(turn);
    }
    setStatus("speaking", "Agent speaking");
  } else if (msg.type === "progress") {
    send({ type: "playback", response_id: msg.id, played_ms: msg.played_ms, finished: false });
  } else if (msg.type === "finished") {
    run.playing = false;
    send({ type: "playback", response_id: msg.id, played_ms: msg.played_ms, finished: true });
    setStatus("listening", run.mode === "sample" ? "Sample caller" : "Listening");
  } else if (msg.type === "flushed") {
    run.playing = false;
    send({ type: "flushed", response_id: msg.id, played_ms: msg.played_ms, dropped_ms: msg.dropped_ms });
  }
}

// ---- Server messages ----------------------------------------------------------------

function onMessage(ev) {
  if (!run) return;
  logEvent(ev);
  const t = ev.type;

  if (t === "session.updated" && !run.live) begin();
  else if (t === "agent.audio_start") {
    run.audioId = ev.response_id;
    run.player.port.postMessage({ type: "start", id: ev.response_id });
  } else if (t === "agent.audio_end") run.player.port.postMessage({ type: "end", id: ev.response_id });
  else if (t === "agent.flush") run.player.port.postMessage({ type: "flush" });
  else if (t === "agent.sent" && ev.event.type === "poly.output_audio.stopped") markHeard(ev.event);
  else if (t === "agent.error") {
    showToast(ev.message);
    stop("Error");
    setStatus("error", "Error");
  } else if (t === "input_audio_buffer.speech_started") {
    setStatus("listening", "Caller speaking");
    const turn = { itemId: ev.item_id, caller: "", agent: "" };
    turn.callerEl = bubble("caller", "Caller", "…");
    turn.callerEl.classList.add("pending");
    turns.push(turn);
  } else if (t === "input_audio_buffer.speech_stopped") {
    const turn = turns.findLast((x) => x.itemId === ev.item_id) || turns.at(-1);
    if (turn && run.t0 != null) {
      turn.end = run.t0 + ev.audio_end_ms;
      turn.confirmed = performance.now();
    }
    setStatus("thinking", "Agent thinking");
  } else if (t === "conversation.item.input_audio_transcription.delta" || t === "conversation.item.input_audio_transcription.completed") {
    const turn = turns.findLast((x) => x.itemId === ev.item_id);
    if (turn) {
      turn.caller = t.endsWith("completed") ? ev.transcript.trim() : turn.caller + ev.delta;
      turn.callerEl.classList.remove("pending");
      turn.callerEl.querySelector(".text").textContent = turn.caller;
    }
  } else if (t === "response.created") {
    run.responding = true;
    const turn = turns.at(-1) || newTextlessTurn();
    turn.responseId = ev.response.id;
    turn.agentEl = bubble("agent", "Agent", "");
  } else if (t === "response.output_text.delta") {
    const turn = turnFor(ev.response_id);
    if (!turn) return;
    if (turn.firstText == null) {
      turn.firstText = performance.now();
      drawTiming(turn);
    }
    turn.agent += ev.delta;
    turn.agentEl.querySelector(".text").textContent = turn.agent;
    scrollConversation();
  } else if (t === "response.done") {
    run.responding = false;
    const turn = turnFor(ev.response.id);
    if (turn && ev.response.status !== "completed" && !turn.agent) turn.agentEl?.remove();
    else if (turn && ev.response.status === "failed") note(turn.agentEl, "Response failed");
  } else if (t === "error") {
    showToast(`${ev.error.code}: ${ev.error.message}`);
  }
}

function turnFor(responseId) {
  return turns.findLast((x) => x.responseId === responseId);
}

function newTextlessTurn() {
  const turn = { caller: "", agent: "" };
  turns.push(turn);
  return turn;
}

// The caller cut in: show which words they heard, and which they never did.
function markHeard(report) {
  const turn = turnFor(report.response_id);
  if (!turn?.agentEl || !report.dropped_ms) return;
  turn.heard = report.spoken_text;
  const words = turn.agent.trim().split(/\s+/);
  const n = report.spoken_text ? report.spoken_text.split(/\s+/).length : 0;
  const text = turn.agentEl.querySelector(".text");
  text.textContent = words.slice(0, n).join(" ") + " ";
  const rest = document.createElement("span");
  rest.className = "unheard";
  rest.textContent = words.slice(n).join(" ");
  text.append(rest);
  note(turn.agentEl, `Interrupted after ${(report.audio_ms / 1000).toFixed(1)} s. Dialog-RSN-1 was told the caller heard only the first ${n} words.`);
}

// ---- Drawing -------------------------------------------------------------------------

function bubble(kind, who, text) {
  $("conversation").querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = `<span class="who"></span><span class="text"></span>`;
  el.querySelector(".who").textContent = who;
  el.querySelector(".text").textContent = text;
  $("conversation").append(el);
  scrollConversation();
  return el;
}

function note(el, text) {
  if (!el) return;
  const n = el.querySelector(".note") || el.appendChild(Object.assign(document.createElement("span"), { className: "note" }));
  n.textContent = text;
}

function drawTiming(turn) {
  if (!turn.agentEl || turn.end == null) return;
  const parts = [];
  if (turn.confirmed != null) parts.push(`turn ${ms(turn.confirmed - turn.end)}`);
  if (turn.firstText != null) parts.push(`first text ${ms(turn.firstText - turn.end)}`);
  if (turn.firstAudio != null) parts.push(`first audio ${ms(turn.firstAudio - turn.end)}`);
  let row = turn.agentEl.querySelector(".timing");
  if (!row) {
    row = document.createElement("div");
    row.className = "timing";
    row.title = "Measured from the moment the caller stopped speaking";
    turn.agentEl.append(row);
  }
  row.textContent = parts.join(" · ");
  drawStats();
}

function drawStats() {
  const median = (key) => {
    const v = turns.filter((t) => t[key] != null && t.end != null).map((t) => t[key] - t.end).sort((a, b) => a - b);
    return v.length ? ms(v[Math.floor(v.length / 2)]) : "–";
  };
  $("stat-turn").textContent = median("confirmed");
  $("stat-text").textContent = median("firstText");
  $("stat-audio").textContent = median("firstAudio");
}

function ms(v) {
  return `${Math.max(0, Math.round(v))} ms`;
}

function scrollConversation() {
  const c = $("conversation");
  c.scrollTop = c.scrollHeight;
}

function logEvent(ev) {
  const out = ev.type === "agent.sent";
  const inner = out ? ev.event : ev;
  const line = document.createElement("div");
  line.className = out ? "out" : ev.type.includes("error") ? "err" : ev.type.startsWith("agent.") ? "" : "in";
  if (QUIET.test(inner.type)) line.dataset.quiet = "";
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const body = JSON.stringify(inner);
  line.textContent = `${time} ${out ? "→" : "←"} ${inner.type}  ${body.length > 400 ? body.slice(0, 400) + "…" : body}`;
  const log = $("events");
  log.append(line);
  while (log.childElementCount > 600) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function setStatus(kind, text) {
  $("status-dot").className = `dot ${kind}`;
  $("status-text").textContent = text;
}

function setControls(live) {
  $("start-mic").disabled = live;
  $("start-sample").disabled = live;
  $("stop").disabled = !live;
  for (const id of ["mic", "voice", "turn-taking", "instructions"]) $(id).disabled = live;
}

function showToast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
}

function hideToast() {
  $("toast").hidden = true;
}

function clearConversation() {
  turns = [];
  $("conversation").innerHTML = `<p class="empty">The conversation shows up here once you start talking.</p>`;
  $("events").innerHTML = "";
  drawStats();
}

function exportConversation() {
  const data = turns.map((t) => ({
    caller: t.caller,
    agent: t.agent,
    heard: t.heard ?? t.agent,
    turn_ms: t.confirmed != null && t.end != null ? Math.round(t.confirmed - t.end) : null,
    first_text_ms: t.firstText != null && t.end != null ? Math.round(t.firstText - t.end) : null,
    first_audio_ms: t.firstAudio != null && t.end != null ? Math.round(t.firstAudio - t.end) : null,
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "conversation.json" });
  a.click();
  URL.revokeObjectURL(a.href);
}
