// Simple send page (send.html): choose a file, confirm the photosensitivity
// warning, and the file is shown as a loop of frames until "停止". Uses the
// measured operating point of P1 (SPEC §3, §10.1): 33.3 ms per logical frame
// plus a 16.7 ms guard, inner FEC rate 2, the random linear outer code.

import { PROFILES, RENDER_LEVELS } from '../common/profiles.js';
import { prepareTransfer, buildCarouselFrame, DEFAULT_MAX_OBJECT_BYTES, OUTER_CODE_RLNC } from '../common/object-frame.js';
import { linearMeanGray } from '../common/luminance.js';
import { WakeLock } from '../common/wake-lock.js';
import { writeSymbolsRgba } from '../sender/mapper.js';
import { CanvasRenderer } from '../sender/renderer-canvas.js';
import { FrameClock } from '../sender/frame-clock.js';

const PROFILE = PROFILES.P1;
const FEC_RATE = 2;
const FRAME_MS = 1000 / 30; // content of one logical frame
const GUARD_MS = 1000 / 60; // gray guard after it
const MANIFEST_INTERVAL_MS = 2000;
const SECONDS_PER_MIB = [25, 30]; // handheld, measured

const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'),
  error: $('error'),
  drop: $('drop'),
  file: $('file'),
  fileInfo: $('file-info'),
  size: $('size'),
  start: $('start'),
  sending: $('sending'),
  sendInfo: $('send-info'),
  fullscreen: $('fullscreen'),
  stop: $('stop'),
  stage: $('stage'),
  canvas: $('screen'),
  warning: $('warning'),
  warningRate: $('warning-rate'),
  warningOk: $('warning-ok'),
  warningCancel: $('warning-cancel'),
};

const levels = RENDER_LEVELS[PROFILE.levels];
const guardGray = linearMeanGray(levels);
const state = {
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
const symbols = new Uint8Array(PROFILE.gridWidth * PROFILE.gridHeight);
const imageData = new ImageData(PROFILE.gridWidth, PROFILE.gridHeight);

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

function showError(message) {
  els.error.textContent = message ?? '';
  els.error.hidden = !message;
}

// Refresh counts closest to the target durations (SPEC §10.1): 2 + 1 at 60 Hz.
function timing() {
  const hz = clock.refreshHz ?? 60;
  return { dwell: Math.max(1, Math.round((FRAME_MS * hz) / 1000)), guard: Math.max(1, Math.round((GUARD_MS * hz) / 1000)), hz };
}

// ---------------------------------------------------------------- file

async function loadFile(file) {
  showError(null);
  if (file.size > DEFAULT_MAX_OBJECT_BYTES) {
    showError(`ファイルが大きすぎます（${fmtBytes(file.size)}）。${fmtBytes(DEFAULT_MAX_OBJECT_BYTES)} までです`);
    return;
  }
  els.fileInfo.textContent = '読み込み中…';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    state.file = { bytes, name: file.name, mime: file.type, sha256 };
  } catch (e) {
    state.file = null;
    els.fileInfo.textContent = '';
    showError(`ファイルを読めませんでした: ${e.message}`);
    return;
  }
  const mib = state.file.bytes.length / 1048576;
  const [lo, hi] = SECONDS_PER_MIB.map((s) => Math.max(3, Math.round(s * mib)));
  els.fileInfo.textContent = `${state.file.name}（${fmtBytes(state.file.bytes.length)}）受け取りの目安: ${lo === hi ? `約 ${lo}` : `${lo}〜${hi}`} 秒`;
  els.start.disabled = false;
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
  buildCarouselFrame(state.transfer, slot, symbols);
  writeSymbolsRgba(symbols, PROFILE.levels, imageData.data, levels);
  renderer.render(imageData, levels[0]);
}

// Guard: the outline (the receiver keeps tracking) around uniform gray.
function drawGuard() {
  const { gridWidth: w, gridHeight: h } = PROFILE;
  const d = imageData.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x === 0 || y === 0 || x === w - 1 || y === h - 1 ? levels[levels.length - 1] : guardGray;
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  renderer.render(imageData, levels[0]);
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
  els.warningRate.textContent = hz.toFixed(0);
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
    showError(`全画面にできませんでした: ${e.message}`);
  }
}

async function start() {
  if (state.running || !state.file) return;
  const t = timing();
  if (!state.warned) {
    if (!(await confirmWarning(t.hz / (t.dwell + t.guard)))) return;
    state.warned = true;
  }
  const periodMs = ((t.dwell + t.guard) * 1000) / t.hz;
  const f = state.file;
  try {
    state.transfer = prepareTransfer({
      profile: PROFILE,
      fec: FEC_RATE,
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
  renderer.maxScale = Number(els.size.value) || Infinity;
  state.timing = t;
  state.startVsync = clock.vsync;
  state.frame = -1;
  state.running = true;
  els.setup.hidden = true;
  els.sending.hidden = false;
  document.body.classList.add('transmitting');
  els.sendInfo.textContent = `送信中: ${f.name}（${fmtBytes(f.bytes.length)}）— スマホで受け取りが終わったら「停止」`;
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
