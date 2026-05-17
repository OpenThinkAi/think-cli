/**
 * Embedding module wrapping Xenova/bge-small-en-v1.5 via @huggingface/transformers.
 *
 * Model auto-downloads ~150MB on first use and is cached in
 * ~/.cache/huggingface/ (override with HF_HOME env var).
 * The daemon (future) will hold this pipeline resident; loading per-call is
 * unacceptable for the <100ms recall latency target.
 *
 * Dep note: @huggingface/transformers is an OPTIONAL dependency. Default
 * `npm install` does not pull it (keeps install weight light for users
 * who don't use semantic features). Callers must handle the "module not
 * installed" case — see error from `getPipeline()`. The version is pinned
 * exact (no caret) because runtime model loading is sensitive to version
 * drift; a minor bump can change the bundled onnxruntime-web revision and
 * invalidate cached ONNX artifacts in ~/.cache/huggingface/.
 *
 * The dep is imported lazily inside getPipeline() rather than at the top
 * of the module so the bare import of `embed` doesn't crash when the
 * optional dep is missing.
 */

/** The HuggingFace model identifier used for all embeddings in this project. */
export const EMBEDDING_MODEL_NAME = 'Xenova/bge-small-en-v1.5';

type FeatureExtractionPipeline = (
  input: string,
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array | Uint8Array | number[] }>;

type ProgressInfo = { status: string; file?: string; progress?: number };

// Module-level cache: store the Promise so concurrent callers await the same
// in-flight load rather than each triggering a separate 150MB model download.
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

// Timeout for the initial model load (model download can take a few minutes on
// a slow connection; 300s is generous enough for a first run).
const LOAD_TIMEOUT_MS = 300_000;

// Track last-reported percentage per file to throttle per-file progress output.
// The HF downloader fires per-file events; percentages cycle 0–100 for each file.
const lastProgressPctByFile = new Map<string, number>();
function onProgress(info: ProgressInfo): void {
  if (info.status === 'progress' && typeof info.progress === 'number' && typeof info.file === 'string') {
    const pct = Math.round(info.progress);
    const file = info.file;
    const last = lastProgressPctByFile.get(file) ?? -1;
    if (pct >= last + 10) {
      lastProgressPctByFile.set(file, pct);
      process.stderr.write(`think: embedding model ${EMBEDDING_MODEL_NAME} (${file}) ${pct}%…\n`);
    }
  }
}

const NOT_INSTALLED_HINT = '@huggingface/transformers is an optional dependency. Install it to enable semantic features: `npm install @huggingface/transformers@4.2.0`';

async function loadTransformersModule(): Promise<typeof import('@huggingface/transformers')> {
  try {
    return await import('@huggingface/transformers');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`think: ${NOT_INSTALLED_HINT} (underlying: ${msg})`, { cause: err });
  }
}

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise === null) {
    process.stderr.write(
      `think: loading embedding model ${EMBEDDING_MODEL_NAME} (~150MB download on first use, cached in ~/.cache/huggingface/)…\n`
    );

    const loadPromise = (async (): Promise<FeatureExtractionPipeline> => {
      const transformers = await loadTransformersModule();
      const pipe = await transformers.pipeline(
        'feature-extraction',
        EMBEDDING_MODEL_NAME,
        { progress_callback: onProgress }
      );
      return pipe as unknown as FeatureExtractionPipeline;
    })();
    // Attach a no-op .catch so that if the timeout branch fires first and the
    // load later rejects, Node.js does not emit unhandledRejection.
    loadPromise.catch(() => { /* handled by Promise.race */ });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`think: embedding model download timed out after ${LOAD_TIMEOUT_MS / 1000}s — check network connection and re-run to retry`)),
        LOAD_TIMEOUT_MS
      );
    });
    pipelinePromise = Promise.race([loadPromise, timeout])
      .then((pipe) => {
        clearTimeout(timeoutHandle);
        lastProgressPctByFile.clear();
        return pipe;
      })
      .catch((err: unknown) => {
        // Reset on failure so a subsequent call can retry.
        clearTimeout(timeoutHandle); // mirror the .then() branch — don't leave the timer alive on fast failures
        pipelinePromise = null;
        lastProgressPctByFile.clear();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`think: failed to load embedding model ${EMBEDDING_MODEL_NAME}: ${msg} — re-run to retry`, {
          cause: err,
        });
      });
  }
  return pipelinePromise;
}

// bge-small-en-v1.5 has a 512-token context window. The tokenizer silently
// truncates overlong inputs, but very large strings cause excessive memory
// pressure before tokenization. Cap well above the 512-token window to avoid
// that pressure.
const MAX_EMBED_CHARS = 32_000;

/**
 * Embed a text string into a 384-dim normalized Float32Array using
 * {@link EMBEDDING_MODEL_NAME} (pooling: mean, normalize: true).
 *
 * Throws with a clear "install @huggingface/transformers" message when
 * the optional dep is not installed.
 */
export default async function embed(text: string): Promise<Float32Array> {
  let input = text;
  if (text.length > MAX_EMBED_CHARS) {
    process.stderr.write(
      `think: embed input truncated from ${text.length} to ${MAX_EMBED_CHARS} chars (model context window is 512 tokens)\n`
    );
    input = text.slice(0, MAX_EMBED_CHARS);
  }
  const pipe = await getPipeline();
  const output = await pipe(input, { pooling: 'mean', normalize: true });
  if (!(output.data instanceof Float32Array)) {
    throw new Error(
      `think: expected Float32Array from embedding model, got ${(output.data as object).constructor.name}`
    );
  }
  return output.data;
}
