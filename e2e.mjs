// ─── End-to-end test: STT (whisper) → LLM → TTS (Kokoro) ─────────────────────
// Speech runs browser-direct now, so this drives the same speech.mjs module the
// client uses. No app server required.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createUtteranceDetector, transcribe, synthesize, buildWavHeader, pcmRMS,
} from './speech.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Endpoints come from the same settings.json the app uses, so this test has no
// machine-specific hosts baked into it.
let settings;
try {
  settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
} catch (e) {
  console.error(`Cannot read settings.json (${e.message}) - start the app once to create it.`);
  process.exit(1);
}

const LLM_BASE = (settings.customLLMBaseUrl || '').replace(/\/+$/, '');
const LLM_MODEL = settings.customLLMModel || '';
const LLM_URL = `${LLM_BASE}/chat/completions`;
const llmHeaders = {
  'Content-Type': 'application/json',
  ...(settings.customLLMApiKey ? { Authorization: `Bearer ${settings.customLLMApiKey}` } : {}),
};

if (!LLM_BASE || !LLM_MODEL) {
  console.error('settings.json is missing customLLMBaseUrl / customLLMModel - set them first.');
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
  let mono = src;
  if (fmt.channels > 1) {
    mono = new Int16Array(src.length / fmt.channels);
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let c = 0; c < fmt.channels; c++) s += src[i * fmt.channels + c];
      mono[i] = s / fmt.channels;
    }
  }
  if (fmt.sampleRate === 16000) return new Uint8Array(mono.buffer, mono.byteOffset, mono.byteLength);
  const ratio = fmt.sampleRate / 16000;
  const outLen = Math.floor(mono.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, mono.length - 1), t = x - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return new Uint8Array(out.buffer);
}

const FRAME_BYTES = 4096 * 2;                     // 4096 samples of s16 = 256ms @16k
const SILENT_FRAME = new Uint8Array(FRAME_BYTES);
const framesOf = (pcm) => {
  const out = [];
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) out.push(pcm.subarray(i, i + FRAME_BYTES));
  return out;
};

// Run frames through the detector exactly as the mic callback does.
function detectUtterance(frames) {
  const detector = createUtteranceDetector();
  const found = [];
  for (const f of frames) {
    const u = detector.push(f);
    if (u) found.push(u);
  }
  return found;
}

// ── TEST 1: VAD + WAV, no network ───────────────────────────────────────────
log('\n── TEST 1: VAD and WAV encoding (offline) ──');
{
  try {
    const tone = new Int16Array(4096 * 6);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(i / 8) * 8000;
    const speech = framesOf(new Uint8Array(tone.buffer));

    const one = detectUtterance([SILENT_FRAME, SILENT_FRAME, ...speech, SILENT_FRAME, SILENT_FRAME, SILENT_FRAME]);
    const noise = detectUtterance([SILENT_FRAME, speech[0], SILENT_FRAME, SILENT_FRAME, SILENT_FRAME]);
    const silence = detectUtterance([SILENT_FRAME, SILENT_FRAME, SILENT_FRAME, SILENT_FRAME]);

    // Pre-roll means the utterance is longer than the speech frames alone
    const preRolled = one.length === 1 && one[0].byteLength > speech.length * FRAME_BYTES;
    const hdr = buildWavHeader(1000, 16000, 1, 16);
    const hdrOk = hdr.byteLength === 44 &&
      String.fromCharCode(...hdr.slice(0, 4)) === 'RIFF' &&
      new DataView(hdr.buffer).getUint32(40, true) === 1000;

    log(`utterances: speech=${one.length} shortburst=${noise.length} silence=${silence.length}`);
    log(`rms: silence=${Math.round(pcmRMS(SILENT_FRAME))} speech=${Math.round(pcmRMS(speech[0]))}`);
    log(`pre-roll included: ${preRolled}, wav header: ${hdrOk ? 'ok' : 'bad'}`);

    one.length === 1 && noise.length === 0 && silence.length === 0 && preRolled && hdrOk
      ? pass('VAD and WAV encoding')
      : fail('VAD and WAV encoding', `got ${one.length}/${noise.length}/${silence.length}`);
  } catch (e) { fail('VAD and WAV encoding', e.message); }
}

// ── TEST 2: LLM streaming ───────────────────────────────────────────────────
log(`\n── TEST 2: LLM streaming (${LLM_MODEL} @ ${LLM_BASE}) ──`);
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

