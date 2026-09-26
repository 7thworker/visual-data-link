// Simple send page (send.html): choose a file and a mode, confirm the
// photosensitivity warning, and the file is shown as a loop of frames until
// "停止". The modes are measured operating points (SPEC §3, §10.1), all with
// the random linear outer code; the receive page tells them apart by the
// profile ID in the frame headers.

import { PROFILES, RENDER_LEVELS } from '../common/profiles.js';
import { paletteFor, writeSymbolsRgbPalette } from '../common/color.js';
import { encodeQr, drawQr } from '../common/qr.js';
import { receivePageUrl } from './receive-url.js';
import { prepareTransfer, buildCarouselFrame, DEFAULT_MAX_OBJECT_BYTES, OUTER_CODE_RLNC } from '../common/object-frame.js';
import { linearMeanGray } from '../common/luminance.js';
import { WakeLock } from '../common/wake-lock.js';
import { writeSymbolsRgba } from '../sender/mapper.js';
import { CanvasRenderer } from '../sender/renderer-canvas.js';
import { FrameClock } from '../sender/frame-clock.js';

// frameMs: content of one logical frame; guardMs: gray guard after it;
// secondsPerMiB: measured handheld on the two test phones (2026-09);
// maxScale: fixed pattern size in display px per cell (null = the size
// chosen). The colour modes stay small: the red of their fine pattern
// flickers within the WCAG red-flash limit only while the pattern is small in
// the field of view (tools/flash-check.mjs, SPEC §16.3).
const MODES = Object.freeze({
  // 8 colours, 50 ms frames: whatever the camera phase, nearly every frame
  // gets one clean capture. Upright or sideways on both phones.
  standard: { profile: PROFILES.P3, fec: 3, frameMs: 50, guardMs: 0, secondsPerMiB: [12, 25], maxScale: 6 },
  // Finer grid: upright only on the newer phone, sideways on both.
  fast: { profile: PROFILES.P4, fec: 3, frameMs: 50, guardMs: 0, secondsPerMiB: [9, 17], maxScale: 6 },
  // Gray 4-PAM (P1, the freeze candidate), as before 2026-09-27.
  compat: { profile: PROFILES.P1, fec: 2, frameMs: 1000 / 30, guardMs: 1000 / 60, secondsPerMiB: [25, 30], maxScale: null },
});
const MODE_KEY = 'vdl-send-mode';
const MANIFEST_INTERVAL_MS = 2000;

const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'),
  error: $('error'),
  drop: $('drop'),
  file: $('file'),
  fileInfo: $('file-info'),
  size: $('size'),
  mode: $('mode'),
  setupQr: $('setup-qr'),
  sendingQr: $('sending-qr'),
  qrToggle: $('qr-toggle'),
  start: $('start'),
  sending: $('sending'),
  sendInfo: $('send-info'),
  fullscreen: $('fullscreen'),
  stop: $('stop'),
  stage: $('stage'),
  canvas: $('screen'),
  warning: $('warning'),
  warningOk: $('warning-ok'),
  warningCancel: $('warning-cancel'),
};

