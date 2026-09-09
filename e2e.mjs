// ─── End-to-end test: STT (whisper) → LLM (LM Studio) → TTS (Kokoro) ─────────
// Drives the app's real /stt and /tts WebSocket handlers + the same LLM
// streaming/sentence-splitting logic main.js uses in the browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// App under test; override with APP_URL when the server isn't on localhost:3000.
const APP = (process.env.APP_URL || 'http://localhost:3000').replace(/[/]+$/, '');
const WS = APP.replace(/^http/, 'ws');

// LLM config comes from the same settings.json the app uses, so this test has
// no machine-specific endpoints baked into it.
let settings;
try {
  settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
} catch (e) {
  console.error('Cannot read settings.json (' + e.message + ') - start the app once to create it.');
  process.exit(1);
}

const LLM_BASE = (settings.customLLMBaseUrl || '').replace(/[/]+$/, '');
const LLM_MODEL = settings.customLLMModel || '';
const LLM_URL = LLM_BASE + '/chat/completions';
const llmHeaders = {
  'Content-Type': 'application/json',
  ...(settings.customLLMApiKey ? { Authorization: 'Bearer ' + settings.customLLMApiKey } : {}),
};

if (!LLM_BASE || !LLM_MODEL) {
  console.error('settings.json is missing customLLMBaseUrl / customLLMModel - set them on the settings page first.');
  process.exit(1);
}

const results = [];
const log = (s) => console.log(s);
const pass = (n) => results.push(`PASS  ${n}`);
const fail = (n, why) => results.push(`FAIL  ${n}${why ? ' — ' + why : ''}`);

// ── helpers ──────────────────────────────────────────────────────────────────
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = {
      channels: buf.readUInt16LE(off + 10),
      sampleRate: buf.readUInt32LE(off + 12),
      bits: buf.readUInt16LE(off + 22),
    };
    else if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  return { fmt, pcm: data };
}

function resampleTo16kMono(pcm, fmt) {
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  // downmix to mono
  let mono = src;
  if (fmt.channels > 1) {
    mono = new Int16Array(src.length / fmt.channels);
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let c = 0; c < fmt.channels; c++) s += src[i * fmt.channels + c];
      mono[i] = s / fmt.channels;
    }
  }
  if (fmt.sampleRate === 16000) return Buffer.from(mono.buffer);
  // linear interpolation resample
  const ratio = fmt.sampleRate / 16000;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, mono.length - 1), t = x - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return Buffer.from(out.buffer);
}

function frameMessage(pcm) {
  const meta = new TextEncoder().encode(JSON.stringify({ sampleRate: 16000 }));
  const buf = new ArrayBuffer(4 + meta.byteLength + pcm.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, meta.byteLength, true);
  new Uint8Array(buf, 4, meta.byteLength).set(meta);
  new Uint8Array(buf, 4 + meta.byteLength).set(pcm);
  return buf;
}

const SILENT_FRAME = Buffer.alloc(4096 * 2); // 4096 samples of s16 silence (256ms @16k)

async function wsOpen(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error(`WS ${url} failed`));
  });
}

// ── TEST 1: LLM streaming (real LM Studio) ──────────────────────────────────
log(`\n── TEST 1: LLM streaming (${LLM_MODEL} @ ${LLM_BASE}) ──`);
{
  const t0 = Date.now();
  let firstTokenMs = null, full = '', chunks = 0;
  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: llmHeaders,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: 'You are a friendly assistant. Reply in one short sentence.' },
                   { role: 'user', content: 'Say hello and tell me you are working.' }],
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        const t = line.replace(/^data: /, '').trim();
        if (!t || t === '[DONE]') continue;
        try {
          const d = JSON.parse(t).choices?.[0]?.delta?.content;
          if (d) { chunks++; if (!firstTokenMs) firstTokenMs = Date.now() - t0; full += d; }
        } catch (_) {}
      }
    }
    log(`reply: "${full}"`);
    log(`chunks: ${chunks}, first token: ${firstTokenMs}ms, total: ${Date.now() - t0}ms`);
    full.length > 0 && chunks > 1 ? pass('LLM streaming') : fail('LLM streaming', 'no streamed content');
  } catch (e) { fail('LLM streaming', e.message); }
}

// ── TEST 2: TTS through app /tts WS (real Kokoro) ───────────────────────────
log('\n── TEST 2: TTS via app /tts WS (Speaches Kokoro) ──');
let ttsWavBuf = null, ttsSentence = 'Hello there! This is an end to end test of the talking assistant.';
{
  try {
    const ws = await wsOpen(WS + '/tts');
    const t0 = Date.now();
    const audio = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout waiting for TTS audio')), 120000);
      ws.onmessage = (ev) => {
        clearTimeout(to);
        try { res(Buffer.from(JSON.parse(ev.data).audioOutput.audio, 'base64')); }
        catch (e) { rej(e); }
      };
      ws.send(ttsSentence);
    });
    ws.close();
    const { fmt, pcm } = parseWav(audio);
    const dur = (pcm.length / 2 / fmt.sampleRate).toFixed(2);
    log(`WAV ok: ${fmt.sampleRate}Hz ${fmt.channels}ch ${fmt.bits}bit, ${dur}s, ${audio.length} bytes, ${Date.now() - t0}ms`);
    ttsWavBuf = audio;
    fmt.bits === 16 && fmt.channels === 1 && pcm.length > 16000 ? pass('TTS via /tts WS') : fail('TTS via /tts WS', 'unexpected format');
  } catch (e) { fail('TTS via /tts WS', e.message); }
}

