/* MITS PWA 서비스워커 — network-first(개발 중 stale 자산 방지) + 오프라인 폴백 */
const CACHE = 'mits-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return; // 제어/쓰기는 항상 네트워크
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // 외부 리소스(mc-heads 등)는 그대로

  // API: 네트워크 전용. 끊기면 503 JSON.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response('{"ok":false,"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // 정적: 네트워크 우선(최신 자산), 실패 시 캐시 → 마지막엔 셸.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('/')))
  );
});
