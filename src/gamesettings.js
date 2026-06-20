'use strict';

// 게임 설정 컨트롤 — 월드보더/난이도/시간/날씨/gamerule/PVP 를 UI에서 제어.
// 읽기는 level.dat(level.js) + 캐시, 쓰기는 mc.sendCommand(tmux) 로 적용 후 캐시에 write-through.

const mc = require('./minecraft');
const level = require('./level');
const properties = require('./properties');
const { getServer } = require('./config');

// 바닐라 gamerule 허용목록(임의 명령 주입 차단). 값은 boolean('true'/'false') 또는 정수만.
const GAMERULES = new Set([
  'announceAdvancements', 'blockExplosionDropDecay', 'commandBlockOutput', 'commandModificationBlockLimit',
  'disableElytraMovementCheck', 'disableRaids', 'doDaylightCycle', 'doEntityDrops', 'doFireTick',
  'doImmediateRespawn', 'doInsomnia', 'doLimitedCrafting', 'doMobLoot', 'doMobSpawning', 'doPatrolSpawning',
  'doTileDrops', 'doTraderSpawning', 'doVinesSpread', 'doWardenSpawning', 'doWeatherCycle', 'drowningDamage',
  'enderPearlsVanishOnDeath', 'fallDamage', 'fireDamage', 'forgiveDeadPlayers', 'freezeDamage',
  'globalSoundEvents', 'keepInventory', 'lavaSourceConversion', 'logAdminCommands', 'maxCommandChainLength',
  'maxCommandForkCount', 'maxEntityCramming', 'minecartMaxSpeed', 'mobExplosionDropDecay', 'mobGriefing',
  'naturalRegeneration', 'playersNetherPortalCreativeDelay', 'playersNetherPortalDefaultDelay',
  'playersSleepingPercentage', 'projectilesCanBreakBlocks', 'randomTickSpeed', 'reducedDebugInfo',
  'sendCommandFeedback', 'showDeathMessages', 'snowAccumulationHeight', 'spawnChunkRadius', 'spawnRadius',
  'spectatorsGenerateChunks', 'tntExplodes', 'tntExplosionDropDecay', 'universalAnger', 'waterSourceConversion',
]);

const DIFF_NUM = { peaceful: 0, easy: 1, normal: 2, hard: 3 };

function finite(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('숫자 값이 올바르지 않습니다.');
  return n;
}
function intIn(v, lo, hi) {
  const n = Math.round(finite(v));
  if (n < lo || n > hi) throw new Error(`값은 ${lo}~${hi} 범위여야 합니다.`);
  return n;
}

async function get(id) {
  if (!getServer(id)) throw new Error('알 수 없는 서버: ' + id);
  const lvl = await level.readLevel(id);
  return { ok: true, settings: lvl, gameruleKeys: [...GAMERULES].sort() };
}

// 명령 전송 후 ok 면 캐시 갱신. 서버 정지 시 sendCommand 가 ok:false 반환 → 에러로 변환.
async function send(id, cmd, cachePatch) {
  const r = await mc.sendCommand(id, cmd);
  if (!r.ok) throw new Error(r.message || '명령 실행 실패 (서버가 꺼져 있을 수 있습니다).');
  if (cachePatch) await level.cacheState(id, cachePatch);
  return r;
}

async function apply(id, body) {
  if (!getServer(id)) throw new Error('알 수 없는 서버: ' + id);
  const b = body || {};
  switch (b.type) {
    case 'worldborder': {
      if (b.op === 'set') {
        const size = intIn(b.size, 1, 60000000);
        const sec = b.seconds != null ? intIn(b.seconds, 0, 100000) : null;
        return send(id, `worldborder set ${size}${sec != null ? ' ' + sec : ''}`, { worldborder: { size } });
      }
      if (b.op === 'center') {
        const x = finite(b.x), z = finite(b.z);
        return send(id, `worldborder center ${x} ${z}`, { worldborder: { centerX: x, centerZ: z } });
      }
      if (b.op === 'warning-distance') {
        const v = intIn(b.value, 0, 100000);
        return send(id, `worldborder warning distance ${v}`, { worldborder: { warningBlocks: v } });
      }
      if (b.op === 'warning-time') {
        const v = intIn(b.value, 0, 100000);
        return send(id, `worldborder warning time ${v}`, { worldborder: { warningTime: v } });
      }
      throw new Error('알 수 없는 worldborder 작업');
    }
    case 'difficulty': {
      if (!(b.value in DIFF_NUM)) throw new Error('난이도 값이 올바르지 않습니다.');
      return send(id, `difficulty ${b.value}`, { difficulty: DIFF_NUM[b.value] });
    }
    case 'time': {
      const v = b.value;
      if (['day', 'night', 'noon', 'midnight', 'sunrise', 'sunset'].includes(v)) {
        return send(id, `time set ${v}`, null);
      }
      return send(id, `time set ${intIn(v, 0, 24000)}`, null);
    }
    case 'weather': {
      if (!['clear', 'rain', 'thunder'].includes(b.value)) throw new Error('날씨 값이 올바르지 않습니다.');
      const dur = b.duration != null ? intIn(b.duration, 0, 1000000) : null;
      return send(id, `weather ${b.value}${dur != null ? ' ' + dur : ''}`, { weather: b.value });
    }
    case 'gamerule': {
      const rule = String(b.rule || '');
      if (!GAMERULES.has(rule)) throw new Error('허용되지 않은 gamerule: ' + rule);
      let val;
      if (typeof b.value === 'boolean' || b.value === 'true' || b.value === 'false') {
        val = (b.value === true || b.value === 'true') ? 'true' : 'false';
      } else {
        val = String(Math.round(finite(b.value)));
      }
      return send(id, `gamerule ${rule} ${val}`, { gamerules: { [rule]: val } });
    }
    case 'pvp': {
      // PVP 는 server.properties 키 — 재시작 후 반영(properties 화이트리스트 경유).
      const on = (b.value === true || b.value === 'true');
      await properties.writeProperties(id, { pvp: on });
      return { ok: true, message: `pvp=${on} 로 설정했습니다. 서버를 재시작하면 반영됩니다.`, restartRequired: true };
    }
    default:
      throw new Error('알 수 없는 설정 type: ' + b.type);
  }
}

module.exports = { get, apply, GAMERULES };