const state = {
  mode: MODES.standard,
  file: null, // { bytes, name, mime, sha256 }
  transfer: null,
  running: false,
  warned: false,
  timing: null, // { dwell, guard } in refreshes
  startVsync: 0,
  frame: -1,
  showingGuard: false,
};
const wakeLock = new WakeLock();
const renderer = new CanvasRenderer(els.canvas);
const clock = new FrameClock(onTick);
// Per mode: gray levels or colour palette, and the frame buffers.
let draw = null;
function prepareDrawing(mode) {
  const p = mode.profile;
  const palette = paletteFor(null, p);
  const levels = RENDER_LEVELS[p.levels];
  draw = {
    palette,
    levels,
    guardGray: palette ? null : linearMeanGray(levels),
    margin: palette ? palette[0][0] : levels[0],
    symbols: new Uint8Array(p.gridWidth * p.gridHeight),
    imageData: new ImageData(p.gridWidth, p.gridHeight),
  };
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

// Japanese text with the English under it (textContent only: file names are user data).
function setText(el, ja, en) {
  const span = document.createElement('span');
  span.className = 'en';
  span.lang = 'en';
  span.textContent = en;
  el.replaceChildren(ja, span);
}

function showError(message) {
  els.error.textContent = message ?? '';
  els.error.hidden = !message;
}

// Refresh counts closest to the target durations (SPEC §10.1), e.g. 3 + 0
// or 2 + 1 at 60 Hz.
function timing(mode) {
  const hz = clock.refreshHz ?? 60;
  return { dwell: Math.max(1, Math.round((mode.frameMs * hz) / 1000)), guard: mode.guardMs ? Math.max(1, Math.round((mode.guardMs * hz) / 1000)) : 0, hz };
}

// ---------------------------------------------------------------- file

async function loadFile(file) {
  showError(null);
  if (file.size > DEFAULT_MAX_OBJECT_BYTES) {
    showError(`ファイルが大きすぎます（${fmtBytes(file.size)}）。${fmtBytes(DEFAULT_MAX_OBJECT_BYTES)} までです / The file is too large (${fmtBytes(file.size)}); the limit is ${fmtBytes(DEFAULT_MAX_OBJECT_BYTES)}`);
    return;
  }
  setText(els.fileInfo, '読み込み中…', 'Loading…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    state.file = { bytes, name: file.name, mime: file.type, sha256 };
  } catch (e) {
    state.file = null;
    els.fileInfo.textContent = '';
    showError(`ファイルを読めませんでした / Could not read the file: ${e.message}`);
    return;
  }
  showFileInfo();
  els.start.disabled = false;
}

function showFileInfo() {
  if (!state.file) return;
  const mib = state.file.bytes.length / 1048576;
  const [lo, hi] = state.mode.secondsPerMiB.map((s) => Math.max(3, Math.round(s * mib)));
  const secs = lo === hi ? `${lo}` : `${lo}〜${hi}`;
  setText(els.fileInfo, `${state.file.name}（${fmtBytes(state.file.bytes.length)}）受け取りの目安: ${lo === hi ? '約 ' : ''}${secs} 秒`, `Estimated reception time: ${lo === hi ? 'about ' : ''}${secs.replace('〜', '–')} s`);
}

// The chosen mode is kept for the next visit.
function selectMode(key) {
  state.mode = MODES[key] ?? MODES.standard;
  els.mode.value = MODES[key] ? key : 'standard';
  try {
    localStorage.setItem(MODE_KEY, els.mode.value);
  } catch {
    // Storage unavailable: the choice is simply not kept.
  }
  // Fixed size: shown as "小さめ" and not selectable.
  if (state.mode.maxScale) els.size.value = String(state.mode.maxScale);
  els.size.disabled = !!state.mode.maxScale;
  showFileInfo();
}
els.mode.addEventListener('change', () => selectMode(els.mode.value));
try {
  selectMode(localStorage.getItem(MODE_KEY) ?? 'standard');
} catch {
  selectMode('standard');
}

els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) loadFile(f);
});
for (const type of ['dragenter', 'dragover']) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
}
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ---------------------------------------------------------------- rendering

function drawFrame(slot) {
  const { symbols, imageData } = draw;
  buildCarouselFrame(state.transfer, slot, symbols);
  if (draw.palette) writeSymbolsRgbPalette(symbols, draw.palette, imageData.data);
  else writeSymbolsRgba(symbols, state.transfer.profile.levels, imageData.data, draw.levels);
  renderer.render(imageData, draw.margin);
}

// Guard (gray modes): the outline (the receiver keeps tracking) around uniform gray.
function drawGuard() {
  const { levels, guardGray, imageData } = draw;
  const { gridWidth: w, gridHeight: h } = state.transfer.profile;
  const d = imageData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? levels[levels.length - 1] : guardGray;
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  renderer.render(imageData, draw.margin);
}

