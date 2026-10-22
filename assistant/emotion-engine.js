// The emotion engine: reads feeling from both sides of the conversation and
// turns it into a face, a mood for the body, and the occasional gesture.
//
//   user      → heard(text)   each final utterance, classified at once and
//                             ahead of anything queued: the character's
//                             reaction should land while it is still thinking,
//                             before its reply starts.
//   assistant → spoke(text)   the reply as spoken so far, coalesced while it
//                             streams so the face follows the audio.
//
// Both channels run through the same in-browser GoEmotions classifier
// (emotions.js) into one mood (affect.js). The user's feelings are first
// rewritten as the character's response to them — sympathy for bad news, not
// a mirror of the user's anger. The classifier is an opt-in download; with it
// off the mood stays calm and the body still follows the conversation.
//
// Hooks: getExpressions() → channels the character has; onFace(face), where
// face.weights is every channel to show, keyed by name (a blend of up to two);
// onFaceReset(); onReaction(kind, opts); onStatus(text).

import { createEmotionClassifier } from './emotions.js';
import { createMood, scoresToAffect, empathize, resolveFace, describeFace } from './affect.js';

// The reply streams in sentence by sentence; waiting a beat lets a burst of
// sentences cost one classification rather than several.
const ASSISTANT_DEBOUNCE_MS = 350;
// Shorter reply text is mostly a greeting fragment and classifies as noise. No
// such floor for the user: "That's awful!" is 13 characters and all signal.
const ASSISTANT_MIN_CHARS = 16;
const CONTEXT_CHARS = 600;

// How far one reading moves the mood, times its confidence. The character's
// own words are its strongest signal; the user's feelings colour its mood
// rather than replace it.
const USER_WEIGHT = 0.55;
const ASSISTANT_WEIGHT = 0.7;
// Readings below this confidence are too vague to act on at all.
const MIN_CONFIDENCE = 0.3;

// A gesture in response to the user needs a clear reading, and a pause since
// the last one: a gesture at every utterance reads as a tic.
const REACT_CONFIDENCE = 0.45;
const REACT_COOLDOWN_MS = 8000;
// Ending a reply on a gesture is rarer still.
const CLOSING_CONFIDENCE = 0.6;
const CLOSING_COOLDOWN_MS = 20000;

// The face only changes when a channel's strength moves by this much: the
// mood decays every frame and the face would otherwise be re-commanded sixty
// times a second.
const FACE_EPSILON = 0.05;

// One classifier failure is usually a hiccup (a lost WebGPU device, a dropped
// download), not a dead model. Retry a few times, further apart each time,
// rather than leave expressions off for the rest of the session.
const RECOVERY_ATTEMPTS = 5;
const RECOVERY_BASE_MS = 500;
const RECOVERY_MAX_MS = 8000;

const NEUTRAL_FACE = () => ({ expression: 'neutral', intensity: 0, weights: {} });

function faceChanged(next, current) {
  if (next.expression !== current.expression) return true;
  const names = new Set([...Object.keys(next.weights), ...Object.keys(current.weights)]);
  for (const name of names) {
    if (Math.abs((next.weights[name] || 0) - (current.weights[name] || 0)) >= FACE_EPSILON) return true;
  }
  return false;
}

// The gesture for a reading of the user. Calm, interested and neutral talk
// earns none: listening attentively is the reaction.
export function userReaction(reading) {
  if (!reading) return null;
  switch (reading.family) {
    case 'surprise': return 'surprise';
    case 'joy': return reading.a >= 0.6 ? 'joy' : null;
    case 'gratitude': return 'gratitude';
    case 'sad': case 'fear': return 'sympathy';
    case 'anger': return 'alarm';
    case 'confusion': return 'confusion';
    default: return null;
  }
}

// The closing beat for a reply that carried a strong feeling of its own.
export function closingReaction(reading) {
  if (!reading) return null;
  switch (reading.family) {
    case 'joy': return 'joy';
    case 'gratitude': return 'gratitude';
    case 'sad': return 'sympathy';
    default: return null;
  }
}

