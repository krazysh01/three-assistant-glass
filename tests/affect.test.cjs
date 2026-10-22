const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

const score = (label, value) => ({ label, score: value });
const ALL = ['neutral', 'happy', 'sad', 'angry', 'relaxed', 'surprised'];

test('every GoEmotions label has an affect reading, and readings collapse by confidence', async () => {
  const { LABEL_AFFECT, scoresToAffect } = await load('assistant/affect.js');
  assert.equal(Object.keys(LABEL_AFFECT).length, 28);
  const joy = scoresToAffect([score('joy', 0.9), score('sadness', 0.05)]);
  assert.equal(joy.family, 'joy');
  assert.equal(joy.label, 'joy');
  assert.ok(joy.v > 0.8, 'one confident label dominates a weak one');
  assert.equal(scoresToAffect([]), null);
  assert.equal(scoresToAffect([score('not-a-label', 0.9), score('joy', 0)]), null);
  assert.equal(scoresToAffect([{ label: 'joy', score: NaN }]), null);
});

test("the user's anger becomes the character's concern, not anger back", async () => {
  const { scoresToAffect, empathize } = await load('assistant/affect.js');
  const user = scoresToAffect([score('anger', 0.9)]);
  const felt = empathize(user);
  assert.ok(felt.v < 0 && felt.v > user.v, 'still unhappy, but less so');
  assert.ok(user.d > 0 && felt.d < 0, 'backs off instead of squaring up');
  assert.ok(felt.a < user.a);
  assert.equal(user.family, 'anger');
  assert.equal(felt.family, 'sad', 'so the face and pose read as concern');
  assert.equal(empathize(scoresToAffect([score('confusion', 0.9)])).family, 'interest');
  const joy = empathize(scoresToAffect([score('joy', 0.9)]));
  assert.ok(joy.v > 0.8, 'delight is mirrored');
});

test('repeated readings pull the mood towards them without inflating it', async () => {
  const { createMood, scoresToAffect } = await load('assistant/affect.js');
  const mood = createMood();
  const joy = scoresToAffect([score('joy', 0.9)]);
  for (let i = 0; i < 50; i++) mood.observe(joy, 0.6);
  const value = mood.value();
  assert.ok(value.valence <= joy.v + 1e-9, 'the cumulative reply text cannot push past the reading');
  assert.ok(value.valence > 0.85);
  assert.equal(value.family, 'joy');
  assert.ok(value.familyWeight <= 1);
});

test('the mood settles back to calm, arousal first', async () => {
  const { createMood, scoresToAffect } = await load('assistant/affect.js');
  const mood = createMood();
  mood.observe(scoresToAffect([score('excitement', 0.95)]), 0.9);
  const start = mood.value();
  for (let i = 0; i < 9 * 60; i++) mood.update(1 / 60); // one arousal half-life
  const later = mood.value();
  assert.ok(Math.abs(later.arousal - 0.25) < Math.abs(start.arousal - 0.25) * 0.55);
  assert.ok(later.valence / start.valence > 0.7, 'valence lingers longer');
  for (let i = 0; i < 300; i++) mood.update(1);
  assert.ok(Math.abs(mood.value().valence) < 0.01);
  assert.equal(mood.value().family, 'neutral');
  mood.update(-1); mood.update(NaN); // ignored
  mood.observe(null); mood.observe(scoresToAffect([score('joy', 0.9)]), 0);
  assert.equal(mood.value().family, 'neutral');
});

test('the face is chosen from channels the character has, with neutral below the threshold', async () => {
  const { createMood, scoresToAffect, resolveExpression } = await load('assistant/affect.js');
  const feel = (label, weight = 0.8) => {
    const mood = createMood();
    mood.observe(scoresToAffect([score(label, 0.9)]), weight);
    return mood.value();
  };
  assert.equal(resolveExpression(feel('joy'), ALL).expression, 'happy');
  assert.equal(resolveExpression(feel('anger'), ALL).expression, 'angry');
  assert.equal(resolveExpression(feel('surprise'), ALL).expression, 'surprised');
  assert.equal(resolveExpression(feel('relief'), ALL).expression, 'relaxed');
  assert.equal(resolveExpression(feel('joy', 0.05), ALL).expression, 'neutral', 'a faint feeling shows nothing');
  // VRM has no fear channel: alarm when keyed up, else unhappiness.
  assert.equal(resolveExpression(feel('fear'), ALL).expression, 'surprised');
  assert.equal(resolveExpression(feel('fear'), ['neutral', 'sad']).expression, 'sad');
  // A missing channel falls back along valence instead of going blank.
  assert.equal(resolveExpression(feel('relief'), ['neutral', 'happy']).expression, 'happy');
  assert.equal(resolveExpression(feel('surprise'), ['neutral', 'happy']).expression, 'neutral');
  assert.equal(resolveExpression(feel('joy'), []).expression, 'neutral');
  const strong = resolveExpression(feel('joy'), ALL);
  assert.ok(strong.intensity > 0.5 && strong.intensity <= 0.9);
});

