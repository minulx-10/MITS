'use strict';

const crypto = require('crypto');
const { config } = require('./config');

// 길이가 달라도 타이밍 정보를 최소화하는 상수시간 비교
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return res.redirect('/login.html');
}

// 쓰기/제어 동작은 관리자만
function requireAdmin(req, res, next) {
  if (req.session && req.session.authed && req.session.role === 'admin') return next();
  return res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다. (뷰어 계정)' });
}

function login(req, res) {
  const password = (req.body || {}).password;
  if (password && safeEqual(password, config.password)) {
    req.session.authed = true;
    req.session.role = 'admin';
    return res.json({ ok: true, role: 'admin' });
  }
  if (config.viewerPassword && password && safeEqual(password, config.viewerPassword)) {
    req.session.authed = true;
    req.session.role = 'viewer';
    return res.json({ ok: true, role: 'viewer' });
  }
  return res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
}

function logout(req, res) {
  if (req.session) req.session.destroy(() => res.json({ ok: true }));
  else res.json({ ok: true });
}

module.exports = { requireAuth, requireAdmin, login, logout };
