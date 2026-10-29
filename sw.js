// CDN 26 · app instalable: busca siempre la versión nueva y guarda copia para abrir sin internet
const CACHE = 'cdn26-v3';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'favicon.png', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'assets/img/splash.jpg', 'assets/img/logo-1.png'];
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {})); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/relay.json') || url.pathname.endsWith('/ws') || url.pathname.endsWith('/health')) return;   // servidor de salas: nunca desde caché
  if (req.headers.has('range')) return;                                    // música y video: el navegador los pide por partes
  if (url.pathname.includes('/assets/img/')) {                             // imágenes: primero la copia guardada
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { if (res && res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return res; })));
    return;
  }
  if (url.pathname.includes('/assets/')) return;                           // canciones/video: directo de internet
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./')))
  );
});
