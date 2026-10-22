const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
// Objects from the module's VM context have their own prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const calm = { valence: 0, arousal: 0.25, dominance: 0, family: 'neutral', familyWeight: 0 };
const delighted = { valence: 0.8, arousal: 0.85, dominance: 0.3, family: 'joy', familyWeight: 0.8 };
const cross = { valence: -0.6, arousal: 0.8, dominance: 0.5, family: 'anger', familyWeight: 0.8 };
const sad = { valence: -0.6, arousal: 0.3, dominance: -0.3, family: 'sad', familyWeight: 0.7 };

async function graph(options = {}) {
  const { createAnimationGraph, POOLS, REACTIONS, EXCLUDED, SPEAKING_GRACE } = await load('assistant/animation-graph.js');
  const g = createAnimationGraph({ base: 'animations/idleFemale.fbx', random: () => 0, ...options });
  const commands = [];
  // Advance in frames, collecting every command the player would receive.
  const run = (seconds, step = 1 / 60) => {
    for (let t = 0; t < seconds - 1e-9; t += step) {
      const command = g.update(step);
      if (command) commands.push(command);
    }
    return commands.at(-1);
  };
  return { g, commands, run, POOLS, REACTIONS, EXCLUDED, SPEAKING_GRACE };
}

test('the first frame plays the configured idle, and phases drive the pose', async () => {
  const { g, commands, run } = await graph();
  run(0.1);
  assert.deepEqual(plain(commands[0]), { clip: 'idleFemale', loop: 'repeat', fade: 0.5, state: 'idle' });
  g.setPhase('thinking'); run(2);
  assert.equal(g.inspect().state, 'thinking');
  assert.equal(commands.at(-1).clip, 'thoughtfulHeadShake');
  g.setPhase('speaking'); run(1);
  assert.equal(commands.at(-1).state, 'speaking');
  assert.match(commands.at(-1).clip, /^talking|TalkingShort/);
});

test('a speech queue that drains mid-reply does not flap the talking pose', async () => {
  const { g, commands, run, SPEAKING_GRACE } = await graph();
  g.setPhase('speaking'); run(1);
  const talking = commands.length;
  // onEnd then onStart again a little later, as when synthesis lags playback.
  g.setPhase('listening'); run(SPEAKING_GRACE * 0.6);
  g.setPhase('speaking'); run(2);
  assert.equal(commands.length, talking, 'no crossfade away and back');
  assert.equal(g.inspect().state, 'speaking');
  // A real end of speech lands once the grace runs out.
  g.setPhase('listening'); run(SPEAKING_GRACE + 0.2);
  assert.equal(g.inspect().state, 'listening');
});

test('the mood picks the clip within a phase', async () => {
  const angry = await graph();
  angry.g.setMood(cross); angry.g.setPhase('speaking'); angry.run(1);
  assert.match(angry.commands.at(-1).clip, /talkingArguing|talkingYelling/);

  const happy = await graph();
  happy.g.setMood(delighted); happy.g.setPhase('speaking'); happy.run(1);
  assert.match(happy.commands.at(-1).clip, /excited|talkingBig/);

  const down = await graph();
  down.g.setMood(sad); down.g.setPhase('idle'); down.run(1.5);
  assert.equal(down.commands.at(-1).clip, 'thoughtfulHeadShake');
});

test('a clip that still fits is kept while the mood drifts, and replaced once it stops fitting', async () => {
  let roll = 0;
  const { g, commands, run } = await graph({ random: () => (roll = (roll + 0.37) % 1) });
  g.setMood(delighted); g.setPhase('speaking'); run(1);
  const first = commands.at(-1).clip;
  const before = commands.length;
  // Small drift every frame for ten seconds: no churn between equal clips.
  for (let i = 0; i < 600; i++) {
    g.setMood({ ...delighted, valence: 0.8 - (i % 10) * 0.005 });
    const command = g.update(1 / 60);
    if (command) commands.push(command);
  }
  assert.equal(commands.length, before, `kept ${first} while the mood drifted`);
  g.setMood(cross); run(2);
  assert.match(commands.at(-1).clip, /talkingArguing|talkingYelling/);
});

test('a gesture plays once and returns to the phase the conversation is in now', async () => {
  const { g, commands, run } = await graph();
  g.setPhase('thinking'); run(1);
  assert.equal(g.react('sympathy'), true);
  run(0.1);
  assert.deepEqual(plain(commands.at(-1)), { clip: 'thoughtfulHeadShake', loop: 'once', fade: 0.22, state: 'reacting' });
  g.setPhase('listening'); // the phase moves on while the gesture plays
  g.clipFinished('thoughtfulHeadShake'); run(0.1);
  assert.equal(commands.at(-1).state, 'listening');
});

