if (window.top === window && !window.__localWhisperCaptionsLoaded) {
  window.__localWhisperCaptionsLoaded = true;

  const MIN_WIDTH = 260;
  const MIN_HEIGHT = 42;
  const MAX_CAPTION_LINES = 8;
  const SAVE_DEBOUNCE_MS = 140;

  const host = document.createElement('div');
  host.id = 'local-whisper-subtitles';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .panel {
        position: absolute;
        display: grid;
        grid-template-rows: auto 1fr;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(8, 10, 16, 0.9);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
        color: #fff;
        overflow: hidden;
        pointer-events: auto;
        font-family: "Segoe UI", Tahoma, sans-serif;
      }
      .panel.dragging,
      .panel.resizing {
        user-select: none;
        -webkit-user-select: none;
      }
      .drag {
        height: 10px;
        background: rgba(8, 10, 16, 0.9);
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }
      .panel.dragging .drag {
        cursor: grabbing;
      }
      .line {
        padding: 0;
        margin: 0;
        line-height: 1.38;
        font-size: clamp(14px, 2.2vw, 28px);
        text-align: left;
        white-space: normal;
        word-break: break-word;
        overflow-wrap: break-word;
        overflow-x: hidden;
        overflow-y: auto;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
        opacity: 0;
        transition: opacity 0.14s ease;
      }
      .line.visible {
        opacity: 1;
      }
      .status {
        position: absolute;
        left: 50%;
        bottom: 4px;
        transform: translateX(-50%);
        margin: 0;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        color: #eaf0ff;
        background: rgba(8, 10, 16, 0.9);
        opacity: 0;
        transition: opacity 0.14s ease;
        user-select: none;
        pointer-events: none;
        display: none;
      }
      .status.visible {
        display: block;
        opacity: 1;
      }
      .resize-handle {
        position: absolute;
        width: 16px;
        height: 16px;
        right: 0;
        bottom: 0;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 55%, rgba(255, 255, 255, 0.45) 56%);
        pointer-events: auto;
      }
    </style>
    <div class="panel" id="caption-panel">
      <div class="drag" id="caption-drag" aria-label="Drag subtitles"></div>
      <div class="line" id="caption-line"></div>
      <div class="status" id="caption-status"></div>
      <div class="resize-handle" id="caption-resize"></div>
    </div>
  `;

  (document.body || document.documentElement).appendChild(host);

  const panel = shadow.getElementById('caption-panel');
  const dragBar = shadow.getElementById('caption-drag');
  const resizeHandle = shadow.getElementById('caption-resize');
  const line = shadow.getElementById('caption-line');
  const status = shadow.getElementById('caption-status');

  const captionHistory = [];
  let hideStatusTimer = null;
  let currentLayout = null;
  let saveLayoutTimer = null;
  let dragState = null;
  let resizeState = null;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function defaultLayout() {
    const width = Math.min(900, Math.max(MIN_WIDTH, window.innerWidth - 24));
    const height = 84;
    const left = Math.round((window.innerWidth - width) / 2);
    const top = Math.max(8, Math.round(window.innerHeight - height - 56));
    return { left, top, width, height };
  }

  function isLikelyLegacyFullscreenLayout(layout) {
    if (!layout || typeof layout !== 'object') {
      return false;
    }

    const width = Number(layout.width);
    const height = Number(layout.height);
    const top = Number(layout.top);
    const left = Number(layout.left);
    if (![width, height, top, left].every((value) => Number.isFinite(value))) {
      return false;
    }

    return width >= window.innerWidth * 0.95 && height >= window.innerHeight * 0.8 && top <= 8 && left <= 8;
  }

  function isLikelyOversizedLayout(layout) {
    if (!layout || typeof layout !== 'object') {
      return false;
    }

    const height = Number(layout.height);
    if (!Number.isFinite(height)) {
      return false;
    }

    return height >= window.innerHeight * 0.65;
  }

  function normalizeLayout(layout) {
    const base = layout && typeof layout === 'object' ? layout : defaultLayout();
    const rawWidth = Number(base.width);
    const rawHeight = Number(base.height);
    const rawLeft = Number(base.left);
    const rawTop = Number(base.top);

    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 8);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 8);
    const width = Number.isFinite(rawWidth) ? clamp(Math.round(rawWidth), MIN_WIDTH, maxWidth) : maxWidth;
    const height = Number.isFinite(rawHeight) ? clamp(Math.round(rawHeight), MIN_HEIGHT, maxHeight) : MIN_HEIGHT;

    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    const left = Number.isFinite(rawLeft) ? clamp(Math.round(rawLeft), 0, maxLeft) : Math.round(maxLeft / 2);
    const top = Number.isFinite(rawTop) ? clamp(Math.round(rawTop), 0, maxTop) : Math.round(maxTop);

    return { left, top, width, height };
  }

  function queuePersistLayout() {
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
    }

    saveLayoutTimer = setTimeout(() => {
      if (!currentLayout) {
        return;
      }
      chrome.runtime
        .sendMessage({
          type: 'SET_SUBTITLE_LAYOUT',
          layout: currentLayout
        })
        .catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  function applyLayout(layout, persist = false) {
    const normalized = normalizeLayout(layout);
    currentLayout = normalized;
    panel.style.left = `${normalized.left}px`;
    panel.style.top = `${normalized.top}px`;
    panel.style.width = `${normalized.width}px`;
    panel.style.height = `${normalized.height}px`;
    if (persist) {
      queuePersistLayout();
    }
  }

  function showStatus(text, timeoutMs = 2200) {
    if (!text) {
      status.classList.remove('visible');
      status.textContent = '';
      return;
    }

    status.textContent = text;
    status.classList.add('visible');

    if (hideStatusTimer) {
      clearTimeout(hideStatusTimer);
    }
    hideStatusTimer = setTimeout(() => {
      status.classList.remove('visible');
    }, timeoutMs);
  }

  function normalizeCaptionText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripCaptionPunctuation(text) {
    return String(text || '')
      .replace(/[\s.,!?;:'"()[\]{}\-_/\\~`|<>。、，．！？：；「」『』（）［］｛｝…]+/g, '')
      .trim();
  }

  function shouldReplaceLastCaption(lastText, nextText) {
    if (!lastText) {
      return false;
    }

    if (lastText === nextText) {
      return true;
    }

    if (nextText.includes(lastText)) {
      return true;
    }

    if (lastText.includes(nextText)) {
      return true;
    }

    const lastCore = stripCaptionPunctuation(lastText);
    const nextCore = stripCaptionPunctuation(nextText);

    if (!lastCore || !nextCore) {
      return nextText.length >= lastText.length;
    }

    if (nextCore.includes(lastCore)) {
      return true;
    }

    if (lastCore.includes(nextCore)) {
      return true;
    }

    return nextCore.length >= lastCore.length;
  }

  function getCommonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) {
      i += 1;
    }
    return i;
  }

  function isLikelyPartialRegression(lastText, nextText) {
    if (!lastText || !nextText || nextText.length >= lastText.length) {
      return false;
    }

    const lastCore = stripCaptionPunctuation(lastText).toLowerCase();
    const nextCore = stripCaptionPunctuation(nextText).toLowerCase();
    if (!lastCore || !nextCore) {
      return false;
    }

    if (!lastCore.includes(nextCore) && !nextCore.includes(lastCore)) {
      return false;
    }

    const prefix = getCommonPrefixLength(lastCore, nextCore);
    const minLen = Math.min(lastCore.length, nextCore.length);
    if (minLen < 6) {
      return false;
    }

    return prefix / minLen >= 0.75;
  }

  function showCaption(text) {
    const clean = normalizeCaptionText(text);
    if (!clean) {
      return;
    }

    const last = captionHistory[captionHistory.length - 1] || '';
    if (last === clean) {
      return;
    }

    if (isLikelyPartialRegression(last, clean)) {
      return;
    }

    if (shouldReplaceLastCaption(last, clean)) {
      captionHistory[captionHistory.length - 1] = clean;
    } else {
      captionHistory.push(clean);
      while (captionHistory.length > MAX_CAPTION_LINES) {
        captionHistory.shift();
      }
    }

    line.textContent = captionHistory.join(' ');
    line.classList.add('visible');
    requestAnimationFrame(() => {
      line.scrollTop = line.scrollHeight;
    });
  }

  function beginDrag(event) {
    if (event.button !== 0 || !currentLayout) {
      return;
    }

    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: currentLayout.left,
      top: currentLayout.top
    };
    panel.classList.add('dragging');
    event.preventDefault();
  }

  function beginResize(event) {
    if (event.button !== 0 || !currentLayout) {
      return;
    }

    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      width: currentLayout.width,
      height: currentLayout.height
    };
    panel.classList.add('resizing');
    event.preventDefault();
    event.stopPropagation();
  }

  dragBar.addEventListener('mousedown', beginDrag);
  resizeHandle.addEventListener('mousedown', beginResize);

  dragBar.addEventListener('dblclick', () => {
    applyLayout(defaultLayout(), true);
  });

  window.addEventListener('mousemove', (event) => {
    if (dragState) {
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      applyLayout(
        {
          ...currentLayout,
          left: dragState.left + dx,
          top: dragState.top + dy
        },
        false
      );
      return;
    }

    if (resizeState) {
      const dx = event.clientX - resizeState.startX;
      const dy = event.clientY - resizeState.startY;
      applyLayout(
        {
          ...currentLayout,
          width: resizeState.width + dx,
          height: resizeState.height + dy
        },
        false
      );
    }
  });

  window.addEventListener('mouseup', () => {
    if (dragState || resizeState) {
      dragState = null;
      resizeState = null;
      panel.classList.remove('dragging');
      panel.classList.remove('resizing');
      queuePersistLayout();
    }
  });

  window.addEventListener('resize', () => {
    if (!currentLayout) {
      return;
    }
    applyLayout(currentLayout, true);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type) {
      return;
    }

    if (message.type === 'PING_SUBTITLES') {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'SUBTITLE_LAYOUT') {
      applyLayout(message.layout || currentLayout || defaultLayout(), false);
      return;
    }

    if (message.type === 'SUBTITLE_TEXT') {
      showCaption(message.text || '');
      return;
    }

    if (message.type === 'SUBTITLE_STATUS') {
      const statusText = message.error ? `error: ${message.error}` : message.status || 'idle';
      showStatus(statusText);
      return;
    }

    if (message.type === 'CLEAR_SUBTITLES') {
      captionHistory.length = 0;
      line.textContent = '';
      line.scrollTop = 0;
      line.classList.remove('visible');
      showStatus('stopped');
    }
  });

  chrome.runtime
    .sendMessage({ type: 'GET_SUBTITLE_LAYOUT' })
    .then((response) => {
      if (
        response?.ok &&
        response.layout &&
        !isLikelyLegacyFullscreenLayout(response.layout) &&
        !isLikelyOversizedLayout(response.layout)
      ) {
        applyLayout(response.layout, false);
      } else {
        applyLayout(defaultLayout(), true);
      }
    })
    .catch(() => {
      applyLayout(defaultLayout(), false);
    });
}
