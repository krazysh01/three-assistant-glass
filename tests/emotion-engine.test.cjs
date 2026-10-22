const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Must match the CDN URL assistant/emotions.js imports.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const ALL = ['neutral', 'happy', 'sad', 'angry', 'relaxed', 'surprised'];

// An engine with manual timers, a manual clock and a classifier whose answers
// the test hands out one request at a time.
async function harness({ supported = ALL } = {}) {
  const timers = new Map(); let id = 0, clock = 100000;
  const { createEmotionEngine, userReaction } = await load('assistant/emotion-engine.js', {
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
  });
  const requests = [], faces = [], reactions = [], statuses = []; let resets = 0;
  const classify = async (text, signal) => {
    if (!text) return null;
    return new Promise((resolve, reject) => {
      requests.push({ text, signal, resolve, reject });
    });
  };
  const engine = createEmotionEngine({
    getExpressions: () => supported,
    onFace: command => faces.push(JSON.parse(JSON.stringify(command))),
    onFaceReset: () => resets++,
    onReaction: (kind, options) => { reactions.push({ kind, ...JSON.parse(JSON.stringify(options)) }); return true; },
    onStatus: text => statuses.push(text),
  }, classify, { now: () => clock });
  const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
  const answer = async (index, scores) => { requests[index].resolve(scores); await tick(); };
  return {
    engine, requests, faces, reactions, statuses, flush, answer, userReaction,
    resets: () => resets, advance: ms => { clock += ms; },
  };
}

test('the engine is opt-in and classifies nothing until enabled', async () => {
  const h = await harness();
  h.engine.heard('That is wonderful news!');
  h.engine.spoke('I am so happy for you, truly!', true); h.flush();
  assert.equal(h.requests.length, 0);
  await h.engine.setEnabled(true);
  assert.equal(h.statuses.at(-1), 'Automatic expressions ready');
});

test("the user's utterance is classified at once, with no length floor, ahead of queued reply text", async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.spoke('Here is a long enough reply sentence.', true); h.flush();
  assert.equal(h.requests.length, 1, 'the reply is being classified');
  h.engine.spoke('Here is a long enough reply sentence. And another one.');
  h.engine.heard('Awful!'); // 6 characters: all signal
  await h.answer(0, [{ label: 'neutral', score: 0.9 }]);
  assert.equal(h.requests[1].text, 'Awful!', 'the user jumps the queue');
});

test('streaming reply text is coalesced, and an interrupted reply cannot steer the face', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.spoke('That is wonderful news!', true);
  h.engine.spoke('That is wonderful news! I am so happy for you!');
  h.flush(); await tick();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].text, /happy for you/);
  h.engine.spoke('A completely different reply begins.', true); // the old one was cut off
  await h.answer(0, [{ label: 'joy', score: 0.95 }]);
  assert.equal(h.faces.length, 0);
});

test("a user reading survives the reply starting, and the user's anger earns concern", async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.heard('This is outrageous, you ruined everything!');
  h.engine.spoke('I am so sorry, that sounds awful.', true); // the reply starts while classifying
  await h.answer(0, [{ label: 'anger', score: 0.92 }]);
  assert.notEqual(h.faces.at(-1).expression, 'angry', 'no anger mirrored back');
  assert.equal(h.faces.at(-1).expression, 'sad');
  assert.deepEqual(h.reactions, [{ kind: 'alarm' }]);
});

test('gestures at the user need a clear reading and a pause since the last one', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.heard('Wow, I did not expect that at all!');
  await h.answer(0, [{ label: 'surprise', score: 0.9 }]);
  h.engine.heard('I got the job!');
  await h.answer(1, [{ label: 'excitement', score: 0.9 }]);
  assert.deepEqual(h.reactions.map(r => r.kind), ['surprise'], 'cooldown');
  h.advance(9000);
  h.engine.heard('I am a bit sad today.');
  await h.answer(2, [{ label: 'sadness', score: 0.35 }]);
  assert.equal(h.reactions.length, 1, 'too vague to gesture at');
  h.engine.heard('My dog died.');
  await h.answer(3, [{ label: 'grief', score: 0.8 }]);
  assert.deepEqual(h.reactions.map(r => r.kind), ['surprise', 'sympathy']);
  assert.equal(h.userReaction({ family: 'calm' }), null, 'calm talk earns attention, not a gesture');
  assert.equal(h.userReaction({ family: 'joy', a: 0.4 }), null);
});

