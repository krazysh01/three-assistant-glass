// Emotion classification in the browser, via transformers.js running the
// GoEmotions RoBERTa model as quantized ONNX (WebGPU where available, WASM
// otherwise). Loaded lazily from a CDN like the rest of the app's libraries.
//
// This runs client-side on purpose: the assistant is the product, and a
// deployment shared by several browsers should not funnel every reply through
// one server-side model. The ~125 MB download happens once per browser and is
// then served from the browser's cache, so it costs nothing unless the feature
// is switched on.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const MODEL_ID = 'SamLowe/roberta-base-go_emotions-onnx';

let loading = null;

// Resolves to a text-classification pipeline. Concurrent callers share one load.
export function loadClassifier(onProgress) {
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import(TRANSFORMERS_URL);
      const webgpu = !!navigator.gpu;
      return pipeline('text-classification', MODEL_ID, {
        dtype: 'q8', // the only ONNX weights this repo publishes
        device: webgpu ? 'webgpu' : 'wasm',
        progress_callback: onProgress,
      });
    })().catch((err) => {
      loading = null; // allow a retry next time
      throw err;
    });
  }
  return loading;
}

/**
 * Returns classify(text, signal) → [{ label, score }] over all 28 GoEmotions
 * labels. An empty string loads the model and resolves to null, which callers
 * use to warm up without classifying anything.
 *
 * Inference is serialized: the model is single-threaded and a queued call is
 * cheaper than two competing ones.
 */
export function createEmotionClassifier(onStatus) {
  let chain = Promise.resolve();

  return async (text, signal) => {
    signal?.throwIfAborted();
    const classifier = await loadClassifier((p) => {
      if (!signal?.aborted && p.status === 'progress' && p.file?.endsWith('.onnx')) {
        onStatus?.(`Loading expression model… ${Math.round(p.progress)}%`);
      }
    });
    signal?.throwIfAborted();
    if (!text) return null;

    const run = chain.then(() => {
      signal?.throwIfAborted();
      return classifier(text, { top_k: 28, truncation: true, max_length: 128 });
    });
    chain = run.catch(() => {});
    const scores = await run;
    signal?.throwIfAborted();
    return scores;
  };
}
