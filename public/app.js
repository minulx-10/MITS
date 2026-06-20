'use strict';

/* ===== 공통 ===== */
const $ = (s, r = document) => r.querySelector(s);
const state = { server: 'server1', tab: 'dashboard', role: null, servers: [] };
let pollTimer = null;
let consoleES = null;          // 콘솔 SSE 연결
const cmdHist = { list: [], idx: -1 };  // 명령 히스토리(↑↓)

const TABS = [
  ['dashboard', '대시보드'], ['gamesettings', '게임설정'], ['options', '설정'], ['console', '콘솔'], ['log', '로그'],
  ['players', '플레이어'], ['software', '소프트웨어'], ['plugins', '플러그인'], ['files', '파일'],
  ['world', '월드'], ['backups', '백업'], ['schedules', '예약'], ['macros', '매크로'], ['access', '액세스'],
];
const STATE_LABEL = { running: '실행 중', stopped: '정지됨', starting: '시작 중', stopping: '종료 중', restarting: '재시작 중' };
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
  if (consoleES) { consoleES.close(); consoleES = null; }
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
      <h3>접속 정보 
        <button class="ghost small" id="copyAddr">주소 복사</button>
        ${admin() ? '<button class="ghost small" id="editPort" style="margin-left: 6px">외부 포트 설정</button>' : ''}
      </h3>
      <p class="muted">GSMSV는 재시작마다 외부 포트가 바뀔 수 있습니다. 외부 포트를 설정하면 아래 접속 정보에 바로 반영됩니다.</p>
      <ul>
        <li><b>PC(Java):</b> <code id="addrJava">ssh.gsmsv.site:&lt;외부포트&gt;</code></li>
        <li><b>모바일/Bedrock:</b> 주소 <code>ssh.gsmsv.site</code> · 포트 <code id="addrBedrock">&lt;외부포트&gt;</code></li>
        <li><b>이 패널:</b> <code>ssh -p 24160 -L 8080:127.0.0.1:3000 ubuntu@ssh.gsmsv.site</code></li>
      </ul>
    </section>
    <section class="info" id="metricsSec">
      <h3>📈 리소스 추이 <span class="muted" style="font-size:12px;font-weight:500">(최근 3시간)</span></h3>
      <div id="metricsBody" class="muted">불러오는 중…</div>
    </section>`;
  $('#copyAddr').onclick = () => {
    const text = $('#addrJava').textContent;
    navigator.clipboard.writeText(text).then(() => toast('주소를 복사했습니다.'));
  };
  if (admin()) {
    $('#editPort').onclick = async () => {
      const curS = (state.serversStatus || []).find(s => s.id === state.server);
      const curPort = curS ? (curS.extPort || '') : '';
      const port = await modal({
        title: '외부 포트 설정',
        text: `현재 서버(${curName()})의 외부 포트 번호를 입력하세요:`,
        input: true,
        placeholder: '예: 25565',
        value: String(curPort),
        ok: '저장'
      });
      if (port === null) return;
      try {
        const r = await post(`${SP()}/extport`, { extPort: port });
        toast(r.message || '설정 완료');
        await refreshDashboard();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  await refreshDashboard();
  pollTimer = setInterval(refreshDashboard, 4000);
}
async function refreshDashboard() {
  let data;
  try { data = await api('/api/status'); } catch { return; }
  state.serversStatus = data.servers;
  renderSysbar(data.system);
  const cards = data.servers.map(serverCard).join('') + globalCard();
  $('#cards').innerHTML = cards;

  // Update connection info
  const curS = data.servers.find(s => s.id === state.server);
  if (curS) {
    const extPort = curS.extPort || '<외부포트>';
    $('#addrJava').textContent = `ssh.gsmsv.site:${extPort}`;
    $('#addrBedrock').textContent = String(extPort);
  }
  loadMetrics();
}
async function loadMetrics() {
  const el = $('#metricsBody'); if (!el) return;
  let d; try { d = await api('/api/metrics?range=3h'); } catch { return; }
  const pts = d.points || [];
  if (pts.length < 2) { el.innerHTML = '<p class="muted">데이터 수집 중… 잠시 후 그래프가 표시됩니다.</p>'; return; }
  const last = pts[pts.length - 1];
  const ramUsed = pts.map((p) => (p.usedMB != null ? p.usedMB / 1024 : null));
  const load = pts.map((p) => p.load);
  const totalGiB = last.totalMB ? (last.totalMB / 1024).toFixed(1) : '?';
  const lastRam = last.usedMB != null ? (last.usedMB / 1024).toFixed(1) : '—';
  const lastLoad = load[load.length - 1] != null ? load[load.length - 1].toFixed(2) : '—';
  const srvIds = [...new Set(pts.flatMap((p) => (p.servers || []).map((s) => s.id)))];
  const srvCards = srvIds.map((id) => {
    const series = pts.map((p) => { const s = (p.servers || []).find((x) => x.id === id); return s && s.rssMB != null ? s.rssMB / 1024 : null; });
    const lastVal = [...series].reverse().find((v) => v != null);
    const name = (state.servers.find((s) => s.id === id) || {}).name || id;
    return `<div class="metric-card"><div class="metric-top"><span class="metric-name">${esc(name)} RAM</span><span class="metric-val">${lastVal != null ? lastVal.toFixed(2) + ' GiB' : '—'}</span></div>${sparkline(series, { color: '#6fdc8c' })}</div>`;
  }).join('');
  el.innerHTML = `<div class="metric-grid">
    <div class="metric-card"><div class="metric-top"><span class="metric-name">시스템 RAM</span><span class="metric-val">${lastRam} / ${totalGiB} GiB</span></div>${sparkline(ramUsed, { color: '#e0a93a' })}</div>
    <div class="metric-card"><div class="metric-top"><span class="metric-name">CPU Load (1m)</span><span class="metric-val">${lastLoad}</span></div>${sparkline(load, { color: '#6fdc8c' })}</div>
    ${srvCards}</div>`;
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
  const ram = s.rssMB != null ? `${(s.rssMB / 1024).toFixed(2)} GiB / ${s.maxRam || '—'}` : `— / ${s.maxRam || '—'}`;
  
  const canStart = s.state === 'stopped';
  const canStop = s.state === 'running' || s.state === 'starting';
  const canRestart = s.state === 'running' || s.state === 'starting';

  const startDis = canStart && admin() ? '' : 'disabled';
  const stopDis = canStop && admin() ? '' : 'disabled';
  const restartDis = canRestart && admin() ? '' : 'disabled';

  return `<div class="card">
    <div class="card-head"><div class="card-title">${esc(s.name)}</div>
      <span class="badge ${s.state}"><span class="dot ${s.state}"></span>${label}</span></div>
    <div class="meta">
      <span class="k">tmux 세션</span><span class="v">${s.session}</span>
      <span class="k">내부 포트</span><span class="v">${s.port}</span>
      <span class="k">메모리(최대)</span><span class="v">${ram}</span>
      <span class="k">상태</span><span class="v">${label}</span></div>
    <div class="btns">
      <button class="start" data-act="start" data-id="${s.id}" ${startDis}>시작</button>
      <button class="stop" data-act="stop" data-id="${s.id}" ${stopDis}>정지</button>
      <button class="restart" data-act="restart" data-id="${s.id}" ${restartDis}>재시작</button>
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

