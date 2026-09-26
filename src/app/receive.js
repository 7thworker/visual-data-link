// Simple receive page (receive.html): camera on, the screen is found and the
// file reception starts by itself, then the file can be saved. Uses the
// experimental receiver's controller (M1Controller) with the recommended
// settings: physical back camera at 3840 × 2160 / 30 fps, GPU sampling,
// profile identified from the frame headers (no sender config).

import { WakeLock } from '../common/wake-lock.js';
import { collectEnvironment, downloadJson, timestampForFilename } from '../common/export.js';
import { hasDevServer } from '../common/dev-server.js';
import { uploadLog } from '../common/log-upload.js';
import { isCameraApiAvailable, isVideoFrameCallbackAvailable, listVideoInputs, openCamera, stopStream } from '../receiver/camera.js';
import { PreviewOverlay } from '../receiver/overlay.js';
import { M1Controller } from '../receiver/m1.js';
import { fmtBytes } from '../receiver/transfer-run.js';
import { frameAction } from './receive-logic.js';

const $ = (id) => document.getElementById(id);
const els = {
  error: $('error'),
  message: $('message'),
  detail: $('detail'),
  progress: $('progress'),
  progressLabel: $('progress-label'),
  progressPercent: $('progress-percent'),
  progressFill: $('progress-fill'),
  start: $('start'),
  stop: $('stop'),
  result: $('result'),
  save: $('save'),
  resultInfo: $('result-info'),
  again: $('again'),
  video: $('video'),
  overlay: $('overlay'),
  uploadLogs: $('upload-logs'),
  uploadLogsRow: $('upload-logs-row'),
  saveDiag: $('save-diag'),
  diag: $('diag'),
  sendDiag: $('send-diag'),
  sendCapture: $('send-capture'),
  diagStatus: $('diag-status'),
};

// Virtual multi-lens cameras switch lenses on their own; the physical wide
// camera is preferred (EXPERIMENTS "General conditions").
const VIRTUAL_CAMERA = /デュアル|トリプル|dual|triple/i;
const PHYSICAL_BACK_CAMERA = /^(背面カメラ|back camera)$/i;
const CAMERA = { width: 3840, height: 2160, frameRate: 30 };
const CLOSER_HINT = 'もう少し近づけると速くなります';

const state = {
  cam: null,
  vfcHandle: null,
  rafHandle: null,
  starting: false, // file reception being started
  done: false, // a file was received; the camera is off
  stopped: false, // stopped by the user
  downloadUrl: null,
  uiScheduled: false,
  cameraStartedAt: null,
  frames: 0,
  lastDiagTs: 0,
};
const wakeLock = new WakeLock();

const m1 = new M1Controller({
  video: els.video,
  overlay: new PreviewOverlay(els.video, els.overlay),
  // The controller reads a few experiment controls; this page has none.
  els: { notes: { value: 'receive.html' }, showErrors: { checked: false }, showBad: { checked: false } },
  getCamera: () => state.cam && { label: state.cam.label, settings: state.cam.settings, capabilities: state.cam.capabilities, constraints: state.cam.constraints },
  onStatsChange: scheduleUi,
  useSenderConfig: false,
  // Enabled once the development server has answered (hasDevServer below).
  uploadLogs: false,
});

function showError(message) {
  els.error.textContent = message ?? '';
  els.error.hidden = !message;
}

// ---------------------------------------------------------------- camera

async function openBackCamera(deviceId = null) {
  const cam = await openCamera({ deviceId, ...CAMERA });
  // Labels are known only after permission: switch from a virtual camera to the physical one once.
  if (!deviceId && VIRTUAL_CAMERA.test(cam.label)) {
    const physical = (await listVideoInputs().catch(() => [])).find((d) => PHYSICAL_BACK_CAMERA.test(d.label));
    if (physical) {
      stopStream(cam.stream);
      return openCamera({ deviceId: physical.deviceId, ...CAMERA });
    }
  }
  return cam;
}

async function startCamera() {
  showError(null);
  if (!isCameraApiAvailable()) {
    showError('このブラウザではカメラを使えません（HTTPS で開いているか確認してください）');
    return;
  }
  els.start.disabled = true;
  try {
    state.cam = await openBackCamera();
  } catch (e) {
    els.start.disabled = false;
    showError(`カメラを開けませんでした: ${e.name}: ${e.message}`);
    return;
  }
  state.cam.settings = state.cam.track.getSettings();
  state.cameraStartedAt = performance.now();
  state.frames = 0;
  els.video.srcObject = state.cam.stream;
  try {
    await els.video.play();
  } catch (e) {
    showError(`映像を再生できませんでした: ${e.message}`);
  }
  state.done = false;
  state.stopped = false;
  m1.clearTransferResult();
  await m1.loadConfig();
  m1.startAuto();
  startLoop();
  await wakeLock.acquire();
  scheduleUi();
}