// ── TEST 3: STT round-trip through app /stt WS (real whisper) ───────────────
log('\n── TEST 3: STT round-trip via app /stt WS (TTS audio → VAD → whisper) ──');
let transcript = null;
{
  try {
    if (!ttsWavBuf) throw new Error('no TTS audio from test 2');
    const { fmt, pcm } = parseWav(ttsWavBuf);
    const pcm16k = resampleTo16kMono(pcm, fmt);
    const FRAME = 4096 * 2;
    const frames = [];
    for (let i = 0; i < pcm16k.length; i += FRAME) frames.push(pcm16k.subarray(i, i + FRAME));
    log(`streaming ${frames.length} speech frames (${(pcm16k.length / 32000).toFixed(2)}s @16k)`);

    const ws = await wsOpen(WS + '/stt');
    const t0 = Date.now();
    transcript = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout waiting for transcript')), 180000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'fullSentence') { clearTimeout(to); res(msg.text); }
      };
      ws.onerror = () => { clearTimeout(to); rej(new Error('ws error')); };
      // pre-roll silence ×2 → speech frames → trailing silence ×4 (triggers VAD end)
      const send = (b) => ws.readyState === 1 && ws.send(frameMessage(b));
      for (let i = 0; i < 2; i++) send(SILENT_FRAME);
      for (const f of frames) send(f);
      for (let i = 0; i < 4; i++) send(SILENT_FRAME);
    });
    ws.close();
    log(`transcript: "${transcript}" (${Date.now() - t0}ms)`);

    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
    const want = new Set(norm(ttsSentence)), got = norm(transcript);
    const hit = got.filter(w => want.has(w)).length / Math.min(want.size, got.length || 1);
    log(`word match: ${(hit * 100).toFixed(0)}%`);
    hit >= 0.6 ? pass('STT round-trip via /stt WS') : fail('STT round-trip via /stt WS', `match ${(hit * 100).toFixed(0)}%`);
  } catch (e) { fail('STT round-trip via /stt WS', e.message); }
}

// ── TEST 4: full pipeline STT → LLM → TTS (mirrors main.js logic) ───────────
log('\n── TEST 4: full pipeline transcript → LLM stream → sentence TTS ──');
{
  try {
    const userMsg = transcript || 'Tell me a short joke about robots.';
    const history = [
      { role: 'system', content: 'You are a friendly 3D assistant. Reply in at most two short sentences.' },
      { role: 'user', content: userMsg },
    ];
    const ttsWs = await wsOpen(WS + '/tts');
    const audioChunks = [];
    let awaiting = 0;
    ttsWs.onmessage = (ev) => {
      try {
        const b64 = JSON.parse(ev.data).audioOutput?.audio;
        if (b64) { audioChunks.push(Buffer.from(b64, 'base64')); awaiting--; }
      } catch (_) {}
    };

    const t0 = Date.now();
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: llmHeaders,
      body: JSON.stringify({ model: LLM_MODEL, messages: history, stream: true }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);

    // identical sentence-splitting to main.js
    let full = '', pending = '';
    const sentenceRegex = /[^.!?\n]*[.!?\n][)"'\s]*/g;
    const reader = res.body.getReader(), dec = new TextDecoder();
    const sentencesSent = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        const t = line.replace(/^data: /, '').trim();
        if (!t || t === '[DONE]') continue;
        try {
          const d = JSON.parse(t).choices?.[0]?.delta?.content;
          if (d) {
            full += d; pending += d;
            sentenceRegex.lastIndex = 0;
            let lastIndex = 0, m;
            while ((m = sentenceRegex.exec(pending)) !== null) lastIndex = sentenceRegex.lastIndex;
            if (lastIndex > 0) {
              const sents = pending.slice(0, lastIndex).trim();
              pending = pending.slice(lastIndex);
              if (sents) { ttsWs.send(sents); awaiting++; sentencesSent.push(sents); }
            }
          }
        } catch (_) {}
      }
    }
    if (pending.trim()) { ttsWs.send(pending.trim()); awaiting++; sentencesSent.push(pending.trim()); }

    const deadline = Date.now() + 180000;
    while (awaiting > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
    ttsWs.close();

    log(`user: "${userMsg}"`);
    log(`assistant: "${full}"`);
    log(`sentences → TTS: ${sentencesSent.length} (${sentencesSent.map(s => JSON.stringify(s.slice(0, 40))).join(', ')})`);
    log(`audio chunks back: ${audioChunks.length} (${audioChunks.map(a => a.length + 'B').join(', ')}), total ${Date.now() - t0}ms`);

    const allValid = audioChunks.every(a => { try { parseWav(a); return true; } catch { return false; } });
    sentencesSent.length > 0 && audioChunks.length >= Math.min(sentencesSent.length, 1) && allValid
      ? pass('full pipeline STT→LLM→TTS')
      : fail('full pipeline STT→LLM→TTS', `${audioChunks.length}/${sentencesSent.length} audio, valid=${allValid}`);
  } catch (e) { fail('full pipeline STT→LLM→TTS', e.message); }
}

log('\n═════════ RESULTS ═════════');
console.log(results.join('\n'));
