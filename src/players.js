'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');
const { validName, validIp } = require('./util');
const mc = require('./minecraft');

async function readJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    const v = JSON.parse(txt || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

async function lists(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const d = s.dir;
  const [whitelist, ops, banned, bannedIps, usercache] = await Promise.all([
    readJson(path.join(d, 'whitelist.json'), []),
    readJson(path.join(d, 'ops.json'), []),
    readJson(path.join(d, 'banned-players.json'), []),
    readJson(path.join(d, 'banned-ips.json'), []),
    readJson(path.join(d, 'usercache.json'), []),
  ]);
  return { whitelist, ops, banned, bannedIps, offline: usercache };
}

const NAME_ACTIONS = {
  'whitelist-add': (n) => `whitelist add ${n}`,
  'whitelist-remove': (n) => `whitelist remove ${n}`,
  op: (n) => `op ${n}`,
  deop: (n) => `deop ${n}`,
  ban: (n) => `ban ${n}`,
  pardon: (n) => `pardon ${n}`,
  kick: (n) => `kick ${n}`,
};

const GAMEMODES = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator', survival: 'survival', creative: 'creative', adventure: 'adventure', spectator: 'spectator' };

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('숫자 값이 올바르지 않습니다.');
  return n;
}
function intIn(v, lo, hi) {
  const n = Math.round(num(v));
  if (n < lo || n > hi) throw new Error(`값은 ${lo}~${hi} 범위여야 합니다.`);
  return n;
}

// 파라미터가 필요한 빠른 액션 — value 는 { name, ... } 객체.
function buildQuick(act, v) {
  const name = (v && typeof v === 'object') ? v.name : v;
  if (!validName(name)) throw new Error('닉네임은 영문/숫자/_ 16자 이하만 가능합니다.');
  switch (act) {
    case 'gamemode': {
      const mode = GAMEMODES[v.mode];
      if (!mode) throw new Error('게임모드 값이 올바르지 않습니다.');
      return `gamemode ${mode} ${name}`;
    }
    case 'tp': {
      if (v.target != null && v.target !== '') {
        if (!validName(v.target)) throw new Error('대상 닉네임이 올바르지 않습니다.');
        return `tp ${name} ${v.target}`;
      }
      return `tp ${name} ${num(v.x)} ${num(v.y)} ${num(v.z)}`;
    }
    case 'give': {
      const item = String(v.item || '');
      if (!/^[a-z0-9_:]{1,64}$/.test(item)) throw new Error('아이템 ID 형식이 올바르지 않습니다.');
      const count = v.count != null ? intIn(v.count, 1, 6400) : 1;
      return `give ${name} ${item} ${count}`;
    }
    case 'effect': {
      const eff = String(v.effect || '');
      if (!/^[a-z0-9_:]{1,48}$/.test(eff)) throw new Error('효과 ID 형식이 올바르지 않습니다.');
      const sec = v.seconds != null ? intIn(v.seconds, 1, 1000000) : 30;
      const amp = v.amplifier != null ? intIn(v.amplifier, 0, 255) : 0;
      return `effect give ${name} ${eff} ${sec} ${amp}`;
    }
    case 'heal': return `effect give ${name} minecraft:instant_health 1 100`;
    case 'feed': return `effect give ${name} minecraft:saturation 2 20`;
    case 'kill': return `kill ${name}`;
    default: return null;
  }
}

const QUICK_ACTIONS = new Set(['gamemode', 'tp', 'give', 'effect', 'heal', 'feed', 'kill']);

async function action(id, act, value) {
  if (act === 'ban-ip' || act === 'pardon-ip') {
    if (!validIp(value)) throw new Error('IP 주소 형식이 올바르지 않습니다.');
    const cmd = act === 'ban-ip' ? `ban-ip ${value}` : `pardon-ip ${value}`;
    return mc.sendCommand(id, cmd);
  }
  if (QUICK_ACTIONS.has(act)) {
    return mc.sendCommand(id, buildQuick(act, value));
  }
  const build = NAME_ACTIONS[act];
  if (!build) throw new Error('알 수 없는 동작: ' + act);
  if (!validName(value)) throw new Error('닉네임은 영문/숫자/_ 16자 이하만 가능합니다.');
  return mc.sendCommand(id, build(value));
}

module.exports = { lists, action };