/* ===== 탭: 설정 ===== */
async function viewOptions() {
  $('#view').innerHTML = `<section class="info">
    <h3>서버 설정 (server.properties) — ${esc(curName())}</h3>
    <p class="muted">Aternos의 설정 화면과 동일한 핵심 마인크래프트 설정을 편집합니다. <b>설정을 수정한 후 서버를 재시작해야 반영됩니다.</b></p>
    <div id="propsLoader" class="muted">설정을 불러오는 중…</div>
    <div id="propsForm" style="display:none">
      <div class="props-grid">
        <!-- slots -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">슬롯</span>
            <span class="prop-sub">max-players</span>
          </div>
          <div class="prop-control">
            <input type="number" id="prop-max-players" min="1" max="1000" class="prop-input-num" />
          </div>
        </div>
        <!-- gamemode -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">게임 모드</span>
            <span class="prop-sub">gamemode</span>
          </div>
          <div class="prop-control">
            <select id="prop-gamemode">
              <option value="survival">서바이벌</option>
              <option value="creative">크리에이티브</option>
              <option value="adventure">모험</option>
              <option value="spectator">관전</option>
            </select>
          </div>
        </div>
        <!-- difficulty -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">난이도</span>
            <span class="prop-sub">difficulty</span>
          </div>
          <div class="prop-control">
            <select id="prop-difficulty">
              <option value="peaceful">평화로움</option>
              <option value="easy">쉬움</option>
              <option value="normal">보통</option>
              <option value="hard">어려움</option>
            </select>
          </div>
        </div>
        <!-- white-list -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">화이트리스트</span>
            <span class="prop-sub">white-list</span>
          </div>
          <div class="prop-control">
            <button class="toggle-btn" id="btn-white-list" data-val="false"></button>
          </div>
        </div>
        <!-- online-mode (rendered as offline-mode) -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">오프라인 모드</span>
            <span class="prop-sub">online-mode=false</span>
          </div>
          <div class="prop-control">
            <button class="toggle-btn" id="btn-offline-mode" data-val="false"></button>
          </div>
        </div>
        <!-- allow-flight -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">비행 허용</span>
            <span class="prop-sub">allow-flight</span>
          </div>
          <div class="prop-control">
            <button class="toggle-btn" id="btn-allow-flight" data-val="false"></button>
          </div>
        </div>
        <!-- force-gamemode -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">게임모드 강제설정</span>
            <span class="prop-sub">force-gamemode</span>
          </div>
          <div class="prop-control">
            <button class="toggle-btn" id="btn-force-gamemode" data-val="false"></button>
          </div>
        </div>
        <!-- spawn-protection -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">스폰 보호</span>
            <span class="prop-sub">spawn-protection</span>
          </div>
          <div class="prop-control">
            <input type="number" id="prop-spawn-protection" min="0" max="65535" class="prop-input-num" />
          </div>
        </div>
        <!-- require-resource-pack -->
        <div class="prop-item">
          <div class="prop-meta">
            <span class="prop-label">리소스 팩 강제 사용</span>
            <span class="prop-sub">require-resource-pack</span>
          </div>
          <div class="prop-control">
            <button class="toggle-btn" id="btn-require-resource-pack" data-val="false"></button>
          </div>
        </div>
      </div>

      <!-- Resource Pack Inputs (Full Width) -->
      <div class="props-full">
        <div class="prop-item-full">
          <span class="prop-label">리소스 팩 URL</span>
          <span class="prop-sub" style="margin-bottom:6px">resource-pack</span>
          <input type="text" id="prop-resource-pack" placeholder="https://example.com/resource-pack.zip" />
        </div>
        <div class="prop-item-full">
          <span class="prop-label">리소스 팩 알림 메시지</span>
          <span class="prop-sub" style="margin-bottom:6px">resource-pack-prompt</span>
          <input type="text" id="prop-resource-pack-prompt" placeholder="리소스 팩을 적용해 주세요." />
        </div>
      </div>

      <div style="margin-top:20px; display:flex; justify-content:flex-end">
        <button class="start" id="savePropsBtn" ${admin() ? '' : 'disabled'}>설정 저장</button>
      </div>
    </div>
  </section>
  <section class="info">
    <h3>고급: 전체 설정 편집 <button class="ghost small" id="propFullToggle">열기</button></h3>
    <p class="muted">server.properties 전체 키를 편집합니다. 안전을 위해 <b>허용된 키만</b> 수정 가능합니다(나머지는 읽기 전용). 저장 후 서버를 재시작하면 반영됩니다.</p>
    <div id="propFullWrap" style="display:none">
      <input id="propFullFilter" class="fm-filter" placeholder="키 검색… (예: pvp, motd, view-distance)" style="margin-bottom:12px;min-width:240px">
      <div id="propFullBody" class="muted">불러오는 중…</div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end"><button class="start" id="propFullSave" ${admin() ? '' : 'disabled'}>변경분 저장</button></div>
    </div>
  </section>`;

  if (admin()) {
    // Toggle button click handlers
    $('#propsForm').addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      const isTrue = btn.dataset.val === 'true';
      setToggleBtn(btn, !isTrue);
    });

    $('#savePropsBtn').onclick = saveProperties;
  }

  $('#propFullToggle').onclick = () => {
    const w = $('#propFullWrap');
    const show = w.style.display === 'none';
    w.style.display = show ? 'block' : 'none';
    $('#propFullToggle').textContent = show ? '닫기' : '열기';
    if (show && !propFullState.order) loadPropsFull();
  };
  $('#propFullFilter').addEventListener('input', (e) => { propFullState.filter = e.target.value.toLowerCase(); renderPropsFull(); });
  $('#propFullSave').onclick = savePropsFull;

  await loadProperties();
}

