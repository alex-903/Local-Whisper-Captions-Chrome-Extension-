const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

let captionState = {
  running: false,
  tabId: null,
  model: 'Xenova/whisper-tiny.en',
  language: 'en',
  tuning: null,
  installedModels: [],
  subtitleLayout: null,
  loadedModel: null,
  modelReady: false,
  modelLoading: false,
  loadStats: null,
  loadLog: [],
  status: 'idle',
  error: null
};

let creatingOffscreen = null;
const PREFLIGHT_TIMEOUT_MS = 10000;
let retargetPromise = Promise.resolve();
let installedModelsHydrated = false;
const NON_CAPTURABLE_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'devtools://', 'about:', 'view-source:'];
const MIN_LAYOUT_WIDTH = 260;
const MIN_LAYOUT_HEIGHT = 56;
const INSTALLED_MODELS_STORAGE_KEY = 'installedModels';
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

function isEnglishOnlyModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return id.includes('whisper-') && id.endsWith('.en');
}

function normalizeLanguageSelection(language) {
  const raw = String(language || '').trim().toLowerCase();
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

function sanitizeTuning(next, current = DEFAULT_TUNING) {
  const source = {
    ...DEFAULT_TUNING,
    ...(current || {}),
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

function normalizeInstalledModels(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const seen = new Set();
  const output = [];
  for (const item of list) {
    const modelId = String(item || '').trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    output.push(modelId);
  }
  return output;
}

async function saveInstalledModels(list) {
  const normalized = normalizeInstalledModels(list);
  await chrome.storage.local.set({ [INSTALLED_MODELS_STORAGE_KEY]: normalized });
  return normalized;
}

async function hydrateInstalledModels() {
  if (installedModelsHydrated) {
    return;
  }

  const local = await chrome.storage.local.get(INSTALLED_MODELS_STORAGE_KEY);
  const installedModels = normalizeInstalledModels(local?.[INSTALLED_MODELS_STORAGE_KEY] || []);
  captionState = {
    ...captionState,
    installedModels
  };
  installedModelsHydrated = true;
}

async function markModelInstalled(modelId) {
  await hydrateInstalledModels();

  const id = String(modelId || '').trim();
  if (!id) {
    return;
  }

  const current = normalizeInstalledModels(captionState.installedModels);
  if (current.includes(id)) {
    return;
  }

  const next = await saveInstalledModels([...current, id]);
  captionState = {
    ...captionState,
    installedModels: next
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function runNetworkPreflight(model) {
  async function fetchOrThrow(url, label) {
    const response = await fetchWithTimeout(url, PREFLIGHT_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`${label} failed (${response.status})`);
    }
    return response;
  }

  const apiUrl = `https://huggingface.co/api/models/${model}`;
  const apiResponse = await fetchOrThrow(apiUrl, 'Hugging Face API');
  const apiData = await apiResponse.json().catch(() => ({}));

  await fetchOrThrow(`https://huggingface.co/${model}/resolve/main/config.json`, 'Model config');
  await fetchOrThrow(
    `https://huggingface.co/${model}/resolve/main/preprocessor_config.json`,
    'Preprocessor config'
  );

  const siblings = Array.isArray(apiData?.siblings) ? apiData.siblings : [];
  const onnxEntry = siblings.find((entry) => typeof entry?.rfilename === 'string' && entry.rfilename.endsWith('.onnx'));
  if (!onnxEntry?.rfilename) {
    throw new Error(`No ONNX file discovered in model repo ${model}`);
  }

  const onnxUrl = `https://huggingface.co/${model}/resolve/main/${onnxEntry.rfilename}`;
  const onnxProbe = await fetchWithTimeout(onnxUrl, PREFLIGHT_TIMEOUT_MS);
  if (!onnxProbe.ok) {
    throw new Error(`ONNX weights failed (${onnxProbe.status})`);
  }

  const localOrt = await fetchWithTimeout(`${chrome.runtime.getURL('ort/ort.bundle.min.mjs')}`, PREFLIGHT_TIMEOUT_MS);
  if (!localOrt.ok) {
    throw new Error(`Local ort.bundle.min.mjs missing (${localOrt.status})`);
  }

  return {
    onnxUrl
  };
}

async function setBadge(state) {
  if (state.running) {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

function sanitizeSubtitleLayout(layout) {
  if (!layout || typeof layout !== 'object') {
    return null;
  }

  const width = Number(layout.width);
  const height = Number(layout.height);
  const left = Number(layout.left);
  const top = Number(layout.top);

  if (![width, height, left, top].every((value) => Number.isFinite(value))) {
    return null;
  }

  const clean = {
    width: Math.max(MIN_LAYOUT_WIDTH, Math.min(2400, Math.round(width))),
    height: Math.max(MIN_LAYOUT_HEIGHT, Math.min(1600, Math.round(height))),
    left: Math.max(-8000, Math.min(8000, Math.round(left))),
    top: Math.max(-8000, Math.min(8000, Math.round(top)))
  };

  return clean;
}

function appendLoadLog(message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) {
    return;
  }

  const existing = Array.isArray(captionState.loadLog) ? captionState.loadLog : [];
  const last = existing[existing.length - 1] || '';
  if (last.endsWith(` ${trimmed}`)) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString([], { hour12: false });
  const line = `[${timestamp}] ${trimmed}`;
  const next = [...existing, line].slice(-80);
  captionState = {
    ...captionState,
    loadLog: next
  };
}

async function publishState() {
  await chrome.storage.session.set({ captionState });
  await setBadge(captionState);

  try {
    await chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: captionState });
  } catch {
    // Popup may be closed.
  }

  if (typeof captionState.tabId === 'number') {
    chrome.tabs
      .sendMessage(captionState.tabId, {
        type: 'SUBTITLE_STATUS',
        status: captionState.status,
        error: captionState.error
      })
      .catch(() => {
        // Content script may not be available.
      });
  }
}

async function ensureOffscreenDocument() {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = (async () => {
    const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url]
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio and run local speech-to-text.'
      });
    }
  })();

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING_SUBTITLES' });
    if (response?.ok) {
      return;
    }
  } catch {
    // Not injected yet.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function pushSubtitleLayout(tabId) {
  if (typeof tabId !== 'number') {
    return;
  }

  chrome.tabs
    .sendMessage(tabId, {
      type: 'SUBTITLE_LAYOUT',
      layout: captionState.subtitleLayout || null
    })
    .catch(() => {});
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tabs?.[0]?.id;
  return typeof tabId === 'number' ? tabId : null;
}

