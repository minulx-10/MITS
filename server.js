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
const playerdata = require('./src/playerdata');
const properties = require('./src/properties');
const gamesettings = require('./src/gamesettings');
const scheduler = require('./src/scheduler');
const macros = require('./src/macros');
const metrics = require('./src/metrics');
const consoleStream = require('./src/console-stream');
const store = require('./src/store');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

const app = express();
app.disable('x-powered-by');
// 원격 접속(HTTPS 프록시: tailscale serve 등) 뒤에서만 secure 쿠키/프록시 신뢰를 켠다.
if (config.secureCookie) app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(
  session({
    name: 'mits.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookie, maxAge: 1000 * 60 * 60 * 8 },
  })
);

// 로그인 무차별 대입 방지 — IP당 15분 윈도우 제한(메모리, 의존성 없음)
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    let e = hits.get(ip);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    e.count += 1;
    if (e.count > max) return res.status(429).json({ ok: false, error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
    next();
  };
}
const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

// 콘솔 명령 히스토리 기록(최근 100개)
async function recordHistory(id, command) {
  try {
    const key = `${id}-cmdhistory.json`;
    const hist = await store.readJson(key, []);
    hist.push({ t: Date.now(), command });
    while (hist.length > 100) hist.shift();
    await store.writeJson(key, hist);
  } catch { /* 무시 */ }
}

// ---- 인증 불필요 ----
app.post('/api/login', loginLimiter, login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) =>
  res.json({ authed: !!(req.session && req.session.authed), role: (req.session && req.session.role) || null })
);
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// PWA 정적 자산(매니페스트/서비스워커/아이콘) — 인증 불필요(민감정보 아님)
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sw.js')));
app.get('/manifest.webmanifest', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest')));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

// 바로가기용 자동 로그인 — ?token=비밀번호 로 접속하면 세션 생성 후 메인으로 리다이렉트
app.get('/auto-login', loginLimiter, (req, res) => {
  const token = req.query.token || '';
  const crypto = require('crypto');
  const safe = (a, b) => { const ba = Buffer.from(String(a)), bb = Buffer.from(String(b)); if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; } return crypto.timingSafeEqual(ba, bb); };
  if (token && safe(token, config.password)) {
    req.session.authed = true;
    req.session.role = 'admin';
    return res.redirect('/');
  }
  if (config.viewerPassword && token && safe(token, config.viewerPassword)) {
    req.session.authed = true;
    req.session.role = 'viewer';
    return res.redirect('/');
  }
  return res.redirect('/login.html');
});

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
app.post('/api/server/:id/extport', requireAdmin, A((req) => mc.setExtPort(req.params.id, (req.body || {}).extPort)));
app.post('/api/power/startall', requireAdmin, A(() => mc.startAll()));
app.post('/api/power/stopall', requireAdmin, A(() => mc.stopAll()));

// ===== 콘솔 =====
app.get('/api/server/:id/console', A((req) => mc.getConsole(req.params.id).then((r) => ({ ok: true, ...r }))));
// 실시간 콘솔(SSE) — latest.log tail. A() 래퍼 대신 직접 응답 유지.
app.get('/api/server/:id/console/stream', (req, res) => {
  consoleStream.addClient(req.params.id, res).catch(() => { try { res.status(400).end(); } catch { /* */ } });
});
app.get('/api/server/:id/console/history', A((req) => store.readJson(`${req.params.id}-cmdhistory.json`, []).then((items) => ({ ok: true, items }))));
app.post('/api/server/:id/command', requireAdmin, A(async (req) => {
  const command = (req.body || {}).command;
  const r = await mc.sendCommand(req.params.id, command);
  if (r && r.ok) recordHistory(req.params.id, command);
  return r;
}));

// ===== 로그 =====
app.get('/api/server/:id/logs', A((req) => logs.tail(req.params.id)));
app.post('/api/server/:id/logs/share', requireAdmin, A((req) => logs.share(req.params.id)));

// ===== 플레이어 =====
app.get('/api/server/:id/players', A((req) => players.lists(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/players/:act', requireAdmin, A((req) => players.action(req.params.id, req.params.act, (req.body || {}).value)));

// ===== 플레이어 상세(NBT: 인벤토리/체력/좌표/허기/엔더상자/착용/스폰 등) =====
app.get('/api/server/:id/playerdata', A((req) => playerdata.list(req.params.id).then((r) => ({ ok: true, ...r }))));
app.get('/api/server/:id/playerdata/:uuid', A((req) => playerdata.detail(req.params.id, req.params.uuid).then((r) => ({ ok: true, ...r }))));

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
app.post('/api/server/:id/files/newfile', requireAdmin, A((req) => files.createFile(req.params.id, (req.body || {}).path, (req.body || {}).name)));
app.post('/api/server/:id/files/rename', requireAdmin, A((req) => files.rename(req.params.id, (req.body || {}).path, (req.body || {}).newName)));
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

// ===== 설정 (server.properties) =====
app.get('/api/server/:id/properties', A((req) => properties.readProperties(req.params.id)));
app.post('/api/server/:id/properties', requireAdmin, A((req) => properties.writeProperties(req.params.id, req.body || {})));
// 전체 키 편집기
app.get('/api/server/:id/properties/full', A((req) => properties.readPropertiesFull(req.params.id)));
app.post('/api/server/:id/properties/full', requireAdmin, A((req) => properties.writePropertiesFull(req.params.id, (req.body || {}).updates || {})));

// ===== 게임 설정 (월드보더/난이도/시간/날씨/gamerule/PVP) =====
app.get('/api/server/:id/gamesettings', A((req) => gamesettings.get(req.params.id)));
app.post('/api/server/:id/gamesettings', requireAdmin, A((req) => gamesettings.apply(req.params.id, req.body || {})));

// ===== 예약 작업 =====
app.get('/api/schedules', A(() => scheduler.list()));
app.post('/api/schedules', requireAdmin, A((req) => scheduler.create(req.body || {})));
app.post('/api/schedules/:sid/toggle', requireAdmin, A((req) => scheduler.toggle(req.params.sid)));
app.post('/api/schedules/:sid/delete', requireAdmin, A((req) => scheduler.remove(req.params.sid)));

// ===== 명령어 매크로 =====
app.get('/api/macros', A(() => macros.list()));
app.post('/api/macros', requireAdmin, A((req) => macros.create(req.body || {})));
app.post('/api/macros/:mid/delete', requireAdmin, A((req) => macros.remove(req.params.mid)));
app.post('/api/server/:id/macros/:mid/run', requireAdmin, A((req) => macros.run(req.params.id, req.params.mid, (req.body || {}).player)));

// ===== 리소스 메트릭(시계열) =====
app.get('/api/metrics', A((req) => {
  const RANGE = { '1h': 3600e3, '3h': 3 * 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 24 * 3600e3 };
  return metrics.query(RANGE[req.query.range] || RANGE['3h']);
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
  scheduler.start();
  metrics.start().catch((e) => console.error('[MITS] 메트릭 시작 실패:', e.message));
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