let propFullState = {};
async function loadPropsFull() {
  try {
    const d = await api(`${SP()}/properties/full`);
    propFullState = { props: d.props, order: d.order, allowed: new Set(d.allowed), filter: '' };
    renderPropsFull();
  } catch (e) { $('#propFullBody').textContent = e.message; }
}
function renderPropsFull() {
  if (!propFullState.order) return;
  const { props, order, allowed, filter } = propFullState;
  const keys = order.filter((k) => !filter || k.toLowerCase().includes(filter));
  $('#propFullBody').innerHTML = `<div class="props-full">${keys.map((k) => {
    const ok = allowed.has(k);
    return `<div class="prop-item-full"><span class="prop-label">${esc(k)}${ok ? '' : ' <span class="muted" style="font-size:11px;font-weight:500">(읽기전용)</span>'}</span>
      <input type="text" data-pk="${esc(k)}" value="${esc(props[k])}" ${ok && admin() ? '' : 'disabled'}></div>`;
  }).join('')}</div>` || '<p class="muted">표시할 키가 없습니다.</p>';
}
async function savePropsFull() {
  const updates = {};
  $('#propFullBody').querySelectorAll('input[data-pk]').forEach((inp) => {
    const k = inp.dataset.pk;
    if (!propFullState.allowed.has(k)) return;
    if (inp.value !== String(propFullState.props[k])) updates[k] = inp.value;
  });
  if (!Object.keys(updates).length) return toast('변경된 항목이 없습니다.');
  try { const r = await post(`${SP()}/properties/full`, { updates }); toast(r.message || '저장했습니다.'); loadPropsFull(); }
  catch (e) { toast(e.message, true); }
}

function setToggleBtn(btn, isTrue) {
  btn.dataset.val = isTrue ? 'true' : 'false';
  btn.className = 'toggle-btn ' + (isTrue ? 'true' : 'false');
  btn.innerHTML = isTrue ? '✓' : '✗';
}

async function loadProperties() {
  try {
    const d = await api(`${SP()}/properties`);
    const p = d.properties;

    $('#prop-max-players').value = p['max-players'];
    $('#prop-gamemode').value = p['gamemode'];
    $('#prop-difficulty').value = p['difficulty'];
    $('#prop-spawn-protection').value = p['spawn-protection'];
    $('#prop-resource-pack').value = p['resource-pack'];
    $('#prop-resource-pack-prompt').value = p['resource-pack-prompt'];

    setToggleBtn($('#btn-white-list'), p['white-list']);
    setToggleBtn($('#btn-offline-mode'), !p['online-mode']); // 오프라인 모드 = !online-mode
    setToggleBtn($('#btn-allow-flight'), p['allow-flight']);
    setToggleBtn($('#btn-force-gamemode'), p['force-gamemode']);
    setToggleBtn($('#btn-require-resource-pack'), p['require-resource-pack']);

    if (!admin()) {
      $('#propsForm').querySelectorAll('input, select').forEach(el => el.disabled = true);
      $('#propsForm').querySelectorAll('.toggle-btn').forEach(el => el.disabled = true);
    }

    $('#propsLoader').style.display = 'none';
    $('#propsForm').style.display = 'block';
  } catch (e) {
    $('#propsLoader').textContent = '설정을 불러오지 못했습니다: ' + e.message;
  }
}