// ── TEST 3: TTS direct to the service ───────────────────────────────────────
log(`\n── TEST 3: TTS direct (${settings.ttsModel} @ ${settings.ttsBaseUrl}) ──`);
let ttsWavBuf = null;
const ttsSentence = 'Hello there! This is an end to end test of the talking assistant.';
{
  try {
    const t0 = Date.now();
    const audio = Buffer.from(await synthesize(ttsSentence, settings));
    const { fmt, pcm } = parseWav(audio);
    log(`WAV ok: ${fmt.sampleRate}Hz ${fmt.channels}ch ${fmt.bits}bit, ${(pcm.length / 2 / fmt.sampleRate).toFixed(2)}s, ${audio.length} bytes, ${Date.now() - t0}ms`);
    ttsWavBuf = audio;
    fmt.bits === 16 && fmt.channels === 1 && pcm.length > 16000
      ? pass('TTS direct') : fail('TTS direct', 'unexpected format');
  } catch (e) { fail('TTS direct', e.message); }
}

// ── TEST 4: STT round-trip (TTS audio → VAD → whisper) ──────────────────────
log(`\n── TEST 4: STT round-trip direct (${settings.sttModel} @ ${settings.sttBaseUrl}) ──`);
let transcript = null;
{
  try {
    if (!ttsWavBuf) throw new Error('no TTS audio from test 3');
    const { fmt, pcm } = parseWav(ttsWavBuf);
    const pcm16k = resampleTo16kMono(pcm, fmt);
    const speech = framesOf(pcm16k);
    log(`feeding ${speech.length} speech frames (${(pcm16k.length / 32000).toFixed(2)}s @16k) through the VAD`);

    const utterances = detectUtterance([SILENT_FRAME, SILENT_FRAME, ...speech, SILENT_FRAME, SILENT_FRAME, SILENT_FRAME]);
    if (utterances.length !== 1) throw new Error(`VAD produced ${utterances.length} utterances, expected 1`);

    const t0 = Date.now();
    transcript = await transcribe(utterances[0], settings);
    log(`transcript: "${transcript}" (${Date.now() - t0}ms)`);

    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
    const want = new Set(norm(ttsSentence)), got = norm(transcript);
    const hit = got.filter(w => want.has(w)).length / Math.min(want.size, got.length || 1);
    log(`word match: ${(hit * 100).toFixed(0)}%`);
    hit >= 0.6 ? pass('STT round-trip direct') : fail('STT round-trip direct', `match ${(hit * 100).toFixed(0)}%`);
  } catch (e) { fail('STT round-trip direct', e.message); }
}

// ── TEST 5: full pipeline, mirroring main.js ────────────────────────────────
log('\n── TEST 5: full pipeline transcript → LLM stream → ordered sentence TTS ──');
{
  try {
    const userMsg = transcript || 'Tell me a short joke about robots.';
    const history = [
      { role: 'system', content: 'You are a friendly 3D assistant. Reply in at most two short sentences.' },
      { role: 'user', content: userMsg },
    ];

    const t0 = Date.now();
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: llmHeaders,
      body: JSON.stringify({ model: LLM_MODEL, messages: history, stream: true }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);

    // Same sentence splitting and serialised synthesis as main.js
    const audioChunks = [];
    let chain = Promise.resolve();
    const speak = (text) => {
      chain = chain.then(async () => {
        audioChunks.push({ text, audio: Buffer.from(await synthesize(text, settings)) });
      });
    };

    let full = '', pending = '';
    const sentenceRegex = /[^.!?\n]*[.!?\n][)"'\s]*/g;
    const reader = res.body.getReader(), dec = new TextDecoder();
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
            let lastIndex = 0;
            while (sentenceRegex.exec(pending) !== null) lastIndex = sentenceRegex.lastIndex;
            if (lastIndex > 0) {
              const sents = pending.slice(0, lastIndex).trim();
              pending = pending.slice(lastIndex);
              if (sents) speak(sents);
            }
          }
        } catch (_) {}
      }
    }
    if (pending.trim()) speak(pending.trim());
    await chain;

    log(`user: "${userMsg}"`);
    log(`assistant: "${full}"`);
    log(`sentences to TTS: ${audioChunks.length}`);
    log(`audio back: ${audioChunks.map(c => c.audio.length + 'B').join(', ')}, total ${Date.now() - t0}ms`);

    const allValid = audioChunks.every(c => { try { parseWav(c.audio); return true; } catch { return false; } });
    audioChunks.length > 0 && allValid
      ? pass('full pipeline STT-LLM-TTS')
      : fail('full pipeline STT-LLM-TTS', `${audioChunks.length} chunks, valid=${allValid}`);
  } catch (e) { fail('full pipeline STT-LLM-TTS', e.message); }
}

log('\n═════════ RESULTS ═════════');
console.log(results.join('\n'));
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
