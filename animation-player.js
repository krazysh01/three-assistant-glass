// Plays the animation graph's commands on a VRM: one persistent mixer per
// character, clips loaded on first use and cached, and crossfades between
// them instead of the hard cut a fresh mixer per clip used to make.
//
// THREE and the clip loader are injected, which keeps this file free of bare
// imports and lets main.js decide where clips come from.

const BASE_URL = 'animations/';

/**
 * @param deps.THREE the three.js namespace (AnimationMixer, LoopOnce, LoopRepeat)
 * @param deps.loadClip (url, vrm, { restHipsHeight }) → Promise<AnimationClip>
 * @param hooks.onFinished(name) a one-shot clip reached its end
 * @param hooks.onError(name, error) a clip failed to load
 */
export function createAnimationPlayer({ THREE, loadClip }, hooks = {}) {
  const caches = new WeakMap(); // vrm → Map<name, Promise<clip>>
  let vrm = null, mixer = null, restHipsHeight = undefined;
  let current = null;           // { name, action }
  let fading = [];              // actions fading out, stopped once silent
  const started = new Set();    // every action this player has set running
  const urls = new Map();       // name → URL, for clips that are not in animations/
  let request = 0;              // the newest play() wins when loads finish out of order
  let preloading = null;

  function cache() {
    let entries = caches.get(vrm);
    if (!entries) caches.set(vrm, entries = new Map());
    return entries;
  }

  function clipFor(name) {
    const entries = cache();
    if (!entries.has(name)) {
      const url = urls.get(name) || `${BASE_URL}${name}.fbx`;
      const loading = loadClip(url, vrm, { restHipsHeight });
      // A failed load is forgotten so the next request tries again.
      loading.catch(() => { if (entries.get(name) === loading) entries.delete(name); });
      entries.set(name, loading);
    }
    return entries.get(name);
  }

  function onMixerFinished(event) {
    if (current && event.action === current.action) hooks.onFinished?.(current.name);
  }

  // Each outgoing action fades from the weight it has right now. fadeOut()
  // alone always starts from full weight, so a second switch in the middle of
  // a crossfade would snap the half-faded clip back to full and pop the pose.
  function fadeOutOthers(keep, seconds) {
    for (const action of started) {
      if (action === keep) continue;
      const weight = action.enabled ? action.getEffectiveWeight() : 0;
      if (weight <= 0.001 || seconds <= 0) {
        action.stop();
        started.delete(action);
        continue;
      }
      action.setEffectiveWeight(weight);
      action.fadeOut(seconds);
      if (!fading.includes(action)) fading.push(action);
    }
  }

  return {
    // A new character: a fresh mixer bound to its skeleton, and its rest hip
    // height measured once. loadMixamoAnimation scales hip motion by that
    // height; measured mid-animation, a kneeling clip would make every clip
    // loaded after it float or sink.
    bind(next) {
      if (mixer) {
        mixer.stopAllAction();
        mixer.removeEventListener('finished', onMixerFinished);
      }
      request++;
      preloading = null;
      current = null;
      fading = [];
      started.clear();
      vrm = next || null;
      mixer = null;
      restHipsHeight = undefined;
      if (!vrm) return;
      vrm.humanoid?.resetNormalizedPose?.();
      const hips = vrm.humanoid?.getNormalizedBoneNode?.('hips');
      if (hips) {
        const hipsY = hips.getWorldPosition(new THREE.Vector3()).y;
        const rootY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
        restHipsHeight = Math.abs(hipsY - rootY);
      }
      mixer = new THREE.AnimationMixer(vrm.scene);
      mixer.addEventListener('finished', onMixerFinished);
    },

    /**
     * Crossfade to a clip. Resolves true once it is playing, false when a
     * newer request or a new character overtook it, and rejects when the clip
     * could not be loaded (the previous clip carries on in that case).
     */
    async play({ clip: name, loop = 'repeat', fade = 0.4 }) {
      if (!vrm || !name) return false;
      const id = ++request, target = vrm;
      let clip;
      try {
        clip = await clipFor(name);
      } catch (error) {
        if (id === request && target === vrm) hooks.onError?.(name, error);
        throw error;
      }
      if (id !== request || target !== vrm || !mixer) return false;

      const action = mixer.clipAction(clip);
      const once = loop === 'once';
      action.reset();
      action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      action.clampWhenFinished = once;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(1);
      fading = fading.filter((other) => other !== action);

      const first = !current;
      fadeOutOthers(action, first ? 0 : fade);
      if (!first && fade > 0) action.fadeIn(fade);
      action.play();
      started.add(action);
      current = { name, action };
      return true;
    },

    // A clip from somewhere other than animations/, such as a dropped file.
    register(name, url) {
      urls.set(name, url);
      if (vrm) cache().delete(name); // a same-named clip must not shadow it
    },

    // Warm the cache one clip at a time, so the first emotional moment does
    // not wait on a multi-megabyte download. FBX parsing blocks the main
    // thread, so `gap` milliseconds between clips keeps the hitches apart.
    // Stops if the character changes or another preload starts.
    async preload(names, { gap = 0 } = {}) {
      const target = vrm;
      const run = {};
      preloading = run;
      for (const name of names) {
        if (preloading !== run || vrm !== target || !vrm) return;
        try { await clipFor(name); } catch { /* reported when actually played */ }
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
    },

    update(seconds) {
      if (!mixer) return;
      mixer.update(seconds);
      if (fading.length) {
        fading = fading.filter((action) => {
          if (action === current?.action) return false;
          // three.js disables an action once its fade-out reaches zero.
          if (action.enabled && action.getEffectiveWeight() > 0) return true;
          action.stop();
          started.delete(action);
          return false;
        });
      }
    },

    current: () => current?.name ?? null,
    isLoaded: (name) => !!vrm && cache().has(name),
  };
}