async function saveProperties() {
  const payload = {
    'max-players': parseInt($('#prop-max-players').value, 10) || 20,
    'gamemode': $('#prop-gamemode').value,
    'difficulty': $('#prop-difficulty').value,
    'white-list': $('#btn-white-list').dataset.val === 'true',
    'online-mode': $('#btn-offline-mode').dataset.val !== 'true', // online-mode = !offline-mode
    'allow-flight': $('#btn-allow-flight').dataset.val === 'true',
    'force-gamemode': $('#btn-force-gamemode').dataset.val === 'true',
    'spawn-protection': parseInt($('#prop-spawn-protection').value, 10) || 0,
    'require-resource-pack': $('#btn-require-resource-pack').dataset.val === 'true',
    'resource-pack': $('#prop-resource-pack').value.trim(),
    'resource-pack-prompt': $('#prop-resource-pack-prompt').value.trim()
  };

  try {
    toast('설정 저장 중…');
    const r = await post(`${SP()}/properties`, payload);
    toast(r.message || '설정을 저장했습니다.');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ===== 탭: 콘솔 (SSE 실시간 + 명령 히스토리) ===== */
async function viewConsole() {
  cmdHist.idx = -1;
  $('#view').innerHTML = `<section class="panel">
    <div class="panel-head"><div class="panel-title">콘솔 — ${esc(curName())} <span class="muted" id="consoleStatus" style="font-size:12px;font-weight:600"></span></div>
      <button class="ghost small" id="clearC">화면 지우기</button></div>
    <pre class="console" id="console">연결 중…</pre>
    <form class="cmd" id="cmdForm"><span class="prompt">&gt;</span>
      <input id="cmdInput" placeholder="명령 입력 (↑↓ 히스토리, 예: list, say 안녕)" autocomplete="off" ${admin() ? '' : 'disabled'} />
      <button type="submit" ${admin() ? '' : 'disabled'}>전송</button></form></section>
    <section class="info"><h3>콘솔 도움말</h3><ul>
      <li><b>치트/관리자(OP):</b> <code>op 닉네임</code> 후 게임에서 <code>/gamemode creative</code> 등 사용</li>
      <li><b>차단 해제(Unban):</b> <code>pardon 닉네임</code> · IP는 <code>pardon-ip 1.2.3.4</code></li>
      <li><b>실시간:</b> latest.log 를 실시간 스트리밍합니다(폴링 없음). 입력한 명령은 <code>&gt;</code> 로 표시됩니다.</li></ul></section>`;
  const el = $('#console');
  const append = (text, cls) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (cls) { const sp = document.createElement('span'); sp.className = cls; sp.textContent = text; el.appendChild(sp); }
    else el.appendChild(document.createTextNode(text));
    if (atBottom) el.scrollTop = el.scrollHeight;
  };
  $('#clearC').onclick = () => { el.textContent = ''; };

  // SSE 연결 (탭 전환 시 setTab 이 close)
  const es = new EventSource(`${SP()}/console/stream`);
  consoleES = es;
  es.addEventListener('init', (ev) => { try { el.textContent = JSON.parse(ev.data).text || '(빈 콘솔)'; } catch { /* */ } el.scrollTop = el.scrollHeight; const st = $('#consoleStatus'); if (st) st.textContent = '● 실시간'; });
  es.addEventListener('log', (ev) => { try { append(JSON.parse(ev.data).text); } catch { /* */ } });
  es.onerror = () => { const st = $('#consoleStatus'); if (st) st.textContent = '○ 재연결 중…'; };

  // 명령 히스토리 로드
  try { const h = await api(`${SP()}/console/history`); cmdHist.list = (h.items || []).map((x) => x.command); } catch { cmdHist.list = []; }

  const inp = $('#cmdInput');
  $('#cmdForm').onsubmit = async (e) => {
    e.preventDefault();
    const command = inp.value.trim();
    if (!command) return;
    append(`\n> ${command}\n`, 'cmd-echo');
    try { const r = await post(`${SP()}/command`, { command }); if (r.ok) { cmdHist.list.push(command); cmdHist.idx = -1; inp.value = ''; } else toast(r.message, true); }
    catch (err) { toast(err.message, true); }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); if (!cmdHist.list.length) return; cmdHist.idx = cmdHist.idx < 0 ? cmdHist.list.length - 1 : Math.max(0, cmdHist.idx - 1); inp.value = cmdHist.list[cmdHist.idx] || ''; }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdHist.idx < 0) return; cmdHist.idx += 1; if (cmdHist.idx >= cmdHist.list.length) { cmdHist.idx = -1; inp.value = ''; } else inp.value = cmdHist.list[cmdHist.idx]; }
  });
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

  const onlineItems = d.items.filter(p => p.online);
  const offlineItems = d.items.filter(p => !p.online);

  const renderItem = (p) => {
    const isBedrock = p.uuid.startsWith('00000000-0000-0000-0009-');
    const avatarUrl = isBedrock ? 'https://mc-heads.net/avatar/steve/28' : `https://mc-heads.net/avatar/${esc(p.uuid)}/28`;
    return `
      <button class="pd-item ${p.online ? 'online' : 'offline'}" data-uuid="${esc(p.uuid)}">
        <img src="${avatarUrl}" class="pd-avatar" alt="" />
        <div class="pd-item-meta">
          <div class="pd-item-header">
            <span class="pd-item-name">${esc(p.name)}</span>
            <span class="pd-status-indicator ${p.online ? 'online' : 'offline'}"></span>
          </div>
          <span class="pd-item-uuid">${isBedrock ? 'Bedrock' : 'Java'} · ${esc(p.uuid.slice(0, 14))}…</span>
        </div>
      </button>`;
  };

  let html = '';
  if (onlineItems.length > 0) {
    html += `<div class="pd-group-title">🟢 접속 중 (${onlineItems.length})</div>`;
    html += onlineItems.map(renderItem).join('');
  }
  if (offlineItems.length > 0) {
    html += `<div class="pd-group-title">⚫ 오프라인 (${offlineItems.length})</div>`;
    html += offlineItems.map(renderItem).join('');
  }

  $('#pdList').innerHTML = html;

  $('#pdList').querySelectorAll('button[data-uuid]').forEach((b) => b.onclick = () => {
    $('#pdList').querySelectorAll('.pd-item').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); showPlayerDetail(b.dataset.uuid);
  });
}
async function showPlayerDetail(uuid) {
  $('#pdDetail').innerHTML = '<p class="muted">불러오는 중…</p>';
  let d; try { d = await api(`${SP()}/playerdata/${uuid}`); } catch (e) { $('#pdDetail').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }

  const stat = (k, v) => `<div class="pd-stat"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  const getArmorSlot = (slotNum) => (d.armor || []).find((a) => a.slot === slotNum);
  const helmet = getArmorSlot(103);
  const chestplate = getArmorSlot(102);
  const leggings = getArmorSlot(101);
  const boots = getArmorSlot(100);
  const offhand = (d.armor || []).find((a) => a.slot === -106);

  const getTextureUrl = (id) => `https://assets.mcasset.cloud/1.20.1/assets/minecraft/textures/item/${esc(id)}.png`;
  const imgFallback = `onerror="if(!this.dataset.triedBlock){this.dataset.triedBlock=true;this.src=this.src.replace('/textures/item/', '/textures/block/');}else{this.remove();}"`;

  const renderEq = (item, icon, label) => {
    if (item) {
      const disp = item.id.replace(/_/g, ' ');
      return `<div class="eq-slot occupied" title="${esc(label)}: ${esc(disp)}" data-item="${esc(item.id)}">
        <img src="${getTextureUrl(item.id)}" class="mc-item-icon" ${imgFallback} />
        <span class="mc-item-fallback">${esc(item.id.slice(0, 3).toUpperCase())}</span>
        ${item.count > 1 ? `<span class="mc-count">${item.count}</span>` : ''}
      </div>`;
    }
    return `<div class="eq-slot empty" title="${esc(label)} 비어 있음"><span class="eq-icon">${icon}</span></div>`;
  };

  const renderInventory = (invItems) => {
    const slots = Array(36).fill(null);
    for (const i of invItems) {
      if (i.slot != null && i.slot >= 0 && i.slot < 36) slots[i.slot] = i;
    }
    const visualOrder = [
      ...Array.from({ length: 27 }, (_, i) => i + 9),
      ...Array.from({ length: 9 }, (_, i) => i)
    ];
    return `<div class="mc-grid">
      ${visualOrder.map((idx) => {
        const i = slots[idx];
        const isHotbar = idx < 9;
        const cls = `mc-slot ${i ? 'occupied' : 'empty'} ${isHotbar ? 'hotbar' : ''}`;
        if (i) {
          const disp = i.id.replace(/_/g, ' ');
          return `<div class="${cls}" title="${esc(disp)} (슬롯 ${idx})" data-item="${esc(i.id)}">
            <img src="${getTextureUrl(i.id)}" class="mc-item-icon" ${imgFallback} />
            <span class="mc-item-fallback">${esc(i.id.slice(0, 3).toUpperCase())}</span>
            ${i.count > 1 ? `<span class="mc-count">${i.count}</span>` : ''}
          </div>`;
        }
        return `<div class="${cls}" title="비어 있음 (슬롯 ${idx})"></div>`;
      }).join('')}
    </div>`;
  };

  const renderEnder = (enderItems) => {
    const slots = Array(27).fill(null);
    for (const i of enderItems) {
      if (i.slot != null && i.slot >= 0 && i.slot < 27) slots[i.slot] = i;
    }
    return `<div class="mc-grid">
      ${slots.map((i, idx) => {
        const cls = `mc-slot ${i ? 'occupied' : 'empty'}`;
        if (i) {
          const disp = i.id.replace(/_/g, ' ');
          return `<div class="${cls}" title="${esc(disp)} (슬롯 ${idx})" data-item="${esc(i.id)}">
            <img src="${getTextureUrl(i.id)}" class="mc-item-icon" ${imgFallback} />
            <span class="mc-item-fallback">${esc(i.id.slice(0, 3).toUpperCase())}</span>
            ${i.count > 1 ? `<span class="mc-count">${i.count}</span>` : ''}
          </div>`;
        }
        return `<div class="${cls}" title="비어 있음 (슬롯 ${idx})"></div>`;
      }).join('')}
    </div>`;
  };

  const pos = d.pos ? `${d.pos[0]}, ${d.pos[1]}, ${d.pos[2]}` : '—';
  const spawn = d.spawn ? `${d.spawn.x}, ${d.spawn.y}, ${d.spawn.z}` : '설정 안 됨';

  const isBedrock = d.uuid.startsWith('00000000-0000-0000-0009-');
  const bodySkinUrl = isBedrock ? 'https://mc-heads.net/body/steve/140' : `https://mc-heads.net/body/${esc(d.uuid)}/140`;
  const bodyFallbackUrl = isBedrock ? 'https://mc-heads.net/avatar/steve/96' : `https://mc-heads.net/avatar/${esc(d.uuid)}/96`;

  let statusHtml = '';
  if (d.online) {
    statusHtml = `<span class="pd-status-badge online">🟢 접속 중</span>`;
  } else {
    const lastPlayed = d.mtime ? new Date(d.mtime).toLocaleString() : '기록 없음';
    statusHtml = `<span class="pd-status-badge offline">⚫ 오프라인 (마지막 접속: ${lastPlayed})</span>`;
  }

  let playTimeStr = '기록 없음';
  if (d.playTimeSeconds) {
    const hours = Math.floor(d.playTimeSeconds / 3600);
    const minutes = Math.floor((d.playTimeSeconds % 3600) / 60);
    if (hours > 0) {
      playTimeStr = `${hours}시간 ${minutes}분`;
    } else {
      playTimeStr = `${minutes}분`;
    }
  }

  $('#pdDetail').innerHTML = `
    <div class="pd-profile-section">
      <div class="pd-profile-eq">
        <div class="pd-armor-col">
          ${renderEq(helmet, '🪖', '머리')}
          ${renderEq(chestplate, '👕', '몸통')}
          ${renderEq(leggings, '👖', '다리')}
          ${renderEq(boots, '🥾', '발')}
        </div>
        <div class="pd-skin-preview" title="${esc(d.name)}의 3D 스킨">
          <img src="${bodySkinUrl}" onerror="this.src='${bodyFallbackUrl}'; this.style.height='96px';" alt="" />
        </div>
        <div class="pd-offhand-col">
          ${renderEq(offhand, '🛡️', '오프핸드')}
        </div>
      </div>
      <div class="pd-profile-info">
        <div class="pd-profile-header">
          <span class="pd-profile-name">${esc(d.name)}</span>
          <span class="pd-badge gamemode-${d.gameType || 0}">${esc(d.gameTypeName || '생존')}</span>
        </div>
        <div class="pd-profile-status-row">
          ${statusHtml}
          <span class="pd-platform-badge ${isBedrock ? 'bedrock' : 'java'}">${isBedrock ? 'Bedrock' : 'Java'}</span>
        </div>
        <div class="pd-profile-uuid"><code>${esc(d.uuid)}</code></div>
        <div class="pd-profile-stats">
          ${stat('누적 플레이 시간', playTimeStr)}
          ${stat('좌표 (XYZ)', pos)}
          ${stat('차원', esc((d.dimension || 'overworld').replace('minecraft:', '').toUpperCase()))}
          ${stat('체력', d.health != null ? `<span class="health-heart">${d.health} / 20 ❤️</span>` : '—')}
          ${stat('허기', d.food != null ? `<span>${d.food} / 20 🍗 (포화 ${d.saturation ?? 0})</span>` : '—')}
          ${stat('경험치', d.xpLevel != null ? `Lv ${d.xpLevel} (총 ${d.xpTotal ?? '?'})` : '—')}
          ${stat('스폰 위치', spawn)}
        </div>
        ${admin() ? `<div class="pd-actions">
          <select data-pq="gamemode"><option value="">게임모드…</option><option value="0">생존</option><option value="1">창작</option><option value="2">모험</option><option value="3">관전</option></select>
          <button class="ghost" data-pq="tp">텔레포트</button>
          <button class="ghost" data-pq="give">아이템</button>
          <button class="restart" data-pq="heal">회복</button>
          <button class="restart" data-pq="feed">배부르게</button>
          <button class="stop" data-pq="kill">처치</button>
          <button class="stop" data-pq="kick">킥</button>
          <button class="stop" data-pq="ban">차단</button>
        </div>` : ''}
      </div>
    </div>
    <div class="pd-section">
      <h4>🎒 인벤토리 (${d.inventory.length} / 36 슬롯 사용)</h4>
      ${renderInventory(d.inventory)}
    </div>
    <div class="pd-section">
      <h4>📦 엔더 상자 (${d.ender.length} / 27 슬롯 사용)</h4>
      ${renderEnder(d.ender)}
    </div>`;

  wirePlayerActions(d.name);
}
function wirePlayerActions(name) {
  const root = $('#pdDetail');
  root.querySelectorAll('[data-pq]').forEach((b) => {
    const act = b.dataset.pq;
    const call = async (value) => {
      try { const r = await post(`${SP()}/players/${act}`, { value }); toast(r.message || (r.ok ? '완료' : '실패'), !r.ok); }
      catch (e) { toast(e.message, true); }
    };
    if (act === 'gamemode') {
      b.onchange = () => { if (b.value === '') return; call({ name, mode: b.value }); b.value = ''; };
    } else {
      b.onclick = async () => {
        if (act === 'tp') {
          const c = await modal({ title: '텔레포트', text: `${name} 이동 — 좌표 "x y z" 또는 대상 닉네임:`, input: true, placeholder: '예: 100 64 -200', ok: '이동' });
          if (!c) return;
          const p = c.trim().split(/\s+/);
          if (p.length === 3) call({ name, x: p[0], y: p[1], z: p[2] }); else call({ name, target: p[0] });
        } else if (act === 'give') {
          const g = await modal({ title: '아이템 지급', text: `${name} 에게 — "아이템 [개수]":`, input: true, placeholder: '예: diamond 1', ok: '지급' });
          if (!g) return;
          const p = g.trim().split(/\s+/);
          call({ name, item: p[0], count: p[1] || 1 });
        } else if (act === 'ban') {
          if (!(await modal({ title: '차단', text: `${name} 을(를) 차단할까요?`, danger: true, ok: '차단' }))) return;
          call(name);
        } else if (act === 'kick') {
          call(name);
        } else if (act === 'kill') {
          if (!(await modal({ title: '처치', text: `${name} 을(를) 처치(kill)할까요?`, danger: true, ok: '처치' }))) return;
          call({ name });
        } else {
          call({ name }); // heal / feed
        }
      };
    }
  });
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

  if (act === 'start') {
    const other = (state.serversStatus || []).find((s) => s.id !== id);
    if (other && (other.state === 'running' || other.state === 'starting') && other.maxRam === '5500M') {
      const confirmRestart = await modal({
        title: '서버 시작 (상대 서버 재시작 필요)',
        text: `상대 서버(${other.name})가 5.5GB로 실행 중입니다. 동시 가동을 위해 상대 서버를 2.8GB로 재시작하시겠습니까?`,
        danger: true,
        ok: '재시작 및 시작'
      });
      if (!confirmRestart) return;
    }
  }
  if (act === 'startall') {
    const s1 = (state.serversStatus || []).find((s) => s.id === 'server1');
    const s2 = (state.serversStatus || []).find((s) => s.id === 'server2');
    const s1Single = s1 && (s1.state === 'running' || s1.state === 'starting') && s1.maxRam === '5500M';
    const s2Single = s2 && (s2.state === 'running' || s2.state === 'starting') && s2.maxRam === '5500M';
    if (s1Single || s2Single) {
      const targetName = s1Single ? s1.name : s2.name;
      const confirmRestart = await modal({
        title: '전체 시작 (서버 재시작 필요)',
        text: `${targetName}가 5.5GB로 실행 중입니다. 동시 가동을 위해 2.8GB로 재시작하시겠습니까?`,
        danger: true,
        ok: '재시작 및 전체 시작'
      });
      if (!confirmRestart) return;
    }
  }

  let p = act === 'startall' ? '/api/power/startall' : act === 'stopall' ? '/api/power/stopall' : `${SP()}/${act}`;
  if (['start', 'stop', 'restart'].includes(act)) p = `/api/server/${id}/${act}`;
  try { const r = await post(p); toast(r.message || (r.ok ? '완료' : '실패'), !r.ok); setTimeout(refreshDashboard, 700); }
  catch (err) { toast(err.message, true); }
});