function onTick(vsync) {
  if (!state.running) return;
  const { dwell, guard } = state.timing;
  const n = vsync - state.startVsync;
  const slot = Math.floor(n / (dwell + guard));
  const inGuard = n % (dwell + guard) >= dwell;
  if (slot !== state.frame) {
    state.frame = slot;
    state.showingGuard = false;
    drawFrame(slot);
  } else if (inGuard && !state.showingGuard) {
    state.showingGuard = true;
    drawGuard();
  }
}

// ---------------------------------------------------------------- run control

function confirmWarning(hz) {
  for (const el of document.querySelectorAll('.warning-rate')) el.textContent = hz.toFixed(0);
  els.warning.hidden = false;
  els.warningOk.focus();
  return new Promise((resolve) => {
    const done = (ok) => {
      els.warning.hidden = true;
      els.warningOk.removeEventListener('click', onOk);
      els.warningCancel.removeEventListener('click', onCancel);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    els.warningOk.addEventListener('click', onOk);
    els.warningCancel.addEventListener('click', onCancel);
  });
}

const isFullscreen = () => !!(document.fullscreenElement ?? document.webkitFullscreenElement);

async function toggleFullscreen() {
  try {
    if (isFullscreen()) await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    else await (els.stage.requestFullscreen?.({ navigationUI: 'hide' }) ?? els.stage.webkitRequestFullscreen?.());
  } catch (e) {
    showError(`全画面にできませんでした / Could not enter full screen: ${e.message}`);
  }
}

async function start() {
  if (state.running || !state.file) return;
  const mode = state.mode;
  const t = timing(mode);
  if (!state.warned) {
    if (!(await confirmWarning(t.hz / (t.dwell + t.guard)))) return;
    state.warned = true;
  }
  const periodMs = ((t.dwell + t.guard) * 1000) / t.hz;
  const f = state.file;
  try {
    state.transfer = prepareTransfer({
      profile: mode.profile,
      fec: mode.fec,
      // A new object gets a new random session ID (SPEC §12).
      sessionId: crypto.getRandomValues(new Uint32Array(1))[0],
      bytes: f.bytes,
      sha256: f.sha256,
      name: f.name,
      mime: f.mime,
      manifestEvery: Math.max(1, Math.min(120, Math.floor(MANIFEST_INTERVAL_MS / periodMs) - 1)),
      outerCode: OUTER_CODE_RLNC,
    });
  } catch (e) {
    showError(e.message);
    return;
  }
  prepareDrawing(mode);
  renderer.maxScale = mode.maxScale ?? (Number(els.size.value) || Infinity);
  state.timing = t;
  state.startVsync = clock.vsync;
  state.frame = -1;
  state.running = true;
  els.setup.hidden = true;
  els.sending.hidden = false;
  document.body.classList.add('transmitting');
  setText(els.sendInfo, `送信中: ${f.name}（${fmtBytes(f.bytes.length)}）— スマホで受け取りが終わったら「停止」`, 'Sending — press "Stop" once the phone has received the file');
  await wakeLock.acquire();
}

async function stop() {
  if (!state.running) return;
  state.running = false;
  document.body.classList.remove('transmitting');
  if (isFullscreen()) await toggleFullscreen();
  els.sending.hidden = true;
  els.setup.hidden = false;
  await wakeLock.release();
}

// ---------------------------------------------------------------- receive page QR

// Always under the start button; while sending, on request in a strip above
// the pattern (the stage shrinks and the renderer lays the pattern out again).
receivePageUrl().then((url) => {
  if (!url) return;
  const qr = encodeQr(url, { ecl: 'M' });
  drawQr($('setup-qr-canvas'), qr, 6);
  drawQr($('sending-qr-canvas'), qr, 6);
  $('setup-qr-url').textContent = url;
  els.setupQr.hidden = false;
  els.qrToggle.hidden = false;
});
els.qrToggle.addEventListener('click', () => {
  els.sendingQr.hidden = !els.sendingQr.hidden;
});

els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) wakeLock.acquire();
});
clock.start();
