// Service worker minimal — seule raison d'être : Chrome pour Android exige
// `ServiceWorkerRegistration.showNotification()` (le constructeur direct
// `new Notification()` y lève "Illegal constructor"). Pas de cache, pas de
// gestion offline : cette app doit toujours parler au service compagnon PC
// en direct, un cache périmé serait pire qu'utile.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
