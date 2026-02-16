const loadButton = document.getElementById('load');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusEl = document.getElementById('status');
const modelStateEl = document.getElementById('model-state');
const loadDebugEl = document.getElementById('load-debug');
const loadLogEl = document.getElementById('load-log');
const modelSelect = document.getElementById('model');
const languageSelect = document.getElementById('language');
const versionEl = document.getElementById('build-version');
const applyTuningButton = document.getElementById('apply-tuning');
const tuneWindowSecondsEl = document.getElementById('tune-window-seconds');
const tuneMinSecondsEl = document.getElementById('tune-min-seconds');
const tuneDispatchMsEl = document.getElementById('tune-dispatch-ms');
const tuneChunkLengthEl = document.getElementById('tune-chunk-length');
const tuneStrideLengthEl = document.getElementById('tune-stride-length');
const tuneSilenceThresholdEl = document.getElementById('tune-silence-threshold');
const tuneVoiceHoldMsEl = document.getElementById('tune-voice-hold-ms');
const tuneBaseWindowSecondsEl = document.getElementById('tune-base-window-seconds');
const tuneBaseChunkLengthEl = document.getElementById('tune-base-chunk-length');
const tuneBaseStrideLengthEl = document.getElementById('tune-base-stride-length');
const installedModelsEl = document.getElementById('installed-models');

let statePoller = null;
let initializedInputs = false;
let initializedTuning = false;

const DEFAULT_TUNING = {
  windowSeconds: 3,
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

function normalizeLanguageValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 'en';
  }
  const aliases = {
    english: 'en',
    spanish: 'es',
    chinese: 'zh',
    french: 'fr',
    german: 'de',
    italian: 'it',
    portuguese: 'pt',
    russian: 'ru',
    japanese: 'ja',
    korean: 'ko',
    arabic: 'ar',
    hindi: 'hi',
    turkish: 'tr',
    dutch: 'nl',
    polish: 'pl',
    indonesian: 'id',
    vietnamese: 'vi',
    thai: 'th',
    ukrainian: 'uk',
    persian: 'fa'
  };
  if (aliases[raw]) {
    return aliases[raw];
  }
  if (/^[a-z]{2}$/.test(raw)) {
    return raw;
  }
  return 'en';
}

function isSelectedModelReady(state) {
  return Boolean(state?.modelReady && state?.loadedModel === modelSelect.value);
}

