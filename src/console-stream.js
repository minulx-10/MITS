'use strict';

// 실시간 콘솔(SSE) — logs/latest.log 를 바이트 오프셋으로 tail 해서 새 줄만 푸시.
// 서버당 폴러 1개 + 클라이언트 Set 팬아웃 + 20초 하트비트(idle 프록시 끊김 방지).

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { getServer } = require('./config');

const streams = new Map(); // id -> { clients:Set<res>, offset, reading, poll, hb }
const MAX_CLIENTS = 12;
const SNAPSHOT_BYTES = 16384;

function logPath(id) {
  const s = getServer(id);
  if (!s) throw new Error('알 수 없는 서버: ' + id);
  return path.join(s.dir, 'logs', 'latest.log');
}

function send(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* 끊긴 클라이언트 */ }
}

// offset 이후 새로 추가된 내용을 읽어 모든 클라이언트로 푸시(재진입 방지).
async function pushNew(id, st) {
  if (st.reading) return;
  st.reading = true;
  try {
    const file = logPath(id);
    const stat = await fsp.stat(file);
    if (stat.size < st.offset) st.offset = 0; // 로그 로테이션
    if (stat.size <= st.offset) return;
    const start = st.offset;
    const text = await new Promise((resolve, reject) => {
      let buf = '';
      const rs = fs.createReadStream(file, { start, end: stat.size - 1, encoding: 'utf8' });
      rs.on('data', (c) => { buf += c; });
      rs.on('end', () => resolve(buf));
      rs.on('error', reject);
    });
    st.offset = stat.size;
    if (text) for (const res of st.clients) send(res, 'log', { text });
  } catch { /* 파일 없음 등 */ } finally {
    st.reading = false;
  }
}

async function addClient(id, res) {
  if (!getServer(id)) throw new Error('알 수 없는 서버: ' + id);

  let st = streams.get(id);
  if (st && st.clients.size >= MAX_CLIENTS) throw new Error('동시 콘솔 연결이 너무 많습니다.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  if (!st) {
    st = { clients: new Set(), offset: 0, reading: false, poll: null, hb: null };
    streams.set(id, st);
  }
  st.clients.add(res);

  // 초기 스냅샷: 마지막 ~16KB
  try {
    const file = logPath(id);
    const stat = await fsp.stat(file);
    const fd = await fsp.open(file, 'r');
    const len = Math.min(SNAPSHOT_BYTES, stat.size);
    const { buffer } = await fd.read(Buffer.alloc(len), 0, len, Math.max(0, stat.size - len));
    await fd.close();
    st.offset = stat.size;
    send(res, 'init', { text: buffer.toString('utf8') });
  } catch {
    st.offset = 0;
    send(res, 'init', { text: '(로그가 없습니다 — 서버가 아직 시작되지 않았을 수 있습니다)' });
  }

  if (!st.poll) {
    st.poll = setInterval(() => { pushNew(id, st); }, 1000);
    st.hb = setInterval(() => { for (const r of st.clients) { try { r.write(': ping\n\n'); } catch { /* */ } } }, 20000);
  }

  res.on('close', () => removeClient(id, res));
}

function removeClient(id, res) {
  const st = streams.get(id);
  if (!st) return;
  st.clients.delete(res);
  try { res.end(); } catch { /* */ }
  if (st.clients.size === 0) {
    if (st.poll) clearInterval(st.poll);
    if (st.hb) clearInterval(st.hb);
    streams.delete(id);
  }
}

module.exports = { addClient };
