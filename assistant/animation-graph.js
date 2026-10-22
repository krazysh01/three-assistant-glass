// The body: which clip the character should be playing, and when to change.
//
// A small state machine over the conversation's phases — idle, listening,
// thinking, speaking — with a one-shot `reacting` state layered on top for
// gestures. Each state owns a pool of clips, and the mood from affect.js
// decides which clip in the pool fits: the same "speaking" phase is `talking`
// when calm, `talkingBig` when delighted and `talkingArguing` when cross.
//
// Pure logic. It is handed the clip names a character has and a frame delta,
// and returns commands; playing them is animation-player.js's job. Nothing
// here imports three.js, so the whole machine is testable headlessly.

// Clips the pools never choose by themselves. Mixamo clips with root motion
// walk the character out of frame, exercise loops read as nonsense in a
// conversation, and talkingOnPhone is 7.6 MB for a pose that looks like a
// different call. A manual pick from the dropdown can still play any of them.
const EXCLUDED = new Set([
  'entry', 'jump', 'catwalkIdleToTwistRight', 'danceBboyHipHop', 'danceHipHop',
  'danceRumba', 'situps', 'jumpingJacks', 'layingFemalePose', 'talkingOnPhone',
  'buttonPushing', 'idleDrunk',
]);

// A candidate reads: play `clip` when the mood is inside this box. `weight` is
// its pull once it qualifies, so a close match beats a merely adequate one.
// 'base' is the idle chosen in Settings.
const POOLS = {
  idle: [
    { clip: 'base', weight: 1.0 },
    { clip: 'idleHappy', weight: 2.2, families: ['joy', 'gratitude'], minValence: 0.25 },
    { clip: 'nervousLookAround', weight: 2.0, families: ['fear', 'anger', 'confusion'], maxValence: -0.1 },
    { clip: 'thoughtfulHeadShake', weight: 1.6, families: ['sad', 'confusion'], maxArousal: 0.6 },
    { clip: 'armStretching', weight: 0.5, maxArousal: 0.35 },
    { clip: 'idleMale', weight: 0.6 },
    { clip: 'idleFemale', weight: 0.6 },
  ],
  // Listening has to stay still enough to read as attention, so it borrows the
  // idle poses rather than gesturing over the user.
  listening: [
    { clip: 'base', weight: 1.0 },
    { clip: 'idleHappy', weight: 2.0, families: ['joy', 'gratitude'], minValence: 0.2 },
    { clip: 'thoughtfulHeadShake', weight: 1.8, families: ['interest', 'confusion', 'sad'] },
    { clip: 'nervousLookAround', weight: 2.0, families: ['fear'], maxDominance: 0 },
    { clip: 'idleFemale', weight: 0.5 },
  ],
  thinking: [
    { clip: 'thoughtfulHeadShake', weight: 2.4 },
    { clip: 'nervousLookAround', weight: 1.6, minArousal: 0.55, maxValence: 0 },
    { clip: 'armStretching', weight: 0.6, maxArousal: 0.35 },
    { clip: 'base', weight: 0.8 },
  ],
  speaking: [
    { clip: 'talking', weight: 1.2 },
    { clip: 'talkingMale', weight: 0.8 },
    { clip: 'TalkingShort', weight: 1.0, maxArousal: 0.45 },
    { clip: 'talkingBig', weight: 2.0, minValence: 0.25, minArousal: 0.5 },
    { clip: 'talkingBig', weight: 1.4, minDominance: 0.4 },
    { clip: 'excited', weight: 2.4, families: ['joy'], minValence: 0.4, minArousal: 0.7 },
    { clip: 'talkingSinging', weight: 0.8, families: ['joy'], minValence: 0.55, minArousal: 0.65 },
    { clip: 'talkingRapping', weight: 0.5, families: ['joy'], minArousal: 0.8 },
    { clip: 'talkingTellingSecret', weight: 1.6, maxArousal: 0.42, maxDominance: 0.2 },
    { clip: 'talkingArguing', weight: 2.0, families: ['anger'], minDominance: 0.1 },
    { clip: 'talkingYelling', weight: 2.2, families: ['anger'], minArousal: 0.7, minDominance: 0.3 },
  ],
};

// One-shot gestures, keyed by the kind of moment that earns one.
const REACTIONS = {
  surprise: ['surprised'],
  joy: ['excited', 'victory', 'flair'],
  gratitude: ['thankful'],
  anger: ['angry'],
  sad: ['defeated', 'rejected'],
  fear: ['nervousLookAround'],
  confusion: ['thoughtfulHeadShake'],
  // Responses to the user rather than feelings of the character's own: an
  // "oh no" head shake for bad news, and being taken aback by hostility.
  sympathy: ['thoughtfulHeadShake'],
  alarm: ['nervousLookAround', 'surprised'],
  greeting: ['greeting', 'salute'],
  emphasis: ['pointForward'],
  dismissal: ['dismissingGesture'],
  plea: ['praying'],
};

