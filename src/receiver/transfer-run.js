// File reception run (ROADMAP M6): one or more consecutive transfer trials.
// Each trial starts with an empty ObjectReceiver, i.e. at an arbitrary point
// of the sender's carousel, and ends when an object's SHA-256 matches its
// manifest. The exit criterion is 10 consecutive trials with a match.

import { ObjectReceiver, toHex } from './object-receiver.js';
import { OUTER_CODE_RLNC, OUTER_CODES } from '../common/object-frame.js';
import { analyzeFailedCaptures } from './failure-analysis.js';

// Failed captures kept per trial for failure-analysis.js (~70 KB each).
const KEEP_FAILED = 250;
// Failed captures of the first trial exported with raw values (~53 KB each in the log).
const RAW_SAMPLES = 30;

export const outerCodeName = (code) => OUTER_CODES[code] ?? `不明 (${code})`;

// Filename for display, shortened.
const s = (name) => (name.length > 28 ? `${name.slice(0, 25)}…` : name);

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
export const fmtBytes = (n) => (n >= 1048576 ? `${fmt(n / 1048576, 2)} MiB` : n >= 1024 ? `${fmt(n / 1024, 1)} KiB` : `${n} B`);

export class TransferRun {
  // trials: number of consecutive transfers; onFinish(outcome) once all are done.
  // schedule: { periodMs, manifestEvery, fecRate } of the sender (optional),
  // for the loss-free minimum time and the efficiency of each trial.
  constructor(profile, { trials = 1, startT, onFinish = null, receiverOptions = {}, schedule = null }) {
    this.profile = profile;
    this.schedule = schedule;
    this.target = trials;
    this.onFinish = onFinish;
    this.receiverOptions = receiverOptions;
    this.results = [];
    this.analyses = [];
    this.lastObject = null; // { data, name, mime, size, sha256 } of the last verified object
    this.finished = false;
    this.#newTrial(startT);
  }

