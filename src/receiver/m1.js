// Milestone 1: screen acquisition and static-pattern BER measurement
// (ROADMAP M1, EXPERIMENTS Experiment 1). The screen is found automatically
// (detect.js) or from four manual taps; either way the corners are refined to
// the outline edge and tracked on every processed frame.

import { describeProfile, profileFromDescription, RENDER_LEVELS, bitsPerSymbol, PROFILES } from '../common/profiles.js';
import { buildTestFrame, hasPilots, hasHeader, payloadMask } from '../common/test-frame.js';
import { recommendLevels, spacingUniformity, minSeparation } from './calibration.js';
import { PILOT_DEMOD_METHOD, PILOT_GRID_METHOD } from './pilot-demod.js';
import { fetchSenderConfig } from '../common/sender-config.js';
import { collectEnvironment } from '../common/export.js';
import { uploadLog } from '../common/log-upload.js';
import { computeHomography, applyHomography, logicalCorners } from './homography.js';
import { isValidQuad, quadBounds, pixelsPerCell, perspectiveRatios } from './acquisition.js';
import { processRegion, processCapture, orientFreeCellSize, applyOrder, IDENTITY_ORDER, isMirrored } from './pipeline.js';
import { GlSampler, glSupported } from './gl-sampler.js';
import { detectScreen } from './detect.js';
import { Reception } from './reception.js';
import { TransferRun, fmtBytes, outerCodeName } from './transfer-run.js';
import { FORMAT_REVISION } from '../common/protocol.js';
import { WorkerPool, workersSupported } from './worker-pool.js';
import { blockGrid, mapKey, loadMap, saveMap, clearMap } from './reliability-map.js';
import { Measurement } from './measurement.js';
import { describeKernel, DEFAULT_KERNEL } from './sampler.js';
import { DEMOD_METHOD } from './demodulator.js';
import { LUMA_FORMULA } from './image.js';
import { RunningStats } from './metrics.js';

const TRACK_INTERVAL_MS = 150; // processing rate while only tracking (CPU)
const TRACK_INTERVAL_GPU_MS = 30; // with the GPU (~10 ms per capture): every camera frame
const DETECT_INTERVAL_MS = 150; // automatic detection attempts while nothing is locked
// Recovery when a tracked capture fails (#track): wider search on the same
// frame, then detection from scratch (at most this often).
const WIDE_RADIUS_FACTOR = 2.5;
const REDETECT_MIN_INTERVAL_MS = 100;
// The outline stays green unless tracking has failed for this long, so that
// single bad captures (blur, a frame change) do not flash red.
const GREEN_HOLD_MS = 600;
// Profile identification without a sender config (SPEC §4.2: try each known
// layout, accept the one whose header validates), most likely first; failed
// acquisitions before trying the next candidate, and before a confirmed
// profile is given up.
const PROFILE_CANDIDATES = [PROFILES.P1, PROFILES.P2, PROFILES.P0];
const PROFILE_TRY_FAILURES = 3;
const PROFILE_DROP_FAILURES = 60;
// Camera px per cell below which the status suggests moving closer.
const SMALL_PPC = 8.5;
// Per-capture records in the transfer log (~30 per second, i.e. 5+ minutes).
const MAX_TRANSFER_RECORDS = 10000;
const DETECT_SHORT_SIDE = 360; // downscaled short side for detection
const READ_TARGET_PPC = 7; // automatic read scale: camera px per cell after downscaling
const READ_MIN_SCALE = 0.4;
const LOST_AFTER_FAILURES = 3; // consecutive failures before searching again from scratch
const OUT_OF_VIEW_SIDES = ['top', 'right', 'bottom', 'left'];
const MAX_ATTEMPT_FACTOR = 3; // give up after this many attempts per requested capture
const CONFIG_POLL_MS = 2000;
const STATUS_HOLD_MS = 8000;
// A capture whose level contrast (brightest - darkest center) falls below this
// fraction of the run's 90th percentile is classified as blurred: motion blur
// mixes neighboring cells, lifting dark and lowering bright levels.
const BLUR_CONTRAST_RATIO = 0.92;
// Opposite edges differing by more than this suggest an oblique view; the
// first real runs lost most symbols on the far side (EXPERIMENTS Experiment 4).
// With inner and outer FEC a moderately oblique view only slows the transfer,
// so the hint appears only for clearly oblique views (was 3%: shown almost
// always when handheld).
const TILT_WARN = 0.1;
// Warn when more than this fraction of the payload falls into bad camera regions (was 2%).
const BAD_OVERLAP_WARN = 0.15;

// Plain-language hint for an oblique view, or null when roughly frontal.
export function tiltHint({ leftRight, topBottom }) {
  const parts = [];
  if (Math.abs(leftRight - 1) > TILT_WARN) parts.push(`${leftRight > 1 ? '右' : '左'}側が ${Math.round(Math.abs(leftRight - 1) * 100)}% 遠い`);
  if (Math.abs(topBottom - 1) > TILT_WARN) parts.push(`${topBottom > 1 ? '下' : '上'}側が ${Math.round(Math.abs(topBottom - 1) * 100)}% 遠い`);
  return parts.length ? `${parts.join('、')}。スマホをモニタと平行にしてください` : null;
}
const TAP_LABELS = ['左上', '右上', '右下', '左下'];
const EDGE_LABELS = ['上', '右', '下', '左'];

// Plain-language explanation of processCapture / refineCorners failure codes.
export function describeReason(reason) {
  if (!reason) return '';
  const out = reason.match(/^out-of-view-(top|right|bottom|left)$/);
  if (out) {
    const side = EDGE_LABELS[OUT_OF_VIEW_SIDES.indexOf(out[1])];
    return `送信画面の${side}端が映っていません。少し離すか、送信側の「表示サイズ」を小さくしてください`;
  }
  const edge = reason.match(/^edge-(\d)-(not-found|not-outline)$/);
  if (edge) {
    const side = EDGE_LABELS[Number(edge[1])];
    return edge[2] === 'not-found'
      ? `${side}辺の白枠が見つかりません。その辺の角をもう少し正確にタップしてください`
      : `${side}辺で白枠以外の縁を拾っています。送信側をフルスクリーンにするか、角をタップし直してください`;
  }
  return (
    {
      'invalid-quad': 'タップの順番か形が不正です（左上 → 右上 → 右下 → 左下）',
      'parallel-edges': '辺の向きが不正です。タップし直してください',
      'refined-quad-invalid': '補正結果の形が不正です。タップし直してください',
      'moved-too-far': 'タップ位置から離れすぎた縁を拾いました。タップし直してください',
      'homography-failed': '座標変換に失敗しました。タップし直してください',
      'too-few-samples': 'セルを読み取れません。画面全体が映っているか確認してください',
      'outline-mismatch': '外周の白枠とグリッドが合いません。送信側の設定（グリッド）と表示が一致しているか確認してください',
      'orientation-unknown': '画面は見つかりましたが、向きを判定できません（ヘッダを読み取れません）。送信側が送信中か、画面全体がはっきり映っているか確認してください',
      'out-of-view': '送信画面が映像の外に出ています',
    }[reason] ?? reason
  );
}

// Tracking diagnostics, reset per reception / transfer and logged with it.
function newTrackingStats() {
  return {
    captures: 0,
    reasons: {}, // first-attempt failure reasons
    wideRecoveries: 0, // recovered by the wider search on the same frame
    redetectRecoveries: 0, // recovered by detection on the same frame
    detections: 0,
    detectReasons: {},
    lostEvents: 0,
    relockMs: new RunningStats(),
    orientations: new Array(8).fill(0), // CORNER_ORDERS index chosen at each acquisition (4-7: mirrored)
  };
}

const trackingJson = (t) => ({ ...t, relockMs: t.relockMs.toJSON() });

// detect.js failure codes in plain language.
export function describeDetectReason(reason) {
  const out = reason?.match(/^out-of-view-(top|right|bottom|left)$/);
  if (out) return `画面の${EDGE_LABELS[OUT_OF_VIEW_SIDES.indexOf(out[1])]}側が切れています。少し離してください`;
  return (
    {
      'no-bright-region': '明るい画面が見つかりません',
      'region-too-small': '画面が小さすぎます。近づけてください',
      'region-not-quad': '画面の形がはっきりしません',
      'region-not-rectangular': '画面の形がはっきりしません。周りの明るい物が重なっていないか確認してください',
      'aspect-mismatch': '縦横比が送信画面と合いません',
    }[reason] ?? reason
  );
}

