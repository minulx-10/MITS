'use strict';

require('dotenv').config();

const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const { config } = require('./src/config');
const { requireAuth, requireAdmin, login, logout } = require('./src/auth');
const mc = require('./src/minecraft');
const { systemInfo } = require('./src/system');
const players = require('./src/players');
const files = require('./src/files');
const logs = require('./src/logs');
const plugins = require('./src/plugins');
const software = require('./src/software');
const worlds = require('./src/worlds');
const backups = require('./src/backups');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(
  session({
    name: 'mits.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

// ---- 인증 불필요 ----
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) =>
  res.json({ authed: !!(req.session && req.session.authed), role: (req.session && req.session.role) || null })
);
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ---- 이하 인증 필요 ----
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// async 라우트 래퍼
const A = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 400).json({ ok: false, error: err.message });
  }
};

// ===== 대시보드 / 시스템 =====
app.get('/api/status', A(async () => {
  const [servers, system] = await Promise.all([mc.allStatus(), systemInfo()]);
  return {
    ok: true,
    servers,
    system,
    panel: { sshHost: config.sshHost, sshPort: config.sshPort, panelPort: config.port },
  };
}));

// ===== 전원 제어 (관리자) =====
app.post('/api/server/:id/start', requireAdmin, A((req) => mc.startServer(req.params.id)));
app.post('/api/server/:id/stop', requireAdmin, A((req) => mc.stopServer(req.params.id)));
app.post('/api/server/:id/restart', requireAdmin, A((req) => mc.restartServer(req.params.id)));
app.post('/api/power/startall', requireAdmin, A(() => mc.startAll()));
app.post('/api/power/stopall', requireAdmin, A(() => mc.stopAll()));

