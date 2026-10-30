// Service worker de Wallindirain : rend l'application installable et ouvrable sans réseau (coque de l'application seulement).
// RÈGLES DE SÉCURITÉ : on ne met JAMAIS en cache les appels /api (données privées), ni les requêtes autres que GET, ni les autres sites.
// Pour publier une nouvelle version des fichiers, changer VERSION n'est pas nécessaire (réseau d'abord) ; on le change seulement pour vider les anciens caches.
const VERSION = 'wld-v1';
const SHELL = [
  '/', '/css/app.css', '/css/legal.css',
  '/assets/logo-gold.png', '/assets/w-gold.png', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/fonts/inter-latin.woff2',
  '/js/api.js', '/js/charts.js', '/js/icons.js', '/js/main.js', '/js/pwa.js', '/js/ui.js', '/js/views/admin.js', '/js/views/agreements.js',
  '/js/views/auth.js', '/js/views/calls.js', '/js/views/courier.js', '/js/views/couriers.js', '/js/views/dashboard.js', '/js/views/invoices.js',
  '/js/views/kyc.js', '/js/views/legal.js', '/js/views/notifications.js', '/js/views/profile.js', '/js/views/seller.js', '/js/views/stats.js',
  '/js/views/supplier.js', '/js/views/support.js', '/js/views/wallet.js', '/js/views/warehouse.js'
];

self.addEventListener('install', (e) => {
  // un fichier absent ne doit pas empêcher l'installation : on ajoute ce qu'on peut
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || req.headers.has('range')) return;   // le navigateur s'en charge
  if (url.pathname === '/sw.js') return;
  const isPage = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);                                   // réseau d'abord : on a toujours la dernière version quand on est en ligne
      if (res.ok && res.status === 200) cache.put(isPage ? '/' : req, res.clone()).catch(() => {});
      return res;
    } catch {
      const hit = await cache.match(isPage ? '/' : req);              // hors connexion : la copie gardée
      if (hit) return hit;
      return new Response('Hors connexion', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