export function createEmotionEngine(hooks = {}, classify, options = {}) {
  // Classification runs in this browser; see emotions.js. Tests inject their own.
  classify ||= createEmotionClassifier((text) => hooks.onStatus?.(text));
  const now = options.now || (() => Date.now());
  const mood = createMood(options.mood);

  let enabled = false, ready = false, busy = false;
  let controller = null;
  let generation = 0;              // bumped by enable/disable/reset: drops everything in flight
  let reply = 0;                   // bumped per reply: drops the previous reply's readings
  let userPending = null;          // latest unclassified utterance
  let assistantPending = null;     // { text, reply } latest unclassified reply text
  let assistantLast = '';
  let timer = null;
  let recovery = null;             // a pending retry after a classifier failure
  let face = NEUTRAL_FACE();
  let lastReactAt = -Infinity, lastClosingAt = -Infinity;
  let replyPeak = null;            // the reply's strongest reading so far
  let closedReply = -1;            // the reply whose closing beat was already taken

  function status(text) { hooks.onStatus?.(text); }

  function setFace(next, force = false) {
    if (!faceChanged(next, face) && !force) return;
    face = next;
    try { hooks.onFace?.(next); } catch (error) {
      // The character changed under us and lost a channel; neutral is safe.
      console.warn('[emotion] face rejected:', error.message);
      face = NEUTRAL_FACE();
    }
  }

  // Runs whether or not the classifier is on: with it off the mood is calm and
  // this settles on neutral once, then stays quiet.
  function refreshFace() {
    const supported = hooks.getExpressions?.() || [];
    if (!supported.length) return;
    setFace(resolveFace(mood.value(), supported, face.expression));
  }

  function warmedUp(version) {
    if (!enabled || generation !== version) return false;
    ready = true;
    status('Automatic expressions ready');
    pump();
    scheduleAssistant();
    return true;
  }

  function recover(version, attempt = 1) {
    if (!enabled || generation !== version || recovery || attempt > RECOVERY_ATTEMPTS) return;
    const delay = Math.min(RECOVERY_MAX_MS, RECOVERY_BASE_MS * 2 ** (attempt - 1));
    recovery = setTimeout(async () => {
      recovery = null;
      if (!enabled || generation !== version) return;
      try {
        await classify('', controller.signal);
        warmedUp(version);
      } catch {
        if (enabled && generation === version) recover(version, attempt + 1);
      }
    }, delay);
  }

  function clearTimer() {
    clearTimeout(timer);
    timer = null;
  }

  // Runs one classification at a time, the user's utterance always first.
  function pump() {
    if (!enabled || !ready || busy) return;
    if (userPending !== null) {
      const text = userPending;
      userPending = null;
      void run(text, 'user', reply);
      return;
    }
    if (assistantPending && !timer) {
      const { text, reply: id } = assistantPending;
      assistantPending = null;
      if (text === assistantLast) return;
      assistantLast = text;
      void run(text, 'assistant', id);
    }
  }

  function scheduleAssistant() {
    if (timer || !assistantPending) return;
    timer = setTimeout(() => { timer = null; pump(); }, ASSISTANT_DEBOUNCE_MS);
  }

  async function run(text, source, replyId) {
    const version = generation;
    busy = true;
    try {
      const scores = await classify(text, controller.signal);
      if (!enabled || generation !== version) return;
      // A reply that was interrupted must not keep steering the face.
      if (source === 'assistant' && replyId !== reply) return;
      absorb(scoresToAffect(scores), source, replyId);
    } catch (error) {
      if (enabled && generation === version) {
        console.warn('[emotion] classification failed:', error);
        ready = false;
        status('Automatic expressions unavailable');
        recover(version);
      }
    } finally {
      if (generation === version) {
        busy = false;
        pump();
        scheduleAssistant();
      }
    }
  }

  function absorb(reading, source, replyId) {
    if (!reading || reading.confidence < MIN_CONFIDENCE) return;
    const felt = source === 'user' ? empathize(reading) : reading;
    const weight = (source === 'user' ? USER_WEIGHT : ASSISTANT_WEIGHT) * reading.confidence;
    mood.observe(felt, weight);
    refreshFace();
    status(`Expression: ${describeFace(face.weights)}`);

    const at = now();
    if (source === 'user') {
      const kind = reading.confidence >= REACT_CONFIDENCE ? userReaction(reading) : null;
      if (kind && at - lastReactAt >= REACT_COOLDOWN_MS && hooks.onReaction?.(kind, {}) !== false) {
        lastReactAt = at;
      }
    } else if (replyId === reply && (!replyPeak || reading.confidence > replyPeak.confidence)) {
      replyPeak = reading;
    }
  }

  return {
    async setEnabled(value) {
      value = value === true;
      if (enabled === value) return;
      enabled = value;
      generation++;
      controller?.abort();
      controller = null;
      clearTimer();
      clearTimeout(recovery);
      recovery = null;
      busy = false;
      ready = false;
      userPending = assistantPending = null;
      assistantLast = '';
      status('');
      if (!enabled) {
        this.reset();
        return;
      }
      controller = new AbortController();
      const version = generation;
      status('Loading automatic expressions…');
      try {
        await classify('', controller.signal);
        warmedUp(version);
      } catch {
        if (enabled && generation === version) {
          status('Automatic expressions unavailable');
          recover(version);
        }
      }
    },

    isEnabled: () => enabled,

    // A final user utterance. It also ends whatever reply was running.
    heard(text) {
      const clean = String(text || '').trim();
      reply++;
      replyPeak = null;
      assistantPending = null;
      assistantLast = '';
      clearTimer();
      if (!enabled || clean.length < 2) return;
      userPending = clean.slice(-CONTEXT_CHARS);
      pump();
    },

    // The reply as spoken so far. `newReply` marks its first sentence.
    spoke(text, newReply = false) {
      if (newReply) {
        reply++;
        replyPeak = null;
        assistantLast = '';
      }
      if (!enabled) return;
      const context = String(text || '').trim().slice(-CONTEXT_CHARS);
      if (context.length < ASSISTANT_MIN_CHARS || context === assistantLast) return;
      assistantPending = { text: context, reply };
      clearTimer();
      scheduleAssistant();
    },

    /**
     * The character stopped talking. A reply that carried a strong feeling
     * may end on a gesture — once per reply, and not after every reply.
     * The speech queue can drain mid-reply, so the graph holds the gesture
     * until speech has really ended.
     */
    replyEnded() {
      if (!enabled || closedReply === reply || !replyPeak) return;
      if (replyPeak.confidence < CLOSING_CONFIDENCE) return;
      const kind = closingReaction(replyPeak);
      const at = now();
      if (!kind || at - lastClosingAt < CLOSING_COOLDOWN_MS) return;
      if (hooks.onReaction?.(kind, { afterSpeech: true }) === false) return;
      closedReply = reply;
      lastClosingAt = at;
    },

    // Per frame: the mood settles towards calm and the face eases with it.
    update(seconds) {
      mood.update(seconds);
      refreshFace();
      return mood.value();
    },

    mood: () => mood.value(),

    // Forget the conversation's feelings; the face returns to neutral.
    reset() {
      clearTimer();
      userPending = assistantPending = null;
      assistantLast = '';
      reply++;
      replyPeak = null;
      mood.reset();
      face = NEUTRAL_FACE();
      hooks.onFaceReset?.();
    },

    stop() { void this.setEnabled(false); },

    // Push a reading straight into the mood, bypassing the classifier. For the
    // debug handle and tests; the label scores look like the classifier's.
    inject(source, scores) {
      const wasEnabled = enabled;
      enabled = true;
      try { absorb(scoresToAffect(scores), source === 'user' ? 'user' : 'assistant', reply); } finally { enabled = wasEnabled; }
      return mood.value();
    },
  };
}
