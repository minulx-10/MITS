'use strict';

const fs = require('fs').promises;
const path = require('path');
const nbt = require('prismarine-nbt');
const { getServer } = require('./config');
const { resolveInside } = require('./util');

const GAMEMODES = ['생존(Survival)', '창작(Creative)', '모험(Adventure)', '관전(Spectator)'];
const ARMOR_LABEL = { 103: '머리', 102: '가슴', 101: '다리', 100: '발', '-106': '손(오프핸드)' };
const DIM_NUM = { '0': 'minecraft:overworld', '-1': 'minecraft:the_nether', '1': 'minecraft:the_end' };

function worldDir(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return path.join(s.dir, 'world');
}

async function nameMap(id) {
  const s = getServer(id);
  const map = {};
  try {
    const cache = JSON.parse(await fs.readFile(path.join(s.dir, 'usercache.json'), 'utf8'));
    for (const e of cache) if (e.uuid) map[e.uuid.toLowerCase()] = e.name;
  } catch { /* 없으면 무시 */ }
  return map;
}

async function list(id) {
  const dir = path.join(worldDir(id), 'playerdata');
  let ents = [];
  try {
    ents = await fs.readdir(dir);
  } catch {
    return { items: [] };
  }
  const names = await nameMap(id);
  const items = [];
  for (const f of ents) {
    if (!/^[0-9a-fA-F-]{36}\.dat$/.test(f)) continue;
    const uuid = f.replace(/\.dat$/, '');
    let mtime = 0;
    try {
      mtime = (await fs.stat(path.join(dir, f))).mtimeMs;
    } catch { /* */ }
    items.push({ uuid, name: names[uuid.toLowerCase()] || '(이름 미상)', mtime });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items };
}

function itemize(listVal) {
  return (Array.isArray(listVal) ? listVal : []).map((it) => ({
    slot: it.Slot != null ? it.Slot : (it.slot != null ? it.slot : null),
    id: String(it.id || it.Id || '').replace(/^minecraft:/, '') || '?',
    count: it.Count != null ? it.Count : (it.count != null ? it.count : 1),
  }));
}

function dimName(d) {
  if (d == null) return null;
  if (typeof d === 'number') return DIM_NUM[String(d)] || String(d);
  return String(d);
}

async function detail(id, uuid) {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) throw new Error('잘못된 UUID');
  const dir = path.join(worldDir(id), 'playerdata');
  const file = resolveInside(dir, uuid + '.dat');
  const buf = await fs.readFile(file);
  const { parsed } = await nbt.parse(buf);
  const d = nbt.simplify(parsed);

  const inv = itemize(d.Inventory);
  const armor = inv
    .filter((i) => [100, 101, 102, 103, -106].includes(i.slot))
    .map((i) => ({ ...i, label: ARMOR_LABEL[i.slot] || i.slot }));
  const main = inv.filter((i) => i.slot != null && i.slot >= 0 && i.slot <= 35).sort((a, b) => a.slot - b.slot);
  const ender = itemize(d.EnderItems).sort((a, b) => (a.slot || 0) - (b.slot || 0));

  const pos = Array.isArray(d.Pos) ? d.Pos.map((n) => Math.round(n * 100) / 100) : null;
  const names = await nameMap(id);

  return {
    uuid,
    name: names[uuid.toLowerCase()] || '(이름 미상)',
    pos,
    dimension: dimName(d.Dimension),
    rotation: Array.isArray(d.Rotation) ? d.Rotation.map((n) => Math.round(n)) : null,
    health: d.Health != null ? Math.round(d.Health * 10) / 10 : null,
    food: d.foodLevel,
    saturation: d.foodSaturationLevel != null ? Math.round(d.foodSaturationLevel * 10) / 10 : null,
    xpLevel: d.XpLevel,
    xpTotal: d.XpTotal,
    gameType: d.playerGameType,
    gameTypeName: GAMEMODES[d.playerGameType] || '?',
    spawn: d.SpawnX != null ? { x: d.SpawnX, y: d.SpawnY, z: d.SpawnZ, dim: dimName(d.SpawnDimension) } : null,
    selectedSlot: d.SelectedItemSlot,
    air: d.Air,
    score: d.Score,
    armor,
    offhand: inv.find((i) => i.slot === -106) || null,
    inventory: main,
    ender,
  };
}

module.exports = { list, detail };
