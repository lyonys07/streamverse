/* StreamVerse — service worker
   - Funciona sin conexión (la app y los catálogos ya vistos)
   - Catálogos: se muestran al instante desde caché y se actualizan en segundo plano
   - Imágenes: caché con límite para no llenar el teléfono
   - Los videos NO pasan por aquí (el reproductor los pide directo para no frenar el streaming) */

const VERSION = 'b8fabd35ad';
const SHELL = `sv-shell-${VERSION}`;
const API = 'sv-api-v1';
const IMAGES = 'sv-img-v1';
const FONTS = 'sv-fonts-v1';
const LIBS = 'sv-libs-v1';
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './maskable-512.png', './icon.svg', './favicon-32.png', './apple-touch-icon.png', './hls.min.js'];

self.addEventListener('install', (e) => {
  // config.js lo pone el administrador una sola vez: si todavía no existe, la instalación no falla
  e.waitUntil(caches.open(SHELL).then(async (c) => { await c.addAll(SHELL_FILES); await c.add('./config.js').catch(() => {}); }));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('sv-shell-') && k !== SHELL) await caches.delete(k);
      // limpia cachés de la versión anterior de la app
      if (k.startsWith('streamverse')) await caches.delete(k);
    }
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) await c.delete(k);
}

async function networkFirstPage(e) {
  try {
    const preload = await e.preloadResponse;
    if (preload) return preload;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(e.request, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) { const c = await caches.open(SHELL); c.put('./index.html', res.clone()); }
    return res;
  } catch {
    return (await caches.match('./index.html')) || (await caches.match('./')) || new Response('Sin conexión', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(e, cacheName, max) {
  const c = await caches.open(cacheName);
  const cached = await c.match(e.request);
  const network = fetch(e.request).then((res) => {
    if (res.ok && (res.type === 'basic' || res.type === 'cors')) { c.put(e.request, res.clone()).then(() => trim(cacheName, max)); }
    return res;
  }).catch(() => cached || Response.error());
  // copia reciente (menos de 10 min): respuesta instantánea y se actualiza por detrás;
  // copia vieja: se espera la red (máx. 5 s) y si no hay internet se usa la copia guardada
  const age = cached ? Date.now() - new Date(cached.headers.get('date') || 0).getTime() : Infinity;
  if (cached && age < 10 * 60 * 1000) { e.waitUntil(network.catch(() => {})); return cached; }
  if (cached) return Promise.race([network, new Promise((r) => setTimeout(() => r(cached), 5000))]);
  return network;
}

async function cacheFirstImage(e) {
  const c = await caches.open(IMAGES);
  const cached = await c.match(e.request.url);
  if (cached) return cached;
  try {
    // se pide en modo CORS para no guardar respuestas opacas (ocupan mucho espacio)
    const res = await fetch(e.request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) { c.put(e.request.url, res.clone()).then(() => trim(IMAGES, 700)); }
    return res;
  } catch {
    return fetch(e.request);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Descargas para ver sin conexión (videos HLS guardados en el teléfono)
  if (url.origin === location.origin && url.pathname.includes('/__offline__/')) {
    e.respondWith(caches.open('sv-downloads-v1').then(async (c) => (await c.match(url.href.split('?')[0])) || new Response('No descargado', { status: 404 })));
    return;
  }
  if (req.headers.has('range')) return; // video/audio
  if (/\.(m3u8|ts|m4s|mp4|webm|aac|vtt|mpd)(\?|$)/i.test(url.pathname)) return;

  if (req.mode === 'navigate' && url.origin === location.origin) { e.respondWith(networkFirstPage(e)); return; }
  // config.js (lo edita el administrador): siempre la versión más nueva; sin internet, la guardada
  if (url.origin === location.origin && url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put('./config.js', res.clone())); return res; }).catch(() => caches.match('./config.js')));
    return;
  }
  // programa de inicio de sesión (Firebase): se guarda para abrir la app aunque no haya internet
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open(LIBS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
    return;
  }
  if (url.hostname === 'api.themoviedb.org' || url.hostname === 'iptv-org.github.io' || (url.hostname === 'archive.org' && /^\/(advancedsearch|metadata)/.test(url.pathname))) {
    e.respondWith(staleWhileRevalidate(e, API, 400));
    return;
  }
  if (url.hostname === 'image.tmdb.org' || url.hostname === 'i.ytimg.com' || url.hostname === 'yt3.ggpht.com' || (url.hostname === 'archive.org' && url.pathname.startsWith('/services/img'))) {
    e.respondWith(cacheFirstImage(e));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; })));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
