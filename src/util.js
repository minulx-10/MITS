'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

// mc1/mc2 세션과 같은 tmux 소켓을 보도록 환경 고정
const ENV = { ...process.env, TMUX_TMPDIR: process.env.TMUX_TMPDIR || '/tmp' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      env: ENV,
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function spawnCmd(cmd, args, opts = {}) {
  return spawn(cmd, args, { env: ENV, ...opts });
}

// rel 경로가 baseDir 밖으로 못 벗어나게 안전하게 결합 (디렉터리 트래버설 차단)
function resolveInside(baseDir, rel) {
  const base = path.resolve(baseDir);
  const cleaned = rel && rel !== '' ? String(rel).replace(/^[/\\]+/, '') : '.';
  const target = path.resolve(base, cleaned);
  if (target !== base && !target.startsWith(base + path.sep)) {
    const e = new Error('허용되지 않은 경로입니다.');
    e.status = 400;
    throw e;
  }
  return target;
}

const MC_NAME = /^[A-Za-z0-9_]{1,16}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validName = (n) => MC_NAME.test(String(n || '').trim());
const validIp = (ip) => IPV4.test(String(ip || '').trim());

module.exports = { ENV, sleep, run, spawnCmd, resolveInside, validName, validIp };
