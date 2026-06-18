'use strict';

/* ===== 공통 ===== */
const $ = (s, r = document) => r.querySelector(s);
const state = { server: 'server1', tab: 'dashboard', role: null, servers: [] };
let pollTimer = null;

const TABS = [
  ['dashboard', '대시보드'], ['console', '콘솔'], ['log', '로그'], ['players', '플레이어'],
  ['software', '소프트웨어'], ['plugins', '플러그인'], ['files', '파일'], ['world', '월드'],
  ['backups', '백업'], ['access', '액세스'],
];
const STATE_LABEL = { running: '실행 중', stopped: '정지됨', starting: '시작 중' };
const admin = () => state.role === 'admin';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : { ok: res.ok };
  if (!res.ok && data && data.error) throw new Error(data.error);
  return data;
}
const post = (p, body) => api(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

/* 모달 */
function modal({ title, text, ok = '실행', danger = false, input = false, placeholder = '', value = '' }) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text || '';
    const inp = $('#modalInput');
    inp.style.display = input ? 'block' : 'none';
    inp.value = value; inp.placeholder = placeholder;
    const okBtn = $('#modalOk'), cancelBtn = $('#modalCancel');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : 'start';
    $('#modalBg').classList.add('show');
    if (input) setTimeout(() => inp.focus(), 50);
    const done = (val) => { $('#modalBg').classList.remove('show'); okBtn.removeEventListener('click', onOk); cancelBtn.removeEventListener('click', onCancel); resolve(val); };
    const onOk = () => done(input ? inp.value : true);
    const onCancel = () => done(null);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/* ===== 셸 ===== */
function renderShell() {
  $('#serverSwitch').innerHTML = state.servers.map((s) =>
    `<button class="seg-btn ${s.id === state.server ? 'active' : ''}" data-srv="${s.id}">${esc(s.name)}</button>`).join('');
  $('#tabsNav').innerHTML = TABS.map(([id, label]) =>
    `<button class="tab-btn ${id === state.tab ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('');
  $('#roleBadge').textContent = state.role === 'viewer' ? '👁 뷰어(읽기전용)' : (state.role === 'admin' ? '🛠 관리자' : '');
  $('#roleBadge').className = 'role-badge ' + (state.role || '');
}

function setTab(tab) {
  state.tab = tab;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  renderShell();
  const fn = VIEWS[tab];
  if (fn) fn();
}

/* 현재 서버 prefix */
const SP = () => `/api/server/${state.server}`;

/* ===== 탭: 대시보드 ===== */
async function viewDashboard() {
  $('#view').innerHTML = `<div id="cards" class="cards"></div>
    <section class="info">
      <h3>접속 정보 <button class="ghost small" id="copyAddr">주소 복사</button></h3>
      <p class="muted">GSMSV는 재시작마다 외부 포트가 바뀔 수 있습니다. 정확한 현재 포트는 GSMSV 대시보드에서 확인하세요.</p>
      <ul>
        <li><b>PC(Java):</b> <code id="addrJava">ssh.gsmsv.site:&lt;외부포트&gt;</code></li>
        <li><b>모바일/Bedrock:</b> 주소 <code>ssh.gsmsv.site</code> · 포트 <code>&lt;외부포트&gt;</code></li>
        <li><b>이 패널:</b> <code>ssh -p 24160 -L 8080:127.0.0.1:3000 ubuntu@ssh.gsmsv.site</code></li>
      </ul>
    </section>`;
  $('#copyAddr').onclick = () => { navigator.clipboard.writeText('ssh.gsmsv.site').then(() => toast('주소를 복사했습니다.')); };
  await refreshDashboard();
  pollTimer = setInterval(refreshDashboard, 4000);
}
async function refreshDashboard() {
  let data;
  try { data = await api('/api/status'); } catch { return; }
  renderSysbar(data.system);
  const cards = data.servers.map(serverCard).join('') + globalCard();
  $('#cards').innerHTML = cards;
}
function renderSysbar(sys) {
  if (!sys) return;
  const pct = sys.totalMB ? Math.round((sys.usedMB / sys.totalMB) * 100) : 0;
  $('#sysbar').innerHTML = [
    `호스트 <b>${esc(sys.hostname)}</b>`,
    `RAM <b>${(sys.usedMB / 1024).toFixed(1)}/${(sys.totalMB / 1024).toFixed(1)}GiB (${pct}%)</b>`,
    `여유 <b>${sys.availMB}MiB</b>`, `Load <b>${(sys.load || []).join(' / ')}</b>`, `Uptime <b>${fmtUptime(sys.uptimeSec)}</b>`,
  ].join(' · ');
}
function serverCard(s) {
  const label = STATE_LABEL[s.state] || s.state;
  const ram = s.rssMB != null ? `${(s.rssMB / 1024).toFixed(2)} GiB` : '—';
  const busy = s.state === 'running' || s.state === 'starting';
  const dis = admin() ? '' : 'disabled';
  return `<div class="card">
    <div class="card-head"><div class="card-title">${esc(s.name)}</div>
      <span class="badge ${s.state}"><span class="dot ${s.state}"></span>${label}</span></div>
    <div class="meta">
      <span class="k">tmux 세션</span><span class="v">${s.session}</span>
      <span class="k">내부 포트</span><span class="v">${s.port}</span>
      <span class="k">메모리(RSS)</span><span class="v">${ram}</span>
      <span class="k">상태</span><span class="v">${label}</span></div>
    <div class="btns">
      <button class="start" data-act="start" data-id="${s.id}" ${busy ? 'disabled' : dis}>시작</button>
      <button class="stop" data-act="stop" data-id="${s.id}" ${busy ? dis : 'disabled'}>정지</button>
      <button class="restart" data-act="restart" data-id="${s.id}" ${busy ? dis : 'disabled'}>재시작</button>
    </div></div>`;
}
function globalCard() {
  const dis = admin() ? '' : 'disabled';
  return `<div class="card">
    <div class="card-title">전체 제어</div>
    <p class="muted" style="margin:10px 0 14px">서버의 <code>~/start.sh</code> / <code>~/stop.sh</code> 실행</p>
    <div class="btns">
      <button class="start" data-act="startall" ${dis}>전체 시작</button>
      <button class="stop" data-act="stopall" ${dis}>전체 정지</button></div></div>`;
}

/* ===== 탭: 콘솔 ===== */
async function viewConsole() {
  $('#view').innerHTML = `<section class="panel">
    <div class="panel-head"><div class="panel-title">콘솔 — ${esc(curName())}</div>
      <button class="ghost small" id="refreshC">새로고침</button></div>
    <pre class="console" id="console">불러오는 중…</pre>
    <form class="cmd" id="cmdForm"><span class="prompt">&gt;</span>
      <input id="cmdInput" placeholder="명령 입력 (예: list, say 안녕, op 닉네임)" autocomplete="off" ${admin() ? '' : 'disabled'} />
      <button type="submit" ${admin() ? '' : 'disabled'}>전송</button></form></section>
    <section class="info"><h3>콘솔 도움말</h3><ul>
      <li><b>치트/관리자(OP):</b> <code>op 닉네임</code> 후 게임에서 <code>/gamemode creative</code> 등 사용</li>
      <li><b>차단 해제(Unban):</b> <code>pardon 닉네임</code> · IP는 <code>pardon-ip 1.2.3.4</code></li>
      <li><b>게임모드 변경:</b> <code>gamemode survival 닉네임</code> (0=생존,1=창작,2=모험,3=관전)</li>
      <li><b>플레이어 목록:</b> <code>list</code> · <b>시간/날씨:</b> <code>time set day</code>, <code>weather clear</code></li></ul></section>`;
  $('#refreshC').onclick = loadConsole;
  $('#cmdForm').onsubmit = async (e) => {
    e.preventDefault();
    const inp = $('#cmdInput'); const command = inp.value.trim();
    if (!command) return;
    try { const r = await post(`${SP()}/command`, { command }); if (r.ok) { inp.value = ''; setTimeout(loadConsole, 400); } else toast(r.message, true); }
    catch (err) { toast(err.message, true); }
  };
  await loadConsole();
  pollTimer = setInterval(loadConsole, 2500);
}
async function loadConsole() {
  try {
    const d = await api(`${SP()}/console`);
    const el = $('#console'); if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = d.text || '(빈 콘솔)';
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch { /* */ }
}

/* ===== 탭: 로그 ===== */
async function viewLog() {
  $('#view').innerHTML = `<section class="panel">
    <div class="panel-head"><div class="panel-title">서버 기록 (latest.log) — ${esc(curName())}</div>
      <div><button class="ghost small" id="refreshL">새로고침</button>
      <button class="start small" id="shareL" ${admin() ? '' : 'disabled'}>로그 공유</button></div></div>
    <pre class="console" id="logbox">불러오는 중…</pre></section>`;
  $('#refreshL').onclick = loadLog;
  $('#shareL').onclick = async () => {
    try { toast('mclo.gs 로 업로드 중…'); const r = await post(`${SP()}/logs/share`); if (r.url) { await navigator.clipboard.writeText(r.url).catch(() => {}); await modal({ title: '로그 공유됨', text: r.url + '\n\n(주소가 클립보드에 복사되었습니다)', ok: '확인' }); } }
    catch (e) { toast(e.message, true); }
  };
  await loadLog();
}
async function loadLog() {
  try { const d = await api(`${SP()}/logs`); const el = $('#logbox'); if (el) { el.textContent = d.text; el.scrollTop = el.scrollHeight; } } catch { /* */ }
}

/* ===== 탭: 플레이어 ===== */
async function viewPlayers() {
  $('#view').innerHTML = `<section class="info"><h3>플레이어 관리 — ${esc(curName())}</h3>
    <p class="muted">추가/차단 등은 콘솔 명령으로 처리되므로 <b>서버가 켜져 있어야</b> 적용됩니다. 목록은 항상 표시됩니다.</p>
    <div class="player-add">
      <input id="pName" placeholder="닉네임" ${admin() ? '' : 'disabled'} />
      <button class="start small" data-pact="whitelist-add" ${admin() ? '' : 'disabled'}>화이트리스트+</button>
      <button class="restart small" data-pact="op" ${admin() ? '' : 'disabled'}>OP 부여</button>
      <button class="stop small" data-pact="ban" ${admin() ? '' : 'disabled'}>차단</button>
      <input id="pIp" placeholder="IP (예: 1.2.3.4)" style="max-width:150px" ${admin() ? '' : 'disabled'} />
      <button class="stop small" data-pact="ban-ip" data-ip="1" ${admin() ? '' : 'disabled'}>IP 차단</button>
    </div></section>
    <div id="plists"></div>
    <section class="panel">
      <div class="panel-head"><div class="panel-title">🎮 플레이어 상세 정보 (인벤토리·체력·좌표·허기·엔더상자·착용·스폰)</div>
        <button class="ghost small" id="pdRefresh">새로고침</button></div>
      <div class="pd-wrap"><div class="pd-list" id="pdList">불러오는 중…</div>
        <div class="pd-detail" id="pdDetail"><p class="muted">왼쪽에서 플레이어를 선택하면 마크 내부 정보를 모두 보여줍니다.</p></div></div>
    </section>`;
  $('#view').addEventListener('click', onPlayerBtn);
  $('#pdRefresh').onclick = loadPlayerDataList;
  await loadPlayers();
  await loadPlayerDataList();
}
async function loadPlayerDataList() {
  let d; try { d = await api(`${SP()}/playerdata`); } catch (e) { $('#pdList').textContent = e.message; return; }
  if (!d.items.length) { $('#pdList').innerHTML = '<p class="muted" style="padding:10px">접속 기록(playerdata)이 없습니다.</p>'; return; }
  $('#pdList').innerHTML = d.items.map((p) => `<button class="pd-item" data-uuid="${esc(p.uuid)}"><b>${esc(p.name)}</b><span class="muted">${esc(p.uuid.slice(0, 13))}…</span></button>`).join('');
  $('#pdList').querySelectorAll('button[data-uuid]').forEach((b) => b.onclick = () => {
    $('#pdList').querySelectorAll('.pd-item').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); showPlayerDetail(b.dataset.uuid);
  });
}
async function showPlayerDetail(uuid) {
  $('#pdDetail').innerHTML = '<p class="muted">불러오는 중…</p>';
  let d; try { d = await api(`${SP()}/playerdata/${uuid}`); } catch (e) { $('#pdDetail').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const stat = (k, v) => `<div class="pd-stat"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const items = (arr) => arr.length ? `<div class="pd-items">${arr.map((i) => `<span class="pd-slot" title="슬롯 ${i.slot}">${esc(i.id)}${i.count > 1 ? ` <b>×${i.count}</b>` : ''}</span>`).join('')}</div>` : '<p class="muted">비어 있음</p>';
  const pos = d.pos ? `${d.pos[0]}, ${d.pos[1]}, ${d.pos[2]}` : '—';
  const spawn = d.spawn ? `${d.spawn.x}, ${d.spawn.y}, ${d.spawn.z}` : '설정 안 됨';
  const armor = (d.armor || []).map((a) => `${a.label}=${esc(a.id)}`).join(' · ') || '없음';
  $('#pdDetail').innerHTML = `
    <div class="pd-headline">${esc(d.name)} <span class="muted">${esc(d.uuid)}</span></div>
    <div class="pd-stats">
      ${stat('좌표 (XYZ)', pos)}${stat('차원', esc(d.dimension || '—'))}
      ${stat('체력', d.health != null ? `${d.health} / 20 ♥` : '—')}${stat('허기', d.food != null ? `${d.food} / 20 🍗 (포화 ${d.saturation ?? 0})` : '—')}
      ${stat('경험치', d.xpLevel != null ? `Lv ${d.xpLevel} (총 ${d.xpTotal ?? '?'})` : '—')}${stat('게임모드', esc(d.gameTypeName))}
      ${stat('스폰 포인트', spawn)}${stat('착용 장비', esc(armor))}
      ${d.offhand ? stat('오프핸드', esc(d.offhand.id) + (d.offhand.count > 1 ? ` ×${d.offhand.count}` : '')) : ''}
    </div>
    <div class="pd-section"><h4>🎒 인벤토리 (${d.inventory.length}칸 사용)</h4>${items(d.inventory)}</div>
    <div class="pd-section"><h4>📦 엔더 상자 (${d.ender.length}칸 사용)</h4>${items(d.ender)}</div>`;
}
async function onPlayerBtn(e) {
  const b = e.target.closest('button[data-pact]'); if (!b) return;
  const act = b.dataset.pact;
  const value = b.dataset.ip ? $('#pIp').value.trim() : (b.dataset.val || $('#pName').value.trim());
  if (!value) return toast('값을 입력하세요.', true);
  try { const r = await post(`${SP()}/players/${act}`, { value }); toast(r.message || (r.ok ? '완료' : '실패'), !r.ok); setTimeout(loadPlayers, 900); }
  catch (err) { toast(err.message, true); }
}
async function loadPlayers() {
  let d; try { d = await api(`${SP()}/players`); } catch (e) { return; }
  const tbl = (title, rows, empty) => `<div class="card"><div class="card-title">${title} <span class="muted">(${rows.length})</span></div>
    <div class="plist">${rows.length ? rows.join('') : `<div class="muted" style="padding:10px">${empty}</div>`}</div></div>`;
  const nameRow = (name, act) => `<div class="prow"><span>${esc(name)}</span>${admin() && act ? `<button class="link-del" data-pact="${act}" data-val="${esc(name)}">제거</button>` : ''}</div>`;
  const wl = (d.whitelist || []).map((p) => nameRow(p.name, 'whitelist-remove'));
  const ops = (d.ops || []).map((p) => nameRow(p.name, 'deop'));
  const bans = (d.banned || []).map((p) => `<div class="prow"><span>${esc(p.name)} <span class="muted">${esc(p.reason || '')}</span></span>${admin() ? `<button class="link-del" data-pact="pardon" data-val="${esc(p.name)}">해제</button>` : ''}</div>`);
  const bips = (d.bannedIps || []).map((p) => `<div class="prow"><span>${esc(p.ip)}</span>${admin() ? `<button class="link-del" data-pact="pardon-ip" data-val="${esc(p.ip)}">해제</button>` : ''}</div>`);
  const off = (d.offline || []).slice(0, 50).map((p) => `<div class="prow"><span>${esc(p.name)}</span></div>`);
  $('#plists').innerHTML = `<div class="cards">
    ${tbl('화이트리스트', wl, '비어 있음')}${tbl('관리자(OP)', ops, '없음')}
    ${tbl('차단된 플레이어', bans, '없음')}${tbl('차단된 IP', bips, '없음')}
    ${tbl('접속 기록(오프라인)', off, '없음')}</div>`;
}

/* ===== 탭: 소프트웨어 ===== */
async function viewSoftware() {
  $('#view').innerHTML = `<section class="info"><h3>소프트웨어 — ${esc(curName())}</h3>
    <div id="swcur" class="muted">불러오는 중…</div>
    <div class="sw-update">
      <label>PaperMC 버전 변경:</label>
      <select id="swver" ${admin() ? '' : 'disabled'}><option>불러오는 중…</option></select>
      <button class="start small" id="swgo" ${admin() ? '' : 'disabled'}>이 버전으로 교체</button>
    </div>
    <p class="muted">⚠ 버전 교체는 <b>서버를 정지한 뒤</b> 진행하세요. 이전 jar은 <code>paper.jar.bak</code>로 보관됩니다.
    Aternos의 Blueprints(테마 맵)는 자체호스팅에 없어 <b>월드 업로드</b>로 대체합니다.</p></section>`;
  try {
    const cur = await api(`${SP()}/software`);
    $('#swcur').innerHTML = `현재: <b>${esc(cur.software)}</b> · <code>${esc(cur.currentVersion || '알 수 없음')}</code>${cur.mcVersion ? ` (MC ${esc(cur.mcVersion)})` : ''}`;
  } catch (e) { $('#swcur').textContent = e.message; }
  try {
    const v = await api('/api/paper/versions');
    $('#swver').innerHTML = v.versions.map((x) => `<option>${esc(x)}</option>`).join('');
  } catch { $('#swver').innerHTML = '<option>목록 실패</option>'; }
  $('#swgo').onclick = async () => {
    const version = $('#swver').value;
    if (!(await modal({ title: 'Paper 교체', text: `${version} 빌드를 내려받아 paper.jar 을 교체합니다. 서버가 꺼져 있어야 합니다.`, danger: true, ok: '교체' }))) return;
    try { toast('다운로드 중…'); const r = await post(`${SP()}/software/update`, { version }); toast(r.message); }
    catch (e) { toast(e.message, true); }
  };
}

/* ===== 탭: 플러그인 ===== */
async function viewPlugins() {
  $('#view').innerHTML = `
    <section class="info"><h3>설치된 플러그인 — ${esc(curName())}</h3>
      <div class="plugin-tools">
        <label class="upload-btn small ${admin() ? '' : 'disabled'}">+ .jar 직접 업로드<input type="file" id="plUp" accept=".jar" hidden ${admin() ? '' : 'disabled'}></label>
        <button class="ghost small" id="plRefresh">새로고침</button>
      </div>
      <div id="plList" class="muted" style="margin-top:12px">불러오는 중…</div></section>
    <section class="info"><h3>🔎 온라인 검색 · 즉시 설치 (Modrinth)</h3>
      <p class="muted">검색 후 <b>[설치]</b>를 누르면 서버 plugins 폴더로 바로 내려받습니다. (서버 재시작 후 적용)</p>
      <div class="plugin-tools">
        <input id="mrQ" placeholder="플러그인 이름 검색 (예: EssentialsX, LuckPerms, WorldGuard)" />
        <button class="start small" id="mrGo">검색</button>
      </div>
      <div class="chips" id="mrChips"></div>
      <div id="mrResults" class="muted" style="margin-top:6px">인기 플러그인 불러오는 중…</div></section>`;
  $('#plUp').onchange = (e) => uploadFile(`${SP()}/plugins/upload`, e.target.files[0], loadPlugins);
  $('#plRefresh').onclick = loadPlugins;
  $('#mrGo').onclick = searchModrinth;
  $('#mrQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchModrinth(); });
  const chips = ['EssentialsX', 'LuckPerms', 'WorldGuard', 'Vault', 'ViaVersion', 'CoreProtect', 'Chunky', 'Dynmap'];
  $('#mrChips').innerHTML = chips.map((c) => `<button class="chip" data-chip="${c}">${c}</button>`).join('');
  $('#mrChips').querySelectorAll('button[data-chip]').forEach((b) => b.onclick = () => { $('#mrQ').value = b.dataset.chip; searchModrinth(); });
  $('#view').addEventListener('click', onPluginBtn);
  await loadPlugins();
  await searchModrinth();
}
async function loadPlugins() {
  let d; try { d = await api(`${SP()}/plugins`); } catch (e) { $('#plList').textContent = e.message; return; }
  if (!d.items.length) { $('#plList').innerHTML = '<p class="muted">설치된 플러그인이 없습니다.</p>'; return; }
  $('#plList').innerHTML = `<table class="tbl"><thead><tr><th>이름</th><th>상태</th><th>크기</th><th></th></tr></thead><tbody>${
    d.items.map((p) => `<tr><td>${esc(p.name)}</td>
      <td>${p.enabled ? '<span class="ok">활성</span>' : '<span class="off">비활성</span>'}</td>
      <td>${fmtSize(p.size)}</td>
      <td class="row-act">${admin() ? `<button class="ghost xs" data-plt="toggle" data-file="${esc(p.file)}">${p.enabled ? '비활성화' : '활성화'}</button>
        <button class="link-del" data-plt="delete" data-file="${esc(p.file)}">삭제</button>` : ''}</td></tr>`).join('')
  }</tbody></table>`;
}
async function onPluginBtn(e) {
  const b = e.target.closest('button[data-plt]'); if (!b) return;
  const file = b.dataset.file;
  if (b.dataset.plt === 'delete' && !(await modal({ title: '플러그인 삭제', text: `${file} 삭제?`, danger: true, ok: '삭제' }))) return;
  try { const r = await post(`${SP()}/plugins/${b.dataset.plt}`, { file }); toast(r.message); loadPlugins(); }
  catch (err) { toast(err.message, true); }
}
async function searchModrinth() {
  const q = $('#mrQ').value.trim();
  $('#mrResults').innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const d = await api('/api/modrinth/search?q=' + encodeURIComponent(q));
    const head = d.popular ? '<p class="muted">⭐ 인기 플러그인 (다운로드순)</p>' : '';
    $('#mrResults').innerHTML = head + (d.items.length ? `<div class="mr-grid">${d.items.map((m) => `<div class="mr-card">
      <div class="mr-top">${m.icon ? `<img class="mr-ico" src="${esc(m.icon)}" alt="" loading="lazy">` : '<span class="mr-ico ph">🧩</span>'}<div class="mr-title">${esc(m.title)}</div></div>
      <div class="mr-desc">${esc((m.desc || '').slice(0, 90))}</div>
      <div class="mr-foot"><span class="muted">⬇ ${m.downloads.toLocaleString()}</span>
      ${admin() ? `<button class="start xs" data-mri="${esc(m.id)}">설치</button>` : ''}</div></div>`).join('')}</div>` : '<p class="muted">결과 없음</p>');
    $('#mrResults').querySelectorAll('button[data-mri]').forEach((btn) => btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '설치 중…';
      try { const r = await post(`${SP()}/plugins/install`, { projectId: btn.dataset.mri }); toast(r.message); loadPlugins(); btn.textContent = '설치됨 ✓'; }
      catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '설치'; }
    });
  } catch (e) { $('#mrResults').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/* ===== 탭: 파일 매니저 ===== */
const fmState = { path: '', items: [], sortKey: 'name', sortDir: 1, filter: '' };
async function viewFiles() {
  fmState.path = ''; fmState.filter = '';
  $('#view').innerHTML = `<section class="panel">
    <div class="panel-head">
      <div class="fm-crumb" id="fmCrumb"></div>
      <div class="fm-tools">
        <input id="fmFilter" class="fm-filter" placeholder="이 폴더에서 찾기…">
        <button class="ghost small" id="fmMk" ${admin() ? '' : 'disabled'}>+폴더</button>
        <button class="ghost small" id="fmNew" ${admin() ? '' : 'disabled'}>+파일</button>
        <label class="upload-btn small ${admin() ? '' : 'disabled'}">업로드<input type="file" id="fmUpload" hidden ${admin() ? '' : 'disabled'}></label>
        <button class="ghost small" id="fmRefresh">새로고침</button>
      </div></div>
    <div id="fmBody" class="fm-body">불러오는 중…</div>
    <div class="fm-drop" id="fmDrop">📥 여기에 파일을 놓으면 업로드됩니다</div></section>`;
  $('#fmRefresh').onclick = () => loadFiles(fmState.path);
  $('#fmMk').onclick = async () => { const name = await modal({ title: '새 폴더', input: true, placeholder: '폴더 이름', ok: '생성' }); if (name) { try { await post(`${SP()}/files/mkdir`, { path: fmState.path, name }); loadFiles(fmState.path); } catch (e) { toast(e.message, true); } } };
  $('#fmNew').onclick = async () => { const name = await modal({ title: '새 파일', input: true, placeholder: '예: config.yml', ok: '생성' }); if (name) { try { await post(`${SP()}/files/newfile`, { path: fmState.path, name }); loadFiles(fmState.path); } catch (e) { toast(e.message, true); } } };
  $('#fmUpload').onchange = (e) => uploadFile(`${SP()}/files/upload?`, e.target.files[0], () => loadFiles(fmState.path), { path: fmState.path });
  $('#fmFilter').addEventListener('input', (e) => { fmState.filter = e.target.value.toLowerCase(); renderFiles(); });
  setupDrop();
  await loadFiles('');
}
function setupDrop() {
  const body = $('#fmBody'); const drop = $('#fmDrop'); if (!body || !drop) return;
  const show = (on) => drop.classList.toggle('show', on);
  ['dragenter', 'dragover'].forEach((ev) => body.addEventListener(ev, (e) => { e.preventDefault(); if (admin()) show(true); }));
  body.addEventListener('dragleave', (e) => { if (e.relatedTarget && body.contains(e.relatedTarget)) return; show(false); });
  body.addEventListener('drop', (e) => {
    e.preventDefault(); show(false);
    if (!admin()) return;
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(`${SP()}/files/upload?`, f, () => loadFiles(fmState.path), { path: fmState.path });
  });
}
async function loadFiles(p) {
  let d; try { d = await api(`${SP()}/files?path=` + encodeURIComponent(p || '')); } catch (e) { toast(e.message, true); return; }
  fmState.path = d.path; fmState.items = d.items;
  renderCrumb(); renderFiles();
}
function renderCrumb() {
  const parts = fmState.path ? fmState.path.split('/') : [];
  let acc = '';
  const crumbs = [`<a class="fm-cr" data-cp="">🏠 루트</a>`];
  parts.forEach((seg) => { acc = acc ? acc + '/' + seg : seg; crumbs.push(`<span class="fm-sep">/</span><a class="fm-cr" data-cp="${esc(acc)}">${esc(seg)}</a>`); });
  const el = $('#fmCrumb'); el.innerHTML = crumbs.join('');
  el.querySelectorAll('a[data-cp]').forEach((a) => a.onclick = () => loadFiles(a.dataset.cp));
}
function fileIcon(name) {
  const e = name.split('.').pop().toLowerCase();
  if (['yml', 'yaml', 'properties', 'conf', 'cfg', 'toml', 'ini'].includes(e)) return '⚙️';
  if (e === 'json') return '🗂️';
  if (['jar', 'zip', 'gz', 'tar', 'tgz'].includes(e)) return '📦';
  if (['log', 'txt', 'md'].includes(e)) return '📄';
  if (e === 'sh') return '📜';
  if (['png', 'jpg', 'jpeg', 'gif'].includes(e)) return '🖼️';
  return '📄';
}
function renderFiles() {
  const ic = (k) => fmState.sortKey === k ? (fmState.sortDir > 0 ? ' ▲' : ' ▼') : '';
  let items = fmState.items.slice();
  if (fmState.filter) items = items.filter((i) => i.name.toLowerCase().includes(fmState.filter));
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    const k = fmState.sortKey;
    const r = k === 'name' ? a.name.localeCompare(b.name) : ((a[k] || 0) - (b[k] || 0));
    return r * fmState.sortDir;
  });
  const rows = items.map((it) => {
    const full = (fmState.path ? fmState.path + '/' : '') + it.name;
    const icon = it.type === 'dir' ? '📁' : fileIcon(it.name);
    const nameCell = it.type === 'dir' ? `<a class="fm-link" data-dir="${esc(full)}">${icon} ${esc(it.name)}</a>` : `<span>${icon} ${esc(it.name)}</span>`;
    const acts = [];
    if (it.type === 'file' && it.editable && admin()) acts.push(`<button class="ghost xs" data-edit="${esc(full)}">편집</button>`);
    if (it.type === 'file') acts.push(`<a class="ghost xs" href="${SP()}/files/download?path=${encodeURIComponent(full)}">받기</a>`);
    if (admin()) acts.push(`<button class="ghost xs" data-ren="${esc(full)}" data-name="${esc(it.name)}">이름</button>`);
    if (admin()) acts.push(`<button class="link-del" data-del="${esc(full)}">삭제</button>`);
    return `<tr><td>${nameCell}</td><td>${it.type === 'dir' ? '' : fmtSize(it.size)}</td><td class="muted">${fmtTime(it.mtime)}</td><td class="row-act">${acts.join('')}</td></tr>`;
  }).join('');
  $('#fmBody').innerHTML = `<table class="tbl"><thead><tr>
    <th class="sortable" data-sk="name">이름${ic('name')}</th>
    <th class="sortable" data-sk="size">크기${ic('size')}</th>
    <th class="sortable" data-sk="mtime">수정${ic('mtime')}</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan=4 class="muted">표시할 항목이 없습니다</td></tr>'}</tbody></table>`;
  const body = $('#fmBody');
  body.querySelectorAll('th.sortable').forEach((th) => th.onclick = () => { const k = th.dataset.sk; if (fmState.sortKey === k) fmState.sortDir *= -1; else { fmState.sortKey = k; fmState.sortDir = 1; } renderFiles(); });
  body.querySelectorAll('a[data-dir]').forEach((a) => a.onclick = () => loadFiles(a.dataset.dir));
  body.querySelectorAll('button[data-edit]').forEach((b) => b.onclick = () => editFile(b.dataset.edit));
  body.querySelectorAll('button[data-ren]').forEach((b) => b.onclick = async () => {
    const nn = await modal({ title: '이름 바꾸기', input: true, value: b.dataset.name, ok: '변경' });
    if (nn && nn !== b.dataset.name) { try { await post(`${SP()}/files/rename`, { path: b.dataset.ren, newName: nn }); loadFiles(fmState.path); } catch (e) { toast(e.message, true); } }
  });
  body.querySelectorAll('button[data-del]').forEach((b) => b.onclick = async () => {
    if (!(await modal({ title: '삭제', text: `${b.dataset.del} 삭제?`, danger: true, ok: '삭제' }))) return;
    try { await post(`${SP()}/files/delete`, { path: b.dataset.del }); loadFiles(fmState.path); } catch (e) { toast(e.message, true); }
  });
}
async function editFile(p) {
  let d; try { d = await api(`${SP()}/file?path=` + encodeURIComponent(p)); } catch (e) { return toast(e.message, true); }
  $('#view').innerHTML = `<section class="panel"><div class="panel-head"><div class="panel-title">📝 /${esc(p)}</div>
    <div><span class="muted" style="margin-right:10px">Ctrl+S 저장</span><button class="ghost small" id="edCancel">← 목록</button><button class="start small" id="edSave">저장</button></div></div>
    <textarea id="edArea" class="editor" spellcheck="false"></textarea></section>`;
  const area = $('#edArea'); area.value = d.content;
  const save = async () => { try { await post(`${SP()}/file`, { path: p, content: area.value }); toast('저장했습니다.'); } catch (e) { toast(e.message, true); } };
  $('#edCancel').onclick = () => viewFiles().then(() => loadFiles(fmState.path));
  $('#edSave').onclick = save;
  area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
  area.focus();
}

