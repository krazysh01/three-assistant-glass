// Shapes speech loudness into how far the mouth opens.
//
// Loudness arrives as the speaker's mouthLevel(): the RMS of the playing audio
// times four, capped at 1. Measured on a Kokoro voice, half of speech sits
// below 0.27 and nine tenths below 0.53, so a linear mapping left the mouth
// about a quarter open on typical speech and never fully open. A curve opens
// the mouth on normal speech (0.27 becomes 0.68 with the defaults), a gain
// sets how wide, and the release is eased so the mouth does not snap shut
// between syllables. Both are tuned per avatar under Settings → Features → Lip
// sync.

export const MOUTH_DEFAULTS = { mouthGain: 1.5, mouthCurve: 0.6 };
export const MOUTH_RANGES = { mouthGain: [0.5, 3], mouthCurve: [0.3, 1] };

// How fast the mouth may close, in full openings per second.
const RELEASE_PER_SECOND = 6;

// A setting as a number within its slider's range, or the default when it is
// missing or not a number.
export function mouthSetting(settings, key) {
  const raw = settings?.[key];
  const value = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(value)) return MOUTH_DEFAULTS[key];
  const [low, high] = MOUTH_RANGES[key];
  return Math.min(high, Math.max(low, value));
}

// getSettings is read on every step, so changed settings apply at once.
export function createMouth(getSettings) {
  let open = 0;
  return {
    // Advances by `seconds` towards the opening for `level` (0 to 1) and returns it.
    drive(level, seconds) {
      const settings = getSettings?.() || {};
      const gain = mouthSetting(settings, 'mouthGain');
      const curve = mouthSetting(settings, 'mouthCurve');
      const target = Math.min(1, Math.pow(Math.max(0, Number(level) || 0), curve) * gain);
      const dt = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      open = target >= open ? target : Math.max(target, open - dt * RELEASE_PER_SECOND);
      return open;
    },
    // Shut at once, for the end of a session.
    close() { open = 0; },
  };
}
