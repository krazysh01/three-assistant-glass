const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./browser-modules.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// Just enough of three.js's mixer to test against, with its fading semantics:
// effective weight = weight × a fade that runs linearly over mixer time, and
// fadeOut() always runs its fade from 1 — which is what makes a naive second
// crossfade pop a half-faded clip back to full weight.
function fakeThree() {
  const mixers = [];
  class Action {
    constructor(clip, mixer) { Object.assign(this, { clip, mixer, weight: 1, enabled: true, running: false, fade: null, loop: null }); }
    reset() { this.enabled = true; this.fade = null; return this; }
    setLoop(mode, count) { this.loop = { mode, count }; return this; }
    setEffectiveTimeScale() { return this; }
    setEffectiveWeight(weight) { this.weight = weight; this.fade = null; return this; }
    getEffectiveWeight() { return this.effective(); }
    effective() {
      if (!this.enabled) return 0;
      if (!this.fade) return this.weight;
      const { from, to, start, duration } = this.fade;
      const t = Math.min(1, (this.mixer.time - start) / duration);
      return this.weight * (from + (to - from) * t);
    }
    fadeIn(duration) { this.fade = { from: 0, to: 1, start: this.mixer.time, duration }; return this; }
    fadeOut(duration) { this.fade = { from: 1, to: 0, start: this.mixer.time, duration }; return this; }
    play() { this.running = true; return this; }
    stop() { this.running = false; this.fade = null; return this; }
  }
  class AnimationMixer {
    constructor(root) { this.root = root; this.time = 0; this.actions = new Map(); this.listeners = new Set(); mixers.push(this); }
    running() { return [...this.actions.values()].filter(action => action.running); }
    weight() { return this.running().reduce((sum, action) => sum + action.effective(), 0); }
    clipAction(clip) {
      if (!this.actions.has(clip)) this.actions.set(clip, new Action(clip, this));
      return this.actions.get(clip);
    }
    addEventListener(_type, fn) { this.listeners.add(fn); }
    removeEventListener(_type, fn) { this.listeners.delete(fn); }
    finish(action) { for (const fn of this.listeners) fn({ action }); }
    stopAllAction() { for (const action of this.actions.values()) action.stop(); }
    update(seconds) {
      this.time += seconds;
      for (const action of this.actions.values()) {
        if (action.fade && this.time >= action.fade.start + action.fade.duration) {
          const ended = action.fade.to;
          action.fade = null;
          if (ended === 0) action.enabled = false; // three.js disables a faded-out action
        }
      }
    }
  }
  class Vector3 { constructor() { this.y = 0; } }
  return { AnimationMixer, Vector3, LoopOnce: 'once', LoopRepeat: 'repeat', mixers };
}

function fakeVrm(hipsY = 0.9) {
  const pose = { reset: 0 };
  return {
    pose,
    scene: { getWorldPosition: (v) => { v.y = 0; return v; } },
    humanoid: {
      resetNormalizedPose: () => { pose.reset++; },
      getNormalizedBoneNode: () => ({ getWorldPosition: (v) => { v.y = pose.reset ? hipsY : 0.3; return v; } }),
    },
  };
}

async function harness() {
  const THREE = fakeThree();
  const loads = [], finished = [], errors = [];
  const loadClip = (url, vrm, options) => {
    const request = { url, vrm, options, ...deferred() };
    loads.push(request);
    return request.promise;
  };
  const { createAnimationPlayer } = await load('animation-player.js');
  const player = createAnimationPlayer({ THREE, loadClip }, {
    onFinished: name => finished.push(name), onError: (name, error) => errors.push({ name, error }),
  });
  // Resolves the newest pending load of a clip with a clip object.
  const ready = (name, clip = { name }) => {
    const request = loads.findLast(r => r.url.endsWith(`/${name}.fbx`) && !r.settled);
    request.settled = true;
    request.resolve(clip);
    return clip;
  };
  return { player, loads, finished, errors, ready, mixer: () => THREE.mixers.at(-1) };
}

test('the rest hip height is measured once, from the rest pose, and handed to every load', async () => {
  const h = await harness();
  const vrm = fakeVrm(0.92);
  h.player.bind(vrm);
  assert.equal(vrm.pose.reset, 1, 'reset to the rest pose before measuring');
  const playing = h.player.play({ clip: 'talking' });
  assert.equal(h.loads[0].url, 'animations/talking.fbx');
  assert.equal(h.loads[0].options.restHipsHeight, 0.92);
  h.loads[0].resolve({ name: 'talking' });
  assert.equal(await playing, true);
  assert.equal(h.player.current(), 'talking');
});

