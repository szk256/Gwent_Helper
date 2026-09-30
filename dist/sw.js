// 离线缓存：先走网络（拿到新版本就更新缓存），断网时用缓存。只在 http(s) 网址下注册，本地打开 html 文件时不用。
const CACHE = 'gwent-tracker-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['gwent_tracker.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('gwent_tracker.html'))));
});