function sanitizeTuning(next = {}) {
  const source = {
    ...DEFAULT_TUNING,
    ...(next && typeof next === 'object' ? next : {})
  };

  function toNum(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  const tuning = {
    windowSeconds: Math.min(12, Math.max(0.8, toNum(source.windowSeconds, DEFAULT_TUNING.windowSeconds))),
    minSeconds: Math.min(5, Math.max(0.1, toNum(source.minSeconds, DEFAULT_TUNING.minSeconds))),
    dispatchIntervalMs: Math.round(
      Math.min(5000, Math.max(100, toNum(source.dispatchIntervalMs, DEFAULT_TUNING.dispatchIntervalMs)))
    ),
    chunkLengthS: Math.min(30, Math.max(1, toNum(source.chunkLengthS, DEFAULT_TUNING.chunkLengthS))),
    strideLengthS: Math.min(15, Math.max(0.1, toNum(source.strideLengthS, DEFAULT_TUNING.strideLengthS))),
    silenceRmsThreshold: Math.min(
      0.05,
      Math.max(0, toNum(source.silenceRmsThreshold, DEFAULT_TUNING.silenceRmsThreshold))
    ),
    voiceHoldMs: Math.round(Math.min(5000, Math.max(0, toNum(source.voiceHoldMs, DEFAULT_TUNING.voiceHoldMs)))),
    baseWindowSeconds: Math.min(
      12,
      Math.max(0.5, toNum(source.baseWindowSeconds, DEFAULT_TUNING.baseWindowSeconds))
    ),
    baseChunkLengthS: Math.min(30, Math.max(1, toNum(source.baseChunkLengthS, DEFAULT_TUNING.baseChunkLengthS))),
    baseStrideLengthS: Math.min(
      15,
      Math.max(0.1, toNum(source.baseStrideLengthS, DEFAULT_TUNING.baseStrideLengthS))
    )
  };

  if (tuning.strideLengthS >= tuning.chunkLengthS) {
    tuning.strideLengthS = Math.max(0.1, tuning.chunkLengthS - 0.1);
  }
  if (tuning.baseStrideLengthS >= tuning.baseChunkLengthS) {
    tuning.baseStrideLengthS = Math.max(0.1, tuning.baseChunkLengthS - 0.1);
  }

  return tuning;
}

function setTuningInputs(tuningState) {
  const tuning = sanitizeTuning(tuningState);
  tuneWindowSecondsEl.value = String(tuning.windowSeconds);
  tuneMinSecondsEl.value = String(tuning.minSeconds);
  tuneDispatchMsEl.value = String(tuning.dispatchIntervalMs);
  tuneChunkLengthEl.value = String(tuning.chunkLengthS);
  tuneStrideLengthEl.value = String(tuning.strideLengthS);
  tuneSilenceThresholdEl.value = String(tuning.silenceRmsThreshold);
  tuneVoiceHoldMsEl.value = String(tuning.voiceHoldMs);
  tuneBaseWindowSecondsEl.value = String(tuning.baseWindowSeconds);
  tuneBaseChunkLengthEl.value = String(tuning.baseChunkLengthS);
  tuneBaseStrideLengthEl.value = String(tuning.baseStrideLengthS);
}

function getTuningFromInputs() {
  return sanitizeTuning({
    windowSeconds: tuneWindowSecondsEl.value,
    minSeconds: tuneMinSecondsEl.value,
    dispatchIntervalMs: tuneDispatchMsEl.value,
    chunkLengthS: tuneChunkLengthEl.value,
    strideLengthS: tuneStrideLengthEl.value,
    silenceRmsThreshold: tuneSilenceThresholdEl.value,
    voiceHoldMs: tuneVoiceHoldMsEl.value,
    baseWindowSeconds: tuneBaseWindowSecondsEl.value,
    baseChunkLengthS: tuneBaseChunkLengthEl.value,
    baseStrideLengthS: tuneBaseStrideLengthEl.value
  });
}

function formatStatus(state) {
  if (state?.error) {
    return `Error: ${state.error}`;
  }

  if (state?.running) {
    const tabLabel = typeof state.tabId === 'number' ? `tab ${state.tabId}` : 'tab';
    return `${state.status || 'running'} on ${tabLabel}`;
  }

  return state?.status || 'Idle';
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 'n/a';
  }

  if (value < 1024) {
    return `${Math.round(value)} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0.0s';
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

function formatLoadDebug(state) {
  const stats = state?.loadStats;
  if (!stats) {
    return 'No model activity yet.';
  }

  const now = Date.now();
  const startedAt = Number(stats.startedAt || now);
  const lastAt = Number(stats.lastAt || startedAt);
  const elapsedMs = Number.isFinite(Number(stats.elapsedMs))
    ? Number(stats.elapsedMs)
    : Math.max(0, now - startedAt);
  const sinceLastMs = Math.max(0, now - lastAt);

  const lines = [
    `stage: ${stats.stage || state?.status || 'unknown'}`,
    `elapsed: ${formatDuration(elapsedMs)}`,
    `last update: ${formatDuration(sinceLastMs)} ago`,
    `progress: ${Number.isFinite(Number(stats.percent)) ? `${Math.round(Number(stats.percent))}%` : 'n/a'}`,
    `bytes: ${formatBytes(Number(stats.loadedBytes))} / ${formatBytes(Number(stats.totalBytes))}`,
    `file: ${typeof stats.file === 'string' && stats.file ? stats.file : 'n/a'}`
  ];

  if (state?.modelLoading && sinceLastMs > 15000) {
    lines.push('hint: no fresh progress events for 15s (likely stalled network/model fetch).');
  }

  return lines.join('\n');
}

function formatLoadLog(state) {
  const entries = Array.isArray(state?.loadLog) ? state.loadLog : [];
  if (entries.length === 0) {
    return 'No logs yet.';
  }

  return entries.slice(-20).join('\n');
}

function renderInstalledModels(state) {
  if (!installedModelsEl) {
    return;
  }

  const models = Array.isArray(state?.installedModels) ? state.installedModels : [];
  installedModelsEl.textContent = '';

  if (models.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'None yet';
    installedModelsEl.appendChild(item);
    return;
  }

  for (const model of models) {
    const item = document.createElement('li');
    item.textContent = model;
    installedModelsEl.appendChild(item);
  }
}

function render(state) {
  statusEl.textContent = formatStatus(state);

  const selectedModelReady = isSelectedModelReady(state);
  const modelLoading = Boolean(state?.modelLoading);
  const running = Boolean(state?.running);

  loadButton.disabled = modelLoading || running;
  startButton.disabled = running || modelLoading;
  stopButton.disabled = !running;

  if (!initializedInputs) {
    if (state?.model) {
      modelSelect.value = state.model;
    }
    if (state?.language) {
      languageSelect.value = normalizeLanguageValue(state.language);
    }
    initializedInputs = true;
  }

  if (!initializedTuning) {
    setTuningInputs(state?.tuning || DEFAULT_TUNING);
    initializedTuning = true;
  }

  const englishOnly = modelSelect.value.endsWith('.en');
  languageSelect.disabled = englishOnly;
  if (englishOnly && languageSelect.value !== 'en') {
    languageSelect.value = 'en';
  }

  if (modelLoading) {
    modelStateEl.textContent = `Loading ${state.model || modelSelect.value}...`;
  } else if (state?.modelReady && state?.loadedModel) {
    if (state.loadedModel === modelSelect.value) {
      modelStateEl.textContent = `${state.loadedModel} ready`;
    } else {
      modelStateEl.textContent = `${state.loadedModel} is loaded. Start will auto-load ${modelSelect.value}.`;
    }
  } else {
    modelStateEl.textContent = 'No model loaded.';
  }

  loadDebugEl.textContent = formatLoadDebug(state);
  loadLogEl.textContent = formatLoadLog(state);
  renderInstalledModels(state);
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function loadModel() {
  const response = await chrome.runtime.sendMessage({
    type: 'LOAD_MODEL',
    model: modelSelect.value,
    language: languageSelect.value,
    tuning: getTuningFromInputs()
  });

  if (!response?.ok) {
    render({ running: false, error: response?.error || 'Failed to load model' });
  }
}

async function start() {
  const tabId = await getActiveTabId();
  if (typeof tabId !== 'number') {
    render({ running: false, error: 'No active tab found' });
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'START_CAPTIONING',
    tabId,
    model: modelSelect.value,
    language: languageSelect.value,
    tuning: getTuningFromInputs()
  });

  if (!response?.ok) {
    render({ running: false, error: response?.error || 'Failed to start' });
  }
}

async function stop() {
  const response = await chrome.runtime.sendMessage({ type: 'STOP_CAPTIONING' });
  if (!response?.ok) {
    render({ running: false, error: response?.error || 'Failed to stop' });
  }
}

async function applyTuning() {
  const response = await chrome.runtime.sendMessage({
    type: 'SET_TUNING',
    tuning: getTuningFromInputs()
  });
  if (!response?.ok) {
    render({ running: false, error: response?.error || 'Failed to apply tuning' });
    return;
  }
  setTuningInputs(response?.state?.tuning || getTuningFromInputs());
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATE') {
    render(message.state);
  }
});

loadButton.addEventListener('click', () => {
  loadModel().catch((error) => {
    render({ running: false, error: error.message || String(error) });
  });
});

startButton.addEventListener('click', () => {
  start().catch((error) => {
    render({ running: false, error: error.message || String(error) });
  });
});

stopButton.addEventListener('click', () => {
  stop().catch((error) => {
    render({ running: false, error: error.message || String(error) });
  });
});

applyTuningButton.addEventListener('click', () => {
  applyTuning().catch((error) => {
    render({ running: false, error: error.message || String(error) });
  });
});

modelSelect.addEventListener('change', () => {
  const englishOnly = modelSelect.value.endsWith('.en');
  languageSelect.disabled = englishOnly;
  if (englishOnly) {
    languageSelect.value = 'en';
  }
  chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((response) => {
    render(response?.state || { running: false });
  });
});

function startStatePolling() {
  if (statePoller) {
    return;
  }

  statePoller = setInterval(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_STATE' })
      .then((response) => render(response?.state || { running: false }))
      .catch(() => {});
  }, 1000);
}

function stopStatePolling() {
  if (!statePoller) {
    return;
  }

  clearInterval(statePoller);
  statePoller = null;
}

window.addEventListener('beforeunload', () => {
  stopStatePolling();
});

chrome.runtime
  .sendMessage({ type: 'GET_STATE' })
  .then((response) => {
    if (versionEl) {
      versionEl.textContent = `Build ${chrome.runtime.getManifest().version}`;
    }
    render(response?.state || { running: false });
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
    startStatePolling();
  })
  .catch(() => {
    if (versionEl) {
      versionEl.textContent = `Build ${chrome.runtime.getManifest().version}`;
    }
    render({ running: false });
    chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
    startStatePolling();
  });