/* ===== 탭: 월드 ===== */
async function viewWorld() {
  $('#view').innerHTML = `<section class="info"><h3>월드 — ${esc(curName())}</h3>
    <div id="wInfo" class="muted">불러오는 중…</div>
    <div class="world-actions">
      <a class="start small" href="${SP()}/world/download">⬇ 월드 다운로드(.zip)</a>
      <label class="upload-btn small ${admin() ? '' : 'disabled'}">⬆ 월드 업로드<input type="file" id="wUp" accept=".zip,.tar.gz,.tgz" hidden ${admin() ? '' : 'disabled'}></label>
      <button class="stop small" id="wReset" ${admin() ? '' : 'disabled'}>월드 초기화</button>
    </div>
    <p class="muted">업로드/초기화는 <b>서버를 정지한 뒤</b> 가능합니다. 업로드 시 기존 world는 <code>world.bak-*</code>로 보관됩니다.
    싱글플레이 맵은 <code>.zip</code>으로 압축해 올리면 <code>level.dat</code>을 자동으로 찾아 적용합니다.</p></section>`;
  $('#wUp').onchange = (e) => uploadFile(`${SP()}/world/upload`, e.target.files[0], loadWorld);
  $('#wReset').onclick = async () => {
    if (!(await modal({ title: '월드 초기화', text: '현재 월드를 삭제합니다. 서버 시작 시 새 월드가 생성됩니다. (백업 권장!)', danger: true, ok: '초기화' }))) return;
    try { const r = await post(`${SP()}/world/reset`); toast(r.message); loadWorld(); } catch (e) { toast(e.message, true); }
  };
  await loadWorld();
}
async function loadWorld() {
  try { const d = await api(`${SP()}/world`); $('#wInfo').innerHTML = `폴더: ${d.worlds.map((w) => `<code>${esc(w)}</code>`).join(' ')} · 용량 약 <b>${d.sizeMB} MB</b>`; }
  catch (e) { $('#wInfo').textContent = e.message; }
}