test('an emotional reply ends on one closing beat, held until speech ends', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.spoke('Congratulations, that is fantastic news!', true); h.flush();
  await h.answer(0, [{ label: 'joy', score: 0.9 }]);
  assert.equal(h.faces.at(-1).expression, 'happy');
  h.engine.replyEnded(); h.engine.replyEnded(); // the queue can drain twice
  assert.deepEqual(h.reactions, [{ kind: 'joy', afterSpeech: true }]);
  h.engine.spoke('And I am so proud of you, really!', true); h.flush();
  await h.answer(1, [{ label: 'joy', score: 0.9 }]);
  h.engine.replyEnded();
  assert.equal(h.reactions.length, 1, 'not after every reply');
  h.advance(21000);
  h.engine.spoke('That is just lovely to hear today.', true); h.flush();
  await h.answer(2, [{ label: 'neutral', score: 0.9 }]);
  h.engine.replyEnded();
  assert.equal(h.reactions.length, 1, 'a calm reply earns none');
});

test('results after disable are discarded, and the face resets', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.heard('That is wonderful news!');
  await h.engine.setEnabled(false);
  assert.equal(h.requests[0].signal.aborted, true);
  await h.answer(0, [{ label: 'joy', score: 0.9 }]);
  assert.equal(h.faces.length, 0);
  assert.ok(h.resets() >= 1);
  h.engine.heard('Another happy sentence after disabling.');
  assert.equal(h.requests.length, 1);
});

test('the face fades with the mood and stays within supported channels', async () => {
  const h = await harness({ supported: ['neutral', 'happy'] });
  await h.engine.setEnabled(true);
  h.engine.heard('You are a terrible listener and I hate this.');
  await h.answer(0, [{ label: 'anger', score: 0.9 }]);
  assert.ok(h.faces.every(f => ['neutral', 'happy'].includes(f.expression)));
  h.engine.heard('Oh that is brilliant, thank you so much!');
  await h.answer(1, [{ label: 'joy', score: 0.95 }]);
  h.engine.heard('Honestly this made my whole day!');
  await h.answer(2, [{ label: 'joy', score: 0.95 }]);
  assert.equal(h.faces.at(-1).expression, 'happy');
  const count = h.faces.length;
  for (let i = 0; i < 5; i++) h.engine.update(1 / 60);
  assert.equal(h.faces.length, count, 'not re-commanded every frame');
  for (let i = 0; i < 120; i++) h.engine.update(1);
  assert.equal(h.faces.at(-1).expression, 'neutral');
});

test('a classifier failure reports itself instead of throwing', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.heard('Hello there, how are you?');
  h.requests[0].reject(new Error('model crashed')); await tick();
  assert.equal(h.statuses.at(-1), 'Automatic expressions unavailable');
  h.engine.heard('Still here?');
  assert.equal(h.requests.length, 1, 'no further requests to a failed model');
});

test('the browser classifier loads once, warms up without classifying, and serializes calls', async () => {
  const progress = [];
  let imports = 0, running = 0, peak = 0;
  const pipeline = async (task, model, options) => {
    imports++;
    options.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', progress: 42 });
    return async (text) => {
      peak = Math.max(peak, ++running);
      await tick();
      running--;
      return [{ label: 'joy', score: 0.9, text }];
    };
  };
  const { createEmotionClassifier } = await load('assistant/emotions.js',
    { navigator: {} }, // no WebGPU: falls back to wasm
    { [TRANSFORMERS_URL]: { pipeline } });

  const classify = createEmotionClassifier(text => progress.push(text));
  assert.equal(await classify(''), null, 'an empty string only warms the model up');
  assert.equal(imports, 1);
  assert.match(progress[0], /42%/);

  const both = await Promise.all([classify('one'), classify('two')]);
  assert.equal(imports, 1, 'the model is loaded once and reused');
  assert.equal(peak, 1, 'inference is serialized');
  assert.deepEqual(both.map(r => r[0].text), ['one', 'two']);
});

