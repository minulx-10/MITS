'use strict';

// 예약 작업 — 자동 재시작 / 정기 공지(say) / 명령 / 백업.
// ~/mits-data/schedules.json 에 영속. server.js 에서 start() 로 30초 틱 인터벌을 돈다.

const store = require('./store');
const mc = require('./minecraft');
const backups = require('./backups');
const { getServer, config } = require('./config');

const FILE = 'schedules.json';
const TYPES = new Set(['restart', 'say', 'command', 'backup']);
const inflight = new Set();
let timer = null;

function uid() {
  return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e7).toString(36);
}
function clean(str) {
  return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ').slice(0, 300);
}
function pad2(n) { return String(n).padStart(2, '0'); }

async function list() {
  const items = await store.readJson(FILE, []);
  return { ok: true, items };
}

function validate(t) {
  if (!TYPES.has(t.type)) throw new Error('알 수 없는 작업 유형: ' + t.type);
  if (!getServer(t.serverId)) throw new Error('알 수 없는 서버: ' + t.serverId);
  const sch = t.schedule || {};
  if (sch.kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(sch.at || ''))) throw new Error('시각 형식은 HH:MM 이어야 합니다.');
  } else if (sch.kind === 'interval') {
    const m = Number(sch.everyMin);
    if (!Number.isFinite(m) || m < 1 || m > 10080) throw new Error('주기(분)는 1~10080 이어야 합니다.');
  } else {
    throw new Error('schedule.kind 는 daily 또는 interval 이어야 합니다.');
  }
  if ((t.type === 'say' || t.type === 'command') && !clean(t.payload)) throw new Error('내용(payload)을 입력하세요.');
}

async function create(t) {
  validate(t);
  const items = await store.readJson(FILE, []);
  const item = {
    id: uid(),
    serverId: t.serverId,
    type: t.type,
    payload: clean(t.payload),
    schedule: t.schedule.kind === 'daily'
      ? { kind: 'daily', at: t.schedule.at }
      : { kind: 'interval', everyMin: Math.round(Number(t.schedule.everyMin)) },
    enabled: t.enabled !== false,
    lastRun: 0,
    lastRunDate: '',
  };
  items.push(item);
  await store.writeJson(FILE, items);
  return { ok: true, item };
}

async function remove(id) {
  const items = await store.readJson(FILE, []);
  const next = items.filter((x) => x.id !== id);
  await store.writeJson(FILE, next);
  return { ok: true };
}

async function toggle(id) {
  const items = await store.readJson(FILE, []);
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error('작업을 찾을 수 없습니다.');
  it.enabled = !it.enabled;
  await store.writeJson(FILE, items);
  return { ok: true, enabled: it.enabled };
}

async function runTask(t) {
  if (t.type === 'restart') return mc.restartServer(t.serverId);
  if (t.type === 'say') return mc.sendCommand(t.serverId, 'say ' + clean(t.payload));
  if (t.type === 'command') return mc.sendCommand(t.serverId, clean(t.payload));
  if (t.type === 'backup') return backups.create(t.serverId, 'scheduled');
}

function due(t, now) {
  const sch = t.schedule || {};
  if (sch.kind === 'interval') {
    return now - (t.lastRun || 0) >= sch.everyMin * 60000;
  }
  if (sch.kind === 'daily') {
    const d = new Date(now);
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return hhmm === sch.at && t.lastRunDate !== today;
  }
  return false;
}

async function tick() {
  let items;
  try { items = await store.readJson(FILE, []); } catch { return; }
  const now = Date.now();
  let changed = false;
  for (const t of items) {
    if (!t.enabled || inflight.has(t.id)) continue;
    if (!due(t, now)) continue;
    inflight.add(t.id);
    t.lastRun = now;
    const d = new Date(now);
    t.lastRunDate = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    changed = true;
    runTask(t)
      .catch((e) => console.error(`[scheduler] ${t.type}(${t.serverId}) 실패: ${e.message}`))
      .finally(() => inflight.delete(t.id));
  }
  if (changed) await store.writeJson(FILE, items).catch(() => {});
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 30000);
  console.log('[MITS] 예약 작업 스케줄러 활성화 (30초 틱)');
}

module.exports = { list, create, remove, toggle, start, _tick: tick };
