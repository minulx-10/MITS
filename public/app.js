'use strict';

const $ = (sel) => document.querySelector(sel);
let SERVERS = [];
let activeId = null;
let consoleTimer = null;

const STATE_LABEL = { running: '실행 중', stopped: '정지됨', starting: '시작 중' };

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  return res.json();
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function renderSysbar(sys) {
  if (!sys) return;
  const memPct = sys.totalMB ? Math.round((sys.usedMB / sys.totalMB) * 100) : 0;
  $('#sysbar').innerHTML = [
    `호스트 <b>${sys.hostname}</b>`,
    `RAM <b>${(sys.usedMB / 1024).toFixed(1)}/${(sys.totalMB / 1024).toFixed(1)}GiB (${memPct}%)</b>`,
    `여유 <b>${sys.availMB}MiB</b>`,
    `Load <b>${(sys.load || []).join(' / ')}</b>`,
    `Uptime <b>${fmtUptime(sys.uptimeSec)}</b>`,
  ].join(' · ');
}

function serverCard(s) {
  const label = STATE_LABEL[s.state] || s.state;
  const ram = s.rssMB != null ? `${(s.rssMB / 1024).toFixed(2)} GiB` : '—';
  const running = s.state === 'running';
  const starting = s.state === 'starting';
  return `
  <div class="card" data-id="${s.id}">
    <div class="card-head">
      <div class="card-title">${s.name}</div>
      <span class="badge ${s.state}"><span class="dot ${s.state}"></span>${label}</span>
    </div>
    <div class="meta">
      <span class="k">tmux 세션</span><span class="v">${s.session}</span>
      <span class="k">내부 포트</span><span class="v">${s.port}</span>
      <span class="k">메모리(RSS)</span><span class="v">${ram}</span>
      <span class="k">상태</span><span class="v">${label}</span>
    </div>
    <div class="btns">
      <button class="start" data-act="start" data-id="${s.id}" ${running || starting ? 'disabled' : ''}>시작</button>
      <button class="stop" data-act="stop" data-id="${s.id}" ${running || starting ? '' : 'disabled'}>정지</button>
      <button class="restart" data-act="restart" data-id="${s.id}" ${running || starting ? '' : 'disabled'}>재시작</button>
    </div>
  </div>`;
}

function renderCards(servers, sys) {
  SERVERS = servers;
  const globalBtns = `
    <div class="card" style="display:flex;flex-direction:column;justify-content:center;gap:14px">
      <div class="card-title">전체 제어</div>
      <p class="muted">서버의 <code>~/start.sh</code> / <code>~/stop.sh</code> 를 실행합니다.</p>
      <div class="global-actions">
        <button class="start" data-act="startall">전체 시작</button>
        <button class="stop" data-act="stopall">전체 정지</button>
      </div>
    </div>`;
  $('#cards').innerHTML = servers.map(serverCard).join('') + globalBtns;

  // 콘솔 탭
  if (!activeId && servers.length) activeId = servers[0].id;
  $('#tabs').innerHTML = servers
    .map((s) => `<div class="tab ${s.id === activeId ? 'active' : ''}" data-tab="${s.id}">${s.name}</div>`)
    .join('');
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    if (!data.ok) return;
    renderSysbar(data.system);
    renderCards(data.servers, data.system);
  } catch (_) { /* unauthorized 처리는 api()에서 */ }
}

async function refreshConsole() {
  if (!activeId) return;
  try {
    const data = await api(`/api/server/${activeId}/console`);
    const el = $('#console');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = data.text || '(빈 콘솔)';
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch (_) {}
}

// ---- 액션 ----
async function doAction(act, id) {
  let path = null;
  if (act === 'start') path = `/api/server/${id}/start`;
  else if (act === 'stop') path = `/api/server/${id}/stop`;
  else if (act === 'restart') path = `/api/server/${id}/restart`;
  else if (act === 'startall') path = '/api/power/startall';
  else if (act === 'stopall') path = '/api/power/stopall';
  if (!path) return;
  try {
    const data = await api(path, { method: 'POST' });
    toast(data.message || (data.ok ? '완료' : '실패'), !data.ok);
    setTimeout(refreshStatus, 800);
  } catch (e) {
    toast('요청 실패: ' + e.message, true);
  }
}

// 확인 모달
function confirmAction(title, text, onOk) {
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  $('#modalBg').classList.add('show');
  const ok = $('#modalOk');
  const cancel = $('#modalCancel');
  const close = () => $('#modalBg').classList.remove('show');
  const okHandler = () => { close(); cleanup(); onOk(); };
  const cancelHandler = () => { close(); cleanup(); };
  function cleanup() {
    ok.removeEventListener('click', okHandler);
    cancel.removeEventListener('click', cancelHandler);
  }
  ok.addEventListener('click', okHandler);
  cancel.addEventListener('click', cancelHandler);
}

// 이벤트 위임
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const name = (SERVERS.find((s) => s.id === id) || {}).name || '';
    if (act === 'stop') return confirmAction('서버 정지', `${name} 을(를) 정지합니다. 접속 중인 플레이어가 끊깁니다. 계속할까요?`, () => doAction(act, id));
    if (act === 'restart') return confirmAction('서버 재시작', `${name} 을(를) 재시작합니다. 잠시 접속이 끊깁니다. 계속할까요?`, () => doAction(act, id));
    if (act === 'stopall') return confirmAction('전체 정지', '두 서버를 모두 정지합니다. 계속할까요?', () => doAction(act, id));
    return doAction(act, id);
  }
  const tab = e.target.closest('.tab[data-tab]');
  if (tab) {
    activeId = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    refreshConsole();
  }
});

$('#cmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#cmdInput');
  const command = input.value.trim();
  if (!command || !activeId) return;
  try {
    const data = await api(`/api/server/${activeId}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    if (data.ok) { input.value = ''; setTimeout(refreshConsole, 400); }
    else toast(data.message || '명령 실패', true);
  } catch (e) {
    toast('명령 전송 실패', true);
  }
});

$('#refreshConsole').addEventListener('click', refreshConsole);
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ---- 부팅 ----
refreshStatus();
refreshConsole();
setInterval(refreshStatus, 4000);
consoleTimer = setInterval(refreshConsole, 2500);
