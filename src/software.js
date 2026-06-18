'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer, config } = require('./config');

const UA = { 'User-Agent': 'MITS-panel/1.0 (github.com/minulx-10/MITS)' };
const API = 'https://api.papermc.io/v2/projects/paper';

async function current(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  try {
    const vh = JSON.parse(await fs.readFile(path.join(s.dir, 'version_history.json'), 'utf8'));
    const cv = vh.currentVersion || '';
    const mcVersion = (cv.match(/MC:\s*([0-9.]+)/) || [])[1] || null;
    return { software: 'PaperMC', currentVersion: cv, mcVersion };
  } catch {
    return { software: 'PaperMC', currentVersion: null, mcVersion: null };
  }
}

async function versions() {
  const res = await fetch(API, { headers: UA });
  if (!res.ok) throw new Error('Paper 버전 목록을 가져오지 못했습니다.');
  const data = await res.json();
  return { versions: (data.versions || []).slice(-30).reverse() };
}

async function update(id, version) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (!/^[0-9][0-9A-Za-z.\-]*$/.test(String(version || ''))) throw new Error('버전 형식이 올바르지 않습니다.');

  const bres = await fetch(`${API}/versions/${encodeURIComponent(version)}`, { headers: UA });
  if (!bres.ok) throw new Error(`Paper ${version} 을(를) 찾을 수 없습니다.`);
  const bdata = await bres.json();
  const build = (bdata.builds || []).slice(-1)[0];
  if (!build) throw new Error('빌드를 찾을 수 없습니다.');

  const jar = `paper-${version}-${build}.jar`;
  const url = `${API}/versions/${version}/builds/${build}/downloads/${jar}`;
  const bin = await fetch(url, { headers: UA });
  if (!bin.ok) throw new Error('jar 다운로드에 실패했습니다.');
  const buf = Buffer.from(await bin.arrayBuffer());

  const target = path.join(s.dir, config.jar);
  try {
    await fs.rename(target, target + '.bak');
  } catch { /* 기존 jar 없으면 무시 */ }
  await fs.writeFile(target, buf);
  return { ok: true, message: `Paper ${version} (build ${build}) 적용 완료. 서버를 시작하세요. (이전 jar은 ${config.jar}.bak)` };
}

module.exports = { current, versions, update };