// Seconds a clip must hold before another may replace it, so a phase that
// flaps cannot start a crossfade it immediately reverses.
const MIN_DWELL = { idle: 1.2, listening: 0.8, thinking: 0.6, speaking: 0.5, reacting: 0.25 };

// Leaving `speaking` waits this long. The TTS queue empties whenever synthesis
// falls behind playback, firing onEnd mid-reply; without the grace the talking
// clip would crossfade to idle and straight back on every slow sentence.
const SPEAKING_GRACE = 0.8;

// Crossfade seconds, by the state being entered.
const FADE = { idle: 0.5, listening: 0.45, thinking: 0.4, speaking: 0.4, reacting: 0.22, out: 0.35 };

// How often a running clip is checked against a mood that may have moved.
const RECHECK = 0.75;

// A long stretch with nothing happening earns a fidget: a one-shot such as a
// stretch or a glance around, after which the pose returns. People waiting
// shift and fidget; a loop that never changes reads as a frozen mannequin.
// The wait is between this and twice this, so the rhythm never shows.
const FIDGET_AFTER = { idle: 30, listening: 40 };
const FIDGETS = [
  { clip: 'armStretching', weight: 1.0, maxArousal: 0.45, minValence: -0.2 },
  { clip: 'nervousLookAround', weight: 1.2, maxValence: -0.1 },
  { clip: 'thoughtfulHeadShake', weight: 1.0, families: ['sad', 'confusion', 'interest'] },
];

// Once speech starts, an unforced reaction gets this long to land before the
// talking pose takes over. A gesture the character was in the middle of reads
// fine; one that keeps going over a whole sentence does not.
const REACTION_SPEECH_CUTOFF = 1.2;

// Backstop for a one-shot whose finish is never reported, so the character
// cannot be stranded in a gesture pose.
const REACTION_TIMEOUT = 6;

// Anything within this much of the best score is an equally fair choice.
const VIABLE_MARGIN = 0.25;

const PHASES = ['idle', 'listening', 'thinking', 'speaking'];

const strip = (name) => String(name || '').replace(/^.*[\\/]/, '').replace(/\.fbx$/i, '');

// How well a candidate fits the mood: null when the mood is outside its box,
// else a score from its weight, how strongly the mood holds its family, and how
// specific its box is.
function fit(candidate, mood) {
  const { valence = 0, arousal = 0.25, dominance = 0, family = 'neutral', familyWeight = 0 } = mood || {};
  if (candidate.minValence !== undefined && valence < candidate.minValence) return null;
  if (candidate.maxValence !== undefined && valence > candidate.maxValence) return null;
  if (candidate.minArousal !== undefined && arousal < candidate.minArousal) return null;
  if (candidate.maxArousal !== undefined && arousal > candidate.maxArousal) return null;
  if (candidate.minDominance !== undefined && dominance < candidate.minDominance) return null;
  if (candidate.maxDominance !== undefined && dominance > candidate.maxDominance) return null;

  let score = candidate.weight;
  if (candidate.families) {
    if (!candidate.families.includes(family)) return null;
    // A family the mood barely holds should not outrank a safe general clip.
    score *= 0.4 + familyWeight * 0.6;
  }
  const specificity = ['minValence', 'maxValence', 'minArousal', 'maxArousal', 'minDominance', 'maxDominance']
    .filter((key) => candidate[key] !== undefined).length;
  return score + specificity * 0.15;
}

/**
 * @param options.base the configured idle clip, which stands in for 'base'.
 * @param options.random injected for tests.
 *
 * setLibrary({ available }) narrows the pools to clips the server actually
 * has, so a trimmed animations/ folder degrades quietly instead of erroring.
 */