function isCapturableTabUrl(url) {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  for (const prefix of NON_CAPTURABLE_PREFIXES) {
    if (url.startsWith(prefix)) {
      return false;
    }
  }

  return url.startsWith('http://') || url.startsWith('https://');
}

function toRetargetStatus(errorText) {
  const text = String(errorText || '').toLowerCase();
  if (text.includes('chrome pages cannot be captured')) {
    return 'waiting: active tab is a Chrome/internal page';
  }
  if (text.includes('has not been invoked') || text.includes('activetab')) {
    return 'waiting: open extension once on this tab, then switch again';
  }
  return 'waiting for active tab';
}

async function retargetCapture(tabId) {
  if (!captionState.running) {
    return;
  }

  const previousTabId = captionState.tabId;

  if (typeof tabId !== 'number') {
    if (typeof previousTabId === 'number') {
      chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
    }

    try {
      await sendToOffscreen({ type: 'STOP_CAPTURE' });
    } catch {
      // Ignore if offscreen is unavailable.
    }

    captionState = {
      ...captionState,
      tabId: null,
      status: 'waiting for active tab',
      error: null
    };
    await publishState();
    return;
  }

  if (captionState.tabId === tabId) {
    return;
  }

  let tabUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    tabUrl = '';
  }

  if (!isCapturableTabUrl(tabUrl)) {
    appendLoadLog(`active tab ${tabId} not capturable (${tabUrl || 'unknown url'})`);
    if (typeof previousTabId === 'number') {
      chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
    }
    try {
      await sendToOffscreen({ type: 'STOP_CAPTURE' });
    } catch {
      // Ignore if offscreen is unavailable.
    }

    captionState = {
      ...captionState,
      tabId: null,
      status: 'waiting: active tab is not capturable',
      error: null
    };
    await publishState();
    return;
  }

  appendLoadLog(`switching capture to tab ${tabId}`);
  captionState = {
    ...captionState,
    tabId,
    status: 'switching tabs',
    error: null
  };
  await publishState();

  try {
    await ensureContentScript(tabId);
    await pushSubtitleLayout(tabId);
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await sendToOffscreen({
      type: 'START_CAPTURE',
      streamId,
      tabId,
      model: captionState.model,
      language: captionState.language,
      tuning: sanitizeTuning(captionState.tuning)
    });

    if (typeof previousTabId === 'number' && previousTabId !== tabId) {
      chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
    }
  } catch (error) {
    appendLoadLog(`retarget failed: ${error.message || String(error)}`);
    if (typeof previousTabId === 'number') {
      chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
    }
    try {
      await sendToOffscreen({ type: 'STOP_CAPTURE' });
    } catch {
      // Ignore if offscreen is unavailable.
    }

    captionState = {
      ...captionState,
      tabId: null,
      status: toRetargetStatus(error.message || String(error)),
      error: null
    };
    await publishState();
  }
}

