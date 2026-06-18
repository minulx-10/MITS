'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const { config } = require('./src/config');
const { requireAuth, login, logout } = require('./src/auth');
const mc = require('./src/minecraft');
const { systemInfo } = require('./src/system');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.use(
  session({
    name: 'mits.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

// ---- 인증 불필요 엔드포인트 ----
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => res.json({ authed: !!(req.session && req.session.authed) }));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// ---- 이하 전부 인증 필요 ----
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

function wrap(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  };
}

app.get(
  '/api/status',
  wrap(async () => {
    const [servers, system] = await Promise.all([mc.allStatus(), systemInfo()]);
    return {
      ok: true,
      servers,
      system,
      panel: { sshHost: config.sshHost, sshPort: config.sshPort, panelPort: config.port },
    };
  })
);

app.get('/api/server/:id/console', wrap((req) => mc.getConsole(req.params.id).then((r) => ({ ok: true, ...r }))));
app.post('/api/server/:id/command', wrap((req) => mc.sendCommand(req.params.id, (req.body || {}).command)));
app.post('/api/server/:id/start', wrap((req) => mc.startServer(req.params.id)));
app.post('/api/server/:id/stop', wrap((req) => mc.stopServer(req.params.id)));
app.post('/api/server/:id/restart', wrap((req) => mc.restartServer(req.params.id)));
app.post('/api/power/startall', wrap(() => mc.startAll()));
app.post('/api/power/stopall', wrap(() => mc.stopAll()));

app.listen(config.port, config.host, () => {
  console.log(`[MITS] listening on http://${config.host}:${config.port}`);
  console.log(`[MITS] 서버: ${config.servers.map((s) => `${s.id}(${s.session}:${s.port})`).join(', ')}`);
});
