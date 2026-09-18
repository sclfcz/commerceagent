/*
 * One-way migration for browsers that installed CommerceAgent's former Workbox
 * Service Worker. This script never caches or intercepts requests. An old
 * registration will update to it, delete its caches, unregister itself and
 * reload controlled tabs onto the network-served application.
 *
 * Keep this file available while old installations may still exist.
 */

const LEGACY_CACHE_NAMES = new Set([
  'api-core-cache',
  'api-groups-cache',
  'google-fonts-cache',
  'gstatic-fonts-cache',
  'local-fonts-cache',
  'mermaid-runtime-cache',
]);

function isLegacyCache(name) {
  return name.startsWith('workbox-') || LEGACY_CACHE_NAMES.has(name);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter(isLegacyCache).map((name) => caches.delete(name)),
      );
      await self.registration.unregister();

      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      await Promise.all(windows.map((client) => client.navigate(client.url)));
    })(),
  );
});
