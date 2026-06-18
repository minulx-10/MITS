'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');

async function readProperties(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);

  const filePath = path.join(s.dir, 'server.properties');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error('server.properties 파일을 읽을 수 없습니다: ' + err.message);
  }

  const props = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      props[key] = val;
    }
  }

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
      'resource-pack-prompt': props['resource-pack-prompt'] || ''
    }
  };
}

async function writeProperties(id, updates) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);

  const filePath = path.join(s.dir, 'server.properties');
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error('server.properties 파일을 읽을 수 없습니다: ' + err.message);
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set();
  const newLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(line);
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      if (updates.hasOwnProperty(key)) {
        let val = updates[key];
        if (typeof val === 'boolean') {
          val = val ? 'true' : 'false';
        }
        newLines.push(`${key}=${val}`);
        updatedKeys.add(key);
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  // Append any keys that weren't in the original file
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      let valStr = val;
      if (typeof val === 'boolean') {
        valStr = val ? 'true' : 'false';
      }
      newLines.push(`${key}=${valStr}`);
    }
  }

  await fs.writeFile(filePath, newLines.join('\n'), 'utf8');
  return { ok: true, message: '설정을 저장했습니다. 서버를 재시작하면 반영됩니다.' };
}

module.exports = { readProperties, writeProperties };
