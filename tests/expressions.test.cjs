const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

test('expressions persist until explicit neutral, blend and leave speech and blink untouched', async () => {
  const { createExpressionController } = await load('assistant/expressions.js');
  const values = { aa: 0.5, blink: 0.7 };
  const face = createExpressionController();
  face.bind({ getExpression: n => ['happy', 'sad'].includes(n), setValue: (n, v) => values[n] = v });
  assert.equal(face.supported().join(','), 'neutral,happy,sad');
  face.apply({ expression: 'happy' });
  face.update(0.1);
  assert.ok(values.happy > 0 && values.happy < 0.8);
  face.apply({ expression: 'sad', intensity: 0.6 });
  const previous = values.happy;
  face.update(0.1);
  assert.ok(values.happy < previous && values.sad > 0);
  for (let i = 0; i < 40; i++) face.update(0.1);
  assert.equal(values.happy, 0);
  assert.ok(Math.abs(values.sad - 0.6) < 0.001);
  face.update(3600);
  assert.equal(values.sad, 0.6);
  face.apply({ expression: 'neutral' });
  face.update(0.1);
  assert.ok(values.sad > 0 && values.sad < 0.6);
  for (let i = 0; i < 40; i++) face.update(0.1);
  assert.equal(values.sad, 0);
  assert.equal(values.aa, 0.5);
  assert.equal(values.blink, 0.7);
  assert.throws(() => face.apply({ expression: 'angry' }));
  face.apply({ expression: 'happy' }); face.update(0.2);
  face.bind(null);
  assert.equal(values.happy, 0);
  assert.equal(face.supported().length, 0);
});


test('VRM 0 custom surprise is exposed as the standard surprised emotion', async () => {
  const { createExpressionController } = await load('assistant/expressions.js');
  const values = {}, face = createExpressionController();
  face.bind({ getExpression: name => name === 'Surprised', setValue: (name, value) => values[name] = value });
  assert.equal(face.supported().join(','), 'neutral,surprised');
  face.apply({ expression: 'surprised' }); face.update(1);
  assert.ok(values.Surprised > 0.7);
  face.reset(); assert.equal(values.Surprised, 0);
});

test('a blended face drives several channels, drops ones the character lacks, and clears to neutral', async () => {
  const { createExpressionController } = await load('assistant/expressions.js');
  const values = { aa: 0.4 }, face = createExpressionController();
  face.bind({ getExpression: n => ['happy', 'Surprised', 'sad'].includes(n), setValue: (n, v) => values[n] = v });
  const { weights } = face.applyWeights({ happy: 0.6, surprised: 0.3, angry: 0.5 });
  assert.deepEqual({ ...weights }, { happy: 0.6, surprised: 0.3 }, 'no angry channel on this character');
  for (let i = 0; i < 40; i++) face.update(0.1);
  assert.ok(Math.abs(values.happy - 0.6) < 0.001 && Math.abs(values.Surprised - 0.3) < 0.001);
  assert.equal(values.angry, undefined);
  face.apply({ expression: 'sad', intensity: 0.5 }); // a single expression replaces the blend
  for (let i = 0; i < 40; i++) face.update(0.1);
  assert.deepEqual([values.happy, values.Surprised, Math.round(values.sad * 100) / 100], [0, 0, 0.5]);
  face.applyWeights({});
  for (let i = 0; i < 40; i++) face.update(0.1);
  assert.equal(values.sad, 0);
  assert.equal(values.aa, 0.4, 'the mouth is not ours');
});
