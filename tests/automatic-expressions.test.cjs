const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Must match the CDN URL assistant/emotions.js imports.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

test('emotion mapping uses confidence, neutral fallback and hysteresis', async () => {
  const { chooseExpression } = await load('assistant/automatic-expressions.js');
  const supported = ['neutral', 'happy', 'sad', 'angry'];
  const score = (label, score) => ({ label, score });
  assert.equal(chooseExpression([score('joy', 0.9)], supported).expression, 'happy');
  assert.equal(chooseExpression([score('anger', 0.2)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('surprise', 0.9)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('neutral', 0.8), score('joy', 0.6)], supported).expression, 'neutral');
  assert.equal(chooseExpression([score('sadness', 0.7), score('joy', 0.6)], supported, 'happy').expression, 'happy');
});

test('automatic expressions are opt-in, coalesce streaming text, and discard results after disable', async () => {
  const timers = new Map(); let id = 0;
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', {
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const requests = [], commands = []; let resolveScores, resets = 0;
  const face = createAutomaticExpressions({
    getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c), onExpressionReset: () => resets++,
  }, async text => { requests.push(text); if (text) return new Promise(resolve => { resolveScores = resolve; }); });
  const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
  face.transcript('That is wonderful news!', true); flush();
  assert.equal(requests.length, 0);
  await face.setEnabled(true);
  face.transcript('That is wonderful news!', true);
  face.transcript('That is wonderful news! I am so happy for you!');
  flush(); await tick();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /happy for you/);
  await face.setEnabled(false);
  resolveScores([{ label: 'joy', score: 0.9 }]); await tick();
  assert.equal(commands.length, 0);
  assert.ok(resets >= 2);
  face.transcript('Another happy sentence after disabling.'); flush();
  assert.equal(requests.length, 2);
});

test('a previous reply cannot change the face during a new reply', async () => {
  const timers = new Map(); let id = 0;
  const { createAutomaticExpressions } = await load('assistant/automatic-expressions.js', {
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  const commands = []; let finish;
  const face = createAutomaticExpressions({ getExpressions: () => ['neutral', 'happy'], onExpression: c => commands.push(c) },
    async text => text ? new Promise(resolve => { finish = resolve; }) : null);
  await face.setEnabled(true);
  face.transcript('A very happy first reply!', true);
  for (const fn of timers.values()) fn(); timers.clear();
  face.transcript('A completely different reply begins.', true);
  finish([{ label: 'joy', score: 0.9 }]); await tick();
  assert.equal(commands.length, 0);
  face.stop();
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