  #newTrial(t) {
    this.trialStartT = t;
    this.rx = new ObjectReceiver(this.profile, {
      keepFailed: KEEP_FAILED,
      ...this.receiverOptions,
      onComplete: (s) => this.#onComplete(s),
    });
  }

  // Resolves once the failure analyses of all completed trials are attached.
  whenAnalyzed() {
    return Promise.all(this.analyses);
  }

  add(t, result, opts) {
    if (this.finished) return null;
    return this.rx.add(t, result, opts);
  }

  #onComplete(s) {
    const rx = this.rx;
    const sum = rx.summary();
    const m = s.manifest;
    const durationMs = s.completeT - this.trialStartT;
    // Loss-free minimum: every needed DATA frame captured once, plus the manifests in between.
    const sc = this.schedule;
    const minimumMs = sc?.periodMs && sc?.manifestEvery ? m.segmentCount * (1 + 1 / sc.manifestEvery) * sc.periodMs : null;
    this.results.push({
      trial: this.results.length + 1,
      outcome: 'sha256-match',
      sessionId: s.sessionId.toString(16).padStart(8, '0'),
      size: m.size,
      name: s.name,
      sha256: toHex(m.sha256),
      segmentCount: m.segmentCount,
      segmentSize: m.segmentSize,
      outerCode: m.outerCode,
      blockCount: m.blockCount,
      // DATA frames decoded for this object (new, redundant); with the outer
      // code, used / segmentCount - 1 is the reception overhead.
      dataFramesUsed: s.received + s.redundant,
      redundant: s.redundant,
      durationMs,
      minimumMs,
      efficiency: minimumMs ? minimumMs / durationMs : null,
      fecRate: sc?.fecRate ?? null,
      fromFirstFrameMs: s.completeT - s.firstT,
      manifestAfterMs: s.manifestT - s.firstT,
      goodputBitsPerSecond: (m.size * 8) / ((s.completeT - this.trialStartT) / 1000),
      hashMismatches: s.hashMismatches,
      captures: sum.captures,
      counts: sum.counts,
      rejections: sum.rejections,
      fec: sum.fec,
      segmentFrames: s.segmentFrames,
      timeline: s.timeline,
    });
    // Failed captures vs. the now known frames, in the background.
    const result = this.results[this.results.length - 1];
    const failed = rx.failed;
    rx.failed = [];
    this.analyses.push(
      analyzeFailedCaptures(this.profile, s, failed, { rawSamples: this.results.length === 1 ? RAW_SAMPLES : 0 })
        .then((a) => (result.failureAnalysis = a))
        .catch((e) => (result.failureAnalysis = { error: String(e?.message ?? e) })),
    );
    this.lastObject = { data: s.data, name: s.name, mime: s.mime, size: m.size, sha256: toHex(m.sha256), trial: this.results.length };
    if (this.results.length >= this.target) {
      this.finished = true;
      this.onFinish?.('completed');
    } else {
      this.#newTrial(s.completeT);
    }
  }

  // Live status line.
  statusText(now) {
    const p = this.rx.primary();
    const c = this.rx.counts;
    const trial = `試行 ${Math.min(this.results.length + 1, this.target)} / ${this.target}`;
    const elapsed = `経過 ${fmt((now - this.trialStartT) / 1000)} 秒`;
    const dropped = `使えなかった撮影: 誤り訂正の失敗 ${c['fec-failed']}・CRC 不一致 ${c['crc-failed']}・遷移 ${c.transition}・ヘッダ失敗 ${c['no-header']}`;
    if (!p) return `ファイル受信中 ${trial}｜${elapsed}｜送信画面のフレームを待っています`;
    if (!p.manifest) return `ファイル受信中 ${trial}｜${elapsed}｜マニフェスト待ち（先に届いたデータ ${p.pending.size} 個）｜${dropped}`;
    const m = p.manifest;
    const n = m.segmentCount;
    const verifying = p.state === 'verifying' ? '・SHA-256 を照合中' : '';
    const progress =
      m.outerCode === OUTER_CODE_RLNC
        ? `独立なシンボル ${p.received} / ${n}（${fmt((p.received / n) * 100)}%）・ブロック完了 ${p.blocksDone} / ${m.blockCount}`
        : `${p.received} / ${n}（${fmt((p.received / n) * 100)}%）`;
    return `ファイル受信中 ${trial}｜${elapsed}｜${progress}${verifying}｜${dropped}`;
  }

  // Progress bar state: { fraction 0..1, state: waiting | receiving | verifying | done, label }.
  progress() {
    const trial = this.target > 1 ? `${Math.min(this.results.length + 1, this.target)} / ${this.target} 回目・` : '';
    if (this.finished) return { fraction: 1, state: 'done', label: `完了（${this.results.length} / ${this.target} 回 SHA-256 一致）` };
    const p = this.rx.primary();
    const c = this.rx.counts;
    // Every frame decodes but fails the CRC32C: sender and receiver pages of different versions.
    if (c['crc-failed'] >= 30 && !c.segment && !c.manifest) {
      return { fraction: 0, state: 'waiting', label: `${trial}CRC 不一致が続いています。送信側と受信側のページが別の版かもしれません。両方を再読み込みしてください` };
    }
    if (!p) return { fraction: 0, state: 'waiting', label: `${trial}送信画面のフレームを待っています` };
    if (!p.manifest) return { fraction: 0, state: 'waiting', label: `${trial}ファイル情報（マニフェスト）を待っています` };
    const m = p.manifest;
    const unit = m.outerCode === OUTER_CODE_RLNC ? 'シンボル' : '個';
    const state = p.state === 'verifying' ? 'verifying' : 'receiving';
    const what = state === 'verifying' ? 'SHA-256 を照合中' : `${p.received} / ${m.segmentCount} ${unit}`;
    return { fraction: p.received / m.segmentCount, state, label: `${trial}${s(p.name)}（${fmtBytes(m.size)}）${what}` };
  }

  summary() {
    const ok = this.results.filter((r) => r.outcome === 'sha256-match');
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      trialsTarget: this.target,
      trialsDone: this.results.length,
      sha256Matches: ok.length,
      trialsWithHashMismatch: this.results.filter((r) => r.hashMismatches > 0).length,
      meanDurationMs: mean(ok.map((r) => r.durationMs)),
      meanEfficiency: mean(ok.filter((r) => r.efficiency).map((r) => r.efficiency)),
      minimumMs: ok[0]?.minimumMs ?? null,
      maxDurationMs: ok.length ? Math.max(...ok.map((r) => r.durationMs)) : null,
      meanGoodputBitsPerSecond: mean(ok.map((r) => r.goodputBitsPerSecond)),
      current: this.finished ? null : this.rx.summary(),
    };
  }
}
