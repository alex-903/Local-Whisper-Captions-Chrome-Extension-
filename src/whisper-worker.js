import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/ort/`;

const PREFLIGHT_TIMEOUT_MS = 15000;

let recognizerPromise = null;
let recognizerModel = null;
let defaultLanguage = 'english';

const queue = [];
let processing = false;

self.postMessage({
  type: 'WORKER_BOOT',
  ts: Date.now()
});

function postModelProgress({ model, initId, status, stage, progress }) {
  self.postMessage({
    type: 'MODEL_PROGRESS',
    model,
    initId: initId || null,
    progress: {
      status,
      ...(stage ? { stage } : {}),
      ...(progress || {})
    }
  });
}

async function fetchWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store'
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runPreflight(model, initId) {
  postModelProgress({
    model,
    initId,
    status: 'checking network connectivity',
    stage: 'preflight'
  });

  const hubApiUrl = `https://huggingface.co/api/models/${model}`;
  const hubResponse = await fetchWithTimeout(hubApiUrl, PREFLIGHT_TIMEOUT_MS, { method: 'GET' });

  if (!hubResponse.ok) {
    throw new Error(`Hugging Face API failed (${hubResponse.status}) for ${model}`);
  }

  postModelProgress({
    model,
    initId,
    status: 'huggingface API reachable',
    stage: 'preflight'
  });

  const ortCandidates = [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm.wasm'
  ];
  let ortOk = false;

  for (const file of ortCandidates) {
    const ortUrl = `${self.location.origin}/ort/${file}`;
    const ortResponse = await fetchWithTimeout(ortUrl, PREFLIGHT_TIMEOUT_MS, { method: 'HEAD' });
    if (ortResponse.ok) {
      ortOk = true;
      break;
    }
  }

  if (!ortOk) {
    throw new Error('Local ONNX wasm assets are missing in /ort');
  }

  postModelProgress({
    model,
    initId,
    status: 'runtime assets reachable',
    stage: 'preflight'
  });
}

async function getRecognizer(model, { initId } = {}) {
  if (!recognizerPromise || recognizerModel !== model) {
    recognizerModel = model;
    recognizerPromise = pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (progress) => {
        postModelProgress({ model, initId, status: 'loading model', progress });
      }
    });
  }

  return recognizerPromise;
}

function normalizeText(output) {
  if (!output) {
    return '';
  }

  if (typeof output === 'string') {
    return output;
  }

  if (typeof output.text === 'string') {
    return output.text;
  }

  return '';
}

async function processQueue() {
  if (processing) {
    return;
  }

  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      const recognizer = await getRecognizer(job.model);
      const output = await recognizer(job.audio, {
        task: 'transcribe',
        language: job.language || defaultLanguage,
        return_timestamps: false,
        chunk_length_s: 20,
        stride_length_s: 5
      });

      self.postMessage({
        type: 'TRANSCRIPT',
        text: normalizeText(output)
      });
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error.message || String(error)
      });
    }
  }

  processing = false;
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message?.type) {
    return;
  }

  if (message.type === 'INIT') {
    try {
      const model = message.model || 'onnx-community/whisper-tiny.en';
      const initId = message.initId || null;
      const startedAt = performance.now();
      defaultLanguage = message.language || defaultLanguage;

      await runPreflight(model, initId);
      await getRecognizer(model, { initId });

      const loadMs = Math.max(0, Math.round(performance.now() - startedAt));
      self.postMessage({
        type: 'READY',
        model,
        language: defaultLanguage,
        initId,
        loadMs
      });
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        error: error.message || String(error)
      });
    }
    return;
  }

  if (message.type === 'TRANSCRIBE') {
    queue.push({
      audio: message.audio,
      language: message.language || defaultLanguage,
      model: recognizerModel || 'onnx-community/whisper-tiny.en'
    });

    if (queue.length > 2) {
      queue.splice(0, queue.length - 2);
    }

    await processQueue();
  }
};
