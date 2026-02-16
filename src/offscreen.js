import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.proxy = false;
const hardwareThreads =
  typeof navigator !== 'undefined' && Number.isFinite(Number(navigator.hardwareConcurrency))
    ? Number(navigator.hardwareConcurrency)
    : 2;
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, hardwareThreads));
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/ort/`;

const TARGET_RATE = 16000;
const MAX_BUFFER_SECONDS = 20;
const MODEL_LOAD_TIMEOUT_MS = 180000;
const NO_PROGRESS_TIMEOUT_MS = 10000;
const MODEL_HEARTBEAT_MS = 1000;
const PROBE_TIMEOUT_MS = 15000;

const DEFAULT_RUNTIME_SETTINGS = {
  windowSeconds: 8,
  minSeconds: 0.5,
  dispatchIntervalMs: 700,
  chunkLengthS: 10,
  strideLengthS: 2,
  silenceRmsThreshold: 0.007,
  voiceHoldMs: 800,
  baseWindowSeconds: 1.8,
  baseChunkLengthS: 6,
  baseStrideLengthS: 1.5
};

let currentTabId = null;
let currentModel = 'Xenova/whisper-tiny.en';
let currentLanguage = 'en';

let loadedModel = null;
let modelReady = false;
let modelLoading = false;
let modelLoadPromise = null;
let modelLoadTimeout = null;
let modelLoadStartedAt = 0;
let modelHeartbeatTimer = null;
let activeLoadId = null;
let modelOnnxUrl = null;
let lastProgressSignalAt = 0;

let recognizerPromise = null;
let recognizerModel = null;
let transcribeBusy = false;
let queuedAudio = null;
let lastTranscriptText = '';
let lastVoiceAt = 0;
let runtimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };

let stream = null;
let monitorAudio = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let isCapturing = false;

let pcmChunks = [];
let totalSamples = 0;
let lastDispatchedAt = 0;
let lastProgressReportAt = 0;
let lastRuntimeWarningAt = 0;

function resetBuffer() {
  pcmChunks = [];
  totalSamples = 0;
}

async function notifyBackground(type, payload = {}) {
  await chrome.runtime.sendMessage({
    type,
    tabId: currentTabId,
    ...payload
  });
}

function trimBuffer() {
  if (!audioContext) {
    return;
  }

  const sampleLimit = Math.floor(audioContext.sampleRate * MAX_BUFFER_SECONDS);
  while (totalSamples > sampleLimit && pcmChunks.length > 0) {
    const oldest = pcmChunks.shift();
    totalSamples -= oldest.length;
  }
}

function getLastSamples(sampleCount) {
  const available = Math.min(sampleCount, totalSamples);
  const output = new Float32Array(available);
  let writeOffset = available;

  for (let i = pcmChunks.length - 1; i >= 0 && writeOffset > 0; i -= 1) {
    const chunk = pcmChunks[i];
    const copyCount = Math.min(writeOffset, chunk.length);
    const from = chunk.length - copyCount;
    writeOffset -= copyCount;
    output.set(chunk.subarray(from), writeOffset);
  }

  return output;
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }

  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);

  for (let i = 0; i < newLength; i += 1) {
    const origin = i * ratio;
    const left = Math.floor(origin);
    const right = Math.min(left + 1, input.length - 1);
    const weight = origin - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

function calculateRms(samples) {
  if (!samples || samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sum += value * value;
  }

  return Math.sqrt(sum / samples.length);
}

function sanitizeRuntimeSettings(next = {}, current = runtimeSettings) {
  const source = {
    ...current,
    ...(next && typeof next === 'object' ? next : {})
  };

  function toNum(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  const settings = {
    windowSeconds: Math.min(12, Math.max(0.8, toNum(source.windowSeconds, current.windowSeconds))),
    minSeconds: Math.min(5, Math.max(0.1, toNum(source.minSeconds, current.minSeconds))),
    dispatchIntervalMs: Math.round(Math.min(5000, Math.max(100, toNum(source.dispatchIntervalMs, current.dispatchIntervalMs)))),
    chunkLengthS: Math.min(30, Math.max(1, toNum(source.chunkLengthS, current.chunkLengthS))),
    strideLengthS: Math.min(15, Math.max(0.1, toNum(source.strideLengthS, current.strideLengthS))),
    silenceRmsThreshold: Math.min(0.05, Math.max(0, toNum(source.silenceRmsThreshold, current.silenceRmsThreshold))),
    voiceHoldMs: Math.round(Math.min(5000, Math.max(0, toNum(source.voiceHoldMs, current.voiceHoldMs)))),
    baseWindowSeconds: Math.min(12, Math.max(0.5, toNum(source.baseWindowSeconds, current.baseWindowSeconds))),
    baseChunkLengthS: Math.min(30, Math.max(1, toNum(source.baseChunkLengthS, current.baseChunkLengthS))),
    baseStrideLengthS: Math.min(15, Math.max(0.1, toNum(source.baseStrideLengthS, current.baseStrideLengthS)))
  };

  if (settings.strideLengthS >= settings.chunkLengthS) {
    settings.strideLengthS = Math.max(0.1, settings.chunkLengthS - 0.1);
  }
  if (settings.baseStrideLengthS >= settings.baseChunkLengthS) {
    settings.baseStrideLengthS = Math.max(0.1, settings.baseChunkLengthS - 0.1);
  }

  return settings;
}

function applyRuntimeSettings(next) {
  runtimeSettings = sanitizeRuntimeSettings(next, runtimeSettings);
}

function clearModelLoadTimer() {
  if (!modelLoadTimeout) {
    return;
  }

  clearTimeout(modelLoadTimeout);
  modelLoadTimeout = null;
}

function stopModelHeartbeat() {
  if (!modelHeartbeatTimer) {
    return;
  }

  clearInterval(modelHeartbeatTimer);
  modelHeartbeatTimer = null;
}

function startModelHeartbeat() {
  stopModelHeartbeat();

  modelHeartbeatTimer = setInterval(() => {
    if (!modelLoading) {
      stopModelHeartbeat();
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - modelLoadStartedAt);
    const stalledMs = Math.max(0, Date.now() - lastProgressSignalAt);
    if (stalledMs >= NO_PROGRESS_TIMEOUT_MS) {
      setModelError(new Error('Model load stalled: no progress for 10s.')).catch(() => {});
      return;
    }

    if (elapsedMs >= MODEL_LOAD_TIMEOUT_MS) {
      setModelError(new Error('Model load timed out (180s). Check network and reload extension.')).catch(() => {});
      return;
    }

    notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
      stage: 'waiting',
      status: 'loading model (waiting for network/download events)',
      elapsedMs,
      stalledMs
    }).catch(() => {});
  }, MODEL_HEARTBEAT_MS);
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

function isEnglishOnlyModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.includes('whisper-') && id.endsWith('.en');
}

function isBaseModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.includes('whisper-base');
}

function getWindowSecondsForModel(modelId) {
  if (isBaseModel(modelId)) {
    return runtimeSettings.baseWindowSeconds;
  }
  return runtimeSettings.windowSeconds;
}

function buildTranscriptionOptions(modelId, language) {
  return buildTranscriptionOptionsWithFlags(modelId, language, {
    forceLanguage: true,
    forceTask: true
  });
}

function buildTranscriptionOptionsWithFlags(modelId, language, { forceLanguage, forceTask }) {
  const base = isBaseModel(modelId)
    ? {
        return_timestamps: false,
        chunk_length_s: runtimeSettings.baseChunkLengthS,
        stride_length_s: runtimeSettings.baseStrideLengthS
      }
    : {
        return_timestamps: false,
        chunk_length_s: runtimeSettings.chunkLengthS,
        stride_length_s: runtimeSettings.strideLengthS
      };

  if (isEnglishOnlyModel(modelId)) {
    return base;
  }

  const output = {
    ...base,
    forced_decoder_ids: null
  };

  if (forceTask) {
    output.task = 'transcribe';
    output.is_multilingual = true;
  }
  if (forceLanguage) {
    output.language = String(language || '').trim().toLowerCase() || 'en';
  }
  return output;
}

function canForceLanguageSelection(recognizer, language) {
  const selected = String(language || '').trim().toLowerCase() || 'en';
  const languageToken = `<|${selected}|>`;
  const maps = [
    recognizer?.model?.generation_config?.lang_to_id,
    recognizer?.processor?.tokenizer?.lang_to_id,
    recognizer?.tokenizer?.lang_to_id
  ];

  for (const map of maps) {
    if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, languageToken)) {
      return true;
    }
  }

  return false;
}

function shouldRetryWithoutForcedLanguage(error) {
  const message = String(error?.message || error || '');
  return message.includes("reading '<|") || message.includes('lang_to_id');
}

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeOnnxTransfer() {
  if (!modelOnnxUrl) {
    return;
  }

  await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
    stage: 'probe',
    status: 'probing ONNX download path',
    elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
  });

  const response = await fetchWithTimeout(modelOnnxUrl, PROBE_TIMEOUT_MS, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Range: 'bytes=0-4095'
    }
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`ONNX probe failed (${response.status})`);
  }

  const chunk = await response.arrayBuffer();
  lastProgressSignalAt = Date.now();
  await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
    stage: 'probe',
    status: `onnx probe ok (${chunk.byteLength} bytes)`,
    loadedBytes: chunk.byteLength,
    totalBytes: Number(response.headers.get('content-length')) || null,
    elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
  });
}

async function setModelError(error) {
  modelLoading = false;
  modelReady = false;
  recognizerPromise = null;
  recognizerModel = null;
  clearModelLoadTimer();
  stopModelHeartbeat();
  await notifyBackground('OFFSCREEN_ERROR', {
    error: error.message || String(error)
  });
}

function disposeRecognizerLater(recognizerPromiseRef) {
  if (!recognizerPromiseRef) {
    return;
  }

  recognizerPromiseRef
    .then(async (recognizer) => {
      if (!recognizer) {
        return;
      }

      if (typeof recognizer.dispose === 'function') {
        await recognizer.dispose();
        return;
      }

      if (recognizer.model && typeof recognizer.model.dispose === 'function') {
        await recognizer.model.dispose();
      }
    })
    .catch(() => {
      // Ignore disposal failures.
    });
}

async function ensureModel({ model, language, tuning }) {
  currentModel = model || currentModel;
  currentLanguage = language || currentLanguage;
  applyRuntimeSettings(tuning);

  if (!modelReady && recognizerModel === currentModel && recognizerPromise) {
    // Recover from a previously hung init promise by forcing a fresh pipeline init.
    recognizerPromise = null;
    recognizerModel = null;
  }

  while (!(modelReady && loadedModel === currentModel)) {
    if (modelLoading && modelLoadPromise) {
      await modelLoadPromise;
      continue;
    }

    modelLoading = true;
    modelReady = false;
    modelLoadStartedAt = Date.now();
    lastProgressSignalAt = Date.now();
    lastProgressReportAt = 0;

    const loadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeLoadId = loadId;

    startModelHeartbeat();
    await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
      status: 'loading model (initializing)',
      stage: 'initializing',
      elapsedMs: 0
    });

    modelLoadPromise = (async () => {
      modelLoadTimeout = setTimeout(async () => {
        if (!modelLoading || activeLoadId !== loadId) {
          return;
        }
        await setModelError(new Error('Model load timed out (180s). Check network and reload extension.'));
      }, MODEL_LOAD_TIMEOUT_MS);

      try {
        if (!recognizerPromise || recognizerModel !== currentModel) {
          if (recognizerPromise && recognizerModel && recognizerModel !== currentModel) {
            const stalePromise = recognizerPromise;
            recognizerPromise = null;
            recognizerModel = null;
            modelReady = false;
            disposeRecognizerLater(stalePromise);
          }

          await probeOnnxTransfer();
          recognizerModel = currentModel;
          const progressCallback = (progress) => {
            if (!modelLoading || activeLoadId !== loadId) {
              return;
            }

            const now = Date.now();
            if (now - lastProgressReportAt < 350) {
              return;
            }
            lastProgressReportAt = now;
            lastProgressSignalAt = now;

            const rawProgress = Number(progress?.progress);
            const loadedBytes = Number(progress?.loaded);
            const totalBytes = Number(progress?.total);
            const stage =
              typeof progress?.status === 'string' && progress.status ? progress.status : 'downloading';
            const file = typeof progress?.file === 'string' && progress.file ? progress.file : null;

            let percent = null;
            if (Number.isFinite(rawProgress)) {
              percent = rawProgress > 1 ? Math.round(rawProgress) : Math.round(rawProgress * 100);
            } else if (Number.isFinite(loadedBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
              percent = Math.round((loadedBytes / totalBytes) * 100);
            }

            const status = percent === null ? `loading model (${stage})` : `loading model ${percent}% (${stage})`;
            notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
              status,
              stage,
              percent,
              loadedBytes: Number.isFinite(loadedBytes) ? loadedBytes : null,
              totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
              file,
              elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
            }).catch(() => {});
          };

          recognizerPromise = (async () => {
            const webGpuAvailable = typeof navigator !== 'undefined' && !!navigator.gpu;
            if (webGpuAvailable) {
              await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
                status: 'loading model (trying webgpu)',
                stage: 'initializing',
                elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
              });

              try {
                const recognizer = await pipeline('automatic-speech-recognition', currentModel, {
                  device: 'webgpu',
                  progress_callback: progressCallback
                });

                await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
                  status: 'model backend: webgpu',
                  stage: 'initializing',
                  elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
                });
                return recognizer;
              } catch (error) {
                const reason = String(error?.message || error || 'unknown reason');
                await notifyBackground('OFFSCREEN_RUNTIME_WARNING', {
                  warning: `webgpu init failed: ${reason}`
                });
                await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
                  status: `webgpu unavailable (${reason}), falling back to wasm`,
                  stage: 'initializing',
                  elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
                });
              }
            }

            const recognizer = await pipeline('automatic-speech-recognition', currentModel, {
              device: 'wasm',
              progress_callback: progressCallback
            });

            await notifyBackground('OFFSCREEN_MODEL_PROGRESS', {
              status: 'model backend: wasm',
              stage: 'initializing',
              elapsedMs: Math.max(0, Date.now() - modelLoadStartedAt)
            });
            return recognizer;
          })();
        }

        await recognizerPromise;

        modelReady = true;
        loadedModel = currentModel;
        modelLoading = false;
        clearModelLoadTimer();
        stopModelHeartbeat();

        const loadMs = Math.max(0, Date.now() - modelLoadStartedAt);
        await notifyBackground('OFFSCREEN_MODEL_READY', {
          model: loadedModel,
          loadMs
        });
      } catch (error) {
        recognizerPromise = null;
        recognizerModel = null;
        await setModelError(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        if (activeLoadId === loadId) {
          modelLoadPromise = null;
        }
      }
    })();

    await modelLoadPromise;
  }
}

async function runTranscription(audio16k) {
  if (!isCapturing || !modelReady || !recognizerPromise) {
    return;
  }

  if (transcribeBusy) {
    queuedAudio = audio16k;
    return;
  }

  transcribeBusy = true;
  try {
    const recognizer = await recognizerPromise;
    const supportsLanguageToken = canForceLanguageSelection(recognizer, currentLanguage);
    const forcedOptions = buildTranscriptionOptionsWithFlags(currentModel, currentLanguage, {
      forceLanguage: supportsLanguageToken,
      forceTask: true
    });

    let output;
    try {
      output = await recognizer(audio16k, forcedOptions);
    } catch (error) {
      if (!shouldRetryWithoutForcedLanguage(error)) {
        throw error;
      }

      // Some ONNX-community exports omit language token mappings.
      const relaxedOptions = buildTranscriptionOptionsWithFlags(currentModel, currentLanguage, {
        forceLanguage: false,
        forceTask: false
      });
      output = await recognizer(audio16k, relaxedOptions);
    }

    const text = normalizeText(output).trim();
    if (isCapturing && text && text !== lastTranscriptText) {
      lastTranscriptText = text;
      await notifyBackground('OFFSCREEN_TRANSCRIPT', { text });
    }
  } catch (error) {
    const warning = error?.message || String(error);
    const now = Date.now();
    if (now - lastRuntimeWarningAt > 1500) {
      lastRuntimeWarningAt = now;
      await notifyBackground('OFFSCREEN_RUNTIME_WARNING', {
        warning
      });
    }
  } finally {
    transcribeBusy = false;

    if (queuedAudio) {
      const next = queuedAudio;
      queuedAudio = null;
      runTranscription(next).catch(() => {});
    }
  }
}

function maybeDispatchTranscription() {
  if (!isCapturing || !modelReady || !audioContext) {
    return;
  }

  const now = Date.now();
  if (now - lastDispatchedAt < runtimeSettings.dispatchIntervalMs) {
    return;
  }

  const minimumSamples = Math.floor(audioContext.sampleRate * runtimeSettings.minSeconds);
  if (totalSamples < minimumSamples) {
    return;
  }

  const windowSamples = Math.floor(audioContext.sampleRate * getWindowSecondsForModel(currentModel));
  const audio = getLastSamples(windowSamples);
  const normalized = resampleLinear(audio, audioContext.sampleRate, TARGET_RATE);
  const rms = calculateRms(normalized);

  if (rms >= runtimeSettings.silenceRmsThreshold) {
    lastVoiceAt = now;
  } else if (now - lastVoiceAt > runtimeSettings.voiceHoldMs) {
    return;
  }

  lastDispatchedAt = now;
  runTranscription(normalized).catch(() => {});
}

async function stopCapture() {
  isCapturing = false;
  transcribeBusy = false;
  queuedAudio = null;
  lastTranscriptText = '';
  lastVoiceAt = 0;

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  if (monitorAudio) {
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
  }

  resetBuffer();

  if (currentTabId !== null) {
    await notifyBackground('OFFSCREEN_STATUS', {
      status: modelReady ? 'model ready' : 'stopped'
    });
  }
}

async function preloadModel({ model, language, tuning, onnxUrl }) {
  currentTabId = null;
  modelOnnxUrl = onnxUrl || null;
  applyRuntimeSettings(tuning);
  await ensureModel({ model, language, tuning });
}

async function startCapture({ streamId, tabId, model, language, tuning }) {
  await stopCapture();

  currentTabId = tabId;
  currentModel = model || currentModel;
  currentLanguage = language || currentLanguage;
  applyRuntimeSettings(tuning);
  lastTranscriptText = '';
  lastVoiceAt = 0;

  await ensureModel({ model: currentModel, language: currentLanguage, tuning });

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));

  sourceNode = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'mono-processor');
  workletNode.port.onmessage = (event) => {
    const chunk = new Float32Array(event.data);
    pcmChunks.push(chunk);
    totalSamples += chunk.length;
    trimBuffer();
    maybeDispatchTranscription();
  };

  sourceNode.connect(workletNode);

  monitorAudio = new Audio();
  monitorAudio.autoplay = true;
  monitorAudio.srcObject = stream;
  await monitorAudio.play().catch(() => {
    // Some pages can block autoplay; capture still works.
  });

  await audioContext.resume();

  isCapturing = true;
  await notifyBackground('OFFSCREEN_STATUS', { status: 'capturing' });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return false;
  }

  (async () => {
    if (message.type === 'PRELOAD_MODEL') {
      preloadModel(message).catch(async (error) => {
        await notifyBackground('OFFSCREEN_ERROR', {
          error: error.message || String(error)
        });
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'START_CAPTURE') {
      await startCapture(message);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'STOP_CAPTURE') {
      await stopCapture();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'UPDATE_SETTINGS') {
      applyRuntimeSettings(message.tuning);
      sendResponse({ ok: true, settings: runtimeSettings });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown offscreen message type' });
  })().catch(async (error) => {
    await notifyBackground('OFFSCREEN_ERROR', {
      error: error.message || String(error)
    });
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
