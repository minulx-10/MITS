'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
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

const RAM_SINGLE = '5500M';
const RAM_DUAL = '2800M';

async function getRunningMaxRam(pid) {
  if (!pid || pid < 0) return null;
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    const args = cmdline.split('\0');
    const xmx = args.find(a => a.startsWith('-Xmx'));
    if (xmx) {
      return xmx.slice(4);
    }
  } catch (e) {}
  return null;
}

async function getTargetRam(id) {
  const other = config.servers.find(s => s.id !== id);
  if (!other) return RAM_DUAL;
  
  const pid = await portPid(other.port);
  const otherOnline = pid !== null;
  return otherOnline ? RAM_DUAL : RAM_SINGLE;
}

async function hasSession(session) {
  const r = await run('tmux', ['has-session', '-t', session]);
  return r.ok;
}

function runCommand(server, targetRam) {
  return `cd ${server.dir} && java -Xms1G -Xmx${targetRam} -jar ${config.jar} nogui`;
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

async function getJavaPidForDir(dir) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'java']);
    const pids = stdout.trim().split(/\s+/).map(x => parseInt(x, 10)).filter(Boolean);
    for (const pid of pids) {
      try {
        const cwd = await fs.readlink(`/proc/${pid}/cwd`);
        if (path.resolve(cwd) === path.resolve(dir)) {
          return pid;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function isJavaRunning(dir) {
  const pid = await getJavaPidForDir(dir);
  return pid !== null;
}

async function serverStatus(s) {
  const session = await hasSession(s.session);
  const javaPid = await getJavaPidForDir(s.dir);
  const running = javaPid !== null;

  const listenPid = await portPid(s.port);
  const listening = listenPid !== null;

  const pid = javaPid || listenPid;
  const rssMB = await pidRssMB(pid);

  let state = 'stopped';
  if (s.stopping) {
    state = 'stopping';
  } else if (s.restarting) {
    state = 'restarting';
  } else if (running) {
    if (listening) state = 'running';
    else state = 'starting';
  }

  const runningMaxRam = await getRunningMaxRam(pid);
  const targetRam = await getTargetRam(s.id);
  const maxRam = runningMaxRam || targetRam;

  return {
    id: s.id,
    name: s.name,
    session: s.session,
    port: s.port,
    extPort: s.extPort,
    state,
    online: state === 'running',
    rssMB,
    maxRam,
  };
}

async function allStatus() {
  const out = [];
  for (const s of config.servers) {
    out.push(await serverStatus(s));
  }
  return out;
}

async function statusOf(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return serverStatus(s);
}

// 일부 작업(월드 교체/복원/소프트웨어 교체)은 서버가 꺼져 있어야 안전
async function requireStopped(id) {
  const st = await statusOf(id);
  if (st.state === 'running' || st.state === 'starting') {
    const e = new Error('이 작업은 서버가 꺼져 있을 때만 가능합니다. 먼저 서버를 정지하세요.');
    e.status = 409;
    throw e;
  }
}

async function startServer(id, overrideRam) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);

  if (await hasSession(s.session)) {
    if (!(await isJavaRunning(s.dir))) {
      await run('tmux', ['kill-session', '-t', s.session]);
      await sleep(500);
    } else {
      return { ok: false, message: `${s.name}: 이미 실행 중이거나 시작 중입니다.` };
    }
  }

  // Calculate dynamic RAM or use override
  const targetRam = overrideRam || (await getTargetRam(id));

  // Check if we need to downscale the other server
  const other = config.servers.find(x => x.id !== id);
  let otherRestartMsg = '';
  if (other) {
    const otherPid = await portPid(other.port);
    if (otherPid !== null) {
      const otherRunningRam = await getRunningMaxRam(otherPid);
      if (otherRunningRam === RAM_SINGLE) {
        otherRestartMsg = ` (${other.name} 램 2.8G 하향 재시작 포함)`;
        // Restart the other server to downscale, forcing DUAL RAM!
        await stopServer(other.id);
        for (let i = 0; i < 40; i++) {
          if (!(await isJavaRunning(other.dir))) break;
          await sleep(1000);
        }
        if (await hasSession(other.session)) {
          await run('tmux', ['kill-session', '-t', other.session]);
          await sleep(500);
        }
        await startServer(other.id, RAM_DUAL);
      }
    }
  }

  await run('tmux', ['new-session', '-d', '-s', s.session]);
  await run('tmux', ['send-keys', '-t', s.session, runCommand(s, targetRam), 'ENTER']);
  return { ok: true, message: `${s.name} 시작 명령을 보냈습니다. (RAM: ${targetRam})${otherRestartMsg}` };
}

async function stopServer(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (!(await hasSession(s.session))) {
    return { ok: false, message: `${s.name}: 이미 정지 상태입니다.` };
  }
  if (!(await isJavaRunning(s.dir))) {
    await run('tmux', ['kill-session', '-t', s.session]);
    return { ok: false, message: `${s.name}: 이미 정지 상태입니다.` };
  }
  if (s.stopping || s.restarting) {
    return { ok: false, message: `${s.name}: 이미 종료 또는 재시작 작업이 진행 중입니다.` };
  }

  // Check if any players are online
  let hasPlayers = false;
  try {
    const playerdata = require('./playerdata');
    const listRes = await playerdata.list(id);
    hasPlayers = listRes.items.some(p => p.online);
  } catch (e) {}

  if (hasPlayers) {
    s.stopping = true;
    (async () => {
      try {
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 60초 후에 종료됩니다!', 'ENTER']);
        await sleep(30000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 30초 후에 종료됩니다!', 'ENTER']);
        await sleep(20000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 10초 후에 종료됩니다!', 'ENTER']);
        await sleep(5000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 5초 후에 종료됩니다!', 'ENTER']);
        await sleep(2000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 3초 후에 종료됩니다!', 'ENTER']);
        await sleep(1000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 2초 후에 종료됩니다!', 'ENTER']);
        await sleep(1000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 1초 후에 종료됩니다!', 'ENTER']);
        await sleep(1000);
      } catch (err) {
        console.error('Stop countdown error:', err);
      } finally {
        await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
        for (let i = 0; i < 40; i++) {
          if (!(await isJavaRunning(s.dir))) break;
          await sleep(1000);
        }
        if (await hasSession(s.session)) {
          await run('tmux', ['kill-session', '-t', s.session]);
        }
        s.stopping = false;
      }
    })();
    return { ok: true, message: `${s.name} 종료 경고를 보냈습니다. 1분 후 안전 종료됩니다.` };
  } else {
    await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
    (async () => {
      for (let i = 0; i < 40; i++) {
        if (!(await isJavaRunning(s.dir))) break;
        await sleep(1000);
      }
      if (await hasSession(s.session)) {
        await run('tmux', ['kill-session', '-t', s.session]);
      }
    })();
    return { ok: true, message: `${s.name} 정지 명령을 보냈습니다.` };
  }
}

async function restartServer(id, overrideRam) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  if (s.stopping || s.restarting) {
    return { ok: false, message: `${s.name}: 이미 종료 또는 재시작 작업이 진행 중입니다.` };
  }

  if (!(await isJavaRunning(s.dir))) {
    if (await hasSession(s.session)) {
      await run('tmux', ['kill-session', '-t', s.session]);
      await sleep(500);
    }
    const r = await startServer(id, overrideRam);
    return { ok: r.ok, message: `${s.name} 시작: ` + r.message };
  }

  // Check if any players are online
  let hasPlayers = false;
  try {
    const playerdata = require('./playerdata');
    const listRes = await playerdata.list(id);
    hasPlayers = listRes.items.some(p => p.online);
  } catch (e) {}

  if (hasPlayers) {
    s.restarting = true;
    (async () => {
      try {
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 60초 후에 재시작됩니다!', 'ENTER']);
        await sleep(30000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 30초 후에 재시작됩니다!', 'ENTER']);
        await sleep(20000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 10초 후에 재시작됩니다!', 'ENTER']);
        await sleep(5000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 5초 후에 재시작됩니다!', 'ENTER']);
        await sleep(2000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 3초 후에 재시작됩니다!', 'ENTER']);
        await sleep(1000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 2초 후에 재시작됩니다!', 'ENTER']);
        await sleep(1000);
        await run('tmux', ['send-keys', '-t', s.session, 'say [MITS] 서버가 1초 후에 재시작됩니다!', 'ENTER']);
        await sleep(1000);
      } catch (err) {
        console.error('Restart countdown error:', err);
      } finally {
        await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
        for (let i = 0; i < 40; i++) {
          if (!(await isJavaRunning(s.dir))) break;
          await sleep(1000);
        }
        if (await hasSession(s.session)) {
          await run('tmux', ['kill-session', '-t', s.session]);
          await sleep(1000);
        }
        await startServer(id, overrideRam);
        s.restarting = false;
      }
    })();
    return { ok: true, message: `${s.name} 재시작 경고를 보냈습니다. 1분 후 재시작됩니다.` };
  } else {
    await run('tmux', ['send-keys', '-t', s.session, 'stop', 'ENTER']);
    for (let i = 0; i < 40; i++) {
      if (!(await isJavaRunning(s.dir))) break;
      await sleep(1000);
    }
    if (await hasSession(s.session)) {
      await run('tmux', ['kill-session', '-t', s.session]);
      await sleep(1000);
    }
    const r = await startServer(id, overrideRam);
    return { ok: r.ok, message: `${s.name} 재시작: ` + r.message };
  }
}

async function setExtPort(id, extPort) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);

  const portVal = extPort ? parseInt(extPort, 10) : null;
  if (extPort && (isNaN(portVal) || portVal <= 0 || portVal > 65535)) {
    throw new Error('올바른 포트 번호를 입력하세요 (1~65535).');
  }

  s.extPort = portVal;

  // Save to .env file on disk
  const envPath = path.join(__dirname, '..', '.env');
  try {
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf8');
    } catch (err) {}

    const key = id === 'server1' ? 'S1_EXT_PORT' : 'S2_EXT_PORT';
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const newLine = portVal !== null ? `${key}=${portVal}` : '';

    let newContent;
    if (regex.test(content)) {
      if (newLine) {
        newContent = content.replace(regex, newLine);
      } else {
        newContent = content.replace(regex, '').split('\n').filter(line => line.trim() !== '').join('\n') + '\n';
      }
    } else {
      if (newLine) {
        newContent = content.trim() + (content.trim() ? '\n' : '') + newLine + '\n';
      } else {
        newContent = content;
      }
    }

    await fs.writeFile(envPath, newContent, 'utf8');
  } catch (err) {
    console.error('Failed to write .env file:', err);
  }

  return { ok: true, message: `${s.name} 외부 포트를 ${portVal || '비설정'}으로 설정했습니다.` };
}

async function sendCommand(id, command) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  // 줄바꿈 제거 — tmux send-keys 로의 다중명령 주입 차단(모든 명령 기능의 공통 관문)
  const cmd = (command || '').replace(/[\r\n]+/g, ' ').trim();
  if (!cmd) return { ok: false, message: '빈 명령입니다.' };
  if (!(await isJavaRunning(s.dir))) {
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
  const r1 = await startServer('server1', RAM_DUAL);
  const r2 = await startServer('server2', RAM_DUAL);
  return {
    ok: r1.ok && r2.ok,
    message: `전체 시작: 1번 서버(${r1.message}), 2번 서버(${r2.message})`,
  };
}

async function stopAll() {
  const r1 = await stopServer('server1');
  const r2 = await stopServer('server2');
  return {
    ok: r1.ok && r2.ok,
    message: `전체 정지: 1번 서버(${r1.message}), 2번 서버(${r2.message})`,
  };
}

module.exports = {
  allStatus,
  serverStatus,
  statusOf,
  requireStopped,
  startServer,
  stopServer,
  restartServer,
  setExtPort,
  sendCommand,
  getConsole,
  startAll,
  stopAll,
};
