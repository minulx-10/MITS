'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');
const { resolveInside } = require('./util');

const UA = { 'User-Agent': 'MITS-panel/1.0 (github.com/minulx-10/MITS)' };

function pluginsDir(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return path.join(s.dir, 'plugins');
}

async function list(id) {
  const dir = pluginsDir(id);
  let ents = [];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { items: [] };
  }
  const items = [];
  for (const e of ents) {
    if (e.isDirectory()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) continue;
    const enabled = !lower.endsWith('.disabled');
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(path.join(dir, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* ignore */ }
    items.push({ file: e.name, name: e.name.replace(/\.jar(\.disabled)?$/i, ''), enabled, size, mtime });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items };
}

async function toggle(id, file) {
  const dir = pluginsDir(id);
  const cur = resolveInside(dir, file);
  if (path.dirname(cur) !== path.resolve(dir)) throw new Error('잘못된 파일입니다.');
  const next = cur.toLowerCase().endsWith('.disabled')
    ? cur.replace(/\.disabled$/i, '')
    : cur + '.disabled';
  await fs.rename(cur, next);
  return { ok: true, message: '변경했습니다. 서버를 재시작하면 반영됩니다.' };
}

async function remove(id, file) {
  const dir = pluginsDir(id);
  const cur = resolveInside(dir, file);
  if (path.dirname(cur) !== path.resolve(dir)) throw new Error('잘못된 파일입니다.');
  await fs.rm(cur, { force: true });
  return { ok: true, message: '삭제했습니다. 서버를 재시작하면 반영됩니다.' };
}

// ---- Modrinth 연동 (Aternos 애드온 카탈로그 대체) ----
async function search(query) {
  const q = (query || '').trim();
  const facets = JSON.stringify([['project_type:plugin']]);
  // 검색어 없으면 다운로드순(인기) 정렬로 인기 플러그인 노출
  const index = q ? 'relevance' : 'downloads';
  const url = `https://api.modrinth.com/v2/search?limit=24&index=${index}&query=${encodeURIComponent(q)}&facets=${encodeURIComponent(facets)}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('Modrinth 검색 실패 (HTTP ' + res.status + ')');
  const data = await res.json();
  return {
    popular: !q,
    items: (data.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      desc: h.description,
      downloads: h.downloads,
      icon: h.icon_url,
    })),
  };
}

async function install(id, projectId, loader = 'paper') {
  const dir = pluginsDir(id);
  const loaders = encodeURIComponent(JSON.stringify([loader, 'spigot', 'bukkit']));
  const vres = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?loaders=${loaders}`, { headers: UA });
  if (!vres.ok) throw new Error('버전 정보를 가져오지 못했습니다.');
  const versions = await vres.json();
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('이 서버(Paper)에 맞는 버전을 찾지 못했습니다.');
  }
  const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
  if (!file) throw new Error('다운로드할 파일이 없습니다.');
  const bin = await fetch(file.url, { headers: UA });
  if (!bin.ok) throw new Error('플러그인 다운로드 실패');
  const buf = Buffer.from(await bin.arrayBuffer());
  const safe = file.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  await fs.writeFile(path.join(dir, safe), buf);
  return { ok: true, message: `${file.filename} 설치 완료. 서버를 재시작하면 반영됩니다.` };
}

module.exports = { list, toggle, remove, search, install, pluginsDir };