test('clips are cached per character, and a failed load is retried next time', async () => {
  const h = await harness();
  const first = fakeVrm();
  h.player.bind(first);
  const a = h.player.play({ clip: 'talking' }); h.loads[0].resolve({});
  await a;
  const again = h.player.play({ clip: 'talking' });
  assert.equal(h.loads.length, 1, 'served from the cache');
  await again;

  const failing = h.player.play({ clip: 'missing' });
  h.loads[1].reject(new Error('404'));
  await assert.rejects(failing, /404/);
  assert.deepEqual(h.errors.map(e => e.name), ['missing']);
  assert.equal(h.player.current(), 'talking', 'the previous clip carries on');
  const retry = h.player.play({ clip: 'missing' });
  assert.equal(h.loads.length, 3, 'a failed load is not cached');
  h.loads[2].resolve({}); await retry;

  h.player.bind(fakeVrm());
  void h.player.play({ clip: 'talking' });
  assert.equal(h.loads.length, 4, 'a new skeleton needs its own retargeted clip');
});

test('a slow load overtaken by a newer request, or by a new character, does not play', async () => {
  const h = await harness();
  h.player.bind(fakeVrm());
  const slow = h.player.play({ clip: 'talkingBig' });
  const fast = h.player.play({ clip: 'talking' });
  h.loads[1].resolve({}); assert.equal(await fast, true);
  h.loads[0].resolve({}); assert.equal(await slow, false);
  assert.equal(h.player.current(), 'talking');

  const stale = h.player.play({ clip: 'excited' });
  h.player.bind(fakeVrm());
  h.loads[2].resolve({});
  assert.equal(await stale, false);
  assert.equal(h.player.current(), null);
});

test('a second switch mid-crossfade fades from the current weight instead of popping', async () => {
  const h = await harness();
  h.player.bind(fakeVrm());
  const play = async (clip, fade) => { const done = h.player.play({ clip, fade }); h.ready(clip); return done; };
  await play('idle', 0.5);
  await play('talk', 0.4);
  h.player.update(0.2); // halfway through idle → talk
  const before = h.mixer().weight();
  await play('big', 0.4); // switch again before the first crossfade finished
  assert.ok(Math.abs(h.mixer().weight() - before) < 1e-6, 'the switch itself moves no weight');
  let previous = h.mixer().weight();
  for (let i = 0; i < 40; i++) {
    h.player.update(1 / 60);
    const total = h.mixer().weight();
    assert.ok(total <= 1 + 1e-6, `total weight ${total} stays normalised`);
    assert.ok(Math.abs(total - previous) < 0.05, 'no jump between frames');
    previous = total;
  }
  assert.deepEqual(h.mixer().running().map(a => a.clip.name), ['big'], 'the outgoing clips were stopped');
});

test('a one-shot reports its finish, and actions that faded out are stopped', async () => {
  const h = await harness();
  h.player.bind(fakeVrm());
  let done = h.player.play({ clip: 'idle' }); h.ready('idle'); await done;
  done = h.player.play({ clip: 'surprised', loop: 'once', fade: 0.2 });
  const clip = h.ready('surprised'); await done;
  const action = h.mixer().clipAction(clip);
  assert.deepEqual({ ...action.loop }, { mode: 'once', count: 1 });
  assert.equal(action.clampWhenFinished, true, 'holds the last frame until the graph moves on');
  assert.equal(h.mixer().running().length, 2, 'both run during the crossfade');
  h.player.update(0.3);
  assert.equal(h.mixer().running().length, 1, 'the faded-out idle was stopped');
  h.mixer().finish({ other: true });
  assert.deepEqual(h.finished, [], 'only the current clip reports');
  h.mixer().finish(action);
  assert.deepEqual(h.finished, ['surprised']);
});

test('a dropped file plays from its own URL, replacing a cached clip of the same name', async () => {
  const h = await harness();
  h.player.bind(fakeVrm());
  let done = h.player.play({ clip: 'wave' }); h.loads[0].resolve({}); await done;
  h.player.register('wave', 'blob:http://localhost/1234');
  done = h.player.play({ clip: 'wave' });
  assert.equal(h.loads[1].url, 'blob:http://localhost/1234');
  h.loads[1].resolve({}); await done;
});

test('preloading warms clips one at a time and stops for a new character', async () => {
  const h = await harness();
  h.player.bind(fakeVrm());
  const warming = h.player.preload(['a', 'b', 'c']);
  assert.equal(h.loads.length, 1, 'one at a time');
  h.loads[0].resolve({}); await tick();
  assert.equal(h.loads.length, 2);
  h.player.bind(fakeVrm());
  h.loads[1].resolve({}); await warming;
  assert.equal(h.loads.length, 2, 'stopped when the character changed');
  assert.equal(h.player.isLoaded('a'), false, 'the new character has its own cache');
});
