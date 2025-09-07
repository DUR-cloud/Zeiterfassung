// public/sw.js (nur wenn du einen eigenen benutzt)
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const names = await caches.keys()
  await Promise.all(names.map((n) => caches.delete(n)))
  await self.clients.claim()
})()))
