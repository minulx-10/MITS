'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const { config, getServer } = require('./config');

const execFileAsync = promisify(execFile);

// tmux 기본 소켓은 $TMUX_TMPDIR/tmux-<uid>/default 이다.
// mc1/mc2 세션과 같은 소켓을 보도록 TMUX_TMPDIR=/tmp 로 고정한다.
const ENV = { ...process.env, TMUX_TMPDIR: process.env.TMUX_TMPDIR || '/tmp' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env: ENV,
      maxBuffer: 8 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: stdout || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

async function hasSession(session) {
  const r = await run('tmux', ['has-session', '-t', session]);
  return r.ok;
}

function runCommand(server) {
  return `cd ${server.dir} && java -Xms${config.xms} -Xmx${config.xmx} -jar ${config.jar} nogui`;
}

// 포트를 LISTEN 중인 PID 조회. null=미LISTEN, -1=LISTEN이나 PID불명, 숫자=PID
async function portPid(port) {
  const r = await run('ss', ['-tlnpH']);
  if (!r.ok) return null;
  for (const line of r.stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.some((c) => c.endsWith(':' + port))) {
      const m = line.match(/pid=(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    }
  }
  return null;
}

async function pidRssMB(pid) {
  if (!pid || pid < 0) return null;
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch {
    return null;
  }
}

async function serverStatus(s) {
  const session = await hasSession(s.session);
  const pid = await portPid(s.port);
  const listening = pid !== null;
  const rssMB = await pidRssMB(pid);

  let state = 'stopped';
  if (session && listening) state = 'running';
  else if (session && !listening) state = 'starting';
  else if (!session && listening) state = 'running'; // 세션 밖에서 떠 있는 경우

  return {
    id: s.id,
    name: s.name,
    session: s.session,
    port: s.port,
    state,
    online: state === 'running',
    rssMB,
  };
}

async function allStatus() {
  const out = [];
  for (const s of config.servers) {
    out.push(await serverStatus(s));
  }
  return out;
}

async function startServer(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (await hasSession(s.session)) {
    return { ok: false, message: `${s.name}: 이미 실행 중입니다.` };
  }
  await run('tmux', ['new-session', '-d', '-s', s.session]);
  await run('tmux', ['send-keys', '-t', s.session, runCommand(s), 'ENTER']);
  return { ok: true, message: `${s.name} 시작 명령을 보냈습니다.` };
}

async function stopServer(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (!(await hasSession(s.session))) {
    return { ok: false, message: `${s.name}: 이미 정지 상태입니다.` };
  }
  await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
  return { ok: true, message: `${s.name} 정지 명령을 보냈습니다. (안전 저장 후 종료)` };
}

async function restartServer(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (await hasSession(s.session)) {
    await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
    // 최대 40초간 종료 대기
    for (let i = 0; i < 40; i++) {
      if (!(await hasSession(s.session))) break;
      await sleep(1000);
    }
    // 그래도 살아있으면 세션 강제 종료
    if (await hasSession(s.session)) {
      await run('tmux', ['kill-session', '-t', s.session]);
      await sleep(1000);
    }
  }
  const r = await startServer(id);
  return { ok: r.ok, message: `${s.name} 재시작: ` + r.message };
}

async function sendCommand(id, command) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  const cmd = (command || '').trim();
  if (!cmd) return { ok: false, message: '빈 명령입니다.' };
  if (!(await hasSession(s.session))) {
    return { ok: false, message: `${s.name}: 서버가 실행 중이 아닙니다.` };
  }
  await run('tmux', ['send-keys', '-t', s.session, cmd, 'ENTER']);
  return { ok: true, message: `명령 전송: ${cmd}` };
}

async function getConsole(id, lines = config.consoleLines) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (!(await hasSession(s.session))) {
    return { running: false, text: '(서버가 실행 중이 아닙니다)' };
  }
  const r = await run('tmux', ['capture-pane', '-p', '-t', s.session, '-S', `-${lines}`]);
  return { running: true, text: r.stdout || '' };
}

async function startAll() {
  const r = await run('bash', [config.startScript]);
  return {
    ok: r.ok,
    message: r.ok ? '전체 시작 명령을 보냈습니다.' : (r.stderr || '시작 스크립트 실행 실패'),
  };
}

async function stopAll() {
  const r = await run('bash', [config.stopScript]);
  return {
    ok: r.ok,
    message: r.ok ? '전체 정지 명령을 보냈습니다.' : (r.stderr || '정지 스크립트 실행 실패'),
  };
}

module.exports = {
  allStatus,
  serverStatus,
  startServer,
  stopServer,
  restartServer,
  sendCommand,
  getConsole,
  startAll,
  stopAll,
};
