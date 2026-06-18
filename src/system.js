'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

async function tryExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function systemInfo() {
  const totalMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMB = Math.round(os.freemem() / 1024 / 1024);

  // Linux의 'available' 메모리가 freemem보다 정확하다.
  let availMB = freeMB;
  let usedMB = totalMB - freeMB;
  const free = await tryExec('free', ['-m']);
  if (free) {
    const memLine = free.split('\n').find((l) => /^Mem:/.test(l));
    if (memLine) {
      const c = memLine.trim().split(/\s+/); // Mem: total used free shared buff/cache available
      usedMB = parseInt(c[2], 10) || usedMB;
      availMB = parseInt(c[6], 10) || availMB;
    }
  }

  let disk = null;
  const df = await tryExec('df', ['-h', os.homedir()]);
  if (df) {
    const line = df.split('\n')[1];
    if (line) {
      const c = line.trim().split(/\s+/);
      disk = { size: c[1], used: c[2], avail: c[3], usePct: c[4] };
    }
  }

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    cpus: os.cpus().length,
    load: os.loadavg().map((n) => Number(n.toFixed(2))),
    uptimeSec: Math.round(os.uptime()),
    totalMB,
    usedMB,
    availMB,
  };
}

module.exports = { systemInfo };