/* ===== 탭: 백업 ===== */
async function viewBackups() {
  $('#view').innerHTML = `<section class="info"><h3>백업 — ${esc(curName())}</h3>
    <p class="muted">월드 폴더를 <code>~/mits-backups</code>에 <code>.tar.gz</code>로 저장합니다. (Aternos의 구글드라이브 대신 서버 내 보관 + 다운로드)</p>
    <div class="backup-add">
      <input id="bName" placeholder="백업 이름(선택)" ${admin() ? '' : 'disabled'} />
      <button class="start small" id="bCreate" ${admin() ? '' : 'disabled'}>지금 백업</button>
    </div></section>
    <div id="bList" class="muted">불러오는 중…</div>`;
  $('#bCreate').onclick = async () => { try { toast('백업 중…'); const r = await post(`${SP()}/backups/create`, { name: $('#bName').value }); toast(r.message); $('#bName').value = ''; loadBackups(); } catch (e) { toast(e.message, true); } };
  $('#view').addEventListener('click', onBackupBtn);
  await loadBackups();
}
async function loadBackups() {
  let d; try { d = await api(`${SP()}/backups`); } catch (e) { $('#bList').textContent = e.message; return; }
  if (!d.items.length) { $('#bList').innerHTML = '<p class="muted">백업이 없습니다.</p>'; return; }
  $('#bList').innerHTML = `<table class="tbl"><thead><tr><th>백업</th><th>크기</th><th>생성</th><th></th></tr></thead><tbody>${
    d.items.map((b) => `<tr><td>${esc(b.file)}</td><td>${fmtSize(b.size)}</td><td class="muted">${fmtTime(b.mtime)}</td>
      <td class="row-act"><a class="ghost xs" href="${SP()}/backups/download?file=${encodeURIComponent(b.file)}">받기</a>
      ${admin() ? `<button class="restart xs" data-brestore="${esc(b.file)}">복구</button>
      <button class="link-del" data-bdel="${esc(b.file)}">삭제</button>` : ''}</td></tr>`).join('')
  }</tbody></table>`;
}
async function onBackupBtn(e) {
  const r = e.target.closest('button[data-brestore]'); const del = e.target.closest('button[data-bdel]');
  if (r) {
    if (!(await modal({ title: '백업 복구', text: `${r.dataset.brestore} 로 되돌립니다. 서버가 꺼져 있어야 하며 현재 월드는 *.before-restore 로 보관됩니다.`, danger: true, ok: '복구' }))) return;
    try { const res = await post(`${SP()}/backups/restore`, { file: r.dataset.brestore }); toast(res.message); } catch (err) { toast(err.message, true); }
  } else if (del) {
    if (!(await modal({ title: '백업 삭제', text: `${del.dataset.bdel} 삭제?`, danger: true, ok: '삭제' }))) return;
    try { await post(`${SP()}/backups/delete`, { file: del.dataset.bdel }); loadBackups(); } catch (err) { toast(err.message, true); }
  }
}

