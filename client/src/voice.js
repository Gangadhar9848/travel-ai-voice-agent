// Browser voice client: mic → PCM16 24 kHz → server WebSocket; server audio → speakers.
const RATE = 24000; // GPT-Live expects/produces mono PCM16 at 24 kHz

// AudioWorklet that hands raw mic samples to the main thread
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);`;

function floatToPcm16Base64(chunks) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(len);
  let o = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) {
    const s = Math.max(-1, Math.min(1, c[i]));
    pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToFloat(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

/**
 * startVoice({ customerId, history, onEvent }) → { stop() }
 * onEvent gets server events: ready · user_transcript · assistant_transcript · ui · status · error · closed
 * plus {type:'level', level} (mic volume 0-1) and {type:'speaking', on}
 */
export async function startVoice({ customerId, conversationId, history, onEvent }) {
  const ctx = new AudioContext({ sampleRate: RATE });
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
  const source = ctx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(ctx, 'capture');
  source.connect(node);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/voice`);
  let ready = false;
  let pending = [];
  let pendingLen = 0;

  node.port.onmessage = (e) => {
    const f = e.data;
    let peak = 0;
    for (let i = 0; i < f.length; i += 8) peak = Math.max(peak, Math.abs(f[i]));
    onEvent({ type: 'level', level: Math.min(1, peak * 3) });
    if (!ready) return;
    pending.push(f);
    pendingLen += f.length;
    if (pendingLen >= RATE / 10) { // send ~100 ms at a time
      ws.send(JSON.stringify({ type: 'audio', audio: floatToPcm16Base64(pending) }));
      pending = [];
      pendingLen = 0;
    }
  };

  // ---- playback: schedule chunks on the audio clock using the server's start_ms ----
  let base = null;
  const playing = new Set();
  function play(b64, startMs) {
    const samples = base64ToFloat(b64);
    if (!samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, RATE);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (base === null || base + (startMs ?? 0) / 1000 < now) base = now + 0.05 - (startMs ?? 0) / 1000;
    src.start(base + (startMs ?? 0) / 1000);
    playing.add(src);
    onEvent({ type: 'speaking', on: true });
    src.onended = () => { playing.delete(src); if (!playing.size) onEvent({ type: 'speaking', on: false }); };
  }
  function flushPlayback() {
    for (const s of playing) try { s.stop(); } catch {}
    playing.clear();
    base = null;
  }

  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', customerId, conversationId, history }));
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'ready') ready = true;
    if (ev.type === 'audio') return play(ev.audio, ev.start_ms);
    onEvent(ev);
  };
  ws.onerror = () => onEvent({ type: 'error', message: 'Voice connection failed — is the server running?' });
  ws.onclose = () => { cleanup(); onEvent({ type: 'closed' }); };

  let stopped = false;
  function cleanup() {
    if (stopped) return;
    stopped = true;
    flushPlayback();
    mic.getTracks().forEach((t) => t.stop());
    node.disconnect();
    source.disconnect();
    ctx.close().catch(() => {});
  }

  return {
    stop() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      setTimeout(() => ws.close(), 200);
      cleanup();
    },
  };
}