/* ===== 탭: 게임 설정 (월드보더/난이도/시간/날씨/gamerule/PVP) ===== */
async function viewGameSettings() {
  $('#view').innerHTML = `<section class="info"><h3>게임 설정 — ${esc(curName())}</h3>
    <p class="muted">월드보더·난이도·시간·날씨·gamerule·PVP를 콘솔 명령으로 적용합니다. <b>서버가 켜져 있어야</b> 즉시 반영됩니다(PVP는 재시작 필요).</p>
    <div id="gsLoader" class="muted">불러오는 중…</div>
    <div id="gsBody" style="display:none"></div>
  </section>`;
  await loadGameSettings();
}
async function loadGameSettings() {
  let d;
  try { d = await api(`${SP()}/gamesettings`); } catch (e) { $('#gsLoader').textContent = e.message; return; }
  const s = d.settings || {};
  const wb = s.worldborder || {};
  const dis = admin() ? '' : 'disabled';
  const curDiff = ['peaceful', 'easy', 'normal', 'hard'][s.difficulty] || '?';
  const grEntries = Object.entries(s.gamerules || {});
  $('#gsBody').innerHTML = `
    <div class="gs-grid">
      <div class="gs-card"><div class="gs-h">🗺️ 월드보더</div>
        <div class="gs-row"><label>크기(블록)</label><input type="number" id="wbSize" value="${wb.size != null ? Math.round(wb.size) : 3000}" min="1" ${dis}><button class="start small" data-gs="wb-size" ${dis}>적용</button></div>
        <div class="gs-row"><label>중심 X / Z</label><input type="number" id="wbX" value="${wb.centerX != null ? Math.round(wb.centerX) : 0}" ${dis}><input type="number" id="wbZ" value="${wb.centerZ != null ? Math.round(wb.centerZ) : 0}" ${dis}><button class="start small" data-gs="wb-center" ${dis}>적용</button></div>
        <div class="gs-row"><label>경고 거리</label><input type="number" id="wbWarn" value="${wb.warningBlocks != null ? Math.round(wb.warningBlocks) : 5}" min="0" ${dis}><button class="start small" data-gs="wb-warn" ${dis}>적용</button></div>
        <p class="muted" style="margin:6px 0 0">현재: ${wb.size != null ? Math.round(wb.size) + '블록' : '미설정'} · 중심 (${Math.round(wb.centerX || 0)}, ${Math.round(wb.centerZ || 0)}) ${s.source === 'level.dat' ? '' : '<span class="off">(level.dat 못읽음 — 캐시값)</span>'}</p>
      </div>
      <div class="gs-card"><div class="gs-h">⚔️ 난이도 · PVP</div>
        <div class="gs-row"><label>난이도</label>
          <select id="gsDiff" ${dis}>${['peaceful:평화로움', 'easy:쉬움', 'normal:보통', 'hard:어려움'].map((o) => { const [v, t] = o.split(':'); return `<option value="${v}" ${curDiff === v ? 'selected' : ''}>${t}</option>`; }).join('')}</select>
          <button class="start small" data-gs="diff" ${dis}>적용</button></div>
        <div class="gs-row"><label>PVP</label>
          <button class="toggle-btn true" id="gsPvpOn" data-gs="pvp" data-v="true" ${dis}>ON</button>
          <button class="toggle-btn false" data-gs="pvp" data-v="false" ${dis}>OFF</button>
          <span class="muted">재시작 필요</span></div>
      </div>
      <div class="gs-card"><div class="gs-h">🕒 시간 · 날씨</div>
        <div class="gs-row"><label>시간</label>${['day:낮', 'noon:정오', 'night:밤', 'midnight:자정'].map((o) => { const [v, t] = o.split(':'); return `<button class="ghost small" data-gs="time" data-v="${v}" ${dis}>${t}</button>`; }).join('')}</div>
        <div class="gs-row"><label>날씨</label>${['clear:맑음', 'rain:비', 'thunder:천둥'].map((o) => { const [v, t] = o.split(':'); return `<button class="ghost small" data-gs="weather" data-v="${v}" ${dis}>${t}</button>`; }).join('')}</div>
      </div>
      <div class="gs-card"><div class="gs-h">🎲 게임룰</div>
        <div class="gs-row"><select id="grKey" ${dis}>${(d.gameruleKeys || []).map((k) => `<option>${k}</option>`).join('')}</select>
          <input id="grVal" placeholder="true / false / 숫자" style="max-width:130px" ${dis}><button class="start small" data-gs="gamerule" ${dis}>적용</button></div>
        <div class="gr-list">${grEntries.length ? grEntries.map(([k, v]) => `<span class="gr-chip">${esc(k)}=<b>${esc(v)}</b></span>`).join('') : '<span class="muted">level.dat에서 읽은 게임룰이 없습니다.</span>'}</div>
      </div>
    </div>`;
  if (admin()) $('#gsBody').addEventListener('click', onGameSettingBtn);
  $('#gsLoader').style.display = 'none';
  $('#gsBody').style.display = 'block';
}
async function gsApply(body) {
  try { const r = await post(`${SP()}/gamesettings`, body); toast(r.message || '적용했습니다.'); setTimeout(loadGameSettings, 500); }
  catch (e) { toast(e.message, true); }
}
async function onGameSettingBtn(e) {
  const b = e.target.closest('[data-gs]'); if (!b) return;
  const k = b.dataset.gs;
  if (k === 'wb-size') return gsApply({ type: 'worldborder', op: 'set', size: $('#wbSize').value });
  if (k === 'wb-center') return gsApply({ type: 'worldborder', op: 'center', x: $('#wbX').value, z: $('#wbZ').value });
  if (k === 'wb-warn') return gsApply({ type: 'worldborder', op: 'warning-distance', value: $('#wbWarn').value });
  if (k === 'diff') return gsApply({ type: 'difficulty', value: $('#gsDiff').value });
  if (k === 'pvp') return gsApply({ type: 'pvp', value: b.dataset.v });
  if (k === 'time') return gsApply({ type: 'time', value: b.dataset.v });
  if (k === 'weather') return gsApply({ type: 'weather', value: b.dataset.v });
  if (k === 'gamerule') { const val = $('#grVal').value.trim(); if (!val) return toast('값을 입력하세요.', true); return gsApply({ type: 'gamerule', rule: $('#grKey').value, value: val }); }
}