/* ===== 탭: 액세스 ===== */
async function viewAccess() {
  $('#view').innerHTML = `<section class="info"><h3>액세스(권한 공유)</h3>
    <p>현재 로그인: <b>${state.role === 'admin' ? '관리자(모든 기능)' : '뷰어(읽기 전용)'}</b></p>
    <p class="muted">Aternos의 계정 초대는 자체호스팅에 없어, <b>2단계 비밀번호</b>로 대체합니다.</p>
    <ul>
      <li><b>관리자</b>: 모든 제어 가능. <code>PANEL_PASSWORD</code> 비밀번호로 로그인.</li>
      <li><b>뷰어(친구 공유용)</b>: 상태·콘솔·로그·목록 <u>보기만</u> 가능, 제어 불가.
        <code>PANEL_VIEWER_PASSWORD</code> 환경변수를 설정하면 활성화됩니다.</li>
    </ul>
    <div class="cards" style="margin-top:16px">
      <div class="card"><div class="card-title">🔑 권한 공유</div><p class="muted">친구에게 뷰어 비밀번호 + SSH 터널 명령을 알려주면 읽기 전용으로 접속합니다.</p></div>
      <div class="card"><div class="card-title">🔌 서버 접속</div><p class="muted">대시보드의 접속 정보 참고. 외부 포트는 GSMSV에서 확인.</p></div>
      <div class="card"><div class="card-title">🚫 차단 해제</div><p class="muted">플레이어 탭 또는 콘솔 <code>pardon 닉네임</code>.</p></div>
    </div>
    <p class="muted" style="margin-top:14px">뷰어 비밀번호 설정: GitHub에서 <code>gh secret set PANEL_VIEWER_PASSWORD</code> 후 재배포, 또는 서버 <code>~/MITS/.env</code>에 추가 후 <code>sudo systemctl restart mits</code>.</p>
  </section>`;
}