// ===== 콘솔 =====
app.get('/api/server/:id/console', A((req) => mc.getConsole(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/command', requireAdmin, A((req) => mc.sendCommand(req.params.id, (req.body || {}).command)));

// ===== 로그 =====
app.get('/api/server/:id/logs', A((req) => logs.tail(req.params.id)));
app.post('/api/server/:id/logs/share', requireAdmin, A((req) => logs.share(req.params.id)));

// ===== 플레이어 =====
app.get('/api/server/:id/players', A((req) => players.lists(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/players/:act', requireAdmin, A((req) => players.action(req.params.id, req.params.act, (req.body || {}).value)));

// ===== 소프트웨어 =====
app.get('/api/server/:id/software', A((req) => software.current(req.params.id).then((r) => ({ ok: true, ...r }))));
app.get('/api/paper/versions', A(() => software.versions().then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/software/update', requireAdmin, A(async (req) => {
  await mc.requireStopped(req.params.id);
  return software.update(req.params.id, (req.body || {}).version);
}));

// ===== 플러그인 =====
app.get('/api/server/:id/plugins', A((req) => plugins.list(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/plugins/toggle', requireAdmin, A((req) => plugins.toggle(req.params.id, (req.body || {}).file)));
app.post('/api/server/:id/plugins/delete', requireAdmin, A((req) => plugins.remove(req.params.id, (req.body || {}).file)));
app.get('/api/modrinth/search', A((req) => plugins.search(req.query.q).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/plugins/install', requireAdmin, A((req) => plugins.install(req.params.id, (req.body || {}).projectId)));
app.post('/api/server/:id/plugins/upload', requireAdmin, upload.single('file'), A(async (req) => {
  if (!req.file) throw new Error('파일이 없습니다.');
  if (!/\.jar$/i.test(req.file.originalname)) {
    await require('fs').promises.rm(req.file.path, { force: true }).catch(() => {});
    throw new Error('.jar 파일만 업로드할 수 있습니다.');
  }
  const dest = path.join(plugins.pluginsDir(req.params.id), req.file.originalname.replace(/[^A-Za-z0-9._-]/g, '_'));
  await require('fs').promises.copyFile(req.file.path, dest);
  await require('fs').promises.rm(req.file.path, { force: true }).catch(() => {});
  return { ok: true, message: '플러그인을 업로드했습니다. 서버를 재시작하면 반영됩니다.' };
}));

// ===== 파일 매니저 =====
app.get('/api/server/:id/files', A((req) => files.list(req.params.id, req.query.path || '').then((r) => ({ ok: true, ...r }))));
app.get('/api/server/:id/file', A((req) => files.read(req.params.id, req.query.path).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/file', requireAdmin, A((req) => files.write(req.params.id, (req.body || {}).path, (req.body || {}).content)));
app.post('/api/server/:id/files/mkdir', requireAdmin, A((req) => files.mkdir(req.params.id, (req.body || {}).path, (req.body || {}).name)));
app.post('/api/server/:id/files/delete', requireAdmin, A((req) => files.remove(req.params.id, (req.body || {}).path)));
app.get('/api/server/:id/files/download', A((req, res) => {
  const f = files.resolveDownload(req.params.id, req.query.path);
  res.download(f);
}));
app.post('/api/server/:id/files/upload', requireAdmin, upload.single('file'), A(async (req) => {
  if (!req.file) throw new Error('파일이 없습니다.');
  const destDir = files.resolveDownload(req.params.id, req.body.path || '.');
  const dest = path.join(destDir, req.file.originalname.replace(/[/\\]/g, '_'));
  await require('fs').promises.copyFile(req.file.path, dest);
  await require('fs').promises.rm(req.file.path, { force: true }).catch(() => {});
  return { ok: true, message: '업로드했습니다.' };
}));

// ===== 월드 =====
app.get('/api/server/:id/world', A((req) => worlds.info(req.params.id).then((r) => ({ ok: true, ...r }))));
app.get('/api/server/:id/world/download', A((req, res) => worlds.downloadStream(req.params.id, res)));
app.post('/api/server/:id/world/reset', requireAdmin, A(async (req) => {
  await mc.requireStopped(req.params.id);
  return worlds.reset(req.params.id);
}));
app.post('/api/server/:id/world/upload', requireAdmin, upload.single('file'), A(async (req) => {
  if (!req.file) throw new Error('파일이 없습니다.');
  await mc.requireStopped(req.params.id);
  return worlds.applyUpload(req.params.id, req.file.path, req.file.originalname);
}));

// ===== 백업 =====
app.get('/api/server/:id/backups', A((req) => backups.list(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/backups/create', requireAdmin, A((req) => backups.create(req.params.id, (req.body || {}).name)));
app.post('/api/server/:id/backups/restore', requireAdmin, A(async (req) => {
  await mc.requireStopped(req.params.id);
  return backups.restore(req.params.id, (req.body || {}).file);
}));
app.post('/api/server/:id/backups/delete', requireAdmin, A((req) => backups.remove(req.params.id, (req.body || {}).file)));
app.get('/api/server/:id/backups/download', A((req, res) => {
  const f = backups.resolveDownload(req.params.id, req.query.file);
  res.download(f);
}));

// 업로드 용량 초과 등 multer 에러 처리
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(400).json({ ok: false, error: err.message || '요청 처리 중 오류' });
});

app.listen(config.port, config.host, () => {
  console.log(`[MITS] listening on http://${config.host}:${config.port}`);
  console.log(`[MITS] servers: ${config.servers.map((s) => `${s.id}(${s.session}:${s.port})`).join(', ')}`);
  startAutoBackup();
});

// ===== 자동 백업 (선택) =====
function startAutoBackup() {
  const hours = config.autoBackupHours;
  if (!hours || hours <= 0) return;
  const ms = Math.max(0.25, hours) * 3600 * 1000;
  console.log(`[MITS] 자동 백업 활성화: ${hours}시간마다 (보관 ${config.backupKeep}개)`);
  setInterval(async () => {
    for (const s of config.servers) {
      try {
        await backups.create(s.id, 'auto');
        console.log(`[MITS] 자동 백업 완료: ${s.id}`);
      } catch (e) {
        console.error(`[MITS] 자동 백업 실패(${s.id}): ${e.message}`);
      }
    }
  }, ms);
}
