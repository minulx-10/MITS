'use strict';

// 리소스 메트릭 시계열 — 일정 간격으로 RAM/Load/서버별 RSS 샘플링.
// 인메모리 링버퍼 + ~/mits-data/metrics.jsonl 영속(보존기간 초과분 주기적 trim).

const store = require('./store');
const { systemInfo } = require('./system');
const mc = require('./minecraft');
const { config } = require('./config');

const FILE = 'metrics.jsonl';
const STEP_SEC = Math.max(5, config.metricsIntervalSec || 15);
const INTERVAL = STEP_SEC * 1000;
const CAP = Math.max(60, Math.round((config.metricsRetainHours * 3600) / STEP_SEC));

let buffer = [];
let timer = null;
let sinceTrim = 0;

async function sample() {
  let sys = null;
  let servers = [];
  try { sys = await systemInfo(); } catch { /* */ }
  try { servers = (await mc.allStatus()).map((s) => ({ id: s.id, rssMB: s.rssMB, online: s.online })); } catch { /* */ }
  const point = {
    t: Date.now(),
    usedMB: sys ? sys.usedMB : null,
    availMB: sys ? sys.availMB : null,
    totalMB: sys ? sys.totalMB : null,
    load: sys && Array.isArray(sys.load) ? sys.load[0] : null,
    servers,
  };
  buffer.push(point);
  if (buffer.length > CAP) buffer = buffer.slice(-CAP);
  await store.appendLine(FILE, point).catch(() => {});
  if (++sinceTrim >= 120) { sinceTrim = 0; await store.trimLines(FILE, CAP).catch(() => {}); }
  return point;
}

async function start() {
  if (timer) return;
  buffer = (await store.readLines(FILE, CAP).catch(() => [])) || [];
  await sample().catch(() => {});
  timer = setInterval(() => { sample().catch(() => {}); }, INTERVAL);
  console.log(`[MITS] 리소스 메트릭 수집 활성화 (${STEP_SEC}s 간격, 보존 ${config.metricsRetainHours}h)`);
}

function query(rangeMs) {
  const cutoff = Date.now() - (rangeMs || 3 * 3600 * 1000);
  let pts = buffer.filter((p) => p.t >= cutoff);
  const MAX = 360;
  if (pts.length > MAX) {
    const step = Math.ceil(pts.length / MAX);
    pts = pts.filter((_, i) => i % step === 0);
  }
  return { ok: true, points: pts, intervalSec: STEP_SEC };
}

module.exports = { start, query, _sample: sample };
