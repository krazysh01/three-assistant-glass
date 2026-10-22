// The character's feelings, as data and arithmetic.
//
// Three jobs live here, all pure: what the 28 GoEmotions labels mean as
// feeling (valence/arousal/dominance plus a coarse family), how the *user's*
// feelings translate into the character's own, and how that state settles back
// towards calm over time.
//
// No model, no three.js, no DOM: the emotion engine and the animation graph
// both depend on this, and both are tested headlessly.

// Valence (-1 miserable … 1 delighted), arousal (0 still … 1 keyed up),
// dominance (-1 cowed … 1 commanding), and the family used to pick a face and
// a body pose. The numbers are judged by how the pose should read on screen,
// not taken from published affect norms.
export const LABEL_AFFECT = {
  admiration:     { v:  0.70, a: 0.45, d:  0.10, family: 'joy' },
  amusement:      { v:  0.80, a: 0.60, d:  0.20, family: 'joy' },
  anger:          { v: -0.80, a: 0.85, d:  0.60, family: 'anger' },
  annoyance:      { v: -0.50, a: 0.55, d:  0.35, family: 'anger' },
  approval:       { v:  0.50, a: 0.30, d:  0.25, family: 'calm' },
  caring:         { v:  0.60, a: 0.30, d:  0.20, family: 'calm' },
  confusion:      { v: -0.20, a: 0.45, d: -0.35, family: 'confusion' },
  curiosity:      { v:  0.35, a: 0.55, d:  0.05, family: 'interest' },
  desire:         { v:  0.40, a: 0.60, d:  0.15, family: 'interest' },
  disappointment: { v: -0.60, a: 0.30, d: -0.30, family: 'sad' },
  disapproval:    { v: -0.45, a: 0.45, d:  0.30, family: 'anger' },
  disgust:        { v: -0.70, a: 0.60, d:  0.35, family: 'anger' },
  embarrassment:  { v: -0.45, a: 0.60, d: -0.55, family: 'fear' },
  excitement:     { v:  0.85, a: 0.90, d:  0.35, family: 'joy' },
  fear:           { v: -0.75, a: 0.85, d: -0.60, family: 'fear' },
  gratitude:      { v:  0.75, a: 0.40, d:  0.05, family: 'gratitude' },
  grief:          { v: -0.90, a: 0.45, d: -0.55, family: 'sad' },
  joy:            { v:  0.90, a: 0.70, d:  0.35, family: 'joy' },
  love:           { v:  0.85, a: 0.50, d:  0.20, family: 'joy' },
  nervousness:    { v: -0.40, a: 0.70, d: -0.45, family: 'fear' },
  optimism:       { v:  0.65, a: 0.50, d:  0.30, family: 'joy' },
  pride:          { v:  0.75, a: 0.60, d:  0.55, family: 'joy' },
  realization:    { v:  0.15, a: 0.50, d:  0.10, family: 'surprise' },
  relief:         { v:  0.60, a: 0.25, d:  0.15, family: 'calm' },
  remorse:        { v: -0.60, a: 0.40, d: -0.45, family: 'sad' },
  sadness:        { v: -0.80, a: 0.30, d: -0.40, family: 'sad' },
  surprise:       { v:  0.15, a: 0.85, d: -0.10, family: 'surprise' },
  neutral:        { v:  0.00, a: 0.20, d:  0.00, family: 'neutral' },
};

