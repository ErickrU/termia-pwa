const VERSION = 'termia-v4';
const CACHE_ESTATICO = `${VERSION}-estatico`;
const CACHE_PAGINAS = `${VERSION}-paginas`;
const CACHE_WIDGETS = 'termia-widgets-v1';
const RECURSOS = [
  './index.html',
  './offline.html',
  './css/estilos.css',
  './css/offline.css',
  './js/conversion.js',
  './js/app.js',
  './js/pwa.js',
  './js/widgets.js',
  './manifest.webmanifest',
  './sw.js',
  './iconos/favicon.svg',
  './iconos/icono-192.png',
  './iconos/icono-512.png',
  './iconos/icono-maskable-512.png',
  './iconos/apple-touch-icon.png',
  './widgets/conversion-rapida-plantilla.json',
  './widgets/conversion-rapida-datos.json',
  './widgets/conversion-rapida-captura.png'
];
const absoluta = (ruta) => new URL(ruta, self.registration.scope).toString();

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE_ESTATICO).then((cache) => cache.addAll(RECURSOS)));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves
          .filter((clave) => clave.startsWith('termia-') && ![CACHE_ESTATICO, CACHE_PAGINAS, CACHE_WIDGETS].includes(clave))
          .map((clave) => caches.delete(clave))
      ))
      .then(() => self.clients.claim())
      .then(async () => {
        if ('widgets' in self) {
          try {
            await updateWidgets();
          } catch (error) {
            console.warn('[SW] widgets', error);
          }
        }
      })
  );
});

