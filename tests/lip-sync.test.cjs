const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');

test('quiet speech still opens the mouth, and loud speech never past fully open', async () => {
  const { createMouth } = await load('lip-sync.js');
  const linear = createMouth(() => ({ mouthGain: 1, mouthCurve: 1 }));
  const shaped = createMouth(() => ({}));
  const quiet = 0.1; // a quiet syllable; typical speech has a median level of about 0.27
  assert.ok(Math.abs(linear.drive(quiet, 1 / 60) - 0.1) < 1e-9, 'gain 1, curve 1 is the raw level');
  assert.ok(shaped.drive(quiet, 1 / 60) > 0.35, 'the defaults open the mouth on normal speech');
  assert.equal(createMouth(() => ({})).drive(5, 1 / 60), 1);
  assert.equal(createMouth(() => ({})).drive(-1, 1 / 60), 0);
});

test('the mouth eases shut between syllables instead of snapping', async () => {
  const { createMouth } = await load('lip-sync.js');
  const mouth = createMouth(() => ({ mouthGain: 1, mouthCurve: 1 }));
  assert.equal(mouth.drive(0.8, 1 / 60), 0.8, 'opens at once');
  const next = mouth.drive(0, 1 / 60);
  assert.ok(Math.abs(next - 0.7) < 1e-9, 'closes at six openings a second');
  for (let i = 0; i < 20; i++) mouth.drive(0, 1 / 60);
  assert.equal(mouth.drive(0, 1 / 60), 0);
  mouth.drive(0.9, 1 / 60); mouth.close();
  assert.equal(mouth.drive(0, 0), 0, 'close() shuts at once, for the end of a session');
});

test('settings apply as they change, within the sliders\' range, with defaults for anything unusable', async () => {
  const { createMouth, mouthSetting, MOUTH_DEFAULTS } = await load('lip-sync.js');
  const settings = { mouthGain: 1, mouthCurve: 1 };
  const mouth = createMouth(() => settings);
  assert.equal(mouth.drive(0.2, 0), 0.2);
  settings.mouthGain = 2; // saved while the character talks
  assert.equal(mouth.drive(0.2, 0), 0.4);
  assert.equal(mouthSetting({ mouthGain: '2.5' }, 'mouthGain'), 2.5, 'saved as text is fine');
  assert.equal(mouthSetting({ mouthGain: 99 }, 'mouthGain'), 3);
  assert.equal(mouthSetting({ mouthCurve: 0 }, 'mouthCurve'), 0.3);
  for (const bad of ['', null, undefined, 'wide']) {
    assert.equal(mouthSetting({ mouthGain: bad }, 'mouthGain'), MOUTH_DEFAULTS.mouthGain, String(bad));
  }
});