async function stopCamera() {
  stopLoop();
  if (state.cam) {
    stopStream(state.cam.stream);
    els.video.srcObject = null;
    state.cam = null;
  }
  await wakeLock.release();
  scheduleUi();
}

function startLoop() {
  const video = els.video;
  if (isVideoFrameCallbackAvailable()) {
    const cb = (now, meta) => {
      onFrame(now, meta);
      state.vfcHandle = video.requestVideoFrameCallback(cb);
    };
    state.vfcHandle = video.requestVideoFrameCallback(cb);
  } else {
    let lastTime = -1;
    const cb = (now) => {
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        onFrame(now, null);
      }
      state.rafHandle = requestAnimationFrame(cb);
    };
    state.rafHandle = requestAnimationFrame(cb);
  }
}

function stopLoop() {
  if (state.vfcHandle !== null) els.video.cancelVideoFrameCallback?.(state.vfcHandle);
  if (state.rafHandle !== null) cancelAnimationFrame(state.rafHandle);
  state.vfcHandle = null;
  state.rafHandle = null;
}

function onFrame(now, meta) {
  if (!state.cam || state.done) return;
  state.frames++;
  m1.onFrame(now, meta);
  if (now - state.lastDiagTs > 500) {
    state.lastDiagTs = now;
    renderDiagnostics();
  }
  const action = frameAction(state, m1);
  if (action === 'finish') {
    state.done = true;
    showResult(m1.receivedObject());
    stopCamera();
  } else if (action === 'start') {
    // As soon as the screen is locked and its profile read from a header.
    state.starting = true;
    m1.startTransfer(1).finally(() => {
      state.starting = false;
      scheduleUi();
    });
  }
}

// ---------------------------------------------------------------- UI

function showResult(obj) {
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  // Never opened automatically (SPEC §16.2): the user saves it.
  state.downloadUrl = URL.createObjectURL(new Blob([obj.data], { type: 'application/octet-stream' }));
  els.save.href = state.downloadUrl;
  els.save.download = obj.name;
  els.save.textContent = `保存: ${obj.name}（${fmtBytes(obj.size)}）`;
  els.resultInfo.textContent = `内容を確認済み（SHA-256 ${obj.sha256.slice(0, 16)}…）`;
}

function scheduleUi() {
  if (state.uiScheduled) return;
  state.uiScheduled = true;
  requestAnimationFrame(() => {
    state.uiScheduled = false;
    renderUi();
  });
}

function renderUi() {
  const p = m1.transferProgress();
  const receiving = !!m1.transfer;
  let message;
  let detail = '';
  if (state.done) {
    message = 'ファイルを受け取りました。';
  } else if (state.stopped) {
    message = '中止しました。「カメラを起動」でやり直せます。';
  } else if (!state.cam) {
    message = '「カメラを起動」を押して、送信画面にスマホを向けてください。';
  } else if (receiving) {
    message = '受信中です。送信画面に向けたままにしてください。';
    if (m1.statusText().includes(CLOSER_HINT)) detail = `${CLOSER_HINT}（送信画面が映像の幅いっぱいになるくらいまで）`;
  } else if (m1.quad && m1.locked) {
    message = '送信画面を見つけました。読み取りを始めています…';
  } else {
    message = '送信画面を探しています。白い枠がすべて映るように向けてください。';
    detail = m1.statusText();
  }
  els.message.textContent = message;
  els.detail.textContent = detail;
  const showProgress = receiving || state.done;
  els.progress.hidden = !showProgress || !p;
  if (showProgress && p) {
    els.progress.className = `progress ${p.state}`;
    els.progressFill.style.width = `${Math.round(p.fraction * 100)}%`;
    els.progressPercent.textContent = `${Math.floor(p.fraction * 100)}%`;
    els.progressLabel.textContent = p.label;
  }
  els.result.hidden = !state.done;
  els.start.hidden = !!state.cam || state.done;
  els.start.disabled = false;
  els.stop.hidden = !state.cam;
}

// ---------------------------------------------------------------- diagnostics