export function createAnimationGraph(options = {}) {
  const random = options.random || Math.random;
  let base = strip(options.base) || 'idleFemale';
  let available = null; // null until told; everything is allowed meanwhile

  let state = 'idle';       // idle | listening | thinking | speaking | reacting
  let phase = 'idle';       // the conversation phase, also underneath a reaction
  let clip = null;          // what the player was last told to run
  let mood = null;
  let elapsed = 0;          // seconds in the current state
  let sinceChange = 0;      // seconds since the clip last changed
  let sinceCheck = 0;       // seconds since the mood was last checked
  let pendingPhase = null;  // a phase waiting out the speaking grace
  let pendingFor = 0;
  let pendingReaction = null;
  let afterSpeech = null;   // a gesture waiting for the character to stop talking
  let reactionForced = false;
  let reactionFor = 0;
  let reactionDone = false;
  let speakingFor = 0;      // seconds of speech since a reaction began
  let override = null;      // a manual pick from the animation dropdown
  let fidgetAt = null;      // seconds of stillness before the next fidget
  let fidgeting = true;     // off when body language is: the idle then stays put

  const resolve = (name) => (name === 'base' ? base : name);
  const playable = (name) => {
    const resolved = resolve(name);
    if (!resolved || EXCLUDED.has(resolved)) return false;
    return !available || available.has(resolved);
  };

  const poolFor = (forState) => POOLS[forState] || POOLS.idle;

  // A pool scored against the current mood, best first.
  function rank(pool) {
    const scored = [];
    for (const candidate of pool) {
      if (!playable(candidate.clip)) continue;
      const score = fit(candidate, mood);
      if (score === null) continue;
      const name = resolve(candidate.clip);
      // 'base' and an explicit idleFemale can be the same clip, and a pool may
      // list one clip under two mood boxes: keep the better score.
      const existing = scored.find((entry) => entry.name === name);
      if (existing) existing.score = Math.max(existing.score, score);
      else scored.push({ name, score });
    }
    return scored.sort((x, y) => y.score - x.score);
  }

  function viable(pool) {
    const scored = rank(pool);
    if (!scored.length) return [];
    return scored.filter((entry) => entry.score >= scored[0].score - VIABLE_MARGIN).map((entry) => entry.name);
  }

  // A fair pick for the state. Picking at random among equally good clips
  // keeps a long conversation from looking canned; `avoid` is the clip just
  // played, skipped when there is anything else.
  function choose(forState, avoid = null) {
    let names = viable(poolFor(forState));
    if (!names.length) return playable('base') ? base : clip || base;
    if (avoid && names.length > 1) names = names.filter((name) => name !== avoid);
    return names[Math.floor(random() * names.length) % names.length];
  }

  // A replacement only when the running clip has stopped fitting. Keeping any
  // clip that is still viable is the hysteresis: the mood drifts every frame,
  // and re-rolling among equal choices would churn crossfades for nothing.
  function better(forState) {
    const names = viable(poolFor(forState));
    if (!names.length || names.includes(clip)) return null;
    return choose(forState);
  }

  function enter(nextState, nextClip, fade, loop = 'repeat') {
    state = nextState;
    clip = nextClip;
    elapsed = sinceChange = sinceCheck = 0;
    fidgetAt = null;
    return { clip: nextClip, loop, fade, state: nextState };
  }

  // A fidget that suits the mood, or null when none does.
  function fidget() {
    const names = viable(FIDGETS).filter((name) => name !== clip);
    return names.length ? names[Math.floor(random() * names.length) % names.length] : null;
  }

  return {
    // The conversation's phase. Anything unrecognised counts as idle.
    setPhase(next) {
      const wanted = PHASES.includes(next) ? next : 'idle';
      // Leaving speech waits out the grace period. Coming back to speech within
      // it cancels the departure, and any other change resolves immediately.
      if (phase === 'speaking' && wanted !== 'speaking') {
        if (pendingPhase === null) pendingFor = 0;
        pendingPhase = wanted;
        return;
      }
      pendingPhase = null;
      if (wanted === phase) return;
      phase = wanted;
      override = null; // a new phase ends a manual pick
    },

    setMood(next) {
      mood = next || null;
    },

    /**
     * Fire a one-shot gesture, then return to the phase's pose. Returns
     * whether it will play. Gestures do not stack, and do not start over
     * speech, which they would cut off mid-sentence.
     *
     * @param opts.force for deliberate moments such as the greeting, which
     *   play out in full even over speech.
     * @param opts.afterSpeech hold the gesture until the character finishes
     *   talking — a closing beat on an emotional reply. The latest one wins.
     */
    react(kind, opts = {}) {
      const { force = false, afterSpeech: later = false } = opts;
      const names = (REACTIONS[kind] || []).filter((name) => !available || available.has(name));
      if (!names.length) return false;
      const name = names[Math.floor(random() * names.length) % names.length];
      if (later && phase === 'speaking') {
        afterSpeech = name;
        return true;
      }
      if (!force && (state === 'reacting' || pendingReaction || phase === 'speaking')) return false;
      pendingReaction = name;
      reactionForced = force;
      return true;
    },

    // A manual pick from the dropdown, honoured until the next phase change so
    // the machine does not fight someone testing a clip. Any clip is allowed.
    setOverride(name) {
      override = name ? strip(name) : null;
      if (!override && state !== 'reacting') clip = null; // re-pick next frame
    },

    // Clip names the server has, and the configured idle.
    setLibrary({ available: names, base: idle } = {}) {
      if (Array.isArray(names)) available = new Set(names.map(strip));
      if (idle) base = strip(idle);
    },

    /**
     * The user took the turn. The reply they interrupted gets no closing beat
     * (a cheer over someone talking reads as not listening), and a departure
     * from speech lands now: the grace exists for the queue draining between
     * sentences, which cannot happen once the user has spoken. Without this,
     * the gesture reacting to what they said would be refused as arriving
     * "during speech" and dropped.
     */
    turnTaken() {
      afterSpeech = null;
      if (pendingPhase !== null) {
        phase = pendingPhase;
        pendingPhase = null;
        override = null;
      }
    },

    // Whether a long stillness earns a fidget. Off, the idle never moves.
    setFidgeting(on) {
      fidgeting = on !== false;
      fidgetAt = null;
    },

    // The player reporting that a one-shot clip finished.
    clipFinished(name) {
      if (state === 'reacting' && (!name || strip(name) === clip)) reactionDone = true;
    },

    // Forget what is playing so the next update re-issues a command, for when
    // the player lost its clips (a new character was loaded).
    invalidate() {
      clip = null;
      if (state === 'reacting') { state = phase; reactionDone = false; }
    },

    /**
     * Advances the machine by `seconds` and returns the command the player
     * should run, or null when nothing should change. Call it every frame.
     */
    update(seconds) {
      const dt = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      elapsed += dt;
      sinceChange += dt;
      sinceCheck += dt;
      if (pendingPhase !== null) pendingFor += dt;

      // The speaking grace ran out without speech resuming: the change lands,
      // and a closing beat saved for this moment gets its turn.
      if (pendingPhase !== null && pendingFor >= SPEAKING_GRACE) {
        phase = pendingPhase;
        pendingPhase = null;
        override = null;
        if (afterSpeech && state !== 'reacting') {
          pendingReaction = afterSpeech;
          reactionForced = false;
        }
        afterSpeech = null;
      }

      // A manual pick wins outright while it stands.
      if (override) {
        if (clip === override) return null;
        return enter(state === 'reacting' ? phase : state, override, FADE.out);
      }

      if (pendingReaction) {
        const name = pendingReaction;
        pendingReaction = null;
        reactionFor = speakingFor = 0;
        reactionDone = false;
        return enter('reacting', name, FADE.reacting, 'once');
      }

      if (state === 'reacting') {
        reactionFor += dt;
        if (phase === 'speaking') speakingFor += dt;
        const cut = !reactionForced && speakingFor >= REACTION_SPEECH_CUTOFF;
        if (!reactionDone && !cut && reactionFor < REACTION_TIMEOUT) return null;
        reactionDone = false;
        return enter(phase, choose(phase, clip), FADE.out);
      }

      if (!clip) return enter(phase, choose(phase), FADE[phase] ?? FADE.out);

      if (state !== phase) {
        if (elapsed < (MIN_DWELL[state] ?? 0.5)) return null;
        return enter(phase, choose(phase, clip), FADE[phase] ?? FADE.out);
      }

      if (sinceChange < (MIN_DWELL[state] ?? 0.5)) return null;

      // A long stillness earns a fidget, and the mood is followed if it moved.
      if (fidgeting && FIDGET_AFTER[state] !== undefined) {
        fidgetAt ??= FIDGET_AFTER[state] * (1 + random());
        if (sinceChange >= fidgetAt) {
          const name = fidget();
          if (name) {
            reactionFor = speakingFor = 0;
            reactionDone = reactionForced = false;
            return enter('reacting', name, FADE.reacting, 'once');
          }
          fidgetAt += FIDGET_AFTER[state];
        }
      }
      if (sinceCheck >= RECHECK) {
        sinceCheck = 0;
        const next = better(state);
        if (next && next !== clip) return enter(state, next, FADE[state] ?? FADE.out);
      }
      return null;
    },

    reset() {
      state = phase = 'idle';
      clip = mood = override = pendingPhase = pendingReaction = afterSpeech = null;
      elapsed = sinceChange = sinceCheck = pendingFor = reactionFor = speakingFor = 0;
      reactionDone = reactionForced = false;
      fidgetAt = null;
    },

    // For tests and the debug handle.
    inspect() {
      return { state, phase, clip, override, pendingPhase };
    },
  };
}

export { POOLS, REACTIONS, FIDGETS, EXCLUDED, SPEAKING_GRACE, REACTION_SPEECH_CUTOFF };
