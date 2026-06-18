'use strict';

const os = require('os');
const path = require('path');

const HOME = process.env.HOME || os.homedir();

function inHome(name) {
  return path.join(HOME, name);
}

// 서버 정의 — 기본값은 GSMSV 실측 구성(server1/server2, mc1/mc2, 25565/25566).
// 필요 시 .env로 오버라이드한다.
const servers = [
  {
    id: 'server1',
    name: process.env.S1_NAME || '1번 서버',
    session: process.env.S1_SESSION || 'mc1',
    dir: process.env.S1_DIR || inHome('server1'),
    port: parseInt(process.env.S1_PORT || '25565', 10),
  },
  {
    id: 'server2',
    name: process.env.S2_NAME || '2번 서버',
    session: process.env.S2_SESSION || 'mc2',
    dir: process.env.S2_DIR || inHome('server2'),
    port: parseInt(process.env.S2_PORT || '25566', 10),
  },
];

const config = {
  servers,
  jar: process.env.PAPER_JAR || 'paper.jar',
  xms: process.env.JAVA_XMS || '3G',
  xmx: process.env.JAVA_XMX || '3G',

  host: process.env.PANEL_HOST || '127.0.0.1',
  port: parseInt(process.env.PANEL_PORT || '3000', 10),
  password: process.env.PANEL_PASSWORD || 'admin',
  viewerPassword: process.env.PANEL_VIEWER_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'mits-dev-secret-change-me',

  sshHost: process.env.SSH_HOST || 'ssh.gsmsv.site',
  sshPort: process.env.SSH_PORT || '24160',

  consoleLines: parseInt(process.env.CONSOLE_LINES || '250', 10),
  startScript: process.env.START_SCRIPT || inHome('start.sh'),
  stopScript: process.env.STOP_SCRIPT || inHome('stop.sh'),

  // 백업 / 자동백업
  backupDir: process.env.BACKUP_DIR || inHome('mits-backups'),
  backupKeep: parseInt(process.env.BACKUP_KEEP || '10', 10),
  autoBackupHours: parseFloat(process.env.AUTO_BACKUP_HOURS || '0'),
};

function getServer(id) {
  return servers.find((s) => s.id === id);
}

module.exports = { config, getServer };