// How the user's feeling becomes the character's. A companion mirrors delight
// and sinks a little at bad news, but meeting anger with anger is a bad
// listener: hostility is damped into concern, so valence stays low while
// dominance goes the other way and the body backs off instead of squaring up.
// Multipliers apply to the user's own affect, chosen by its family; `family`
// is what the character feels in turn, where that differs from the user's.
// Without it an angry user would still get an angry face and an arguing pose.
export const EMPATHY = {
  joy:       { v:  1.00, a: 0.80, d:  0.70 },
  gratitude: { v:  0.90, a: 0.70, d:  0.50 },
  calm:      { v:  0.90, a: 0.70, d:  0.60 },
  interest:  { v:  0.85, a: 0.90, d:  0.60 },
  surprise:  { v:  0.60, a: 1.00, d:  0.70 },
  confusion: { v:  0.50, a: 0.60, d: -0.20, family: 'interest' },
  sad:       { v:  0.70, a: 0.50, d: -0.25 },
  fear:      { v:  0.60, a: 0.60, d: -0.20, family: 'sad' },
  anger:     { v:  0.50, a: 0.60, d: -0.40, family: 'sad' },
};

// Which VRM expression channel a family asks for. There is no 'fear' channel
// in the VRM spec, so high arousal reads as alarm and the rest as unhappiness.
const FAMILY_EXPRESSION = {
  joy: 'happy', gratitude: 'happy', calm: 'relaxed', interest: 'relaxed',
  sad: 'sad', anger: 'angry', surprise: 'surprised', confusion: 'neutral', neutral: 'neutral',
};

const FAMILIES = Object.keys(EMPATHY);
const BASELINE = { v: 0, a: 0.25, d: 0 };

