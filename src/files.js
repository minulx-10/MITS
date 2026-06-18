'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');
const { resolveInside } = require('./util');

const TEXT_EXT = new Set([
  '.txt', '.json', '.yml', '.yaml', '.properties', '.log', '.sh', '.cfg',
  '.conf', '.md', '.toml', '.ini', '.csv', '.mcmeta', '.xml', '.html',
]);
const MAX_EDIT = 2 * 1024 * 1024; // 2MB

function baseDir(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return s.dir;
}
const isText = (name) => TEXT_EXT.has(path.extname(name).toLowerCase());

async function list(id, rel) {
  const base = baseDir(id);
  const dir = resolveInside(base, rel);
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of ents) {
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(path.join(dir, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* 깨진 심볼릭 링크 등 무시 */ }
    items.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
      editable: !e.isDirectory() && isText(e.name),
    });
  }
  items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  const relNorm = path.relative(base, dir).split(path.sep).join('/');
  return { path: relNorm, items };
}

async function read(id, rel) {
  const f = resolveInside(baseDir(id), rel);
  const st = await fs.stat(f);
  if (st.isDirectory()) throw new Error('폴더는 열 수 없습니다.');
  if (!isText(f)) throw new Error('텍스트 파일만 편집할 수 있습니다. (다운로드해서 확인하세요)');
  if (st.size > MAX_EDIT) throw new Error('파일이 너무 큽니다(2MB 초과). 다운로드해서 확인하세요.');
  return { content: await fs.readFile(f, 'utf8') };
}

async function write(id, rel, content) {
  const f = resolveInside(baseDir(id), rel);
  if (!isText(f)) throw new Error('텍스트 파일만 저장할 수 있습니다.');
  await fs.writeFile(f, String(content == null ? '' : content), 'utf8');
  return { ok: true, message: '저장했습니다.' };
}

async function remove(id, rel) {
  const base = baseDir(id);
  const f = resolveInside(base, rel);
  if (f === path.resolve(base)) throw new Error('서버 루트 폴더는 삭제할 수 없습니다.');
  await fs.rm(f, { recursive: true, force: true });
  return { ok: true, message: '삭제했습니다.' };
}

async function mkdir(id, rel, name) {
  if (!name || /[/\\]/.test(name)) throw new Error('폴더 이름이 올바르지 않습니다.');
  const dir = resolveInside(baseDir(id), path.join(rel || '.', name));
  await fs.mkdir(dir, { recursive: true });
  return { ok: true, message: '폴더를 만들었습니다.' };
}

function resolveDownload(id, rel) {
  return resolveInside(baseDir(id), rel);
}

module.exports = { list, read, write, remove, mkdir, resolveDownload, baseDir };
