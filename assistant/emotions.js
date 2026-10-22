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
let loaded = null; // the pipeline `loading` resolved to

// Resolves to a text-classification pipeline. Concurrent callers share one load.
export function loadClassifier(onProgress) {
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import(TRANSFORMERS_URL);
      const webgpu = !!navigator.gpu;
      loaded = await pipeline('text-classification', MODEL_ID, {
        dtype: 'q8', // the only ONNX weights this repo publishes
        device: webgpu ? 'webgpu' : 'wasm',
        progress_callback: onProgress,
      });
      return loaded;
    })().catch((err) => {
      loading = null; // allow a retry next time
      throw err;
    });
  }
  return loading;
}

// A pipeline whose inference failed (a lost WebGPU device, say) is broken for
// good, so it is dropped and the next call loads a fresh one, from the
// browser's cache rather than the network. Only that pipeline: a newer one may
// already be loading.
function discard(classifier) {
  if (loaded !== classifier) return;
  loading = loaded = null;
  Promise.resolve(classifier?.dispose?.()).catch(() => {});
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
    let scores;
    try {
      scores = await run;
    } catch (error) {
      // Being cancelled is the caller's choice, not a broken model.
      if (!signal?.aborted) discard(classifier);
      throw error;
    }
    signal?.throwIfAborted();
    return scores;
  };
}