function queueRetarget(tabId) {
  retargetPromise = retargetPromise.then(() => retargetCapture(tabId)).catch(() => {});
  return retargetPromise;
}

async function retargetToActiveTabIfRunning() {
  if (!captionState.running) {
    return;
  }
  const activeTabId = await getActiveTabId();
  await queueRetarget(activeTabId);
}

async function loadModel({ model, language, tuning }) {
  const requestedModel = model || captionState.model;
  const selectedLanguage = isEnglishOnlyModel(requestedModel) ? 'en' : normalizeLanguageSelection(language);
  const selectedTuning = sanitizeTuning(tuning, captionState.tuning || DEFAULT_TUNING);
  const modeLabel = isEnglishOnlyModel(requestedModel)
    ? 'english-only'
    : `multilingual-${selectedLanguage}`;
  const alreadyLoaded = captionState.modelReady && captionState.loadedModel === requestedModel;
  const now = Date.now();
  captionState = {
    ...captionState,
    model: requestedModel,
    language: selectedLanguage,
    tuning: selectedTuning,
    modelLoading: !alreadyLoaded,
    modelReady: alreadyLoaded,
    loadStats: {
      startedAt: now,
      lastAt: now,
      stage: alreadyLoaded ? 'ready' : 'queued',
      percent: alreadyLoaded ? 100 : null,
      loadedBytes: null,
      totalBytes: null,
      file: null,
      elapsedMs: 0
    },
    loadLog: [],
    status: alreadyLoaded ? 'model ready' : 'loading model',
    error: null
  };
  appendLoadLog(`load requested: ${requestedModel}`);
  appendLoadLog(`decode mode: ${modeLabel}`);
  await publishState();

  if (alreadyLoaded) {
    appendLoadLog('model already loaded, skipping preload');
    await publishState();
    return;
  }

  captionState = {
    ...captionState,
    status: 'preflight: checking network',
    loadStats: {
      ...(captionState.loadStats || {}),
      stage: 'preflight',
      lastAt: Date.now()
    }
  };
  appendLoadLog('preflight: checking model and runtime assets');
  await publishState();

  const preflight = await runNetworkPreflight(captionState.model);
  appendLoadLog('preflight ok');
  await publishState();

  await sendToOffscreen({
    type: 'PRELOAD_MODEL',
    model: captionState.model,
    language: selectedLanguage,
    tuning: selectedTuning,
    onnxUrl: preflight.onnxUrl
  });
}

async function startCaptioning({ tabId, model, language, tuning }) {
  if (typeof tabId !== 'number') {
    throw new Error('No active tab selected');
  }

  const requestedModel = model || captionState.model;
  const requestedLanguage = isEnglishOnlyModel(requestedModel) ? 'en' : normalizeLanguageSelection(language);
  const selectedTuning = sanitizeTuning(tuning, captionState.tuning || DEFAULT_TUNING);

  if (!captionState.modelReady || captionState.loadedModel !== requestedModel) {
    throw new Error('Model not loaded. Click "Load model" first.');
    await loadModel({
      model: requestedModel,
      language: requestedLanguage,
      tuning: selectedTuning
    });
  }

  if (captionState.running) {
    await queueRetarget(tabId);
    return;
  }

  await ensureContentScript(tabId);
  await pushSubtitleLayout(tabId);
  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  captionState = {
    ...captionState,
    running: true,
    tabId,
    model: requestedModel,
    language: requestedLanguage,
    tuning: selectedTuning,
    status: 'starting',
    error: null
  };
  await publishState();

  await sendToOffscreen({
    type: 'START_CAPTURE',
    streamId,
    tabId,
    model: captionState.model,
    language: requestedLanguage,
    tuning: selectedTuning
  });
}

