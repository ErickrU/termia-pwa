const VERSION = 'termia-v3';
const CACHE_ESTATICO = `${VERSION}-estatico`;
const CACHE_PAGINAS = `${VERSION}-paginas`;
const RECURSOS = [
  './index.html',
  './offline.html',
  './css/estilos.css',
  './css/offline.css',
  './js/conversion.js',
  './js/app.js',
  './js/pwa.js',
  './manifest.webmanifest',
  './sw.js',
  './iconos/favicon.svg',
  './iconos/icono-192.png',
  './iconos/icono-512.png',
  './iconos/icono-maskable-512.png',
  './iconos/apple-touch-icon.png'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE_ESTATICO).then((cache) => cache.addAll(RECURSOS)));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves
          .filter((clave) => clave.startsWith('termia-') && ![CACHE_ESTATICO, CACHE_PAGINAS].includes(clave))
          .map((clave) => caches.delete(clave))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (evento) => {
  if (evento.data?.tipo === 'ACTIVAR_ACTUALIZACION') self.skipWaiting();
});

async function navegar(solicitud) {
  try {
    const respuesta = await fetch(solicitud);
    const cache = await caches.open(CACHE_PAGINAS);
    cache.put(solicitud, respuesta.clone());
    return respuesta;
  } catch {
    return (await caches.match(solicitud)) || (await caches.match('./index.html')) || caches.match('./offline.html');
  }
}

async function estatico(solicitud) {
  const guardado = await caches.match(solicitud);
  const red = fetch(solicitud).then(async (respuesta) => {
    if (respuesta.ok) {
      const cache = await caches.open(CACHE_ESTATICO);
      cache.put(solicitud, respuesta.clone());
    }
    return respuesta;
  }).catch(() => null);
  return guardado || (await red) || Response.error();
}

self.addEventListener('fetch', (evento) => {
  if (evento.request.method !== 'GET' || new URL(evento.request.url).origin !== self.location.origin) return;
  evento.respondWith(evento.request.mode === 'navigate' ? navegar(evento.request) : estatico(evento.request));
});