test('gestures do not stack or start over speech, except forced ones', async () => {
  const { g, commands, run } = await graph();
  g.setPhase('listening'); run(1);
  assert.equal(g.react('surprise'), true);
  assert.equal(g.react('joy'), false, 'one gesture at a time');
  run(0.1); g.clipFinished(); run(0.1);
  g.setPhase('speaking'); run(1);
  assert.equal(g.react('joy'), false, 'would cut the talking pose off');
  assert.equal(g.react('greeting', { force: true }), true);
  run(0.1);
  assert.equal(commands.at(-1).clip, 'greeting');
  run(3); // a forced gesture plays out in full over speech
  assert.equal(g.inspect().state, 'reacting');
  g.clipFinished('greeting'); run(0.1);
  assert.equal(g.inspect().state, 'speaking');
});

test('an unforced gesture gives way soon after speech starts, and a lost finish cannot strand it', async () => {
  const { g, run, REACTIONS } = await graph();
  g.setPhase('thinking'); run(1);
  g.react('surprise'); run(0.1);
  g.setPhase('speaking'); run(1.5);
  assert.equal(g.inspect().state, 'speaking');

  const other = await graph();
  other.g.setPhase('listening'); other.run(1);
  other.g.react('surprise'); other.run(0.1);
  other.run(7); // the player never reports the finish
  assert.equal(other.g.inspect().state, 'listening');
  assert.ok(REACTIONS.surprise.length);
});

test('a closing beat waits for speech to really end, and an interruption cancels it', async () => {
  const { g, commands, run, SPEAKING_GRACE } = await graph();
  g.setPhase('speaking'); run(1);
  assert.equal(g.react('gratitude', { afterSpeech: true }), true);
  run(1);
  assert.equal(g.inspect().state, 'speaking');
  g.setPhase('listening'); run(SPEAKING_GRACE + 0.1);
  assert.equal(commands.at(-1).clip, 'thankful');

  const interrupted = await graph();
  interrupted.g.setPhase('speaking'); interrupted.run(1);
  interrupted.g.react('joy', { afterSpeech: true });
  interrupted.g.setPhase('listening');
  interrupted.g.cancelClosing(); // the user barged in
  interrupted.run(SPEAKING_GRACE + 0.5);
  assert.equal(interrupted.commands.some((c) => c.state === 'reacting'), false);
});

test('a manual pick holds until the next phase, and can be any clip', async () => {
  const { g, commands, run } = await graph();
  g.setPhase('listening'); run(1);
  g.setOverride('animations/danceRumba.fbx'); run(0.1);
  assert.equal(commands.at(-1).clip, 'danceRumba');
  g.setMood(delighted); run(30);
  assert.equal(commands.at(-1).clip, 'danceRumba', 'the machine does not fight the pick');
  g.setPhase('thinking'); run(1);
  assert.equal(commands.at(-1).clip, 'thoughtfulHeadShake');
});

test('pools never choose excluded clips, and only clips the server has', async () => {
  const { g, run, POOLS, EXCLUDED } = await graph();
  for (const pool of Object.values(POOLS)) {
    for (const candidate of pool) assert.equal(EXCLUDED.has(candidate.clip), false, candidate.clip);
  }
  g.setLibrary({ available: ['idleFemale.fbx', 'talking.fbx'] });
  g.setMood(delighted);
  g.setPhase('speaking');
  const seen = new Set();
  for (let i = 0; i < 600; i++) { const c = g.update(1 / 30); if (c) seen.add(c.clip); }
  assert.deepEqual([...seen], ['talking']);
  assert.equal(g.react('joy'), false, 'no joy gesture is available');
});

test('a long stillness earns a fidget that suits the mood, then the pose returns', async () => {
  const { g, commands, run } = await graph({ random: () => 0.5 });
  run(1.5);
  assert.equal(commands.at(-1).clip, 'idleFemale');
  run(42); // 30 s, stretched by the random factor to 45 s
  assert.equal(commands.at(-1).clip, 'idleFemale', 'not yet');
  run(3);
  assert.deepEqual(plain(commands.at(-1)), { clip: 'armStretching', loop: 'once', fade: 0.22, state: 'reacting' });
  g.clipFinished('armStretching'); run(0.1);
  assert.equal(commands.at(-1).clip, 'idleFemale');

  const tense = await graph({ random: () => 0 });
  tense.g.setMood({ valence: -0.4, arousal: 0.6, dominance: -0.3, family: 'fear', familyWeight: 0.5 });
  tense.run(31);
  assert.equal(tense.commands.at(-1).clip, 'nervousLookAround');
});

test('a new character re-issues the pose', async () => {
  const { g, commands, run } = await graph();
  run(1);
  const count = commands.length;
  g.invalidate(); run(0.1);
  assert.equal(commands.length, count + 1);
  assert.equal(commands.at(-1).clip, 'idleFemale');
});
