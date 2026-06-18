'use strict';

const fs = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');

function logFile(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return path.join(s.dir, 'logs', 'latest.log');
}

async function tail(id, maxBytes = 300000) {
  try {
    const data = await fs.readFile(logFile(id), 'utf8');
    const text = data.length > maxBytes ? '... (앞부분 생략) ...\n' + data.slice(data.length - maxBytes) : data;
    return { ok: true, text };
  } catch {
    return { ok: true, text: '(logs/latest.log 가 아직 없습니다. 서버를 한 번 켜면 생성됩니다.)' };
  }
}

// mclo.gs(마인크래프트 로그 공유 표준 서비스)로 업로드 → 공유 URL 반환
async function share(id) {
  const content = await fs.readFile(logFile(id), 'utf8');
  const body = new URLSearchParams({ content }).toString();
  const res = await fetch('https://api.mclo.gs/1/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (data && data.success) return { ok: true, url: data.url, raw: data.raw };
  throw new Error((data && data.error) || '로그 공유에 실패했습니다.');
}

module.exports = { tail, share };
