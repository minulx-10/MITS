'use strict';

// level.dat(gzip big-endian NBT) 에서 월드보더/gamerule/난이도/시간을 읽는다.
// prismarine-nbt 는 playerdata.js 와 동일하게 gzip 자동 해제 + 엔디안 자동 감지(추가 의존성 없음).
// 패널이 설정한 값은 ~/mits-data/<id>-gamestate.json 에 write-through 캐시 — level.dat autosave 지연 보정.

const fs = require('fs').promises;
const path = require('path');
const nbt = require('prismarine-nbt');
const { getServer } = require('./config');
const store = require('./store');

async function levelName(dir) {
  try {
    const txt = await fs.readFile(path.join(dir, 'server.properties'), 'utf8');
    const m = txt.match(/^level-name=(.*)$/m);
    return (m && m[1].trim()) || 'world';
  } catch {
    return 'world';
  }
}

function num(v, d = null) {
  return v != null && !Number.isNaN(Number(v)) ? Number(v) : d;
}

async function readLevelDat(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const world = await levelName(s.dir);
  const file = path.join(s.dir, world, 'level.dat');
  const buf = await fs.readFile(file);
  const { parsed } = await nbt.parse(buf);
  const d = nbt.simplify(parsed);
  const data = d.Data || d;

  // GameRules 는 문자열 값("true"/"10")으로 저장됨 (구버전). 신버전 26.x level.dat 엔 없을 수 있음 → 캐시로 보완.
  const gamerules = {};
  for (const [k, v] of Object.entries(data.GameRules || {})) gamerules[k] = String(v);

  // 난이도: 구버전 Data.Difficulty(바이트) 또는 신버전 Data.difficulty_settings.difficulty(문자열) 모두 지원
  const DIFF_NUM = { peaceful: 0, easy: 1, normal: 2, hard: 3 };
  let difficulty = num(data.Difficulty);
  const ds = data.difficulty_settings;
  if (difficulty == null && ds && typeof ds.difficulty === 'string') difficulty = DIFF_NUM[ds.difficulty];
  const hardcore = ds && (ds.hardcore === 1 || ds.hardcore === true) ? true : (data.hardcore === 1 || data.hardcore === true ? true : null);

  return {
    levelName: data.LevelName || world,
    difficulty,
    hardcore,
    dayTime: num(data.DayTime),
    raining: data.raining === 1 || data.raining === true || null,
    thundering: data.thundering === 1 || data.thundering === true || null,
    worldborder: {
      centerX: num(data.BorderCenterX, 0),
      centerZ: num(data.BorderCenterZ, 0),
      size: num(data.BorderSize),
      warningBlocks: num(data.BorderWarningBlocks),
      warningTime: num(data.BorderWarningTime),
    },
    gamerules,
  };
}

function mergeState(base, cache) {
  const out = { ...base };
  if (cache.difficulty != null) out.difficulty = cache.difficulty;
  if (cache.weather) out.weather = cache.weather;
  if (cache.worldborder) out.worldborder = { ...(base.worldborder || {}), ...cache.worldborder };
  if (cache.gamerules) out.gamerules = { ...(base.gamerules || {}), ...cache.gamerules };
  return out;
}

// 화면 표시용 — level.dat(가능하면) + 패널 캐시 병합. level.dat 못 읽어도 캐시로 동작.
async function readLevel(id) {
  let base = { worldborder: { centerX: 0, centerZ: 0 }, gamerules: {} };
  let source = 'cache';
  try {
    base = await readLevelDat(id);
    source = 'level.dat';
  } catch (e) {
    base.readError = e.message;
  }
  const cache = await store.readJson(`${id}-gamestate.json`, {});
  return { ...mergeState(base, cache), source };
}

// 패널이 명령으로 바꾼 값을 캐시에 반영(부분 병합).
async function cacheState(id, patch) {
  const cache = await store.readJson(`${id}-gamestate.json`, {});
  const merged = { ...cache, ...patch };
  if (patch.worldborder) merged.worldborder = { ...(cache.worldborder || {}), ...patch.worldborder };
  if (patch.gamerules) merged.gamerules = { ...(cache.gamerules || {}), ...patch.gamerules };
  await store.writeJson(`${id}-gamestate.json`, merged);
  return merged;
}

module.exports = { readLevel, readLevelDat, cacheState };