// Seconds for a feeling to half fade. Arousal settles first: being startled
// passes quickly, while a mood can colour a whole conversation.
const HALF_LIFE = { v: 22, a: 9, d: 16, family: 11 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/**
 * Collapses a classifier's label scores into one affect reading.
 *
 * GoEmotions is multi-label, so the scores are independent confidences: the
 * reading is their weighted centre of mass, and `confidence` is the strongest
 * recognised score — how much to believe the reading at all. Returns null when
 * nothing recognisable scored above zero.
 */
export function scoresToAffect(scores) {
  let weight = 0, v = 0, a = 0, d = 0, top = null, confidence = 0;
  const families = {};
  for (const entry of scores || []) {
    const affect = LABEL_AFFECT[entry?.label];
    const score = finite(entry?.score);
    if (!affect || score <= 0) continue;
    // Squaring favours one confident label over a spread of weak ones.
    const w = score * score;
    weight += w;
    v += affect.v * w;
    a += affect.a * w;
    d += affect.d * w;
    families[affect.family] = (families[affect.family] || 0) + score;
    if (score > confidence) { confidence = score; top = entry.label; }
  }
  if (!weight) return null;
  const family = Object.entries(families).sort((x, y) => y[1] - x[1])[0][0];
  return { v: v / weight, a: a / weight, d: d / weight, family, label: top, confidence };
}

// The user's reading, rewritten as the character's response to it.
export function empathize(affect) {
  if (!affect) return null;
  const gain = EMPATHY[affect.family] || EMPATHY.calm;
  return {
    ...affect,
    family: gain.family || affect.family,
    v: affect.v * gain.v, a: affect.a * gain.a, d: affect.d * gain.d,
  };
}

/**
 * The running mood: valence/arousal/dominance plus a decaying weight per
 * family. Those weights are what stop the chosen face and clip flickering
 * between two plausible feelings on every classification.
 *
 * observe() pulls the mood towards a reading instead of adding to it. The
 * assistant channel reclassifies its reply cumulatively, so the same sentence
 * arrives again and again; adding would inflate the mood without limit.
 */
export function createMood(options = {}) {
  const baseline = { ...BASELINE, ...(options.baseline || {}) };
  const halfLife = { ...HALF_LIFE, ...(options.halfLife || {}) };
  let v = baseline.v, a = baseline.a, d = baseline.d;
  const families = new Map();

  const pull = (current, target, weight) => current + (target - current) * weight;
  const fade = (seconds, life) => (life > 0 ? Math.pow(0.5, seconds / life) : 0);

  return {
    /**
     * @param affect a reading from scoresToAffect, already empathized when it
     *   came from the user.
     * @param weight 0…1, how far the mood moves towards it. Callers set this
     *   from the reading's confidence and which channel it arrived on.
     */
    observe(affect, weight = 0.5) {
      if (!affect) return null;
      const w = clamp(finite(weight), 0, 1);
      if (w === 0) return null;
      v = clamp(pull(v, clamp(finite(affect.v), -1, 1), w), -1, 1);
      a = clamp(pull(a, clamp(finite(affect.a), 0, 1), w), 0, 1);
      d = clamp(pull(d, clamp(finite(affect.d), -1, 1), w), -1, 1);
      const family = EMPATHY[affect.family] ? affect.family : 'neutral';
      if (family !== 'neutral') {
        families.set(family, clamp((families.get(family) || 0) + w, 0, 1));
      }
      return this.value();
    },

    // Settles everything towards calm. Called once a frame with that frame's
    // delta, so the face keeps easing off while the model is quiet.
    update(seconds) {
      const dt = finite(seconds);
      if (dt <= 0) return;
      v = baseline.v + (v - baseline.v) * fade(dt, halfLife.v);
      a = baseline.a + (a - baseline.a) * fade(dt, halfLife.a);
      d = baseline.d + (d - baseline.d) * fade(dt, halfLife.d);
      const familyFade = fade(dt, halfLife.family);
      for (const [family, weight] of families) {
        const next = weight * familyFade;
        if (next < 0.02) families.delete(family);
        else families.set(family, next);
      }
    },

    value() {
      let family = 'neutral', weight = 0;
      for (const [name, w] of families) if (w > weight) { family = name; weight = w; }
      let runnerUp = 0;
      for (const [name, w] of families) if (name !== family && w > runnerUp) runnerUp = w;
      return {
        valence: v, arousal: a, dominance: d,
        family, familyWeight: weight, runnerUp,
        // Distance from calm overall, used to pace the body.
        energy: clamp(Math.hypot(v, a - baseline.a) / 1.2, 0, 1),
      };
    },

    reset() {
      v = baseline.v; a = baseline.a; d = baseline.d;
      families.clear();
    },
  };
}

/**
 * The face to wear for a mood, limited to the channels this character has.
 * Most of the hysteresis lives in the mood's decaying family weights; here
 * `previous` only breaks a near-tie, so two plausible feelings do not swap
 * back and forth between classifications.
 */
export function resolveExpression(mood, supported = [], previous = 'neutral') {
  const can = (name) => supported.includes(name);
  const { family, familyWeight, runnerUp = 0, valence, arousal } = mood || {};
  if (!family || !(familyWeight > 0.12)) return { expression: 'neutral', intensity: 0 };

  let wanted = FAMILY_EXPRESSION[family] || 'neutral';
  if (family === 'fear') wanted = arousal > 0.7 && can('surprised') ? 'surprised' : 'sad';
  if (wanted === 'neutral' && valence > 0.3) wanted = 'relaxed';
  // Fall back along the family's own axis rather than snapping to neutral, so a
  // character with no 'relaxed' channel still looks pleased instead of blank.
  if (!can(wanted)) wanted = valence > 0.2 ? 'happy' : valence < -0.2 ? 'sad' : 'neutral';
  if (!can(wanted)) return { expression: 'neutral', intensity: 0 };

  const strength = clamp(0.3 + familyWeight * 0.45 + Math.abs(valence) * 0.25, 0, 0.9);
  // A runner-up family still close behind keeps the face it already had: a
  // 0.1 edge is noise from a single classification, not a change of feeling.
  if (previous && previous !== wanted && previous !== 'neutral' && can(previous)
    && runnerUp > 0.12 && familyWeight - runnerUp < 0.1
    && FAMILIES.some((name) => FAMILY_EXPRESSION[name] === previous)) {
    return { expression: previous, intensity: strength };
  }
  return { expression: wanted, intensity: strength };
}

export { FAMILIES, FAMILY_EXPRESSION };