/* ===== 업로드 헬퍼 ===== */
async function uploadFile(url, file, after, extra) {
  if (!file) return;
  const fd = new FormData();
  if (extra) for (const k in extra) fd.append(k, extra[k]);
  fd.append('file', file);
  const real = url.endsWith('?') ? url.slice(0, -1) + '?path=' + encodeURIComponent((extra && extra.path) || '') : url;
  try {
    toast(`업로드 중… (${file.name})`);
    const res = await fetch(real, { method: 'POST', body: fd });
    if (res.status === 401) { location.href = '/login.html'; return; }
    const d = await res.json();
    if (d.ok) { toast(d.message || '업로드 완료'); if (after) after(); } else toast(d.error || '업로드 실패', true);
  } catch (e) { toast('업로드 실패: ' + e.message, true); }
}

/* ===== 공통 액션(전원) ===== */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id || state.server;
  const name = (state.servers.find((s) => s.id === id) || {}).name || '';
  if (act === 'stop' && !(await modal({ title: '서버 정지', text: `${name} 정지? 접속자가 끊깁니다.`, danger: true, ok: '정지' }))) return;
  if (act === 'restart' && !(await modal({ title: '서버 재시작', text: `${name} 재시작?`, danger: true, ok: '재시작' }))) return;
  if (act === 'stopall' && !(await modal({ title: '전체 정지', text: '두 서버 모두 정지?', danger: true, ok: '정지' }))) return;
  let p = act === 'startall' ? '/api/power/startall' : act === 'stopall' ? '/api/power/stopall' : `${SP()}/${act}`;
  if (['start', 'stop', 'restart'].includes(act)) p = `/api/server/${id}/${act}`;
  try { const r = await post(p); toast(r.message || (r.ok ? '완료' : '실패'), !r.ok); setTimeout(refreshDashboard, 700); }
  catch (err) { toast(err.message, true); }
});

/* ===== 네비게이션 ===== */
const VIEWS = { dashboard: viewDashboard, console: viewConsole, log: viewLog, players: viewPlayers, software: viewSoftware, plugins: viewPlugins, files: viewFiles, world: viewWorld, backups: viewBackups, access: viewAccess };
const curName = () => (state.servers.find((s) => s.id === state.server) || {}).name || state.server;

$('#tabsNav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#serverSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-srv]'); if (b) { state.server = b.dataset.srv; setTab(state.tab); } });
$('#logout').onclick = async () => { await post('/api/logout'); location.href = '/login.html'; };

/* ===== 부팅 ===== */
(async function boot() {
  try {
    const me = await api('/api/me');
    state.role = me.role;
    const st = await api('/api/status');
    state.servers = st.servers.map((s) => ({ id: s.id, name: s.name }));
    state.server = state.servers[0] ? state.servers[0].id : 'server1';
  } catch { /* 401 처리됨 */ }
  renderShell();
  setTab('dashboard');
})();