/* ===== 탭: 예약 작업 ===== */
async function viewSchedules() {
  $('#view').innerHTML = `<section class="info"><h3>예약 작업</h3>
    <p class="muted">자동 재시작 · 정기 공지(say) · 명령 · 백업을 시각/주기에 맞춰 실행합니다. 30초 단위로 점검합니다.</p>
    ${admin() ? `<div class="sch-form">
      <select id="schServer">${state.servers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="schType"><option value="restart">재시작</option><option value="say">공지(say)</option><option value="command">명령</option><option value="backup">백업</option></select>
      <input id="schPayload" placeholder="공지/명령 내용" style="flex:1;min-width:160px">
      <select id="schKind"><option value="daily">매일</option><option value="interval">주기(분)</option></select>
      <input id="schWhen" placeholder="03:00" style="max-width:90px">
      <button class="start small" id="schAdd">추가</button>
    </div>` : ''}
    <div id="schList" class="muted" style="margin-top:12px">불러오는 중…</div></section>`;
  if (admin()) {
    $('#schAdd').onclick = addSchedule;
    $('#schKind').onchange = () => { $('#schWhen').placeholder = $('#schKind').value === 'daily' ? '03:00' : '예: 120'; };
  }
  await loadSchedules();
}
async function addSchedule() {
  const kind = $('#schKind').value;
  const when = $('#schWhen').value.trim();
  const body = {
    serverId: $('#schServer').value,
    type: $('#schType').value,
    payload: $('#schPayload').value,
    schedule: kind === 'daily' ? { kind: 'daily', at: when } : { kind: 'interval', everyMin: parseInt(when, 10) },
  };
  try { await post('/api/schedules', body); toast('예약을 추가했습니다.'); $('#schPayload').value = ''; $('#schWhen').value = ''; loadSchedules(); }
  catch (e) { toast(e.message, true); }
}
async function loadSchedules() {
  let d; try { d = await api('/api/schedules'); } catch (e) { $('#schList').textContent = e.message; return; }
  if (!d.items.length) { $('#schList').innerHTML = '<p class="muted">예약된 작업이 없습니다.</p>'; return; }
  const TYPE = { restart: '🔄 재시작', say: '📢 공지', command: '⌨️ 명령', backup: '💾 백업' };
  const srvName = (id) => (state.servers.find((s) => s.id === id) || {}).name || id;
  $('#schList').innerHTML = `<table class="tbl"><thead><tr><th>서버</th><th>작업</th><th>내용</th><th>주기</th><th>상태</th><th></th></tr></thead><tbody>${
    d.items.map((t) => `<tr style="${t.enabled ? '' : 'opacity:.5'}">
      <td>${esc(srvName(t.serverId))}</td><td>${TYPE[t.type] || t.type}</td>
      <td>${esc(t.payload || '—')}</td>
      <td>${t.schedule.kind === 'daily' ? '매일 ' + esc(t.schedule.at) : esc(t.schedule.everyMin) + '분마다'}</td>
      <td>${t.enabled ? '<span class="ok">활성</span>' : '<span class="off">중지</span>'}</td>
      <td class="row-act">${admin() ? `<button class="ghost xs" data-sch-toggle="${t.id}">${t.enabled ? '중지' : '활성'}</button><button class="link-del" data-sch-del="${t.id}">삭제</button>` : ''}</td></tr>`).join('')
  }</tbody></table>`;
  $('#schList').querySelectorAll('[data-sch-toggle]').forEach((b) => b.onclick = async () => { try { await post(`/api/schedules/${b.dataset.schToggle}/toggle`); loadSchedules(); } catch (e) { toast(e.message, true); } });
  $('#schList').querySelectorAll('[data-sch-del]').forEach((b) => b.onclick = async () => { if (!(await modal({ title: '예약 삭제', text: '이 예약을 삭제할까요?', danger: true, ok: '삭제' }))) return; try { await post(`/api/schedules/${b.dataset.schDel}/delete`); loadSchedules(); } catch (e) { toast(e.message, true); } });
}

/* ===== 탭: 매크로 ===== */
async function viewMacros() {
  $('#view').innerHTML = `<section class="info"><h3>명령어 매크로 — 실행 대상: ${esc(curName())}</h3>
    <p class="muted">자주 쓰는 명령을 저장하고 원클릭 실행합니다. <code>{player}</code> 토큰은 실행 시 닉네임으로 치환됩니다.</p>
    ${admin() ? `<div class="macro-form">
      <input id="mcIcon" placeholder="⚡" style="max-width:60px" maxlength="4">
      <input id="mcLabel" placeholder="이름 (예: 낮으로)" style="max-width:160px">
      <input id="mcCmd" placeholder="명령 (예: time set day, give {player} diamond 1)" style="flex:1;min-width:200px">
      <button class="start small" id="mcAdd">추가</button>
    </div>` : ''}
    <div id="mcList" class="muted" style="margin-top:12px">불러오는 중…</div></section>`;
  if (admin()) $('#mcAdd').onclick = addMacro;
  await loadMacros();
}
async function addMacro() {
  const body = { icon: $('#mcIcon').value, label: $('#mcLabel').value, command: $('#mcCmd').value };
  try { await post('/api/macros', body); toast('매크로를 추가했습니다.'); $('#mcLabel').value = ''; $('#mcCmd').value = ''; $('#mcIcon').value = ''; loadMacros(); }
  catch (e) { toast(e.message, true); }
}
async function loadMacros() {
  let d; try { d = await api('/api/macros'); } catch (e) { $('#mcList').textContent = e.message; return; }
  if (!d.items.length) { $('#mcList').innerHTML = '<p class="muted">저장된 매크로가 없습니다.</p>'; return; }
  $('#mcList').innerHTML = `<div class="macro-grid">${d.items.map((m) => `<div class="macro-card">
    <button class="macro-run" data-mc-run="${m.id}" title="${esc(m.command)}"><span class="macro-ico">${esc(m.icon || '⚡')}</span><span class="macro-label">${esc(m.label)}</span></button>
    <code class="macro-cmd">${esc(m.command)}</code>
    ${admin() ? `<button class="link-del" data-mc-del="${m.id}">삭제</button>` : ''}</div>`).join('')}</div>`;
  $('#mcList').querySelectorAll('[data-mc-run]').forEach((b) => b.onclick = () => runMacro(b.dataset.mcRun, b.closest('.macro-card').querySelector('.macro-cmd').textContent));
  $('#mcList').querySelectorAll('[data-mc-del]').forEach((b) => b.onclick = async () => { if (!(await modal({ title: '매크로 삭제', text: '삭제할까요?', danger: true, ok: '삭제' }))) return; try { await post(`/api/macros/${b.dataset.mcDel}/delete`); loadMacros(); } catch (e) { toast(e.message, true); } });
}
async function runMacro(id, cmd) {
  let player;
  if (cmd && cmd.includes('{player}')) {
    player = await modal({ title: '플레이어 지정', text: `이 매크로는 {player}가 필요합니다.`, input: true, placeholder: '닉네임', ok: '실행' });
    if (player === null) return;
  }
  try { const r = await post(`${SP()}/macros/${id}/run`, { player }); toast(r.message || '실행했습니다.'); }
  catch (e) { toast(e.message, true); }
}

/* ===== 미니 스파크라인(의존성 없는 인라인 SVG) ===== */
function sparkline(values, { w = 240, h = 40, color = 'var(--green-b)' } = {}) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = v == null ? h : h - ((v - min) / span) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">
    <polyline fill="none" stroke="${color}" stroke-width="1.6" points="${pts}" /></svg>`;
}

/* ===== 네비게이션 ===== */
const VIEWS = { dashboard: viewDashboard, gamesettings: viewGameSettings, options: viewOptions, console: viewConsole, log: viewLog, players: viewPlayers, software: viewSoftware, plugins: viewPlugins, files: viewFiles, world: viewWorld, backups: viewBackups, schedules: viewSchedules, macros: viewMacros, access: viewAccess };
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
    state.serversStatus = st.servers;
    state.server = state.servers[0] ? state.servers[0].id : 'server1';
  } catch { /* 401 처리됨 */ }
  renderShell();
  setTab('dashboard');
})();