self.addEventListener('message', (evento) => {
  const mensaje = evento.data;
  if (!mensaje || typeof mensaje !== 'object') return;
  if (mensaje.tipo === 'ACTIVAR_ACTUALIZACION') {
    self.skipWaiting();
    return;
  }
  if (!esTagPropio(mensaje.tag)) return;
  if (mensaje.tipo === 'WIDGET_DATOS') evento.waitUntil(recibirDatosWidget(mensaje.tag, mensaje.datos));
  else if (mensaje.tipo === 'WIDGET_ACCION') evento.waitUntil(manejarAccionWidget(mensaje.tag, mensaje.verb));
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

/* ================================================================
   WIDGETS (Edge PWA Widgets API + simulador de la página)
   El mismo esqueleto vive en las tres PWA; aquí la fuente de datos es la
   última conversión que publica la página y los verbos son «subir»/«bajar».
   ================================================================ */
const TAG_WIDGET = 'conversion-rapida';
const datosWidgets = new Map();
const claveEstado = (tag) => absoluta(`./widgets/${tag}-estado.json`);

function esTagPropio(tag) {
  return typeof tag === 'string' && /^[a-z0-9-]+$/.test(tag) && tag === TAG_WIDGET;
}

function esObjetoPlano(valor) {
  return Boolean(valor) && typeof valor === 'object' && !Array.isArray(valor);
}

async function guardarDatosWidget(tag, datos) {
  datosWidgets.set(tag, datos);
  try {
    const cache = await caches.open(CACHE_WIDGETS);
    await cache.put(claveEstado(tag), new Response(JSON.stringify(datos), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (error) {
    console.warn('[SW] No se pudo guardar el estado del widget', error);
  }
}

async function leerDatosGuardados(tag) {
  if (datosWidgets.has(tag)) return datosWidgets.get(tag);
  try {
    const respuesta = await caches.match(claveEstado(tag));
    if (respuesta) {
      const datos = await respuesta.json();
      datosWidgets.set(tag, datos);
      return datos;
    }
  } catch {
    // Sin estado guardado: se usan los datos estáticos.
  }
  return null;
}

async function obtenerDatosEstaticos(tag, urlDatos = `./widgets/${tag}-datos.json`) {
  const url = absoluta(urlDatos);
  const respuesta = (await caches.match(url)) || (await fetch(url));
  return respuesta.json();
}

async function obtenerDatosWidget(tag, urlDatos) {
  return (await leerDatosGuardados(tag)) ?? obtenerDatosEstaticos(tag, urlDatos);
}

async function obtenerPlantillaWidget(urlPlantilla = `./widgets/${TAG_WIDGET}-plantilla.json`) {
  const url = absoluta(urlPlantilla);
  const respuesta = (await caches.match(url)) || (await fetch(url));
  return respuesta.text();
}

/** Copia para el host de Windows: la URL de la app debe ser absoluta. */
function datosParaHost(datos) {
  return JSON.stringify({ ...datos, urlApp: absoluta(datos.urlApp ?? './') });
}

async function difundirWidget(tag, datos) {
  if ('widgets' in self) {
    try {
      await self.widgets.updateByTag(tag, { template: await obtenerPlantillaWidget(), data: datosParaHost(datos) });
    } catch (error) {
      console.warn('[SW] updateByTag', error);
    }
  }
  const clientes = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const cliente of clientes) cliente.postMessage({ tipo: 'WIDGET_ACTUALIZADO', tag, datos });
}

async function recibirDatosWidget(tag, datos) {
  if (esObjetoPlano(datos)) {
    await guardarDatosWidget(tag, datos);
    await difundirWidget(tag, datos);
    return;
  }
  await difundirWidget(tag, await obtenerDatosWidget(tag));
}

// Espejo mínimo de js/conversion.js: el SW es un script clásico y no puede
// importar módulos ES. Mismos umbrales que obtenerEstadoTermico.
function estadoTermico(celsius) {
  if (celsius <= -273.15 + 1e-9) return { estado: 'Cero absoluto', tono: 'extremo-frio' };
  if (celsius < 0) return { estado: 'Bajo cero', tono: 'frio' };
  if (celsius < 15) return { estado: 'Fresco', tono: 'fresco' };
  if (celsius <= 26) return { estado: 'Templado', tono: 'templado' };
  if (celsius < 40) return { estado: 'Cálido', tono: 'calido' };
  return { estado: 'Muy caliente', tono: 'muy-calido' };
}

function datosDesdeCelsius(celsius, base) {
  const redondear = (valor) => Math.round(valor * 100) / 100;
  const c = Math.max(-273.15, redondear(Number.isFinite(celsius) ? celsius : 20));
  const ahora = new Date();
  return {
    ...base,
    valorOrigen: String(c),
    unidadOrigen: 'C',
    simboloOrigen: '°C',
    celsius: c,
    fahrenheit: redondear(c * 9 / 5 + 32),
    kelvin: redondear(c + 273.15),
    rankine: redondear((c + 273.15) * 9 / 5),
    ...estadoTermico(c),
    actualizado: ahora.toISOString(),
    actualizadoTexto: `Actualizado el ${ahora.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}`
  };
}

/** Única ruta para los verbos: la usan tanto WIDGET_ACCION como widgetclick. */
async function manejarAccionWidget(tag, verb) {
  const delta = { subir: 1, bajar: -1 }[verb];
  if (!delta) {
    console.warn(`[SW] Verbo de widget desconocido: ${verb}`);
    return;
  }
  const actual = await obtenerDatosWidget(tag);
  const nuevos = datosDesdeCelsius(Number(actual.celsius) + delta, actual);
  await guardarDatosWidget(tag, nuevos);
  await difundirWidget(tag, nuevos);
}

async function renderWidget(widget) {
  const tag = widget.definition.tag;
  const template = await (await fetch(widget.definition.msAcTemplate)).text();
  const datos = await obtenerDatosWidget(tag, widget.definition.data);
  await self.widgets.updateByTag(tag, { template, data: datosParaHost(datos) });
}

async function updateWidgets() {
  const widget = await self.widgets.getByTag(TAG_WIDGET);
  if (widget) await renderWidget(widget);
}

if ('widgets' in self) {
  self.addEventListener('widgetinstall', (evento) => evento.waitUntil(renderWidget(evento.widget)));
  self.addEventListener('widgetresume', (evento) => evento.waitUntil(renderWidget(evento.widget)));
  self.addEventListener('widgetclick', (evento) => evento.waitUntil(manejarAccionWidget(TAG_WIDGET, evento.action)));
}