test('a near-tie keeps the face it already had', async () => {
  const { createMood, scoresToAffect, resolveExpression } = await load('assistant/affect.js');
  const mood = createMood();
  mood.observe(scoresToAffect([score('sadness', 0.9)]), 0.5);
  mood.observe(scoresToAffect([score('joy', 0.9)]), 0.4);
  const tied = mood.value();
  assert.equal(tied.family, 'joy');
  assert.ok(tied.familyWeight - tied.runnerUp < 0.1, 'joy only just leads');
  assert.equal(resolveExpression(tied, ALL, 'sad').expression, 'sad');
  assert.equal(resolveExpression(tied, ALL, 'neutral').expression, 'happy');
  mood.observe(scoresToAffect([score('joy', 0.9)]), 0.5);
  assert.equal(resolveExpression(mood.value(), ALL, 'sad').expression, 'happy', 'a clear win switches');
});

test('a new feeling displaces an older one at once, instead of waiting for it to fade', async () => {
  const { createMood, scoresToAffect, empathize, resolveFace } = await load('assistant/affect.js');
  // Good news, a delighted reply classified twice as it streams, then bad news
  // eight seconds later, weighted as the engine weights them.
  const mood = createMood();
  const user = (label, s) => { const r = scoresToAffect([score(label, s)]); mood.observe(empathize(r), 0.55 * r.confidence); };
  const reply = (label, s) => { const r = scoresToAffect([score(label, s)]); mood.observe(r, 0.7 * r.confidence); };
  user('excitement', 0.92); mood.update(2.5);
  reply('joy', 0.9); mood.update(2);
  reply('joy', 0.88);
  assert.ok(mood.value().familyWeight < 1, 'a reclassified reply no longer piles up to the limit');
  mood.update(7.5);
  let face = resolveFace(mood.value(), ALL, 'happy');
  assert.equal(face.expression, 'happy');
  user('sadness', 0.85); // "but it means moving away from my family"
  face = resolveFace(mood.value(), ALL, face.expression);
  assert.equal(face.expression, 'sad', 'the smile gives way before the reply');
  assert.equal(face.weights.happy, undefined);
  // A neutral reading calms whatever is held.
  const before = mood.value().familyWeight;
  mood.observe(scoresToAffect([score('neutral', 0.9)]), 0.6);
  assert.ok(mood.value().familyWeight < before * 0.7);
});

test('a fading mood eases the face out instead of dropping it', async () => {
  const { createMood, scoresToAffect, resolveFace } = await load('assistant/affect.js');
  const mood = createMood();
  mood.observe(scoresToAffect([score('joy', 0.9)]), 0.8);
  const shown = [];
  for (let t = 0; t <= 60; t += 0.5) {
    shown.push(resolveFace(mood.value(), ALL, 'happy').weights.happy || 0);
    mood.update(0.5);
  }
  assert.ok(shown[0] > 0.8, 'starts strong');
  assert.equal(shown.at(-1), 0, 'ends neutral');
  const steepest = Math.max(...shown.slice(1).map((value, i) => shown[i] - value));
  // It used to hold about 0.42 and then fall to nothing in one step.
  assert.ok(steepest < 0.05, `largest drop per half second was ${steepest.toFixed(3)}`);
});

test('two feelings held at once blend, the leading one stronger, never past a full face', async () => {
  const { createMood, scoresToAffect, resolveFace, describeFace } = await load('assistant/affect.js');
  const mood = createMood();
  mood.observe(scoresToAffect([score('excitement', 0.9)]), 0.7);
  mood.observe(scoresToAffect([score('surprise', 0.9)]), 0.6);
  const face = resolveFace(mood.value(), ALL);
  assert.deepEqual(Object.keys(face.weights).sort(), ['happy', 'surprised']);
  assert.equal(face.expression, 'surprised', 'the newer feeling leads');
  assert.ok(face.weights.surprised > face.weights.happy);
  assert.ok(face.weights.happy >= 0.15, 'and the delight still shows');
  assert.ok(face.weights.happy + face.weights.surprised <= 1 + 1e-9);
  assert.equal(face.intensity, face.weights.surprised);
  assert.match(describeFace(face.weights), /^surprised 0\.\d\d \+ happy 0\.\d\d$/);
  assert.equal(describeFace({}), 'neutral');
  // A character without the second channel gets the leading one alone.
  assert.deepEqual(Object.keys(resolveFace(mood.value(), ['neutral', 'happy']).weights), ['happy']);
});

test('a smile is never paired with sadness or anger', async () => {
  const { createMood, scoresToAffect, resolveFace } = await load('assistant/affect.js');
  for (const other of ['sadness', 'anger']) {
    for (const [first, second] of [['joy', other], [other, 'joy']]) {
      for (const secondWeight of [0.3, 0.45, 0.6]) {
        const mood = createMood();
        mood.observe(scoresToAffect([score(first, 0.9)]), 0.7);
        mood.observe(scoresToAffect([score(second, 0.9)]), secondWeight);
        const { weights } = resolveFace(mood.value(), ALL);
        assert.ok(Object.keys(weights).length > 0, `${first} then ${second}: a face shows`);
        assert.ok(!(weights.happy && (weights.sad || weights.angry)), `${first} then ${second} at ${secondWeight}: ${JSON.stringify(weights)}`);
      }
    }
  }
  const calm = createMood(); // a sad face can still carry calm: sympathy, not a grimace
  calm.observe(scoresToAffect([score('sadness', 0.9)]), 0.7);
  calm.observe(scoresToAffect([score('caring', 0.9)]), 0.5);
  assert.deepEqual(Object.keys(resolveFace(calm.value(), ALL).weights).sort(), ['relaxed', 'sad']);
});
