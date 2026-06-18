'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer, config } = require('./config');
const { run, resolveInside } = require('./util');

const DIM_DIRS = ['world', 'world_nether', 'world_the_end'];

function backupRoot(id) {
  return path.join(config.backupDir, id);
}

async function existingWorldDirs(dir) {
  const out = [];
  for (const w of DIM_DIRS) {
    try {
      const st = await fs.stat(path.join(dir, w));
      if (st.isDirectory()) out.push(w);
    } catch { /* 없음 */ }
  }
  return out.length ? out : ['world'];
}

function stampName(name) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const safe = String(name || '').trim().replace(/[^A-Za-z0-9가-힣_-]/g, '_').slice(0, 40);
  return safe ? `${stamp}_${safe}.tar.gz` : `${stamp}.tar.gz`;
}

async function create(id, name) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const root = backupRoot(id);
  await fs.mkdir(root, { recursive: true });
  const worlds = await existingWorldDirs(s.dir);
  const file = path.join(root, stampName(name));
  const r = await run('tar', ['-czf', file, '-C', s.dir, ...worlds]);
  if (!r.ok) throw new Error('백업 실패: ' + r.stderr);
  await prune(id);
  return { ok: true, message: '백업을 만들었습니다.' };
}

async function list(id) {
  const root = backupRoot(id);
  let ents = [];
  try {
    ents = await fs.readdir(root);
  } catch {
    return { items: [] };
  }
  const items = [];
  for (const f of ents) {
    if (!f.endsWith('.tar.gz')) continue;
    try {
      const st = await fs.stat(path.join(root, f));
      items.push({ file: f, size: st.size, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items };
}

async function restore(id, file) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const f = resolveInside(backupRoot(id), file);
  // 현재 월드를 보존(.before-restore)한 뒤 복원
  for (const w of DIM_DIRS) {
    await fs.rm(path.join(s.dir, `${w}.before-restore`), { recursive: true, force: true }).catch(() => {});
    await fs.rename(path.join(s.dir, w), path.join(s.dir, `${w}.before-restore`)).catch(() => {});
  }
  const r = await run('tar', ['-xzf', f, '-C', s.dir]);
  if (!r.ok) throw new Error('복원 실패: ' + r.stderr);
  return { ok: true, message: '복원 완료. 서버를 시작하세요. (직전 월드는 *.before-restore 로 보관)' };
}

async function remove(id, file) {
  const f = resolveInside(backupRoot(id), file);
  await fs.rm(f, { force: true });
  return { ok: true, message: '백업을 삭제했습니다.' };
}

function resolveDownload(id, file) {
  return resolveInside(backupRoot(id), file);
}

async function prune(id) {
  const keep = config.backupKeep;
  if (!keep || keep <= 0) return;
  const { items } = await list(id);
  for (const it of items.slice(keep)) {
    await fs.rm(path.join(backupRoot(id), it.file), { force: true }).catch(() => {});
  }
}

module.exports = { create, list, restore, remove, resolveDownload, prune, backupRoot };
