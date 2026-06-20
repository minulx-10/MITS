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
    extPort: process.env.S1_EXT_PORT ? parseInt(process.env.S1_EXT_PORT, 10) : null,
  },
  {
    id: 'server2',
    name: process.env.S2_NAME || '2번 서버',
    session: process.env.S2_SESSION || 'mc2',
    dir: process.env.S2_DIR || inHome('server2'),
    port: parseInt(process.env.S2_PORT || '25566', 10),
    extPort: process.env.S2_EXT_PORT ? parseInt(process.env.S2_EXT_PORT, 10) : null,
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

  // 영속 데이터(스케줄/매크로/메트릭/게임상태 캐시 등) — repo 밖에 둬서 배포(git reset)에 안 날아감
  dataDir: process.env.DATA_DIR || inHome('mits-data'),

  // 원격 접속(HTTPS 프록시: tailscale serve 등) 뒤에서만 켠다. http(로컬/SSH터널)에선 0 유지.
  secureCookie: process.env.PANEL_SECURE_COOKIE === '1',

  // 리소스 메트릭 수집
  metricsIntervalSec: parseInt(process.env.METRICS_INTERVAL_SEC || '15', 10),
  metricsRetainHours: parseFloat(process.env.METRICS_RETAIN_HOURS || '24'),
};

function getServer(id) {
  return servers.find((s) => s.id === id);
}

module.exports = { config, getServer };
