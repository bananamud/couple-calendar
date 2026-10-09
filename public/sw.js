/* Service Worker：让 App 能装到桌面、断网时也能打开界面 */
const CACHE = 'couple-calendar-v23';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/util.js',
  './js/ui.js',
  './js/holidays.js',
  './js/ops.js',
  './js/sync.js',
  './js/diff.js',
  './js/datepicker.js',
  './js/views/calendar.js',
  './js/views/trips.js',
  './js/views/anniv.js',
  './js/views/me.js',
  './data/holidays.json',
  './data/holidays-predict.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // 同步接口永远走网络

  // 网络优先：在线时每次都拿最新文件（所以更新后刷新一次就能看到），
  // 只有断网/超时才退回缓存，保证离线也能打开。
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
