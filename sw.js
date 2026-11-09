const VERSION = 'termia-v5';
const CACHE_ESTATICO = `${VERSION}-estatico`;
const CACHE_PAGINAS = `${VERSION}-paginas`;
const CACHE_WIDGETS = 'termia-widgets-v1';
// Marca del ultimo refresco en segundo plano; sobrevive a los cambios de VERSION.
const CACHE_SINCRONIZACION = 'termia-sync-v1';
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
          .filter((clave) => clave.startsWith('termia-') && ![CACHE_ESTATICO, CACHE_PAGINAS, CACHE_WIDGETS, CACHE_SINCRONIZACION].includes(clave))
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
  if (mensaje.tipo === 'REFRESCAR') {
    evento.waitUntil(refrescarPorPeticion(evento.source));
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

/* ================================================================
   SINCRONIZACION EN SEGUNDO PLANO
   Sigue la guia de Microsoft Edge «Sincronización y actualización de una
   PWA en segundo plano»: la sincronizacion periodica (periodicsync) refresca
   el app shell y el widget para que esten frescos al abrir la app, y la
   sincronizacion puntual (sync) actua como reintento diferido cuando un
   refresco falla sin red. La pagina registra las etiquetas tras comprobar
   `registration.periodicSync` / `registration.sync`; aqui solo se reacciona.
   Background Fetch no aplica: Termia no descarga archivos grandes.
   ================================================================ */
const ETIQUETA_REFRESCO = 'termia-refresco';
const ETIQUETA_REINTENTO = 'termia-reintento';
const RUTA_ESTADO_SINCRONIZACION = './estado-sincronizacion.json';

/** Guarda la marca del ultimo refresco como Response JSON (el SW no tiene localStorage). */
async function guardarEstadoSincronizacion(estado) {
  const cache = await caches.open(CACHE_SINCRONIZACION);
  await cache.put(absoluta(RUTA_ESTADO_SINCRONIZACION), new Response(JSON.stringify(estado), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function leerEstadoSincronizacion() {
  try {
    const cache = await caches.open(CACHE_SINCRONIZACION);
    const respuesta = await cache.match(absoluta(RUTA_ESTADO_SINCRONIZACION));
    return respuesta ? await respuesta.json() : null;
  } catch {
    return null;
  }
}

/**
 * Vuelve a descargar un recurso saltando la cache HTTP y sustituye la copia
 * estatica solo si la respuesta es correcta: nunca se pisa una copia buena
 * con un error. Devuelve true si el recurso quedo actualizado.
 */
async function refrescarRecurso(cache, ruta) {
  const url = absoluta(ruta);
  const respuesta = await fetch(url, { cache: 'reload' });
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${ruta}`);
  await cache.put(url, respuesta);
  return true;
}

/** Pide al navegador que reintente cuando vuelva la red (patron «se intentara mas tarde»). */
async function programarReintento() {
  if (!('sync' in self.registration)) return false;
  try {
    await self.registration.sync.register(ETIQUETA_REINTENTO);
    return true;
  } catch (error) {
    console.warn('[SW] No se pudo programar el reintento', error);
    return false;
  }
}

/**
 * Trabajo comun de periodicsync, sync y la peticion manual de la pagina:
 * refresca el app shell (incluidos widgets/*.json), vuelve a pintar el widget
 * en el host de Windows y guarda la marca de tiempo del exito. Cada recurso
 * falla por separado sin abortar el resto. Devuelve { ok, cuando, fallidos }.
 */
async function refrescarEnSegundoPlano({ origen = 'periodicsync', reintentar = true } = {}) {
  const cache = await caches.open(CACHE_ESTATICO);
  const resultados = await Promise.allSettled(RECURSOS.map((ruta) => refrescarRecurso(cache, ruta)));
  const fallidos = RECURSOS.filter((ruta, indice) => resultados[indice].status === 'rejected');
  const ok = fallidos.length === 0;

  if (ok) {
    const cuando = new Date().toISOString();
    await guardarEstadoSincronizacion({ cuando, origen });
    if ('widgets' in self) {
      try {
        await updateWidgets();
      } catch (error) {
        console.warn('[SW] widgets', error);
      }
    }
    // No se llama a self.registration.update() aqui: en Chrome la primera
    // llamada desde el SW tardaba mas de 20 s en resolverse y retrasaba la
    // respuesta REFRESCADO. La nueva version del SW la detecta el navegador al
    // navegar y la pagina la ofrece con su flujo explicito (updatefound).
    return { ok, cuando, fallidos };
  }

  console.warn(`[SW] Refresco incompleto (${origen}): ${fallidos.length} de ${RECURSOS.length} recursos`);
  if (reintentar) await programarReintento();
  const anterior = await leerEstadoSincronizacion();
  return { ok, cuando: anterior?.cuando ?? null, fallidos };
}

async function difundirRefresco(resultado, origen, destinos) {
  const mensaje = { tipo: 'REFRESCADO', ok: resultado.ok, cuando: resultado.cuando, origen };
  const clientes = destinos ?? await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const cliente of clientes) cliente.postMessage(mensaje);
}

/** Peticion manual («Buscar actualizaciones»): responde solo a la pagina que la pidio. */
async function refrescarPorPeticion(cliente) {
  const resultado = await refrescarEnSegundoPlano({ origen: 'manual' });
  if (cliente) await difundirRefresco(resultado, 'manual', [cliente]);
}

self.addEventListener('periodicsync', (evento) => {
  if (evento.tag !== ETIQUETA_REFRESCO) return;
  evento.waitUntil(
    refrescarEnSegundoPlano({ origen: 'periodicsync' })
      .then((resultado) => difundirRefresco(resultado, 'periodicsync'))
  );
});

self.addEventListener('sync', (evento) => {
  if (evento.tag !== ETIQUETA_REINTENTO) return;
  // Sin reprogramar: si el refresco falla se rechaza la promesa y es el
  // navegador quien reintenta con su propio retroceso hasta `lastChance`.
  evento.waitUntil(
    refrescarEnSegundoPlano({ origen: 'sync', reintentar: false }).then(async (resultado) => {
      await difundirRefresco(resultado, 'sync');
      if (!resultado.ok && !evento.lastChance) throw new Error('Refresco incompleto; se reintentara');
    })
  );
});
