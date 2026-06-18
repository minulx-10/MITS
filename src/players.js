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

async function action(id, act, value) {
  if (act === 'ban-ip' || act === 'pardon-ip') {
    if (!validIp(value)) throw new Error('IP 주소 형식이 올바르지 않습니다.');
    const cmd = act === 'ban-ip' ? `ban-ip ${value}` : `pardon-ip ${value}`;
    return mc.sendCommand(id, cmd);
  }
  const build = NAME_ACTIONS[act];
  if (!build) throw new Error('알 수 없는 동작: ' + act);
  if (!validName(value)) throw new Error('닉네임은 영문/숫자/_ 16자 이하만 가능합니다.');
  return mc.sendCommand(id, build(value));
}

module.exports = { lists, action };
