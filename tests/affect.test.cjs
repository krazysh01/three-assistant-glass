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
  mood.observe(scoresToAffect([score('joy', 0.9)]), 0.5);
  mood.observe(scoresToAffect([score('sadness', 0.9)]), 0.55);
  const tied = mood.value();
  assert.equal(tied.family, 'sad');
  assert.equal(resolveExpression(tied, ALL, 'happy').expression, 'happy');
  assert.equal(resolveExpression(tied, ALL, 'neutral').expression, 'sad');
  mood.observe(scoresToAffect([score('sadness', 0.9)]), 0.5);
  assert.equal(resolveExpression(mood.value(), ALL, 'happy').expression, 'sad', 'a clear win switches');
});
