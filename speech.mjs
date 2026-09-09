// OpenAI-compatible speech helpers, shared by the browser client (main.js) and
// the end-to-end test. Deliberately limited to APIs that exist in both browsers
// and Node 18+: fetch, FormData, Blob, DataView, TextEncoder.

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

const baseUrlOf = (url) => (url || DEFAULT_BASE_URL).replace(/\/+$/, '');
const authHeaders = (apiKey) => (apiKey ? { Authorization: 'Bearer ' + apiKey } : {});

// ─── PCM / WAV ───────────────────────────────────────────────────────────────

// Minimal 44-byte WAV header for raw PCM.
export function buildWavHeader(dataLen, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const view = new DataView(new ArrayBuffer(44));
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitDepth / 8), true);  // byte rate
  view.setUint16(32, channels * (bitDepth / 8), true);               // block align
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);

  return new Uint8Array(view.buffer);
}

export function encodeWav(pcm, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const header = buildWavHeader(pcm.byteLength, sampleRate, channels, bitDepth);
  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out;
}

// RMS amplitude of 16-bit LE PCM, on the same 0-32767 scale as the samples.
export function pcmRMS(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export function floatToPcm16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
  }
  return new Uint8Array(int16.buffer);
}

// ─── Voice activity detection ────────────────────────────────────────────────

export const VAD_DEFAULTS = {
  speechThreshold: 500,   // RMS level counted as speech (0-32767)
  silenceFrames: 3,       // consecutive silent frames that end an utterance
  minSpeechFrames: 2,     // ignore bursts shorter than this (likely noise)
  preRollFrames: 2,       // silent frames kept before onset so it isn't clipped
};

// Frame-at-a-time utterance detector. push() returns the assembled utterance as
// one PCM buffer when speech ends, otherwise null.
export function createUtteranceDetector(options = {}) {
  const cfg = { ...VAD_DEFAULTS, ...options };
  let speaking = false, silenceCount = 0, speechCount = 0, busy = false;
  let utterance = [], preRoll = [];

  const keepPreRoll = (pcm) => {
    preRoll.push(pcm);
    if (preRoll.length > cfg.preRollFrames) preRoll.shift();
  };

  const concat = (chunks) => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  };

  return {
    get busy() { return busy; },
    // Set while the previous utterance is still being transcribed.
    setBusy(v) { busy = v; },

    reset() {
      speaking = false; silenceCount = 0; speechCount = 0;
      utterance = []; preRoll = []; busy = false;
    },

    push(pcm) {
      // Don't start a new utterance while the previous one is in flight, but
      // keep the pre-roll fed so speech resuming right after isn't clipped.
      if (busy) { keepPreRoll(pcm); return null; }

      if (pcmRMS(pcm) >= cfg.speechThreshold) {
        if (!speaking) { utterance = preRoll.slice(); preRoll = []; }
        speaking = true;
        silenceCount = 0;
        speechCount++;
        utterance.push(pcm);
      } else if (speaking) {
        silenceCount++;
        utterance.push(pcm);
        if (silenceCount >= cfg.silenceFrames) {
          const complete = speechCount >= cfg.minSpeechFrames ? concat(utterance) : null;
          speaking = false; silenceCount = 0; speechCount = 0; utterance = [];
          return complete;
        }
      } else {
        keepPreRoll(pcm);
      }
      return null;
    },
  };
}

// ─── Service calls ───────────────────────────────────────────────────────────

// POST 16 kHz mono PCM to {sttBaseUrl}/audio/transcriptions; resolves to text.
export async function transcribe(pcm, settings) {
  const wav = encodeWav(pcm, 16000, 1, 16);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', settings.sttModel || 'whisper-1');

  const res = await fetch(`${baseUrlOf(settings.sttBaseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(settings.sttApiKey),
    body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = await res.json();
  return (json.text || '').trim();
}

// POST text to {ttsBaseUrl}/audio/speech; resolves to WAV bytes as an ArrayBuffer.
export async function synthesize(text, settings) {
  const res = await fetch(`${baseUrlOf(settings.ttsBaseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(settings.ttsApiKey) },
    body: JSON.stringify({
      model: settings.ttsModel || 'tts-1',
      voice: settings.ttsVoice || 'alloy',
      input: text,
      response_format: 'wav',
    }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  return res.arrayBuffer();
}