async function stopCaptioning() {
  const targetTabId = captionState.tabId;

  try {
    await sendToOffscreen({ type: 'STOP_CAPTURE' });
  } catch {
    // Offscreen document might not exist.
  }

  captionState = {
    ...captionState,
    running: false,
    tabId: null,
    status: captionState.modelReady ? 'model ready' : 'idle',
    error: null
  };
  await publishState();

  if (typeof targetTabId === 'number') {
    try {
      await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_SUBTITLES' });
    } catch {
      // Ignore tabs where content script is not available.
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (captionState.running && captionState.tabId === tabId) {
    getActiveTabId()
      .then((activeTabId) => queueRetarget(activeTabId))
      .catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!captionState.running) {
    return;
  }
  queueRetarget(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message?.type) {
      sendResponse({ ok: false, error: 'Missing message type' });
      return;
    }

    if (message.type === 'GET_STATE') {
      await hydrateInstalledModels();
      if (!captionState.tuning) {
        captionState = {
          ...captionState,
          tuning: sanitizeTuning(null)
        };
      }
      if (!Array.isArray(captionState.installedModels)) {
        captionState = {
          ...captionState,
          installedModels: []
        };
      }
      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'SET_TUNING') {
      const nextTuning = sanitizeTuning(message.tuning, captionState.tuning || DEFAULT_TUNING);
      captionState = {
        ...captionState,
        tuning: nextTuning
      };
      appendLoadLog('tuning updated');
      await publishState();

      if (captionState.running || captionState.modelReady || captionState.modelLoading) {
        try {
          await sendToOffscreen({
            type: 'UPDATE_SETTINGS',
            tuning: nextTuning
          });
        } catch {
          // Offscreen may not exist yet.
        }
      }

      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'GET_SUBTITLE_LAYOUT') {
      sendResponse({ ok: true, layout: captionState.subtitleLayout || null });
      return;
    }

    if (message.type === 'SET_SUBTITLE_LAYOUT') {
      const nextLayout = sanitizeSubtitleLayout(message.layout);
      if (!nextLayout) {
        sendResponse({ ok: false, error: 'Invalid subtitle layout' });
        return;
      }

      captionState = {
        ...captionState,
        subtitleLayout: nextLayout
      };
      await chrome.storage.session.set({ captionState });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'POPUP_OPENED') {
      retargetToActiveTabIfRunning().catch(() => {});
      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'LOAD_MODEL') {
      await loadModel(message);
      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'START_CAPTIONING') {
      await startCaptioning(message);
      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'STOP_CAPTIONING') {
      await stopCaptioning();
      sendResponse({ ok: true, state: captionState });
      return;
    }

    if (message.type === 'OFFSCREEN_STATUS') {
      const nextStatus = message.status || captionState.status;
      const shouldKeepWaiting =
        captionState.running &&
        captionState.tabId === null &&
        (nextStatus === 'model ready' || nextStatus === 'stopped');
      const resolvedStatus = shouldKeepWaiting ? captionState.status : nextStatus;

      if (resolvedStatus !== captionState.status) {
        appendLoadLog(`status: ${resolvedStatus}`);
      }
      captionState = {
        ...captionState,
        status: resolvedStatus,
        loadStats: captionState.modelLoading
          ? {
              ...(captionState.loadStats || {}),
              lastAt: Date.now(),
              stage: nextStatus || captionState.loadStats?.stage || 'loading'
            }
          : captionState.loadStats,
        error: null
      };
      await publishState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OFFSCREEN_MODEL_PROGRESS') {
      const now = Date.now();
      const nextStatus = message.status || captionState.status;
      const nextStage = message.stage || captionState.loadStats?.stage || 'loading';
      if (nextStatus !== captionState.status || nextStage !== captionState.loadStats?.stage) {
        appendLoadLog(`progress: ${nextStatus}`);
      }
      captionState = {
        ...captionState,
        status: nextStatus,
        loadStats: {
          ...(captionState.loadStats || {
            startedAt: now
          }),
          lastAt: now,
          stage: nextStage,
          percent:
            Number.isFinite(Number(message.percent)) ? Number(message.percent) : captionState.loadStats?.percent ?? null,
          loadedBytes:
            Number.isFinite(Number(message.loadedBytes))
              ? Number(message.loadedBytes)
              : captionState.loadStats?.loadedBytes ?? null,
          totalBytes:
            Number.isFinite(Number(message.totalBytes))
              ? Number(message.totalBytes)
              : captionState.loadStats?.totalBytes ?? null,
          file: typeof message.file === 'string' && message.file ? message.file : captionState.loadStats?.file ?? null,
          elapsedMs:
            Number.isFinite(Number(message.elapsedMs))
              ? Number(message.elapsedMs)
              : Math.max(0, now - Number(captionState.loadStats?.startedAt || now))
        },
        error: null
      };
      await publishState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OFFSCREEN_MODEL_READY') {
      const loadedModel = message.model || captionState.model;
      const loadMs = Number(message.loadMs || 0);
      const loadSeconds = Math.max(0, Math.round(loadMs / 100) / 10);
      appendLoadLog(`model ready in ${loadSeconds}s`);
      await markModelInstalled(loadedModel);

      captionState = {
        ...captionState,
        modelLoading: false,
        modelReady: true,
        loadedModel,
        loadStats: {
          ...(captionState.loadStats || {}),
          lastAt: Date.now(),
          stage: 'ready',
          percent: 100,
          elapsedMs: loadMs
        },
        status: loadSeconds > 0 ? `model ready (${loadSeconds}s)` : 'model ready',
        error: null
      };
      await publishState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OFFSCREEN_ERROR') {
      appendLoadLog(`error: ${message.error || 'Unknown error'}`);
      const failedWhileLoading = Boolean(captionState.modelLoading);
      const previousTabId = captionState.tabId;

      if (captionState.running || typeof previousTabId === 'number') {
        try {
          await sendToOffscreen({ type: 'STOP_CAPTURE' });
        } catch {
          // Ignore if offscreen is unavailable.
        }
      }

      if (typeof previousTabId === 'number') {
        chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
      }

      captionState = {
        ...captionState,
        running: false,
        tabId: null,
        modelLoading: false,
        modelReady: failedWhileLoading ? false : captionState.modelReady,
        loadStats: {
          ...(captionState.loadStats || {}),
          lastAt: Date.now(),
          stage: 'error'
        },
        status: 'error',
        error: message.error || 'Unknown error'
      };
      await publishState();
      sendResponse({ ok: false, error: captionState.error });
      return;
    }

    if (message.type === 'OFFSCREEN_RUNTIME_WARNING') {
      appendLoadLog(`runtime warning: ${message.warning || 'Unknown warning'}`);
      await publishState();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'OFFSCREEN_TRANSCRIPT') {
      if (!captionState.running || message.tabId !== captionState.tabId) {
        sendResponse({ ok: true });
        return;
      }

      chrome.tabs
        .sendMessage(captionState.tabId, {
          type: 'SUBTITLE_TEXT',
          text: message.text || ''
        })
        .catch(() => {
          // Ignore if target tab can't receive at this moment.
        });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })().catch(async (error) => {
    appendLoadLog(`error: ${error.message || String(error)}`);
    const previousTabId = captionState.tabId;
    if (captionState.running || typeof previousTabId === 'number') {
      try {
        await sendToOffscreen({ type: 'STOP_CAPTURE' });
      } catch {
        // Ignore if offscreen is unavailable.
      }
    }
    if (typeof previousTabId === 'number') {
      chrome.tabs.sendMessage(previousTabId, { type: 'CLEAR_SUBTITLES' }).catch(() => {});
    }
    captionState = {
      ...captionState,
      running: false,
      tabId: null,
      modelLoading: false,
      status: 'error',
      error: error.message || String(error)
    };
    await publishState();
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

chrome.runtime.onStartup.addListener(async () => {
  const stored = await chrome.storage.session.get('captionState');
  await hydrateInstalledModels();
  const installedModels = normalizeInstalledModels(captionState.installedModels);
  if (stored?.captionState) {
    const storedModel = stored.captionState.model || captionState.model;
    const storedLanguage = isEnglishOnlyModel(storedModel)
      ? 'en'
      : normalizeLanguageSelection(stored.captionState.language || 'en');
    const storedTuning = sanitizeTuning(stored.captionState.tuning, DEFAULT_TUNING);
    captionState = {
      ...captionState,
      ...stored.captionState,
      language: storedLanguage,
      tuning: storedTuning,
      installedModels: installedModels.length > 0 ? installedModels : normalizeInstalledModels(stored.captionState.installedModels),
      running: false,
      tabId: null,
      modelLoading: false,
      status: stored.captionState.modelReady ? 'model ready' : 'idle'
    };
    await publishState();
  } else {
    captionState = {
      ...captionState,
      tuning: sanitizeTuning(null, DEFAULT_TUNING),
      installedModels
    };
    await publishState();
  }
});
