'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');

// 쓰기 허용 키 화이트리스트 — 임의 키 주입 방지(전체 편집기·간이폼 모두 이 목록만 기록).
const ALLOWED_KEYS = new Set([
  'allow-flight', 'allow-nether', 'broadcast-console-to-ops', 'broadcast-rcon-to-ops', 'difficulty',
  'enable-command-block', 'enable-query', 'enable-status', 'enforce-secure-profile', 'enforce-whitelist',
  'entity-broadcast-range-percentage', 'force-gamemode', 'function-permission-level', 'gamemode',
  'generate-structures', 'hardcore', 'hide-online-players', 'level-name', 'level-seed', 'level-type',
  'max-chained-neighbor-updates', 'max-players', 'max-tick-time', 'max-world-size', 'motd',
  'network-compression-threshold', 'online-mode', 'op-permission-level', 'player-idle-timeout',
  'prevent-proxy-connections', 'pvp', 'rate-limit', 'require-resource-pack', 'resource-pack',
  'resource-pack-prompt', 'resource-pack-sha1', 'server-ip', 'server-port', 'simulation-distance',
  'spawn-animals', 'spawn-monsters', 'spawn-npcs', 'spawn-protection', 'sync-chunk-writes',
  'use-native-transport', 'view-distance', 'white-list', 'allow-cheats', 'accepts-transfers',
  'log-ips', 'pause-when-empty-seconds', 'region-file-compression', 'text-filtering-config',
]);

function propsPath(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return path.join(s.dir, 'server.properties');
}

async function readRaw(id) {
  try {
    return await fs.readFile(propsPath(id), 'utf8');
  } catch (err) {
    throw new Error('server.properties 파일을 읽을 수 없습니다: ' + err.message);
  }
}

function parse(content) {
  const props = {};
  const order = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      props[key] = trimmed.slice(idx + 1).trim();
      order.push(key);
    }
  }
  return { props, order };
}

// 값 정규화: boolean→true/false, 줄바꿈 제거, 길이 제한.
function normVal(val) {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val == null ? '' : val).replace(/[\r\n]+/g, ' ').slice(0, 1024);
}

// 허용 키만 남긴 정규화된 updates. strict=true 면 미허용 키에 에러.
function sanitize(updates, strict) {
  const out = {};
  for (const [key, val] of Object.entries(updates || {})) {
    if (!ALLOWED_KEYS.has(key)) {
      if (strict) throw new Error('허용되지 않은 설정 키: ' + key);
      continue;
    }
    out[key] = normVal(val);
  }
  return out;
}

// 원본 순서·주석을 보존하며 키를 교체/추가.
async function applyUpdates(id, updates) {
  const content = await readRaw(id);
  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set();
  const newLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { newLines.push(line); continue; }
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        newLines.push(`${key}=${updates[key]}`);
        updatedKeys.add(key);
        continue;
      }
    }
    newLines.push(line);
  }
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) newLines.push(`${key}=${val}`);
  }
  await fs.writeFile(propsPath(id), newLines.join('\n'), 'utf8');
}

// ===== 간이폼(기존 11키) =====
async function readProperties(id) {
  const { props } = parse(await readRaw(id));
  return {
    ok: true,
    properties: {
      'max-players': parseInt(props['max-players'] || '20', 10),
      'gamemode': props['gamemode'] || 'survival',
      'difficulty': props['difficulty'] || 'easy',
      'white-list': props['white-list'] === 'true',
      'online-mode': props['online-mode'] === 'true',
      'allow-flight': props['allow-flight'] === 'true',
      'force-gamemode': props['force-gamemode'] === 'true',
      'spawn-protection': parseInt(props['spawn-protection'] || '16', 10),
      'require-resource-pack': props['require-resource-pack'] === 'true',
      'resource-pack': props['resource-pack'] || '',
      'resource-pack-prompt': props['resource-pack-prompt'] || '',
    },
  };
}

async function writeProperties(id, updates) {
  // 간이폼: 미허용 키는 조용히 무시(안전)
  await applyUpdates(id, sanitize(updates, false));
  return { ok: true, message: '설정을 저장했습니다. 서버를 재시작하면 반영됩니다.' };
}

// ===== 전체 편집기 =====
async function readPropertiesFull(id) {
  const { props, order } = parse(await readRaw(id));
  return { ok: true, props, order, allowed: [...ALLOWED_KEYS].sort() };
}

async function writePropertiesFull(id, updates) {
  // 전체 편집기: 미허용 키는 에러로 알림
  await applyUpdates(id, sanitize(updates, true));
  return { ok: true, message: '설정을 저장했습니다. 서버를 재시작하면 반영됩니다.' };
}

module.exports = { readProperties, writeProperties, readPropertiesFull, writePropertiesFull, ALLOWED_KEYS };