const fmtRate = (v) => (v === null || v === undefined ? '-' : v === 0 ? '0' : v.toExponential(2));
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export class M1Controller {
  // deps: { video, overlay, els, getCamera, onStatsChange, useSenderConfig,
  // uploadLogs }. useSenderConfig = false: never fetch the sender config (the
  // simple receive page works from the video alone); uploadLogs = false: keep
  // the logs local.
  constructor(deps) {
    Object.assign(this, deps);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.config = null;
    this.profile = null;
    this.autoProfile = false; // profile identified from the frame headers (no or file config)
    this.profileConfirmed = false;
    this.candidateFailures = 0;
    this.expected = null;
    this.taps = [];
    this.picking = false;
    this.quad = null; // image order, clockwise
    this.order = IDENTITY_ORDER; // frame corners within this.quad (pipeline.js CORNER_ORDERS)
    this.quadOk = false;
    this.locked = false;
    this.failures = 0;
    this.lastProcessTs = 0;
    this.last = null;
    this.lastErrorPoints = [];
    this.run = null;
    this.reception = null; // continuous dynamic-frame reception (Milestone 4)
    this.transfer = null; // file reception (Milestone 6), TransferRun
    this.lastTransfer = null; // log of the last finished file reception
    this.frameTime = 0;
    this.pool = null; // WorkerPool, or null for main-thread processing
    this.gl = null; // GlSampler when processing on the GPU
    this.workerCount = 0;
    this.jobSeq = 0;
    this.lastAppliedJob = 0;
    this.skippedBusy = 0; // camera frames skipped because all workers were busy
    this.readScaleMode = 'auto'; // 'auto' (downscale to ~7 px/cell) or 'full'
    this.readSmoothing = false; // smoothing when downscaling (measured: no benefit)
    this.statusHoldUntil = 0;
    this.status = '送信側の設定を取得してください';
    this.lastTaps = null;
    this.autoMode = true;
    this.lastDetectTs = 0;
    this.lastDetect = null;
    this.map = null; // ReliabilityMap for the current camera / orientation
    this.mapKey = null;
    this.mapGrid = null;
    this.badRects = [];
    this.badOverlap = 0;
    this.smallCanvas = document.createElement('canvas');
    this.smallCtx = this.smallCanvas.getContext('2d', { willReadFrequently: true });
    this.tracking = newTrackingStats();
    this.detectedThisFrame = false;
    this.lastRedetectTs = 0;
    this.lastOkTs = -Infinity;
    this.displayOk = false; // outline color, with GREEN_HOLD_MS hysteresis
    this.lostAt = null;
    this.overlay.onTap = (p) => this.#onTap(p);
    this.overlay.setPicking(false);
  }

  // ------------------------------------------------------------ sender config

  // Returns true when a sender config is available. Without one (or when it
  // announces a file transfer) the receiver works from the video alone: the
  // profile is identified from the frame headers (#identify). Measurements
  // of test patterns still need the config for their ground truth.
  async loadConfig() {
    if (this.useSenderConfig === false) {
      this.#enterAuto();
      return false;
    }
    try {
      const cfg = await fetchSenderConfig();
      if (!cfg) {
        this.#enterAuto();
        return false;
      }
      this.#applyConfig(cfg);
      return true;
    } catch (e) {
      this.#enterAuto(`設定の取得に失敗しました（${e.message}）。`);
      return false;
    }
  }

  // No sender config: file reception with the profile read from the headers.
  #enterAuto(prefix = '') {
    this.config = null;
    this.autoProfile = true;
    if (!this.profile) this.#setProfile(PROFILE_CANDIDATES[0]);
    this.status = `${prefix}送信側の設定なし: 送信画面のヘッダからプロファイルを自動で判定します`;
    this.render();
  }

  #pattern() {
    return this.config?.pattern ?? 'file';
  }

  // Switches the grid being looked for (auto mode: a candidate until a header confirms it).
  #setProfile(profile, confirmed = false) {
    this.profile = profile;
    this.profileConfirmed = confirmed;
    this.candidateFailures = 0;
    this.payload = payloadMask(profile, this.#pattern());
    this.locked = false;
  }

  // Auto mode: a capture whose header decoded confirms (or corrects) the
  // candidate profile; failed acquisitions move on to the next candidate.
  #identify(r) {
    if (!this.autoProfile) return;
    const id = r.headerFields?.profileId;
    if (r.ok && id !== undefined) {
      if (id === this.profile.id) {
        if (!this.profileConfirmed) this.tracking.profileIdentified = { id, name: this.profile.name };
        this.profileConfirmed = true;
        this.candidateFailures = 0;
        return;
      }
      const other = PROFILE_CANDIDATES.find((p) => p.id === id);
      if (other) this.#setProfile(other);
      return;
    }
    // Only captures where the screen outline was located count against the grid.
    if (r.ok || !this.quad || !r.refine?.ok) return;
    // Located but not readable with this grid: after a few tries, the next
    // candidate. A confirmed profile is only dropped after a long run of
    // failures (the sender may have switched profiles).
    this.candidateFailures++;
    const limit = this.profileConfirmed ? PROFILE_DROP_FAILURES : PROFILE_TRY_FAILURES;
    if (this.candidateFailures < limit) return;
    const i = PROFILE_CANDIDATES.indexOf(this.profile);
    this.#setProfile(PROFILE_CANDIDATES[(i + 1) % PROFILE_CANDIDATES.length]);
  }

  #applyConfig(cfg) {
    const changedGrid = !this.config || cfg.profile.gridWidth !== this.config.profile.gridWidth || cfg.profile.gridHeight !== this.config.profile.gridHeight;
    this.config = cfg;
    // A file transfer is identified from its headers; the config's profile is only the first guess.
    this.autoProfile = cfg.pattern === 'file';
    if (this.autoProfile) {
      if (!this.profileConfirmed) this.#setProfile(profileFromDescription(cfg.profile));
      this.expected = null;
      this.status = this.quad ? this.#trackingStatus() : this.#searchingStatus();
      this.render();
      return;
    }
    this.profileConfirmed = true;
    this.profile = profileFromDescription(cfg.profile);
    // File frames have no known content (static measurements are refused for them).
    this.expected =
      cfg.pattern === 'file'
        ? null
        : buildTestFrame({
            pattern: cfg.pattern,
            profile: this.profile,
            sessionId: parseInt(cfg.sessionId, 16) >>> 0,
            sequence: cfg.frame >>> 0,
          });
    this.payload = payloadMask(this.profile, cfg.pattern);
    if (changedGrid) this.locked = false;
    this.status = this.quad ? this.#trackingStatus() : this.#searchingStatus();
    this.render();
  }

  #searchingStatus() {
    if (!this.autoMode) return '「手動で指定」を押して、送信画面の外周の角をタップしてください';
    const d = this.lastDetect;
    const why = d && !d.ok ? `（${describeDetectReason(d.reason)}）` : '';
    return `送信画面を探しています${why}。白い外周枠まで画面全体が映るようにしてください（縦持ち・横持ち・多少の傾きは可）`;
  }

  // Switches back to automatic detection and forgets the current corners.
  startAuto() {
    this.autoMode = true;
    this.picking = false;
    this.overlay.setPicking(false);
    this.taps = [];
    this.quad = null;
    this.locked = false;
    this.last = null;
    this.lastDetectTs = 0;
    this.status = this.#searchingStatus();
    this.render();
  }

  #configWarning() {
    const c = this.config;
    if (!c) return '送信側の設定が未取得です';
    if (c.mode === 'animated' && c.running) return '送信側がアニメーション中です。静止モードにしてください';
    if (c.pattern === 'file' && c.formatRevision !== FORMAT_REVISION) return '送信側のページが古い版です（sender.html を再読み込みしてください）';
    if (c.fullscreen === false) return '送信側がフルスクリーンではありません（ブラウザの枠を外周と取り違えることがあります）';
    if (c.pattern !== 'prbs') return `パターンが ${c.pattern} です（誤り率の測定には PRBS を推奨）`;
    return null;
  }

  // ------------------------------------------------------------ corners

  startPicking() {
    this.autoMode = false;
    this.taps = [];
    this.picking = true;
    this.overlay.setPicking(true);
    this.status = `${TAP_LABELS[0]}の角に触れ、拡大鏡の十字を白枠の外側の角に合わせて指を離してください`;
    this.render();
  }

  resetCorners() {
    this.startAuto();
  }

  #onTap(p) {
    if (!this.picking) return;
    this.taps.push(p);
    if (this.taps.length < 4) {
      this.status = `${TAP_LABELS[this.taps.length]}の角をタップ`;
      this.render();
      return;
    }
    const quad = this.taps.map((t) => [...t]);
    if (!isValidQuad(quad)) {
      this.status = '順番が違うか、形が不正です。左上 → 右上 → 右下 → 左下 の順にタップし直してください';
      this.taps = [];
      this.render();
      return;
    }
    this.picking = false;
    this.overlay.setPicking(false);
    this.lastTaps = quad.map((p) => p.map((v) => +v.toFixed(1)));
    this.quad = quad;
    this.order = IDENTITY_ORDER; // taps are in frame order
    this.locked = false;
    this.failures = 0;
    this.lastProcessTs = 0;
    this.status = '角を補正中…';
    this.render();
  }

  // ------------------------------------------------------------ processing

  #radius(cellSize) {
    const v = this.video;
    const short = Math.min(v.videoWidth, v.videoHeight);
    // Initial taps need a wide search; tracking only has to follow hand motion.
    // Tracking must absorb hand motion between processed frames (~100 ms apart).
    return this.locked ? Math.max(24, 0.03 * short, 3 * cellSize) : this.#unlockedRadius(cellSize);
  }

  #unlockedRadius(cellSize) {
    const v = this.video;
    return Math.max(24, 0.04 * Math.min(v.videoWidth, v.videoHeight), 3 * cellSize);
  }

  // Scale at which the tracked region is read (see READ_TARGET_PPC).
  #readScale(cell) {
    if (this.readScaleMode === 'full') return 1;
    return Math.max(READ_MIN_SCALE, Math.min(1, READ_TARGET_PPC / cell));
  }

  // Reads the region around the quad, downscaled by `scale`; returns the
  // region image and its mapping to camera coordinates (pipeline.processRegion).
  #readRegion(quad, margin, scale = 1) {
    const { x0, y0, w, h } = this.#roi(quad, margin);
    if (w <= 0 || h <= 0) return null;
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    // Nearest-neighbour downscaling is cheapest; the cell kernel averages anyway.
    this.ctx.imageSmoothingEnabled = scale === 1 || this.readSmoothing;
    this.ctx.drawImage(this.video, x0, y0, w, h, 0, 0, cw, ch);
    const { data } = this.ctx.getImageData(0, 0, cw, ch);
    return { img: { data, width: cw, height: ch, x0: 0, y0: 0 }, map: { x0, y0, sx: cw / w, sy: ch / h } };
  }

  // Rough corners from a downscaled full frame (detect.js), in image order.
  #detectCorners() {
    const v = this.video;
    const factor = Math.max(1, Math.min(v.videoWidth, v.videoHeight) / DETECT_SHORT_SIDE);
    const w = Math.round(v.videoWidth / factor);
    const h = Math.round(v.videoHeight / factor);
    if (!w || !h) return null;
    if (this.smallCanvas.width !== w || this.smallCanvas.height !== h) {
      this.smallCanvas.width = w;
      this.smallCanvas.height = h;
    }
    this.smallCtx.imageSmoothingQuality = 'high';
    this.smallCtx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, 0, 0, w, h);
    const small = { data: this.smallCtx.getImageData(0, 0, w, h).data, width: w, height: h, x0: 0, y0: 0 };
    const d = detectScreen(small, v.videoWidth / w, { gridAspect: this.profile.gridWidth / this.profile.gridHeight });
    this.lastDetect = d;
    this.tracking.detections++;
    if (!d.ok) this.tracking.detectReasons[d.reason] = (this.tracking.detectReasons[d.reason] ?? 0) + 1;
    return d;
  }

  #detect(now) {
    this.lastDetectTs = now;
    this.detectedThisFrame = true;
    const d = this.#detectCorners();
    if (!d) return;
    if (d.ok) {
      this.quad = d.corners;
      this.order = IDENTITY_ORDER; // found again by the orientation search
      this.locked = false;
      this.failures = 0;
    } else {
      this.status = this.#searchingStatus();
      this.render();
    }
  }

  // Loads the reliability map for the current camera and video size.
  #ensureMap() {
    const v = this.video;
    if (!v.videoWidth) return;
    const key = mapKey(this.getCamera()?.label, v.videoWidth, v.videoHeight);
    const grid = blockGrid(v.videoWidth, v.videoHeight);
    if (key === this.mapKey && this.mapGrid?.cols === grid.cols && this.mapGrid?.rows === grid.rows) return;
    this.mapKey = key;
    this.mapGrid = grid;
    this.map = loadMap(key, v.videoWidth, v.videoHeight);
    this.badRects = this.map.badRects(grid);
  }

  resetMap() {
    if (this.mapKey) clearMap(this.mapKey);
    this.mapKey = null;
    this.#ensureMap();
    this.render();
  }

  // Cell -> camera-block bookkeeping for one acquired capture: per-block
  // symbol / error counts (for learning) and the erasure mask from the map
  // as it was when the measurement started.
  #blockStats(r, H, badSnapshot) {
    const { gridWidth: w, gridHeight: h } = this.profile;
    const n = this.map.cols * this.map.rows;
    const symbols = new Float32Array(n);
    const errors = new Float32Array(n);
    const erasures = new Uint8Array(w * h);
    const p = [0, 0];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!this.payload[i]) continue;
        applyHomography(H, x + 0.5, y + 0.5, p);
        const b = this.map.blockAt(p[0], p[1], this.mapGrid);
        if (b < 0) continue;
        symbols[b]++;
        if (r.symbols[i] !== this.expected[i]) errors[b]++;
        if (badSnapshot[b]) erasures[i] = 1;
      }
    }
    return { symbols, errors, erasures };
  }

  // Fraction of payload cells falling into bad blocks (sampled).
  #badOverlap(corners) {
    if (!this.map?.badCount) return 0;
    const { gridWidth: w, gridHeight: h } = this.profile;
    const H = computeHomography(logicalCorners(w, h), corners);
    const p = [0, 0];
    let n = 0;
    let bad = 0;
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        applyHomography(H, x + 0.5, y + 0.5, p);
        n++;
        if (this.map.isBad(p[0], p[1], this.mapGrid)) bad++;
      }
    }
    return n ? bad / n : 0;
  }

  // Called for every camera frame by the receiver loop. meta: the
  // requestVideoFrameCallback metadata when available.
  onFrame(now, meta = null) {
    if (!this.profile || this.picking) return;
    this.#ensureMap();
    this.detectedThisFrame = false;
    // Capture timestamp (camera side when the browser provides it).
    this.frameTime = meta?.captureTime ?? now;
    if (this.reception) {
      if (meta?.presentedFrames !== undefined) {
        this.reception.presentedFirst ??= meta.presentedFrames;
        this.reception.presentedLast = meta.presentedFrames;
      }
      if (now >= this.reception.endTs) {
        this.#finishReception('completed');
        return;
      }
    }
    if (!this.quad) {
      if (!this.autoMode || now - this.lastDetectTs < DETECT_INTERVAL_MS) return;
      this.#detect(now);
      if (!this.quad) {
        const failed = { ok: false, reason: this.lastDetect?.reason ?? 'not-detected' };
        if (this.reception) this.#recordReception(failed);
        if (this.transfer) this.#recordTransfer(failed);
        return;
      }
    }
    const interval = this.gl ? TRACK_INTERVAL_GPU_MS : TRACK_INTERVAL_MS;
    if (!this.run && !this.reception && !this.transfer && now - this.lastProcessTs < interval) return;
    this.lastProcessTs = now;

    const t0 = performance.now();
    // Until the orientation is known the quad's corner order is the image's.
    const orient = !this.locked && hasHeader(this.#pattern());
    const cell = orient ? orientFreeCellSize(this.quad, this.profile) : pixelsPerCell(applyOrder(this.quad, this.order), this.profile.gridWidth, this.profile.gridHeight).min;
    const radius = this.#radius(cell);
    // Samples outside the image are skipped, so the outline may come within
    // about a cell of the image border.
    const outside = this.#outOfView(this.quad, cell + 4);
    if (outside) {
      this.#fail({ ok: false, reason: `out-of-view-${outside}`, corners: this.quad }, now, t0, radius);
      return;
    }
    const scale = this.#readScale(cell);
    // Comparison decisions only for static measurements (they cost ~2x).
    const compare = !!this.run;
    const options = { pattern: this.#pattern(), compare };
    if (this.gl) {
      try {
        const up = this.gl.upload(this.video);
        const tUp = performance.now();
        let gpuMs = 0;
        const attempt = (quad, rad, o) => {
          const r = processCapture(this.gl, quad, this.profile, { ...options, radius: rad, orient: o, order: this.order });
          gpuMs += this.gl.gpuMs;
          return r;
        };
        const r = this.#track(attempt, radius, orient, cell, now);
        const tEnd = performance.now();
        r.readScale = 1;
        this.#update(r, now, { readMs: up + gpuMs, procMs: tEnd - tUp - gpuMs, totalMs: tEnd - t0, radius });
        return;
      } catch (e) {
        // Context loss or an unsupported feature: continue on the CPU.
        this.poolError = `GPU: ${e?.message ?? e}`;
        this.gl.destroy?.();
        this.gl = null;
      }
    }
    if (this.pool?.usable) {
      this.#submit(now, radius, cell, scale, compare);
      return;
    }
    let readMs = 0;
    const attempt = (quad, rad, o) => {
      const ts = performance.now();
      const region = this.#readRegion(quad, rad + cell + 4, scale);
      readMs += performance.now() - ts;
      if (!region) return { ok: false, reason: 'out-of-view', corners: quad };
      return processRegion(region.img, quad, this.profile, { ...options, radius: rad, orient: o, order: this.order }, region.map);
    };
    const r = this.#track(attempt, radius, orient, cell, now);
    const tEnd = performance.now();
    this.#update(r, now, { readMs, procMs: tEnd - t0 - readMs, totalMs: tEnd - t0, radius });
  }

  // One capture with recovery: when the tracked screen is not found (hand
  // motion beyond the search radius), the same camera frame is searched again
  // with a wider radius and then re-detected from scratch, instead of
  // counting failures over several frames. attempt(quad, radius, orient)
  // runs the receiver chain on the current frame.
  #track(attempt, radius, orient, cell, now) {
    const t = this.tracking;
    t.captures++;
    const r = attempt(this.quad, radius, orient);
    // Located but undecodable (e.g. blurred): nothing to recover for tracking.
    if (r.ok || r.geometryOk) return r;
    t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1;
    if (this.locked) {
      const wide = attempt(this.quad, radius * WIDE_RADIUS_FACTOR, false);
      if (wide.ok) {
        t.wideRecoveries++;
        return wide;
      }
    }
    if (this.autoMode && !this.detectedThisFrame && now - this.lastRedetectTs >= REDETECT_MIN_INTERVAL_MS) {
      this.lastRedetectTs = now;
      const d = this.#detectCorners();
      if (d?.ok) {
        const again = attempt(d.corners, this.#unlockedRadius(cell), hasHeader(this.#pattern()));
        if (again.ok) {
          t.redetectRecoveries++;
          return again;
        }
      }
    }
    return r;
  }

  // ------------------------------------------------------------ worker processing

  // 'gpu', 'main', or a worker count (1-3). Takes effect for the next frames.
  async setProcessing(mode) {
    this.gl?.destroy?.();
    this.gl = null;
    if (mode === 'gpu') {
      await this.setWorkers(0);
      if (!glSupported()) {
        this.poolError = 'このブラウザは WebGL に対応していません';
        return;
      }
      try {
        this.gl = new GlSampler();
      } catch (e) {
        this.poolError = `GPU: ${e?.message ?? e}`;
      }
      return;
    }
    await this.setWorkers(mode === 'main' ? 0 : Number(mode));
  }

  // Number of workers (0 = main thread). Takes effect for the next frames.
  async setWorkers(n) {
    this.pool?.terminate();
    this.pool = null;
    this.workerCount = 0;
    this.poolError = null;
    if (!n) return;
    if (!workersSupported()) {
      this.poolError = 'このブラウザは Worker / OffscreenCanvas に対応していません';
      return;
    }
    const pool = new WorkerPool(n);
    this.pool = pool;
    await pool.ready;
    if (this.pool !== pool) return;
    if (pool.usable) this.workerCount = n;
    else this.poolError = pool.error;
  }

  processingMode() {
    if (this.gl) return 'GPU（WebGL）';
    if (this.pool?.usable) return `Worker × ${this.workerCount}`;
    return `メインスレッド${this.poolError ? `（Worker 不可: ${this.poolError}）` : ''}`;
  }

  #roi(quad, margin) {
    const v = this.video;
    const b = quadBounds(quad, margin);
    const x0 = Math.max(0, Math.floor(b.x0));
    const y0 = Math.max(0, Math.floor(b.y0));
    const x1 = Math.min(v.videoWidth, Math.ceil(b.x1));
    const y1 = Math.min(v.videoHeight, Math.ceil(b.y1));
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  #submit(now, radius, cell, scale, compare) {
    if (!this.pool.hasIdle()) {
      this.skippedBusy++;
      return;
    }
    const roi = this.#roi(this.quad, radius + cell + 4);
    if (roi.w <= 0 || roi.h <= 0) return;
    const jobId = ++this.jobSeq;
    const frameTime = this.frameTime;
    const job = { quad: this.quad.map((p) => [...p]), profile: describeProfile(this.profile), pattern: this.#pattern(), radius, scale, compare, orient: !this.locked && hasHeader(this.#pattern()), order: [...this.order] };
    this.pool
      .run(this.video, roi, job)
      .then(({ r, timing }) => {
        // Results may arrive out of order; only the newest may move the quad.
        const stale = jobId < this.lastAppliedJob;
        if (!stale) this.lastAppliedJob = jobId;
        this.frameTime = frameTime;
        this.#update(r, now, timing, stale);
      })
      .catch((e) => {
        // Fall back to the main thread for good; the reason is shown in the UI.
        this.pool?.fail(e);
        this.poolError = String(e?.message ?? e);
      });
  }

  // Which side of the frame a corner has left (with a margin), or null.
  #outOfView(quad, margin) {
    const { videoWidth: w, videoHeight: h } = this.video;
    for (const [x, y] of quad) {
      if (y < margin) return 'top';
      if (x > w - margin) return 'right';
      if (y > h - margin) return 'bottom';
      if (x < margin) return 'left';
    }
    return null;
  }

  #fail(r, now, t0, radius) {
    const ms = performance.now() - t0;
    this.#update(r, now, { readMs: 0, procMs: ms, totalMs: ms, radius });
  }

  #update(r, now, timing, stale = false) {
    this.last = { ...r, ...timing };
    if (!stale) this.#identify(r);
    this.quadOk = r.ok;
    // Tracking follows every capture whose corners were verified, including
    // captures too blurred to decode (pipeline.js geometryOk), so that a
    // blurry moment on an oblique view does not drop the lock.
    const tracked = r.ok || !!r.geometryOk;
    if (tracked) this.lastOkTs = now;
    this.displayOk = tracked || now - this.lastOkTs < GREEN_HOLD_MS;
    if (stale) {
      // Counted and recorded below, but tracking follows newer results only.
    } else if (tracked) {
      if (!this.locked && r.orientation !== undefined) this.tracking.orientations[r.orientation]++;
      // Image-order corners for tracking, the frame order separately (mirrored views).
      if (r.order) this.order = r.order;
      if (this.lostAt !== null) {
        this.tracking.relockMs.push(now - this.lostAt);
        this.lostAt = null;
      }
      this.quad = r.imageCorners ?? r.corners;
      this.locked = true;
      this.failures = 0;
      this.badOverlap = this.#badOverlap(r.corners);
    } else if (++this.failures >= LOST_AFTER_FAILURES) {
      if (this.locked) {
        this.tracking.lostEvents++;
        this.lostAt = now;
      }
      this.locked = false;
      // In automatic mode a lost screen is searched for again from scratch,
      // also during a measurement (failed attempts are still counted).
      if (this.autoMode) this.quad = null;
    }

    let captureErrors = null;
    const measuring = !!this.run;
    if (measuring) captureErrors = this.#recordCapture(r, now);
    if (this.reception) this.#recordReception(r, timing.totalMs);
    if (this.transfer) this.#recordTransfer(r, timing.totalMs);
    this.lastErrorPoints = captureErrors ?? (r.ok ? this.lastErrorPoints : []);
    // A finished measurement's message stays visible for a while.
    if (!measuring && !this.reception && !this.transfer && now >= this.statusHoldUntil) this.status = this.#trackingStatus();
    this.render();
  }

  // ------------------------------------------------------------ reception (M4)

  async startReception(seconds) {
    if (this.run || this.reception || this.transfer) return;
    if (!(await this.loadConfig())) {
      this.status = '測定には送信側の設定が必要です。PC の sender.html を localhost で開いてください';
      this.render();
      return;
    }
    const c = this.config;
    if (c.pattern !== 'dynamic') {
      this.status = '送信側のパターンを「動的テスト (M4)」にしてください';
      this.render();
      return;
    }
    if (!this.quad || !this.locked) {
      this.status = '送信画面を捉えていません（枠が緑になってから開始してください）';
      this.render();
      return;
    }
    const now = performance.now();
    this.tracking = newTrackingStats();
    this.reception = {
      rx: new Reception(this.profile),
      startedAt: new Date().toISOString(),
      startTs: now,
      endTs: now + seconds * 1000,
      seconds,
      config: c,
      camera: this.getCamera(),
      processingMs: new RunningStats(),
      presentedFirst: null,
      presentedLast: null,
      skippedBusyAtStart: this.skippedBusy,
      warning: c.mode !== 'animated' || !c.running ? '送信側がアニメーション送信中ではありません' : null,
    };
    this.status = `連続受信中（${seconds} 秒）`;
    this.render();
  }

  stopReception() {
    if (this.reception) this.#finishReception('stopped');
  }

  // Payload cells lying in bad blocks of the reliability map (erasures for FEC).
  #mapErasureCells(r) {
    if (!r.ok || !this.map?.badCount) return null;
    const { gridWidth: w, gridHeight: h } = this.profile;
    const H = computeHomography(logicalCorners(w, h), r.corners);
    const out = new Uint8Array(w * h);
    const p = [0, 0];
    for (let i = 0; i < out.length; i++) {
      if (!this.payload[i]) continue;
      applyHomography(H, (i % w) + 0.5, Math.floor(i / w) + 0.5, p);
      if (this.map.isBad(p[0], p[1], this.mapGrid)) out[i] = 1;
    }
    return out;
  }

  #recordReception(r, totalMs = null) {
    const rec = this.reception;
    rec.rx.add(this.frameTime, r, { cellErasures: this.#mapErasureCells(r) });
    if (totalMs !== null) rec.processingMs.push(totalMs);
    const s = rec.rx.counts;
    const left = Math.max(0, Math.ceil((rec.endTs - performance.now()) / 1000));
    this.status = `連続受信中 残り ${left} 秒｜正常 ${s.clean}・重複 ${s.duplicate}・遷移 ${s.transition}・劣化 ${s.degraded}・区切り ${s.guard}・ヘッダ失敗 ${s['no-header']}・取得失敗 ${s['acquisition-failed']}`;
  }

  #finishReception(outcome) {
    const rec = this.reception;
    this.reception = null;
    const s = rec.rx.summary();
    const cameraFrames = rec.presentedFirst !== null ? rec.presentedLast - rec.presentedFirst + 1 : null;
    const refreshHz = rec.config.refreshHz ?? 60;
    const dwell = rec.config.dwellRefreshes ?? rec.config.profile.dwellRefreshes;
    const guard = rec.config.guardRefreshes ?? 0;
    const log = {
      kind: 'vdl-m4-reception',
      schemaVersion: 1,
      milestone: 'M4',
      experiment: 'E6-dynamic-frames',
      outcome,
      startedAt: rec.startedAt,
      finishedAt: new Date().toISOString(),
      environment: collectEnvironment(),
      camera: rec.camera,
      video: { width: this.video.videoWidth, height: this.video.videoHeight },
      senderConfig: rec.config,
      profile: describeProfile(this.profile),
      timing: {
        dwellRefreshes: dwell,
        senderRefreshHz: refreshHz,
        dwellMs: (dwell * 1000) / refreshHz,
        guardRefreshes: guard,
        periodMs: ((dwell + guard) * 1000) / refreshHz,
        cameraFrames,
        processedCaptures: s.captures,
        skippedBusy: this.skippedBusy - rec.skippedBusyAtStart,
        processing: this.processingMode(),
        readScaleMode: this.readScaleMode,
        readScale: this.last?.readScale ?? null,
        processingMs: rec.processingMs.toJSON(),
      },
      receiver: { demodulation: PILOT_GRID_METHOD, configWarning: rec.warning },
      tracking: trackingJson(this.tracking),
      summary: s,
      records: rec.rx.records,
      recordsTruncated: rec.rx.recordsTruncated,
      notes: this.els.notes.value,
    };
    this.lastReception = log;
    this.statusHoldUntil = performance.now() + STATUS_HOLD_MS;
    this.status = `連続受信 終了: ${s.framesClean} / ${s.sequenceSpan} フレームを正常受信（${fmt(s.goodLogicalFramesPerSecond)} フレーム/秒）`;
    this.render();
    this.#upload(log)
      .then((file) => {
        this.receptionUpload = `送信済み: ${file}`;
        this.render();
      })
      .catch((e) => {
        this.receptionUpload = `送信失敗: ${e.message}`;
        this.render();
      });
  }

  #fecEntries(s, pct) {
    const f = s.fec;
    const kbps = (v) => (v === null || v === undefined ? '-' : `${fmt(v / 1000, 1)} kbit/s`);
    if (!f) {
      return [['訂正なしで誤り0のフレーム', `${s.framesRawErrorFree} / ${s.sequenceSpan}（使えるデータ ${kbps(s.rawErrorFreeBitsPerSecond)}）`]];
    }
    return [
      ['誤り訂正', `${f.name}：${f.codewordsPerFrame} 個 × RS(${f.n}, ${f.k})、符号化率 ${fmt(f.codeRate, 3)}、1フレーム ${f.dataBytesPerFrame} バイト`],
      ['訂正後に正しく届いたフレーム', `${f.framesDelivered} / ${s.sequenceSpan}（${pct(f.deliveredRate)}）・消失を使わない場合 ${f.framesDeliveredErrorsOnly}`],
      ['実効スループット（訂正後）', `${kbps(f.goodputBitsPerSecond)}（消失を使わない場合 ${kbps(f.goodputErrorsOnlyBitsPerSecond)}）`],
      ['訂正なしで誤り0のフレーム', `${s.framesRawErrorFree} / ${s.sequenceSpan}（使えるデータ ${kbps(s.rawErrorFreeBitsPerSecond)}）`],
      [
        '符号語の復号失敗',
        `${pct(f.codewordFailureRate)}（消失を使わない場合 ${pct(f.codewordFailureRateErrorsOnly)}）・誤訂正 ${f.miscorrections} 件`,
      ],
      ['訂正したバイト / 消失扱い', `1撮影あたり ${fmt(f.correctedPerDecode, 1)} バイト訂正、${pct(f.erasedByteShare)} を消失扱い`],
    ];
  }

  receptionEntries() {
    const log = this.lastReception;
    if (!log || this.reception) return [];
    const s = log.summary;
    const t = log.timing;
    const pct = (v) => (v === null || v === undefined ? '-' : `${fmt(v * 100, 1)}%`);
    return [
      ['連続受信', `${log.outcome}（表示 ${fmt(t.dwellMs)} ms${t.guardRefreshes ? ` + 区切り ${fmt(t.periodMs - t.dwellMs)} ms` : ''}、${fmt(s.durationMs / 1000)} 秒）`],
      ['正常に受信したフレーム', `${s.framesClean} / ${s.sequenceSpan}（${pct(s.cleanFrameRate)}、取りこぼし ${s.framesMissed}）`],
      ['有効フレーム/秒', `${fmt(s.goodLogicalFramesPerSecond, 2)}（送信 ${fmt(1000 / (t.periodMs ?? t.dwellMs), 1)} フレーム/秒）`],
      ['ペイロード速度（誤り訂正前）', s.rawPayloadBitsPerSecond ? `${fmt(s.rawPayloadBitsPerSecond / 1000, 1)} kbit/s（${s.payloadBitsPerFrame} bit/フレーム）` : '-'],
      ['SER / BER（正常フレーム）', `${fmtRate(s.ser)} / ${fmtRate(s.ber)}`],
      [
        '撮影の内訳',
        `正常 ${s.counts.clean}・重複 ${s.counts.duplicate}・遷移 ${s.counts.transition}・劣化 ${s.counts.degraded}・区切り ${s.counts.guard ?? 0}・ヘッダ失敗 ${s.counts['no-header']}・取得失敗 ${s.counts['acquisition-failed']}`,
      ],
      ...this.#fecEntries(s, pct),
      ['1フレームあたりの撮影数', Object.entries(s.capturesPerFrameHistogram).map(([n, c]) => `${n}回: ${c}`).join('、') || '-'],
      ['カメラ / 処理', `カメラ ${t.cameraFrames ?? '-'} 枚中 ${t.processedCaptures} 枚を処理（${t.processing ?? 'メインスレッド'}、1枚 平均 ${fmt(t.processingMs.mean)} ms）`],
      ...(this.receptionUpload ? [['受信ログ', this.receptionUpload]] : []),
    ];
  }

  // ------------------------------------------------------------ file reception (M6)

  async startTransfer(trials) {
    if (this.run || this.reception || this.transfer) return;
    // The sender config is optional here: everything needed travels optically.
    await this.loadConfig();
    const c = this.config;
    if (c && c.pattern !== 'file') {
      this.status = '送信側のパターンを「ファイル転送 (M6)」にしてください';
      this.render();
      return;
    }
    if (c && c.formatRevision !== FORMAT_REVISION) {
      this.status = '送信側のページが古い版のままです。PC の sender.html を再読み込みして、もう一度「開始」してください';
      this.render();
      return;
    }
    if (!this.quad || !this.locked || !this.profileConfirmed) {
      this.status = this.quad && !this.profileConfirmed ? '送信画面のヘッダをまだ読めていません（プロファイルを判定中）。少し待ってから開始してください' : '送信画面を捉えていません（枠が緑になってから開始してください）';
      this.render();
      return;
    }
    this.tracking = newTrackingStats();
    // Acquisition (orientation, profile) happened before the start: record it.
    this.tracking.atStart = {
      order: [...this.order],
      mirrored: isMirrored(this.order),
      profile: this.profile.key,
      profileFromHeader: this.autoProfile,
      camera: this.getCamera()?.label ?? null,
    };
    // Only for the efficiency figure; unknown without a config.
    const schedule = c
      ? {
          periodMs: (((c.dwellRefreshes ?? c.profile.dwellRefreshes) + (c.guardRefreshes ?? 0)) * 1000) / (c.refreshHz ?? 60),
          manifestEvery: c.manifestEvery ?? null,
          fecRate: c.fecRate ?? null,
        }
      : null;
    const tr = new TransferRun(this.profile, { trials, startT: performance.now(), schedule, onFinish: (outcome) => this.#finishTransfer(outcome) });
    Object.assign(tr, {
      startT: performance.now(),
      records: [],
      recordsTruncated: false,
      startedAt: new Date().toISOString(),
      config: c,
      camera: this.getCamera(),
      processingMs: new RunningStats(),
      warning: !c ? '送信側の設定なし（映像だけで受信、プロファイルはヘッダから判定）' : c.mode !== 'animated' || !c.running ? '送信側がアニメーション送信中ではありません' : null,
    });
    this.transfer = tr;
    this.status = tr.statusText(performance.now());
    this.render();
  }

  stopTransfer() {
    if (this.transfer) this.#finishTransfer('stopped');
  }

  // Snapshot of the acquisition for the simple page's diagnostics (receive.js).
  diagnostics() {
    const l = this.last;
    const d = this.lastDetect;
    return {
      processing: this.processingMode(),
      gpuError: this.poolError ?? null,
      profile: this.profile?.key ?? null,
      profileConfirmed: this.profileConfirmed,
      screenFound: !!this.quad,
      locked: this.locked,
      lastDetect: d ? { ok: d.ok, reason: d.reason ?? null } : null,
      lastCapture: l ? { ok: l.ok, reason: l.reason ?? null, pixelsPerCell: l.ppc?.min ?? null, ms: l.totalMs ?? null } : null,
      status: this.status,
      tracking: trackingJson(this.tracking),
    };
  }

  // Forgets the last file reception (progress and received object).
  clearTransferResult() {
    this.lastObject = null;
    this.lastProgress = null;
  }

  #upload(log) {
    return this.uploadLogs === false ? Promise.resolve('（送信しない設定）') : uploadLog(log);
  }

  // Progress bar of the running (or last) file reception, or null.
  transferProgress() {
    return this.transfer?.progress() ?? this.lastProgress ?? null;
  }

  // The last object whose SHA-256 matched ({ data, name, mime, size, sha256, trial }), or null.
  receivedObject() {
    return this.transfer?.lastObject ?? this.lastObject ?? null;
  }

  #recordTransfer(r, totalMs = null) {
    const tr = this.transfer;
    const cls = tr.add(this.frameTime, r, { cellErasures: () => this.#mapErasureCells(r) });
    // Compact per-capture record: [ms since start, class, failure reason, px/cell, left/right, top/bottom].
    if (tr.records.length < MAX_TRANSFER_RECORDS) {
      const p = r.ok ? perspectiveRatios(r.corners) : null;
      tr.records.push([Math.round(this.frameTime - tr.startT), cls, r.ok ? null : r.reason ?? null, r.ppc ? +r.ppc.min.toFixed(1) : null, p && +p.leftRight.toFixed(3), p && +p.topBottom.toFixed(3)]);
    } else {
      tr.recordsTruncated = true;
    }
    if (totalMs !== null) tr.processingMs.push(totalMs);
    if (this.transfer === tr) this.status = tr.statusText(this.frameTime) + (r.ppc && r.ppc.min < SMALL_PPC ? '｜もう少し近づけると速くなります' : '');
  }

  async #finishTransfer(outcome) {
    const tr = this.transfer;
    if (!tr) return;
    this.transfer = null;
    this.lastObject = tr.lastObject;
    const p = tr.progress();
    this.lastProgress = outcome === 'stopped' && p.state !== 'done' ? { ...p, state: 'stopped', label: `停止しました（${p.label}）` } : p;
    // Failure analyses (failure-analysis.js) run in the background after each trial.
    this.status = 'ファイル受信 終了。受信ログをまとめています…';
    this.render();
    await tr.whenAnalyzed();
    const s = tr.summary();
    const log = {
      kind: 'vdl-m6-transfer',
      // 2: trials record outerCode, blockCount, dataFramesUsed, redundant;
      // 3: trials[].failureAnalysis (failure-analysis.js)
      schemaVersion: 3,
      milestone: 'M7',
      outcome,
      startedAt: tr.startedAt,
      finishedAt: new Date().toISOString(),
      environment: collectEnvironment(),
      camera: tr.camera,
      video: { width: this.video.videoWidth, height: this.video.videoHeight },
      senderConfig: tr.config,
      profile: describeProfile(this.profile),
      timing: {
        dwellRefreshes: tr.config ? tr.config.dwellRefreshes ?? tr.config.profile.dwellRefreshes : null,
        guardRefreshes: tr.config ? tr.config.guardRefreshes ?? 0 : null,
        senderRefreshHz: tr.config?.refreshHz ?? null,
        profileIdentifiedFromHeader: this.autoProfile,
        processing: this.processingMode(),
        readScaleMode: this.readScaleMode,
        processingMs: tr.processingMs.toJSON(),
      },
      receiver: { demodulation: PILOT_GRID_METHOD, configWarning: tr.warning },
      tracking: trackingJson(this.tracking),
      summary: s,
      trials: tr.results,
      recordFields: ['ms', 'class', 'reason', 'ppc', 'leftRight', 'topBottom'],
      records: tr.records,
      recordsTruncated: tr.recordsTruncated,
      notes: this.els.notes.value,
    };
    this.lastTransfer = log;
    this.transferUpload = null;
    this.statusHoldUntil = performance.now() + STATUS_HOLD_MS;
    this.status = `ファイル受信 終了: ${s.sha256Matches} / ${s.trialsTarget} 回 SHA-256 一致${s.meanDurationMs ? `（平均 ${fmt(s.meanDurationMs / 1000)} 秒）` : ''}`;
    this.render();
    this.#upload(log)
      .then((file) => {
        this.transferUpload = `送信済み: ${file}`;
        this.render();
      })
      .catch((e) => {
        this.transferUpload = `送信失敗: ${e.message}`;
        this.render();
      });
  }

  transferEntries() {
    const tr = this.transfer;
    const results = tr ? tr.results : this.lastTransfer?.trials;
    if (!results) return [];
    const s = tr ? tr.summary() : this.lastTransfer.summary;
    const kbps = (v) => (Number.isFinite(v) ? `${fmt(v / 1000, 1)} kbit/s` : '-');
    const out = [
      ['ファイル受信', tr ? `受信中（${s.trialsDone} / ${s.trialsTarget} 回 完了）` : `${this.lastTransfer.outcome}（${s.trialsDone} / ${s.trialsTarget} 回 完了）`],
      ['SHA-256 一致', `${s.sha256Matches} 回${s.trialsWithHashMismatch ? `（途中で不一致が出てやり直した回 ${s.trialsWithHashMismatch}）` : ''}`],
    ];
    if (s.meanDurationMs) {
      const eff = s.meanEfficiency ? `・効率 ${fmt(s.meanEfficiency * 100, 0)}%（取りこぼしゼロなら ${fmt(s.minimumMs / 1000)} 秒）` : '';
      out.push(['平均', `${fmt(s.meanDurationMs / 1000)} 秒（最長 ${fmt(s.maxDurationMs / 1000)} 秒）・実効 ${kbps(s.meanGoodputBitsPerSecond)}${eff}`]);
    }
    for (const r of results) {
      const c = r.counts;
      const fecName = r.fecRate ? `・誤り訂正 ${['', '高率', '中', '低'][r.fecRate] ?? r.fecRate}` : '';
      out.push([
        `${r.trial} 回目`,
        `${fmt(r.durationMs / 1000)} 秒${r.efficiency ? `（効率 ${fmt(r.efficiency * 100, 0)}%）` : ''}・${kbps(r.goodputBitsPerSecond)}${fecName}・${r.name}（${fmtBytes(r.size)}、${r.segmentCount} 個、外符号 ${outerCodeName(r.outerCode)}）・撮影 ${r.captures} 枚（新しいデータ ${c.segment}・不要だったデータ ${c.redundant ?? 0}・既知 ${c.known}・訂正失敗 ${c['fec-failed']}・CRC 不一致 ${c['crc-failed']}）・複数撮影の合成で救ったフレーム ${r.fec?.combinedRecoveries ?? 0}・隣のフレームの混ざりを除いて救ったフレーム ${r.fec?.mixedRecoveries ?? 0}（混ざりを検出 ${r.fec?.mixedDetected ?? 0}）`,
      ]);
    }
    if (!tr && this.transferUpload) out.push(['受信ログ', this.transferUpload]);
    return out;
  }

  #trackingStatus() {
    const l = this.last;
    if (!l) return '角を補正中…';
    if (l.ok || l.geometryOk) {
      const tilt = tiltHint(perspectiveRatios(l.corners));
      // Real runs: below ~8.5 camera px per cell a third of the captures fail
      // the inner FEC (22–36% at 7.3–7.6 vs 2–28% at 9.3–11.5).
      const small = l.ppc.min < SMALL_PPC ? '。もう少し近づけて、送信画面が映像の幅いっぱいに映るようにすると速くなります' : '';
      const base = `追従中（${fmt(l.ppc.min)} px/cell）${l.ok ? '' : '。ぼけ・ぶれで読み取れていません'}${small}`;
      if (this.badOverlap > BAD_OVERLAP_WARN) {
        return `${base}。パターンの ${Math.round(this.badOverlap * 100)}% が写りの悪い範囲（橙色）に掛かっています。上下にずらしてください`;
      }
      return tilt ? `${base}。傾き: ${tilt}` : `${base}、正面から撮れています。「測定開始」で計測できます`;
    }
    return `未検出: ${describeReason(l.reason)}`;
  }

  // ------------------------------------------------------------ measurement

  async startMeasurement(count) {
    if (this.run || this.reception || this.transfer) return;
    if (!(await this.loadConfig())) {
      this.status = '測定には送信側の設定が必要です。PC の sender.html を localhost で開いてください';
      this.render();
      return;
    }
    if (this.config.pattern === 'dynamic' || this.config.pattern === 'file') {
      this.status = this.config.pattern === 'file' ? 'ファイル転送は「ファイル受信開始」で受信してください' : '動的テストは「連続受信」で測定してください';
      this.render();
      return;
    }
    const warn = this.#configWarning();
    if (warn && this.config.mode === 'animated') {
      this.status = warn;
      this.render();
      return;
    }
    if (!this.quad || !this.locked) {
      this.status = '送信画面を捉えていません（枠が緑になってから測定してください）';
      this.render();
      return;
    }
    const cam = this.getCamera();
    this.run = {
      target: count,
      attempts: 0,
      acquired: 0,
      startedAt: new Date().toISOString(),
      startTs: performance.now(),
      config: this.config,
      profile: this.profile,
      measurement: new Measurement(this.profile, this.expected, { payload: this.payload }),
      pilots: hasPilots(this.config.pattern),
      pilotCenters: Array.from({ length: this.profile.levels }, () => new RunningStats()),
      map: this.map,
      mapKey: this.mapKey,
      mapBefore: this.map?.summary() ?? null,
      badSnapshot: this.map ? Uint8Array.from(this.map.bad) : null,
      captureBlocks: [],
      captures: [],
      failures: {},
      ppc: new RunningStats(),
      totalMs: new RunningStats(),
      readMs: new RunningStats(),
      camera: cam,
      warning: warn,
    };
    this.status = `測定中 0 / ${count}`;
    this.render();
    this.#pollConfig();
  }

  cancelMeasurement() {
    if (!this.run) return;
    this.#finish('cancelled');
  }

  async #pollConfig() {
    const run = this.run;
    while (this.run === run) {
      await new Promise((r) => setTimeout(r, CONFIG_POLL_MS));
      if (this.run !== run) return;
      try {
        const cfg = await fetchSenderConfig();
        if (cfg && cfg.updatedAt !== run.config.updatedAt) {
          this.#finish('sender-config-changed');
          return;
        }
      } catch {
        // Transient network errors do not invalidate the optical measurement.
      }
    }
  }

  #recordCapture(r, now) {
    const run = this.run;
    run.attempts++;
    const rec = { t: Math.round(now - run.startTs), ok: r.ok, reason: r.reason, totalMs: +this.last.totalMs.toFixed(2), corners: r.corners.map((c) => c.map((v) => +v.toFixed(2))) };
    let errorPoints = null;
    if (r.ok) {
      run.acquired++;
      const H = computeHomography(logicalCorners(this.profile.gridWidth, this.profile.gridHeight), r.corners);
      const blocks = run.map ? this.#blockStats(r, H, run.badSnapshot) : null;
      const res = run.measurement.add(r.symbols, r.values, {
        confidence: r.confidence,
        alternatives: r.alternatives,
        erasures: blocks?.erasures ?? null,
      });
      if (blocks) run.captureBlocks.push({ index: run.captures.length, symbols: blocks.symbols, errors: blocks.errors });
      if (r.pilot) r.pilot.global.forEach((c, l) => run.pilotCenters[l].push(c));
      const pr = perspectiveRatios(r.corners);
      Object.assign(rec, {
        ppc: +r.ppc.min.toFixed(3),
        leftRight: +pr.leftRight.toFixed(4),
        topBottom: +pr.topBottom.toFixed(4),
        outlineMatch: +r.outlineMatch.toFixed(4),
        centers: r.centers.map((c) => +c.toFixed(2)),
        pilotCenters: r.pilot ? r.pilot.global.map((c) => +c.toFixed(2)) : undefined,
        contrast: +(() => {
          const c = r.pilot ? r.pilot.global : r.centers;
          return c[c.length - 1] - c[0];
        })().toFixed(2),
        symbols: res.symbols,
        symbolErrors: res.symbolErrors,
        bitErrors: res.bitErrors,
        unsampled: res.unsampled,
      });
      run.ppc.push(r.ppc.min);
      errorPoints = this.#errorPoints(r);
    } else {
      run.failures[r.reason] = (run.failures[r.reason] ?? 0) + 1;
    }
    run.totalMs.push(this.last.totalMs);
    run.readMs.push(this.last.readMs);
    run.captures.push(rec);

    if (run.acquired >= run.target) this.#finish('completed');
    else if (run.attempts >= run.target * MAX_ATTEMPT_FACTOR) this.#finish('too-many-failures');
    else this.status = `測定中 ${run.acquired} / ${run.target}（試行 ${run.attempts}）`;
    return errorPoints;
  }

  // Cell centers (camera px) of the symbol errors in this capture, for display.
  #errorPoints(r) {
    const { gridWidth: w, gridHeight: h } = this.profile;
    const H = computeHomography(logicalCorners(w, h), r.corners);
    const pts = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (this.payload[i] && r.symbols[i] !== this.expected[i]) pts.push(applyHomography(H, x + 0.5, y + 0.5, [0, 0]));
      }
    }
    return pts.slice(0, 5000);
  }

  #finish(outcome) {
    const run = this.run;
    this.run = null;
    const log = this.#buildLog(run, outcome);
    this.#learnMap(run, log);
    this.lastResult = log;
    this.statusHoldUntil = performance.now() + STATUS_HOLD_MS;
    const s = log.summary;
    this.status =
      outcome === 'completed'
        ? `測定完了: BER ${fmtRate(s.ber)}（${s.bitErrors} / ${s.bits} bit）`
        : `測定終了（${outcome}）: 取得 ${run.acquired} / 試行 ${run.attempts}`;
    this.render();
    this.#upload(log)
      .then((file) => {
        this.uploadStatus = `送信済み: ${file}`;
        this.render();
      })
      .catch((e) => {
        this.uploadStatus = `送信失敗: ${e.message}`;
        this.render();
      });
  }

  // Merges the run's sharp captures into the reliability map and saves it.
  // Blur classification (captures[i].blurred) is set by #buildLog.
  #learnMap(run, log) {
    if (!run.map || run.map !== this.map || !run.captureBlocks.length || log.outcome === 'cancelled') return;
    const n = run.map.cols * run.map.rows;
    const symbols = new Float64Array(n);
    const errors = new Float64Array(n);
    let used = 0;
    for (const cb of run.captureBlocks) {
      if (run.captures[cb.index]?.blurred) continue;
      used++;
      for (let b = 0; b < n; b++) {
        symbols[b] += cb.symbols[b];
        errors[b] += cb.errors[b];
      }
    }
    if (!used) return;
    this.map.merge(symbols, errors);
    saveMap(this.mapKey, this.map);
    this.badRects = this.map.badRects(this.mapGrid);
    log.summary.reliabilityMap = { key: this.mapKey, before: run.mapBefore, after: this.map.summary(), capturesUsed: used, map: this.map.toJSON() };
  }

  // Level calibration from the mean pilot centers of a run (SPEC §6). The
  // recommendation weights the gaps by the per-level spread of payload cells.
  #calibration(run, summary) {
    if (!run.pilots) return null;
    const observed = run.pilotCenters.map((s) => s.mean);
    const rendered = run.config.renderLevels ?? RENDER_LEVELS[run.profile.levels];
    const noise = summary.levelStats?.map((s) => s.std) ?? null;
    return {
      renderLevels: rendered,
      observedCenters: observed,
      observedCenterStd: run.pilotCenters.map((s) => s.std),
      levelNoise: noise,
      spacingUniformity: spacingUniformity(observed),
      minSeparation: minSeparation(observed, noise),
      recommendedLevels: recommendLevels(rendered, observed, { noise }),
      recommendedLevelsEqualSpacing: recommendLevels(rendered, observed),
    };
  }

  // Post-hoc blur classification of the acquired captures (see BLUR_CONTRAST_RATIO).
  #sharpness(run) {
    const ok = run.captures.filter((c) => c.ok && Number.isFinite(c.contrast));
    if (ok.length < 3) return null;
    const sorted = ok.map((c) => c.contrast).sort((a, b) => a - b);
    const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const bps = bitsPerSymbol(run.profile.levels);
    let symbols = 0;
    let symbolErrors = 0;
    let bitErrors = 0;
    let blurred = 0;
    for (const c of ok) {
      c.blurred = c.contrast < BLUR_CONTRAST_RATIO * reference;
      if (c.blurred) {
        blurred++;
        continue;
      }
      symbols += c.symbols;
      symbolErrors += c.symbolErrors;
      bitErrors += c.bitErrors;
    }
    const mean = (k) => ok.reduce((a, c) => a + c[k], 0) / ok.length;
    return {
      meanLeftRight: mean('leftRight'),
      meanTopBottom: mean('topBottom'),
      contrastRatioThreshold: BLUR_CONTRAST_RATIO,
      referenceContrast: reference,
      blurredCaptures: blurred,
      sharpCaptures: ok.length - blurred,
      serSharp: symbols ? symbolErrors / symbols : null,
      berSharp: symbols ? bitErrors / (symbols * bps) : null,
    };
  }

  #buildLog(run, outcome) {
    const s = run.measurement.summary();
    const cam = run.camera;
    const m2 = run.pilots;
    return {
      kind: m2 ? 'vdl-m2-measurement' : 'vdl-m1-measurement',
      schemaVersion: 1,
      milestone: m2 ? 'M2' : 'M1',
      experiment: m2 ? 'E2-static-pam-pilots' : 'E1-static-grid',
      outcome,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      environment: collectEnvironment(),
      camera: cam,
      video: { width: this.video.videoWidth, height: this.video.videoHeight },
      senderConfig: run.config,
      profile: describeProfile(run.profile),
      receiver: {
        acquisition: `${this.autoMode ? 'automatic detection (detect.js)' : 'manual 4-corner taps'}, refined to the outline outer edge per capture`,
        kernel: describeKernel(DEFAULT_KERNEL),
        luma: LUMA_FORMULA,
        demodulation: m2 ? PILOT_GRID_METHOD : DEMOD_METHOD,
        comparison: m2 ? { pilotSurface: PILOT_DEMOD_METHOD, pilotGlobal: 'pilot medians, position-independent', kmeans: DEMOD_METHOD } : null,
        configWarning: run.warning,
      },
      summary: {
        target: run.target,
        attempts: run.attempts,
        acquired: run.acquired,
        acquisitionRate: run.attempts ? run.acquired / run.attempts : null,
        failures: run.failures,
        pixelsPerCell: run.ppc.toJSON(),
        processingMs: run.totalMs.toJSON(),
        readMs: run.readMs.toJSON(),
        ...s,
        sharpness: this.#sharpness(run),
        calibration: this.#calibration(run, s),
      },
      captures: run.captures,
      notes: this.els.notes.value,
    };
  }

  // ------------------------------------------------------------ raw capture archive

  // Lossless full-resolution frame plus the corners, for offline re-evaluation
  // (EXPERIMENTS "Raw capture archive").
  async saveCapture() {
    const v = this.video;
    if (!v.videoWidth || this.captureBusy) return;
    this.captureBusy = true;
    this.captureStatus = '保存中…（数秒かかります）';
    this.status = 'キャプチャを保存中…（数秒かかります）';
    this.statusHoldUntil = Infinity;
    this.render();
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
      const meta = {
        kind: 'vdl-raw-capture',
        capturedAt: new Date().toISOString(),
        video: { width: v.videoWidth, height: v.videoHeight },
        corners: this.quad,
        cornersRefined: this.quadOk,
        taps: this.lastTaps,
        lastResult: this.last && {
          ok: this.last.ok,
          reason: this.last.reason,
          radius: this.last.radius,
          edges: this.last.refine?.edges ?? null,
          outlineMatch: this.last.outlineMatch ?? null,
          centers: this.last.centers ?? null,
        },
        camera: { label: this.getCamera()?.label ?? null },
        senderConfig: this.config && { profile: this.config.profile, pattern: this.config.pattern, sessionId: this.config.sessionId, frame: this.config.frame },
        notes: this.els.notes.value.slice(0, 500),
      };
      const res = await fetch('api/captures', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-VDL-Meta': encodeURIComponent(JSON.stringify(meta)) },
        body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      this.captureStatus = `保存済み: ${body.file}（${(blob.size / 1048576).toFixed(1)} MiB）`;
    } catch (e) {
      this.captureStatus = `保存失敗: ${e.message}`;
    }
    this.captureBusy = false;
    this.captureCount = (this.captureCount ?? 0) + (this.captureStatus.startsWith('保存済み') ? 1 : 0);
    this.status = `キャプチャ${this.captureStatus}`;
    this.statusHoldUntil = performance.now() + 4000;
    this.render();
  }

  // ------------------------------------------------------------ view

  render() {
    this.overlay.draw({
      taps: this.picking ? this.taps : [],
      quad: this.quad,
      quadOk: this.displayOk,
      errorPoints: this.els.showErrors.checked ? this.lastErrorPoints : [],
      badRects: this.els.showBad?.checked === false ? [] : this.badRects,
    });
    this.onStatsChange?.();
  }

  statusText() {
    return this.status;
  }

  configEntries() {
    const c = this.config;
    const auto = this.autoProfile && this.profile
      ? [['プロファイル', `${this.profile.name}（${this.profile.gridWidth} × ${this.profile.gridHeight}、ヘッダから${this.profileConfirmed ? '判定済み' : '判定中'}）`]]
      : [];
    if (!c) return [['送信側の設定', 'なし（映像だけで受信）'], ...auto];
    const p = c.profile;
    const warn = this.#configWarning();
    return [
      ...auto,
      ['グリッド', `${p.gridWidth} × ${p.gridHeight}（${p.levels} レベル）`],
      ['パターン', `${c.pattern} / session ${c.sessionId} / frame ${c.frame}`],
      ['モード', `${c.mode === 'animated' ? 'アニメーション' : '静止'}${c.running ? '（送信中）' : ''}`],
      ['更新', c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString() : '-'],
      ['注意', warn ?? 'なし'],
    ];
  }

  resultEntries() {
    const l = this.last;
    const out = [['処理方式', this.processingMode()]];
    if (l) {
      out.push([
        '直近の処理',
        `${l.ok ? '成功' : `失敗（${l.reason}）`} / 読み出し ${fmt(l.readMs)} ms + 処理 ${fmt(l.procMs)} ms（読み取り倍率 ${fmt(l.readScale ?? 1, 2)}）`,
      ]);
      if (l.ppc) out.push(['px/cell', `${fmt(l.ppc.min, 2)}（横 ${fmt(l.ppc.x, 2)} / 縦 ${fmt(l.ppc.y, 2)}）`]);
      if (l.pilot) out.push(['パイロット中心', l.pilot.global.map((c) => fmt(c)).join(' / ')]);
      else if (l.centers) out.push(['レベル中心（k-means）', l.centers.map((c) => fmt(c)).join(' / ')]);
    }
    const run = this.run;
    if (run) {
      const s = run.measurement.totals;
      out.push(['測定中', `${run.acquired} / ${run.target}（試行 ${run.attempts}）`]);
      out.push(['暫定 BER', `${fmtRate(s.bits ? s.bitErrors / s.bits : null)}（${s.bitErrors} / ${s.bits}）`]);
    } else if (this.lastResult) {
      const s = this.lastResult.summary;
      const ring = (label) => s.rings.find((r) => r.label === label);
      out.push(['結果', `${this.lastResult.outcome} / 取得率 ${fmt((s.acquisitionRate ?? 0) * 100, 0)}%`]);
      out.push(['SER / BER', `${fmtRate(s.ser)} / ${fmtRate(s.ber)}${s.berUpper95IfZero ? `（誤りなし、95% 上限 ${fmtRate(s.berUpper95IfZero)}）` : ''}`]);
      out.push(['端 / 中央の SER', `d=1: ${fmtRate(ring('d=1')?.ser)} / d≥8: ${fmtRate(ring('d>=8')?.ser)}`]);
      const worst = s.regions.filter((r) => r.symbols).sort((a, b) => b.ser - a.ser)[0];
      if (worst) out.push(['最も悪い区画', `${worst.label}: ${fmtRate(worst.ser)}`]);
      if (s.alternatives?.kmeans) {
        out.push([
          '判定方式の比較（SER）',
          `局所補間 ${fmtRate(s.ser)} / 二次曲面 ${fmtRate(s.alternatives.pilotSurface?.ser)} / 全体 ${fmtRate(s.alternatives.pilotGlobal?.ser)} / k-means ${fmtRate(s.alternatives.kmeans.ser)}`,
        ]);
      }
      if (s.levelStats?.length) {
        out.push(['レベル別の輝度', s.levelStats.map((l, i) => `S${i} ${fmt(l.mean)}±${fmt(l.std)}`).join(' / ')]);
      }
      const e = s.erasureSimulation?.find((x) => x.threshold === 0.2);
      if (e) out.push(['低信頼セルを消失扱い（<0.2）', `${fmt(e.erasureRate * 100, 2)}% を消失扱い → 残りの SER ${fmtRate(e.residualSer)}`]);
      const sh = s.sharpness;
      if (sh) out.push(['傾き（平均）', tiltHint({ leftRight: sh.meanLeftRight, topBottom: sh.meanTopBottom }) ?? 'ほぼ正面']);
      if (sh) out.push(['ぶれ判定', `${sh.blurredCaptures} / ${sh.blurredCaptures + sh.sharpCaptures} 枚がぶれ → ぶれを除いた SER ${fmtRate(sh.serSharp)} / BER ${fmtRate(sh.berSharp)}`]);
      const c = s.calibration;
      if (c) {
        out.push(['レベル間隔', `均一度 ${fmt(c.spacingUniformity, 2)}（1.00 が等間隔）/ 最小分離度 ${fmt(c.minSeparation, 2)}（大きいほど良い）`]);
        if (c.recommendedLevels) out.push(['推奨レベル値', `${c.recommendedLevels.join(', ')}（現在 ${c.renderLevels.join(', ')}）`]);
      }
      out.push(['px/cell（平均）', fmt(s.pixelsPerCell.mean, 2)]);
      out.push(['処理時間（平均）', `${fmt(s.processingMs.mean)} ms`]);
      if (this.uploadStatus) out.push(['測定ログ', this.uploadStatus]);
    }
    if (this.map) {
      const m = this.map.summary();
      out.push(['写りの悪い範囲（信頼度マップ）', m.measurements ? `${m.badBlocks} ブロック（学習 ${m.measurements} 回、全体 SER ${fmtRate(m.globalSer)}）` : '未学習（測定すると学習します）']);
    }
    // What-if for the future error correction: cells in the orange area are
    // reported as "unknown" instead of guessed (an erasure costs RS half of an error).
    const me = this.lastResult?.summary?.mapErasure;
    if (!this.run && me) {
      out.push([
        '橙の範囲を「読めない」扱いにした場合',
        me.erased
          ? `セルの ${fmt(me.erasureRate * 100, 1)}% が該当し、誤りの ${fmt(me.errorsCaught * 100, 0)}% がそこに集中 → 残りのセルの SER ${fmtRate(me.residualSer)}`
          : 'パターンが橙の範囲を避けていたので該当なし',
      ]);
    }
    if (this.captureStatus) out.push(['キャプチャ', this.captureStatus]);
    return out;
  }
}
