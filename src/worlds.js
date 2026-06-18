'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');
const { run, spawnCmd } = require('./util');

const DIM_DIRS = ['world', 'world_nether', 'world_the_end'];

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

async function info(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const worlds = await existingWorldDirs(s.dir);
  let sizeKB = 0;
  const du = await run('du', ['-sk', ...worlds.map((w) => path.join(s.dir, w))]);
  if (du.ok) {
    sizeKB = du.stdout.split('\n').reduce((a, l) => a + (parseInt(l, 10) || 0), 0);
  }
  return { worlds, sizeMB: Math.round(sizeKB / 1024) };
}

// 월드를 zip으로 스트리밍 다운로드 (메모리에 적재하지 않음)
async function downloadStream(id, res) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const worlds = await existingWorldDirs(s.dir);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${id}-world.zip"`);
  const z = spawnCmd('zip', ['-r', '-q', '-', ...worlds], { cwd: s.dir });
  z.stdout.pipe(res);
  z.stderr.on('data', () => {});
  z.on('error', () => { try { res.status(500).end('zip 실행 실패'); } catch { /* */ } });
}

async function findLevelRoot(startDir) {
  // level.dat 을 포함한 폴더를 BFS로 탐색 (최대 깊이 4)
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let ents;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (ents.some((e) => e.isFile() && e.name === 'level.dat')) return dir;
    if (depth < 4) {
      for (const e of ents) if (e.isDirectory()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

// 업로드한 월드 압축파일(.zip/.tar.gz)을 풀어 world 폴더로 교체
async function applyUpload(id, tmpPath, originalName) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const lower = String(originalName || '').toLowerCase();
  const staging = path.join(s.dir, '.world_upload_tmp');
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  try {
    if (lower.endsWith('.zip')) {
      const r = await run('unzip', ['-q', '-o', tmpPath, '-d', staging]);
      if (!r.ok) throw new Error('압축 해제 실패: ' + r.stderr);
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const r = await run('tar', ['-xzf', tmpPath, '-C', staging]);
      if (!r.ok) throw new Error('압축 해제 실패: ' + r.stderr);
    } else {
      throw new Error('.zip 또는 .tar.gz 파일만 지원합니다.');
    }

    const root = await findLevelRoot(staging);
    if (!root) throw new Error('업로드한 파일에서 level.dat 을 찾지 못했습니다. 올바른 월드 폴더인지 확인하세요.');

    const dest = path.join(s.dir, 'world');
    try {
      await fs.rename(dest, path.join(s.dir, `world.bak-${Date.now()}`));
    } catch { /* 기존 world 없으면 무시 */ }
    await fs.rename(root, dest);
    return { ok: true, message: '월드를 적용했습니다. 서버를 시작하세요. (기존 world 는 world.bak-* 로 보관)' };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// 월드 초기화 — 폴더 삭제 후 서버 시작 시 새 월드 생성
async function reset(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  for (const w of DIM_DIRS) {
    await fs.rm(path.join(s.dir, w), { recursive: true, force: true });
  }
  return { ok: true, message: '월드를 삭제했습니다. 서버를 시작하면 새 월드가 생성됩니다.' };
}

module.exports = { info, downloadStream, applyUpload, reset };
