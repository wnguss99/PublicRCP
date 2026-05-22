// Minimal service worker — satisfies PWA installability requirement.
// No caching: all requests go to the network as normal.
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