test('a reaction to the user and the reply can show together as one blended face', async () => {
  const h = await harness();
  await h.engine.setEnabled(true);
  h.engine.heard('I got the job!');
  await h.answer(0, [{ label: 'excitement', score: 0.92 }]);
  h.engine.spoke('No way, I did not see that coming at all!', true); h.flush();
  await h.answer(1, [{ label: 'surprise', score: 0.9 }]);
  const face = h.faces.at(-1);
  assert.deepEqual(Object.keys(face.weights).sort(), ['happy', 'surprised']);
  assert.match(h.statuses.at(-1), /^Expression: surprised 0\.\d\d \+ happy 0\.\d\d$/);
});

// An engine whose classifier fails on demand, with every timer's delay recorded.
async function failingHarness() {
  const timers = new Map(), delays = []; let id = 0;
  const { createEmotionEngine } = await load('assistant/emotion-engine.js', {
    setTimeout: (fn, ms) => { timers.set(++id, fn); delays.push(ms); return id; },
    clearTimeout: key => timers.delete(key),
  });
  const state = { warmFailures: 0, warmCalls: 0, failNext: 0, requests: [], statuses: [] };
  const classify = async (text) => {
    if (!text) {
      state.warmCalls++;
      if (state.warmFailures > 0) { state.warmFailures--; throw new Error('model lost'); }
      return null;
    }
    state.requests.push(text);
    if (state.failNext > 0) { state.failNext--; throw new Error('device lost'); }
    return [{ label: 'joy', score: 0.9 }];
  };
  const engine = createEmotionEngine({ getExpressions: () => ['neutral', 'happy'], onStatus: t => state.statuses.push(t) }, classify);
  const flush = async () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); await tick(); await tick(); };
  return { engine, state, delays, timers, flush };
}

test('after a classifier failure it retries, further apart each time, and picks up where it left off', async () => {
  const h = await failingHarness();
  await h.engine.setEnabled(true);
  h.state.failNext = 1;
  h.engine.heard('That is great news!'); await tick();
  assert.equal(h.state.statuses.at(-1), 'Automatic expressions unavailable');
  h.state.warmFailures = 2; // the first two retries fail as well
  h.engine.heard('Are you still there?'); // waits for the model to come back
  await h.flush(); await h.flush(); await h.flush();
  assert.deepEqual(h.delays, [500, 1000, 2000]);
  assert.ok(h.state.statuses.includes('Automatic expressions ready'));
  assert.deepEqual(h.state.requests, ['That is great news!', 'Are you still there?']);
  assert.match(h.state.statuses.at(-1), /^Expression: happy/);
});

test('a model that never comes back is given up on after five tries, and turning off stops retrying', async () => {
  const h = await failingHarness();
  await h.engine.setEnabled(true);
  h.state.failNext = 1; h.state.warmFailures = Infinity;
  h.engine.heard('Hello there!'); await tick();
  for (let i = 0; i < 8; i++) await h.flush();
  assert.deepEqual(h.delays, [500, 1000, 2000, 4000, 8000]);
  assert.equal(h.state.warmCalls, 1 + 5);
  assert.equal(h.timers.size, 0, 'nothing left scheduled');

  const off = await failingHarness();
  await off.engine.setEnabled(true);
  off.state.failNext = 1;
  off.engine.heard('Hello there!'); await tick();
  assert.equal(off.timers.size, 1, 'a retry is scheduled');
  await off.engine.setEnabled(false);
  assert.equal(off.timers.size, 0, 'and cancelled when expressions are turned off');
});
