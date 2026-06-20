'use strict';

// 가벼운 영속 저장소 — repo 밖 config.dataDir 에 원자적(tmp+rename)으로 JSON/JSONL 보관.
// 스케줄/매크로/게임상태 캐시/메트릭 등이 배포(git reset --hard)에 날아가지 않게 한다.

const fs = require('fs').promises;
const path = require('path');
const { config } = require('./config');

const DIR = config.dataDir;
const locks = new Map(); // name -> 직렬화용 Promise 체인 (인터벌·요청 쓰기 경합 방지)

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true }).catch(() => {});
}

function fileFor(name) {
  // 디렉터리 트래버설 차단 — 단순 파일명만 허용
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('잘못된 스토어 이름: ' + name);
  return path.join(DIR, name);
}

async function readJson(name, fallback) {
  try {
    const txt = await fs.readFile(fileFor(name), 'utf8');
    const v = JSON.parse(txt || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

async function atomicWrite(name, obj) {
  await ensureDir();
  const target = fileFor(name);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

// 같은 파일에 대한 쓰기를 직렬화하되, 호출자에겐 실제 성공/실패를 그대로 전달.
async function writeJson(name, obj) {
  const prev = (locks.get(name) || Promise.resolve()).catch(() => {});
  const next = prev.then(() => atomicWrite(name, obj));
  locks.set(name, next.catch(() => {})); // 다음 쓰기가 이 작업 뒤에 줄서도록(에러는 체인에서 흡수)
  return next;
}

// JSONL append (메트릭 등 시계열)
async function appendLine(name, obj) {
  await ensureDir();
  await fs.appendFile(fileFor(name), JSON.stringify(obj) + '\n', 'utf8');
}

async function readLines(name, maxLines) {
  try {
    const txt = await fs.readFile(fileFor(name), 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    const slice = maxLines ? lines.slice(-maxLines) : lines;
    return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// JSONL 을 maxLines 이하로 잘라 다시 쓴다(보존기간 관리용). tmp+rename 로 원자적.
async function trimLines(name, maxLines) {
  const lines = await readLines(name, maxLines);
  try {
    await ensureDir();
    const target = fileFor(name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, lines.map((o) => JSON.stringify(o)).join('\n') + (lines.length ? '\n' : ''), 'utf8');
    await fs.rename(tmp, target);
  } catch { /* ignore */ }
}

module.exports = { dataDir: DIR, readJson, writeJson, appendLine, readLines, trimLines, fileFor };
