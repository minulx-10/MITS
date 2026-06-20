'use strict';

// 명령어 매크로 — 자주 쓰는 명령을 저장하고 원클릭 실행. {player} 토큰은 닉네임으로 치환.
// ~/mits-data/macros.json 에 영속(서버 공용).

const store = require('./store');
const mc = require('./minecraft');
const { validName } = require('./util');

const FILE = 'macros.json';

function uid() {
  return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e7).toString(36);
}
function clean(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
}

async function list() {
  const items = await store.readJson(FILE, []);
  return { ok: true, items };
}

async function create(m) {
  const label = clean(m && m.label).slice(0, 40);
  const command = clean(m && m.command).slice(0, 300);
  if (!label) throw new Error('매크로 이름을 입력하세요.');
  if (!command) throw new Error('명령을 입력하세요.');
  const items = await store.readJson(FILE, []);
  const item = { id: uid(), label, command, icon: (clean(m && m.icon) || '⚡').slice(0, 4) };
  items.push(item);
  await store.writeJson(FILE, items);
  return { ok: true, item };
}

async function remove(id) {
  const items = await store.readJson(FILE, []);
  await store.writeJson(FILE, items.filter((x) => x.id !== id));
  return { ok: true };
}

async function run(serverId, macroId, player) {
  const items = await store.readJson(FILE, []);
  const m = items.find((x) => x.id === macroId);
  if (!m) throw new Error('매크로를 찾을 수 없습니다.');
  let cmd = m.command;
  if (cmd.includes('{player}')) {
    const p = String(player || '').trim();
    if (!validName(p)) throw new Error('이 매크로는 플레이어 닉네임이 필요합니다 (영문/숫자/_ 16자 이하).');
    cmd = cmd.replace(/\{player\}/g, p);
  }
  const r = await mc.sendCommand(serverId, cmd);
  if (!r.ok) throw new Error(r.message || '명령 실행 실패 (서버가 꺼져 있을 수 있습니다).');
  return { ok: true, message: '실행: ' + cmd, command: cmd };
}

module.exports = { list, create, remove, run };
