const EMOTIONS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];

// Own only emotional weights; blinking and speech keep their existing channels.
// A face is a set of channel targets: one expression from apply(), or a blend
// of several from applyWeights().
export function createExpressionController() {
  let manager = null;
  const weights = new Map(), channels = new Map(), targets = new Map();
  function reset() {
    for (const name of weights.keys()) manager?.setValue(name, 0);
    weights.clear();
    targets.clear();
  }
  function aim(channel, strength) {
    targets.set(channel, strength);
    if (!weights.has(channel)) weights.set(channel, 0);
  }
  return {
    bind(next) {
      reset(); manager = next || null; channels.clear();
      for (const name of EMOTIONS) {
        // The bundled VRM 0 models store surprise as a custom capitalized name.
        const channel = manager?.getExpression(name) ? name
          : name === 'surprised' && manager?.getExpression('Surprised') ? 'Surprised' : null;
        if (channel) channels.set(name, channel);
      }
    },
    supported() { return manager ? ['neutral', ...channels.keys()] : []; },
    apply(command) {
      const { expression, intensity: strength = 0.8 } = command || {};
      if (!this.supported().includes(expression)) throw new Error('This character does not support that expression.');
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Invalid expression strength.');
      targets.clear();
      if (expression !== 'neutral') aim(channels.get(expression), strength);
      return { expression };
    },
    // A blend, as weights keyed by emotion name on a 0 to 1 scale. Channels
    // this character lacks are dropped, and an empty face returns to neutral.
    applyWeights(face) {
      targets.clear();
      const applied = {};
      for (const [name, channel] of channels) {
        const value = Number(face?.[name]);
        if (Number.isFinite(value) && value > 0) {
          applied[name] = Math.min(1, value);
          aim(channel, applied[name]);
        }
      }
      return { weights: applied };
    },
    update(delta) {
      if (!manager || !Number.isFinite(delta) || delta <= 0) return;
      const blend = 1 - Math.exp(-delta / 0.18);
      for (const [name, weight] of weights) {
        const value = weight + ((targets.get(name) ?? 0) - weight) * blend;
        manager.setValue(name, value < 0.001 ? 0 : value);
        if (value < 0.001 && !targets.has(name)) weights.delete(name);
        else weights.set(name, value);
      }
    },
    reset,
  };
}