function diagnosticLog(reason) {
  const s = state.cam?.settings ?? {};
  return {
    kind: 'vdl-receive-diagnostic',
    reason,
    at: new Date().toISOString(),
    environment: collectEnvironment(),
    camera: state.cam ? { label: state.cam.label, settings: state.cam.settings, capabilities: state.cam.capabilities, constraints: state.cam.constraints } : null,
    video: { width: els.video.videoWidth, height: els.video.videoHeight },
    cameraRequested: CAMERA,
    cameraSettings: { width: s.width ?? null, height: s.height ?? null, frameRate: s.frameRate ?? null },
    secondsSinceCameraStart: state.cameraStartedAt ? (performance.now() - state.cameraStartedAt) / 1000 : null,
    framesProcessed: state.frames,
    receiver: m1.diagnostics(),
  };
}

function renderDiagnostics() {
  const d = m1.diagnostics();
  const s = state.cam?.settings;
  const secs = state.cameraStartedAt ? (performance.now() - state.cameraStartedAt) / 1000 : 0;
  const rows = [
    ['カメラ', state.cam ? `${state.cam.label || '（名前なし）'}` : '停止中'],
    ['映像', els.video.videoWidth ? `${els.video.videoWidth} × ${els.video.videoHeight}${s?.frameRate ? `・${Math.round(s.frameRate)} fps` : ''}` : '-'],
    ['処理', `${d.processing}${d.gpuError ? `（${d.gpuError}）` : ''}、${state.frames} 枚${secs ? `（毎秒 ${(state.frames / secs).toFixed(1)} 枚）` : ''}`],
    ['画面', d.locked ? '捉えている' : d.screenFound ? '見つけたが読めない' : '見つかっていない'],
    ['最後の検出', d.lastDetect ? (d.lastDetect.ok ? '成功' : d.lastDetect.reason) : '-'],
    ['最後の読み取り', d.lastCapture ? `${d.lastCapture.ok ? '成功' : d.lastCapture.reason}${d.lastCapture.pixelsPerCell ? `・1 セル ${d.lastCapture.pixelsPerCell.toFixed(1)} px` : ''}` : '-'],
    ['プロファイル', `${d.profile ?? '-'}${d.profileConfirmed ? '（ヘッダで確認）' : ''}`],
  ];
  els.diag.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

async function sendDiagnostics(reason) {
  els.diagStatus.textContent = '送信中…';
  try {
    els.diagStatus.textContent = `送信しました（${await uploadLog(diagnosticLog(reason))}）`;
  } catch (e) {
    els.diagStatus.textContent = `送信できませんでした: ${e.message}`;
  }
}

els.start.addEventListener('click', () => startCamera());
els.stop.addEventListener('click', async () => {
  state.stopped = true;
  // A reception that never started leaves no transfer log: send what the camera and detection saw.
  if (!m1.transfer && m1.uploadLogs) sendDiagnostics('stopped-before-reception');
  m1.stopTransfer();
  await stopCamera();
});
els.sendDiag.addEventListener('click', () => sendDiagnostics('button'));
// Without the development server (e.g. GitHub Pages): kept on the device.
els.saveDiag.addEventListener('click', () => downloadJson(`vdl-receive-diagnostic-${timestampForFilename()}.json`, diagnosticLog('saved')));
// The current camera frame, lossless at full resolution (logs/captures/), to
// see the image quality (focus, noise, processing) on a new device.
els.sendCapture.addEventListener('click', async () => {
  if (!state.cam) {
    els.diagStatus.textContent = '先に「カメラを起動」を押して、送信画面に向けてください';
    return;
  }
  els.sendCapture.disabled = true;
  els.diagStatus.textContent = '撮影画像を送信中…（数秒かかります）';
  await m1.saveCapture();
  els.diagStatus.textContent = m1.captureStatus;
  els.sendCapture.disabled = false;
});
els.again.addEventListener('click', () => {
  m1.clearTransferResult();
  state.done = false;
  startCamera();
});
els.uploadLogs.addEventListener('change', () => {
  m1.uploadLogs = !els.uploadLogsRow.hidden && els.uploadLogs.checked;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.cam) wakeLock.acquire();
});

// Logs and raw captures go to the development server only (none on a static host).
hasDevServer().then((dev) => {
  els.uploadLogsRow.hidden = !dev;
  els.sendDiag.hidden = !dev;
  els.sendCapture.hidden = !dev;
  for (const el of document.querySelectorAll('.dev-note')) el.hidden = !dev;
  m1.uploadLogs = dev && els.uploadLogs.checked;
});

m1.setProcessing('gpu').then(() => {
  scheduleUi();
  renderDiagnostics();
});
renderUi();
renderDiagnostics();
