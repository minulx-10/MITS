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

const CACHE_FILE_NAME = 'mits_name_cache.json';

async function loadLocalCache(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, CACHE_FILE_NAME), 'utf8')) || {};
  } catch {
    return {};
  }
}

async function saveLocalCache(dir, cache) {
  try {
    await fs.writeFile(path.join(dir, CACHE_FILE_NAME), JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

const mc = require('./minecraft');

function getBedrockXuid(uuid) {
  const parts = uuid.split('-');
  if (parts.length === 5 && parts[3] === '0009') {
    const hex = parts[3] + parts[4];
    try {
      return BigInt('0x' + hex).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchBedrockName(uuid) {
  const xuid = getBedrockXuid(uuid);
  if (!xuid) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.geysermc.org/v2/xbox/gamertag/${xuid}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.status === 200) {
      const data = await res.json();
      if (data && data.gamertag) {
        return '.' + data.gamertag;
      }
    }
  } catch (e) {}
  return null;
}

async function fetchMojangName(uuid) {
  if (uuid.length === 36 && uuid[14] === '4') {
    const cleanUuid = uuid.replace(/-/g, '');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.status === 200) {
        const data = await res.json();
        if (data && data.name) return data.name;
      }
    } catch {}
  }
  return null;
}

async function getOnlinePlayers(s) {
  const online = new Set();
  try {
    const status = await mc.serverStatus(s);
    if (!status.online) {
      return online;
    }
    const logPath = path.join(s.dir, 'logs', 'latest.log');
    const logs = await fs.readFile(logPath, 'utf8');
    const lines = logs.split('\n');
    for (const line of lines) {
      const loginMatch = line.match(/\[Server thread\/INFO\]: ([\w_.-]+)\[\/[\d.:]+\] logged in with/i);
      if (loginMatch) {
        online.add(loginMatch[1].toLowerCase());
        continue;
      }
      const logoutMatch = line.match(/\[Server thread\/INFO\]: ([\w_.-]+) (left the game|lost connection|was kicked)/i);
      if (logoutMatch) {
        online.delete(logoutMatch[1].toLowerCase());
      }
    }
  } catch (e) {}
  return online;
}

async function nameMap(id, activeUuids = []) {
  const s = getServer(id);
  const map = {};

  const reg = (uuid, name) => {
    if (uuid && name && typeof uuid === 'string' && typeof name === 'string') {
      map[uuid.toLowerCase()] = name;
    }
  };

  // 1. Read local cache first (keeps historical records)
  const localCache = await loadLocalCache(s.dir);
  for (const [uuid, name] of Object.entries(localCache)) {
    reg(uuid, name);
  }

  // 2. Load from usercache.json
  try {
    const cache = JSON.parse(await fs.readFile(path.join(s.dir, 'usercache.json'), 'utf8'));
    for (const e of cache) if (e.uuid) reg(e.uuid, e.name);
  } catch {}

  // 3. Load from whitelist.json
  try {
    const whitelist = JSON.parse(await fs.readFile(path.join(s.dir, 'whitelist.json'), 'utf8'));
    for (const e of whitelist) if (e.uuid) reg(e.uuid, e.name);
  } catch {}

  // 4. Load from ops.json
  try {
    const ops = JSON.parse(await fs.readFile(path.join(s.dir, 'ops.json'), 'utf8'));
    for (const e of ops) if (e.uuid) reg(e.uuid, e.name);
  } catch {}

  // 5. Load from banned-players.json
  try {
    const banned = JSON.parse(await fs.readFile(path.join(s.dir, 'banned-players.json'), 'utf8'));
    for (const e of banned) if (e.uuid) reg(e.uuid, e.name);
  } catch {}

  // 6. Scan latest.log
  try {
    const logPath = path.join(s.dir, 'logs', 'latest.log');
    const logs = await fs.readFile(logPath, 'utf8');
    const regex = /UUID of player ([\w_.-]+) is ([0-9a-fA-F-]{36})/gi;
    let match;
    while ((match = regex.exec(logs)) !== null) {
      reg(match[2], match[1]);
    }
  } catch {}

  // 7. Scan Essentials userdata
  try {
    const essDir = path.join(s.dir, 'plugins', 'Essentials', 'userdata');
    const files = await fs.readdir(essDir);
    for (const f of files) {
      if (f.endsWith('.yml')) {
        const uuid = f.slice(0, -4);
        try {
          const content = await fs.readFile(path.join(essDir, f), 'utf8');
          const m = content.match(/lastAccountName:\s*['"]?([\w_.-]+)['"]?/i);
          if (m) reg(uuid, m[1]);
        } catch {}
      }
    }
  } catch {}

  // 8. If any active UUIDs are still unresolved, try APIs
  let cacheUpdated = false;
  const unresolvedUuids = activeUuids.filter(uuid => !map[uuid.toLowerCase()]);
  
  if (unresolvedUuids.length > 0) {
    const toResolve = unresolvedUuids.slice(0, 10);
    const results = await Promise.all(
      toResolve.map(async (uuid) => {
        let name = null;
        if (uuid.startsWith('00000000-0000-0000-0009-')) {
          name = await fetchBedrockName(uuid);
        } else {
          name = await fetchMojangName(uuid);
        }
        return { uuid, name };
      })
    );

    for (const r of results) {
      if (r.name) {
        reg(r.uuid, r.name);
        localCache[r.uuid.toLowerCase()] = r.name;
        cacheUpdated = true;
      }
    }
  }

  // Update local cache if we found new pairings
  for (const [uuid, name] of Object.entries(map)) {
    if (!localCache[uuid]) {
      localCache[uuid] = name;
      cacheUpdated = true;
    }
  }

  if (cacheUpdated) {
    await saveLocalCache(s.dir, localCache);
  }

  return map;
}

async function getPlayerdataDir(id) {
  const wd = worldDir(id);
  const candidates = [
    path.join(wd, 'players', 'data'),
    path.join(wd, 'playerdata'),
    path.join(wd, 'players')
  ];
  for (const c of candidates) {
    try {
      const stats = await fs.stat(c);
      if (stats.isDirectory()) {
        const files = await fs.readdir(c);
        if (files.some(f => /^[0-9a-fA-F-]{36}\.dat$/.test(f))) {
          return c;
        }
      }
    } catch {}
  }
  return path.join(wd, 'playerdata');
}

async function list(id) {
  const s = getServer(id);
  const dir = await getPlayerdataDir(id);
  let ents = [];
  try {
    ents = await fs.readdir(dir);
  } catch {
    return { items: [] };
  }
  const uuids = ents
    .filter((f) => /^[0-9a-fA-F-]{36}\.dat$/.test(f))
    .map((f) => f.replace(/\.dat$/, ''));
  const names = await nameMap(id, uuids);
  const onlineNames = await getOnlinePlayers(s);

  const items = [];
  for (const uuid of uuids) {
    let mtime = 0;
    try {
      mtime = (await fs.stat(path.join(dir, uuid + '.dat'))).mtimeMs;
    } catch {}
    const name = names[uuid.toLowerCase()] || (uuid.startsWith('00000000-0000-0000-0009-') ? '.Bedrock_' + uuid.split('-')[4] : '(이름 미상)');
    const isOnline = onlineNames.has(name.toLowerCase());
    items.push({ uuid, name, mtime, online: isOnline });
  }

  items.sort((a, b) => {
    if (a.online !== b.online) {
      return a.online ? -1 : 1;
    }
    return b.mtime - a.mtime;
  });

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
  const s = getServer(id);
  const dir = await getPlayerdataDir(id);
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
  
  const names = await nameMap(id, [uuid]);
  const onlineNames = await getOnlinePlayers(s);
  const name = names[uuid.toLowerCase()] || (uuid.startsWith('00000000-0000-0000-0009-') ? '.Bedrock_' + uuid.split('-')[4] : '(이름 미상)');
  const isOnline = onlineNames.has(name.toLowerCase());

  let mtime = 0;
  try {
    const stats = await fs.stat(file);
    mtime = stats.mtimeMs;
  } catch {}

  let playTimeSeconds = 0;
  try {
    const statsFile = path.join(worldDir(id), 'players', 'stats', uuid + '.json');
    const statsContent = await fs.readFile(statsFile, 'utf8');
    const statsObj = JSON.parse(statsContent);
    const customStats = statsObj.stats && statsObj.stats['minecraft:custom'];
    if (customStats) {
      const ticks = customStats['minecraft:play_time'] || customStats['minecraft:play_one_minute'] || 0;
      playTimeSeconds = Math.round(ticks / 20);
    }
  } catch (e) {}

  return {
    uuid,
    name,
    online: isOnline,
    playTimeSeconds,
    mtime,
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
