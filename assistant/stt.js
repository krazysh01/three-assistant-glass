// Speech-to-text adapters. Every adapter exposes the same surface:
//   start(), stop(), setSuppressed(bool)
// and reports through hooks: onUtterance(text), onInterim(text),
// onSpeechStart(), onSpeechCancel(), onStatus(text), onError(err) for a
// recoverable failure, and onFatal(err) for one that has ended listening.
//
//   openai  → Silero VAD segments speech in the browser, then the utterance
//             goes straight to the configured /audio/transcriptions endpoint
//   browser → Chrome's Web Speech API (zero install, audio goes to Google)

import { createMicVad } from './vad.js';
import { floatToPcm16, transcribe } from '../speech.mjs';

export function createStt(settings, hooks) {
  const provider = settings.sttProvider || 'openai';
  return provider === 'browser' ? browserStt(settings, hooks) : serverStt(settings, hooks);
}

// ─── VAD + OpenAI-compatible transcription ───────────────────────────────────

function serverStt(settings, hooks) {
  let vad = null;
  let suppressed = false;
  let session = null;

  return {
    async start() {
      const controller = new AbortController();
      session = controller;
      const active = () => session === controller && !controller.signal.aborted;
      hooks.onStatus?.('Loading voice detection…');
      try {
        const instance = await createMicVad({
          signal: controller.signal,
          onSpeechStart: () => {
            if (active() && !suppressed) hooks.onSpeechStart?.();
          },
          onSpeechEnd: async (audio) => {
            if (!active() || suppressed) return;
            hooks.onStatus?.('Transcribing…');
            try {
              const text = await transcribe(floatToPcm16(audio), settings, { signal: controller.signal });
              if (!active() || suppressed) return;
              if (text) hooks.onUtterance(text);
              else hooks.onSpeechCancel?.();
            } catch (err) {
              if (!active()) return;
              hooks.onSpeechCancel?.();
              hooks.onError?.(err);
            }
          },
          onMisfire: () => { if (active()) hooks.onSpeechCancel?.(); },
        });
        // MicVAD.new starts capture before resolving. Dispose late arrivals.
        if (!active()) { await instance.destroy(); return; }
        vad = instance;
      } catch (err) {
        if (active()) throw err;
      }
    },
    stop() {
      session?.abort();
      session = null;
      vad?.destroy();
      vad = null;
    },
    setSuppressed(value) {
      suppressed = value;
    },
  };
}

// ─── Web Speech API ───────────────────────────────────────────────────────────

function browserStt(settings, hooks) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let active = false;
  let suppressed = false;
  let restartTimer = null;

  function listen() {
    if (!active) return;
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.assistantLanguage || navigator.language;

    recognition.onresult = (event) => {
      if (!active || suppressed) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          hooks.onUtterance(text);
        } else {
          hooks.onSpeechStart?.();
          hooks.onInterim?.(text);
        }
      }
    };
    recognition.onerror = (event) => {
      if (!active) return;
      if (event.error === 'not-allowed') {
        // Nothing will be heard again this session, and onend must not restart.
        active = false;
        hooks.onFatal?.(new Error('Microphone permission denied'));
      }
      // 'no-speech' / 'aborted' are routine; onend restarts us
    };
    // Chrome ends continuous sessions after a while - keep listening
    recognition.onend = () => {
      if (active) {
        hooks.onSpeechCancel?.();
        restartTimer = setTimeout(listen, 200);
      }
    };
    recognition.start();
  }

  return {
    async start() {
      if (!Recognition) {
        throw new Error('Web Speech API is not available in this browser — use Chrome, or pick another speech-to-text provider.');
      }
      active = true;
      listen();
    },
    stop() {
      active = false;
      clearTimeout(restartTimer);
      recognition?.abort();
      recognition = null;
    },
    setSuppressed(value) {
      suppressed = value;
    },
  };
}
