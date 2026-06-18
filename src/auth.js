'use strict';

const crypto = require('crypto');
const { config } = require('./config');

// 길이가 달라도 타이밍 정보를 최소화하는 상수시간 비교
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 길이 비교만으로 조기 반환하지 않도록 더미 비교 수행
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

function login(req, res) {
  const password = (req.body || {}).password;
  if (password && safeEqual(password, config.password)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
}

function logout(req, res) {
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
}

module.exports = { requireAuth, login, logout };
