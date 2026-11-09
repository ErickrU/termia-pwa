/**
 * Verificación de la sincronización en segundo plano de Termia con Chrome
 * DevTools Protocol. Sin dependencias: usa el WebSocket nativo de Node (>= 22).
 *
 * Sigue la guía de Microsoft Edge «Sincronización y actualización de una PWA en
 * segundo plano» y comprueba en un navegador real que:
 *   - la página detecta soporte (registration.sync / periodicSync / permisos)
 *     y degrada sin errores cuando falta alguna API
 *   - el mensaje REFRESCAR al SW responde REFRESCADO { ok: true, cuando } y
 *     deja la marca en la caché termia-sync-v1 sin tocar la precarga (18)
 *   - «Buscar actualizaciones» (diálogo de ayuda) anuncia «Termia está al día»
 *     y el pie muestra «Última sincronización: hace un momento»
 *   - el formato relativo en español es correcto (vectores) y la marca
 *     persiste tras recargar («ayer»)
 *   - sin red, la acción registra el reintento termia-reintento y anuncia
 *     «Sin conexión: … cuando vuelva la red» (patrón «se intentará más tarde»)
 *   - sin red, un refresco fallido no pisa la marca ni la caché buena
 *   - los eventos sync y periodicsync simulados con DevTools (igual que los
 *     campos Sync / Periodic Sync del panel Application) refrescan y anuncian
 *     «Actualizado en segundo plano»
 *   - no hay errores de consola
 *
 * Genera dos capturas de revisión visual en /tmp (ayuda y pie de página).
 *
 * Uso:  node herramientas/verificar-sincronizacion.mjs [--url http://localhost:8171/] [--cdp 9431]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const flag = (nombre, porDefecto) => {
  const indice = process.argv.indexOf(`--${nombre}`);
  return indice !== -1 ? process.argv[indice + 1] : porDefecto;
};
const URL_APP = flag('url', 'http://localhost:8171/');
const PUERTO_CDP = Number(flag('cdp', 9431));
const VERSION_SW = readFileSync(join(RAIZ, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)?.[1] ?? 'termia';
const CACHE_ESTATICO = `${VERSION_SW}-estatico`;
const CACHE_SINCRONIZACION = 'termia-sync-v1';
const ETIQUETA_REFRESCO = 'termia-refresco';
const ETIQUETA_REINTENTO = 'termia-reintento';
const RECURSOS_PRECACHE = 18;

const espera = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/* ================================================================
   Cliente CDP mínimo
   ================================================================ */
class Cdp {
  #ws; #id = 0; #pendientes = new Map();
  eventos = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (evento) => {
      const mensaje = JSON.parse(evento.data);
      if (mensaje.id !== undefined) {
        const pendiente = this.#pendientes.get(mensaje.id);
        this.#pendientes.delete(mensaje.id);
        mensaje.error ? pendiente?.rechazar(new Error(mensaje.error.message)) : pendiente?.resolver(mensaje.result);
      } else {
        this.eventos.push(mensaje);
      }
    });
  }

  static async conectar(url) {
    const ws = new WebSocket(url);
    await new Promise((resolver, rechazar) => {
      ws.addEventListener('open', resolver, { once: true });
      ws.addEventListener('error', () => rechazar(new Error('No se pudo abrir el WebSocket de CDP')), { once: true });
    });
    return new Cdp(ws);
  }

  /** `sessionId` permite hablar con otro target (p. ej. el service worker) en modo flatten. */
  enviar(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolver, rechazar) => {
      this.#pendientes.set(id, { resolver, rechazar });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => {
        if (this.#pendientes.delete(id)) rechazar(new Error(`Tiempo agotado en ${method}`));
      }, 30_000);
    });
  }

  /** Evalúa JS en la página y devuelve el valor ya deserializado. */
  async evaluar(expresion) {
    const { result, exceptionDetails } = await this.enviar('Runtime.evaluate', {
      expression: expresion,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'Error al evaluar');
    return result.value;
  }

  cerrar() { this.#ws.close(); }
}

/* ================================================================
   Informe
   ================================================================ */
const resultados = [];
const comprobar = (nombre, ok, detalle = '') => {
  resultados.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✓' : '✗'}  ${nombre}${detalle ? `  ${detalle}` : ''}`);
};

/** Espera a que una expresión de la página sea verdadera (o agota los intentos). */
async function esperarA(cdp, expresion, intentos = 40, pausa = 250) {
  for (let intento = 0; intento < intentos; intento++) {
    try {
      if (await cdp.evaluar(expresion)) return true;
    } catch { /* la página puede estar navegando todavía */ }
    await espera(pausa);
  }
  return false;
}

const ES_ISO = (texto) => typeof texto === 'string' && !Number.isNaN(Date.parse(texto));

/**
 * Sesión CDP (flatten) con el target del service worker, o null si no existe.
 * La emulación de red es por target: para que el SW también quede sin red hay
 * que aplicarla en su propia sesión, no solo en la de la página.
 */
async function sesionServiceWorker(cdp) {
  try {
    const { targetInfos } = await cdp.enviar('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(new URL(URL_APP).origin));
    if (!sw) return null;
    const { sessionId } = await cdp.enviar('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp.enviar('Network.enable', {}, sessionId);
    return sessionId;
  } catch {
    return null;
  }
}

async function emularRed(cdp, sesionSw, offline) {
  const condiciones = offline
    ? { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await cdp.enviar('Network.emulateNetworkConditions', condiciones);
  if (sesionSw) await cdp.enviar('Network.emulateNetworkConditions', condiciones, sesionSw).catch(() => {});
}

/** Envía REFRESCAR al SW que controla la página y devuelve el REFRESCADO (manual) o null. */
const REFRESCO_DIRECTO = `(() => new Promise((resolver) => {
  const escucha = (evento) => {
    if (evento.data?.tipo !== 'REFRESCADO' || evento.data.origen !== 'manual') return;
    navigator.serviceWorker.removeEventListener('message', escucha);
    resolver(evento.data);
  };
  navigator.serviceWorker.addEventListener('message', escucha);
  setTimeout(() => { navigator.serviceWorker.removeEventListener('message', escucha); resolver(null); }, 20000);
  navigator.serviceWorker.controller.postMessage({ tipo: 'REFRESCAR' });
}))()`;

/** Lee la marca guardada por el SW y el tamaño de la precarga. */
const ESTADO_CACHES = `(async () => {
  const nombres = await caches.keys();
  const sync = await caches.open(${JSON.stringify(CACHE_SINCRONIZACION)});
  const marca = await sync.match(new URL('./estado-sincronizacion.json', (await navigator.serviceWorker.ready).scope).href);
  const estatico = nombres.includes(${JSON.stringify(CACHE_ESTATICO)}) ? await caches.open(${JSON.stringify(CACHE_ESTATICO)}) : null;
  return {
    nombres,
    estado: marca ? await marca.json() : null,
    tipo: marca?.headers.get('Content-Type') ?? null,
    precache: estatico ? (await estatico.keys()).length : 0,
  };
})()`;

/* ================================================================
   Principal
   ================================================================ */
const perfil = mkdtempSync(join(tmpdir(), 'chrome-termia-sync-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PUERTO_CDP}`,
  `--user-data-dir=${perfil}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
let codigoSalida = 0;

try {
  /* --- Localizar el target de la página --------------------------------- */
  let objetivo;
  for (let intento = 0; intento < 60; intento++) {
    try {
      const lista = await (await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/list`)).json();
      objetivo = lista.find((t) => t.type === 'page');
      if (objetivo?.webSocketDebuggerUrl) break;
    } catch { /* Chrome aún no escucha */ }
    await espera(250);
  }
  if (!objetivo) throw new Error('Chrome no expuso ningún target de página');

  cdp = await Cdp.conectar(objetivo.webSocketDebuggerUrl);
  await cdp.enviar('Runtime.enable');
  await cdp.enviar('Log.enable');
  await cdp.enviar('Page.enable');
  await cdp.enviar('Network.enable');
  await cdp.enviar('ServiceWorker.enable');

  /* --- Primera carga ------------------------------------------------------ */
  console.log(`\nCargando ${URL_APP}\n`);
  await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.enviar('Page.navigate', { url: URL_APP });
  const cargada = await esperarA(cdp, `document.getElementById('resultado-C')?.textContent.trim().length > 0`, 80);
  // Tras activarse, el SW reclama la página (clients.claim); hace falta un controller para mandarle mensajes.
  const controlada = await esperarA(cdp, `navigator.serviceWorker.getRegistration().then(r => !!r?.active && !!navigator.serviceWorker.controller)`, 80);
  await esperarA(cdp, `'sincronizacionPeriodica' in document.body.dataset`, 40);

  console.log('Detección de soporte');
  comprobar('La app carga y el service worker controla la página', cargada && controlada);

  const soporte = await cdp.evaluar(`(async () => {
    const registro = await navigator.serviceWorker.ready;
    let permiso = 'sin-api';
    try { permiso = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch (e) { permiso = 'excepcion:' + e.name; }
    return {
      sync: !!registro.sync,
      periodicSync: !!registro.periodicSync,
      permiso,
      resultado: document.body.dataset.sincronizacionPeriodica,
      etiquetasPeriodicas: registro.periodicSync ? await registro.periodicSync.getTags().catch(() => []) : [],
      etiquetasSync: registro.sync ? await registro.sync.getTags().catch(() => []) : [],
      indicadorOculto: document.getElementById('ultima-sincronizacion').hidden,
      estadoPwa: document.getElementById('estado-pwa').textContent,
    };
  })()`);
  const esperadoPeriodico = !soporte.periodicSync ? 'no-soportada' : soporte.permiso === 'granted' ? 'registrada' : 'sin-permiso';
  comprobar('Chrome expone registration.sync (Background Sync)', soporte.sync);
  comprobar(`registration.periodicSync ${soporte.periodicSync ? 'disponible' : 'ausente'}: la página degrada según la guía`,
    soporte.resultado === esperadoPeriodico
      && (esperadoPeriodico === 'registrada' ? soporte.etiquetasPeriodicas.includes(ETIQUETA_REFRESCO) : soporte.etiquetasPeriodicas.length === 0),
    `permiso ${soporte.permiso} · resultado ${soporte.resultado} · etiquetas ${JSON.stringify(soporte.etiquetasPeriodicas)}`);
  // El pie puede decir «Lista para funcionar sin conexión.» o, si Chrome lanzó
  // beforeinstallprompt, «Termia está lista para instalarse.»: ambos son estados previos.
  comprobar('Sin marca previa, el indicador «Última sincronización» permanece oculto y no hay reintentos pendientes',
    soporte.indicadorOculto && soporte.etiquetasSync.length === 0 && /Lista para funcionar sin conexión|lista para instalarse/.test(soporte.estadoPwa),
    soporte.estadoPwa);

  /* --- REFRESCAR directo al SW ------------------------------------------- */
  console.log('\nMensaje REFRESCAR → REFRESCADO');
  const refrescado = await cdp.evaluar(REFRESCO_DIRECTO);
  const caches1 = await cdp.evaluar(ESTADO_CACHES);
  comprobar('El SW responde REFRESCADO { ok: true, cuando } al mensaje REFRESCAR',
    refrescado?.ok === true && ES_ISO(refrescado.cuando) && refrescado.origen === 'manual',
    JSON.stringify(refrescado));
  comprobar(`La caché ${CACHE_SINCRONIZACION} guarda la marca como Response JSON con el mismo instante`,
    caches1.nombres.includes(CACHE_SINCRONIZACION) && caches1.estado?.cuando === refrescado?.cuando
      && caches1.estado?.origen === 'manual' && /application\/json/.test(caches1.tipo ?? ''),
    `${caches1.estado?.cuando} · ${caches1.tipo}`);
  comprobar(`La precarga ${CACHE_ESTATICO} sigue con ${RECURSOS_PRECACHE} recursos (sin duplicados ni pérdidas)`,
    caches1.precache === RECURSOS_PRECACHE, `${caches1.precache} recursos`);

  /* --- «Buscar actualizaciones» con red ---------------------------------- */
  console.log('\nBuscar actualizaciones (con red)');
  const ayuda = await cdp.evaluar(`(async () => {
    document.getElementById('control-ayuda').click();
    await new Promise(r => setTimeout(r, 250));
    const d = document.getElementById('dialogo-ayuda');
    const seccion = d.querySelector('.ayuda-sincronizacion');
    const boton = document.getElementById('buscar-actualizaciones');
    return {
      abierto: !!d.open,
      seccion: !!seccion && seccion.getAttribute('aria-labelledby') === 'titulo-sincronizacion',
      texto: seccion?.querySelector('p')?.textContent ?? '',
      boton: !!boton && boton.textContent.trim() === 'Buscar actualizaciones' && boton.getAttribute('aria-describedby') === 'descripcion-sincronizacion',
      alto: boton ? Math.round(boton.getBoundingClientRect().height) : 0,
      estado: document.getElementById('estado-sincronizacion')?.getAttribute('role'),
      controles: document.querySelectorAll('.controles-titulo [data-control-ventana]').length,
    };
  })()`);
  comprobar('El diálogo de ayuda incluye la sección con la acción «Buscar actualizaciones» (≥ 44 px) y su estado accesible',
    ayuda.abierto && ayuda.seccion && ayuda.boton && ayuda.alto >= 44 && ayuda.estado === 'status' && ayuda.controles === 6,
    `botón ${ayuda.alto} px · ${ayuda.controles} controles`);
  comprobar('La ayuda explica que la sincronización requiere Chromium (Edge/Chrome) con la app instalada',
    /Chromium \(Microsoft Edge o Google Chrome\) con la app instalada/.test(ayuda.texto));

  await cdp.evaluar(`document.getElementById('buscar-actualizaciones').click()`);
  const alDia = await esperarA(cdp, `/^Termia está al día \\(actualizado hace un momento\\)\\.$/.test(document.getElementById('estado-sincronizacion').textContent)`, 80);
  const trasBuscar = await cdp.evaluar(`({
    dialogo: document.getElementById('estado-sincronizacion').textContent,
    pie: document.getElementById('estado-pwa').textContent,
    indicador: document.getElementById('ultima-sincronizacion').textContent,
    indicadorVisible: !document.getElementById('ultima-sincronizacion').hidden,
    titulo: document.getElementById('ultima-sincronizacion').title,
    habilitado: !document.getElementById('buscar-actualizaciones').disabled,
  })`);
  comprobar('La acción anuncia «Termia está al día (actualizado hace un momento).» en el diálogo y en el pie',
    alDia && trasBuscar.dialogo === trasBuscar.pie, trasBuscar.dialogo);
  comprobar('El pie muestra «Última sincronización: hace un momento» con la fecha absoluta en title',
    trasBuscar.indicadorVisible && trasBuscar.indicador === 'Última sincronización: hace un momento' && trasBuscar.titulo.length > 0 && trasBuscar.habilitado,
    `${trasBuscar.indicador} · ${trasBuscar.titulo}`);

  /* --- Capturas de revisión ---------------------------------------------- */
  console.log('\nCapturas');
  await espera(300);
  const capturaAyuda = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/termia-pwa-sync-ayuda.png', Buffer.from(capturaAyuda.data, 'base64'));
  comprobar('Captura de revisión /tmp/termia-pwa-sync-ayuda.png', true, '1280×900 · diálogo de ayuda');

  await cdp.evaluar(`document.getElementById('cerrar-ayuda').click()`);
  await espera(200);
  await cdp.evaluar(`document.querySelector('footer').scrollIntoView({ block: 'end' })`);
  await espera(300);
  const pie = await cdp.evaluar(`(() => {
    const f = document.querySelector('footer').getBoundingClientRect();
    const s = document.getElementById('ultima-sincronizacion').getBoundingClientRect();
    const e = document.getElementById('estado-pwa').getBoundingClientRect();
    return { dentro: s.right <= f.right + 1 && s.left >= f.left - 1 && s.bottom <= f.bottom + 1, alineado: Math.abs(s.right - e.right) < 2, visible: s.width > 0 && s.height > 0, cerrado: !document.getElementById('dialogo-ayuda').open };
  })()`);
  const capturaPie = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/termia-pwa-sync-estado.png', Buffer.from(capturaPie.data, 'base64'));
  comprobar('Captura de revisión /tmp/termia-pwa-sync-estado.png', true, '1280×900 · pie con última sincronización');
  comprobar('El indicador cabe en el pie, alineado a la derecha bajo el estado, con la ayuda cerrada',
    pie.dentro && pie.alineado && pie.visible && pie.cerrado);

  /* --- Vectores del formato relativo (mismo módulo que usa la página) ----- */
  console.log('\nFormato relativo');
  const vectores = await cdp.evaluar(`(async () => {
    const m = await import('./js/pwa.js');
    const ahora = Date.parse('2026-03-10T12:00:00Z');
    const antes = (ms) => new Date(ahora - ms).toISOString();
    const MIN = 60000, H = 60 * MIN, D = 24 * H;
    const casos = [
      [m.formatearTiempoRelativo(antes(10 * 1000), ahora), 'hace un momento'],
      [m.formatearTiempoRelativo(antes(59 * 1000), ahora), 'hace un momento'],
      [m.formatearTiempoRelativo(antes(1 * MIN), ahora), 'hace 1 minuto'],
      [m.formatearTiempoRelativo(antes(5 * MIN), ahora), 'hace 5 minutos'],
      [m.formatearTiempoRelativo(antes(3 * H), ahora), 'hace 3 horas'],
      [m.formatearTiempoRelativo(antes(26 * H), ahora), 'ayer'],
      [m.formatearTiempoRelativo(antes(3 * D), ahora), 'hace 3 días'],
      [m.formatearTiempoRelativo(antes(10 * D), ahora), 'la semana pasada'],
      [m.formatearTiempoRelativo(antes(40 * D), ahora), 'el mes pasado'],
      [m.formatearTiempoRelativo(antes(400 * D), ahora), 'el año pasado'],
      [m.formatearTiempoRelativo(new Date(ahora - 2 * H), ahora), 'hace 2 horas'],
      [m.formatearTiempoRelativo(ahora + 5 * MIN, ahora), 'hace un momento'],
      [m.formatearTiempoRelativo('no-es-fecha', ahora), ''],
      [m.formatearTiempoRelativo(null, ahora), ''],
    ];
    const fallos = casos.map((c, i) => [i + 1, c]).filter(([, [real, esperado]]) => real !== esperado);
    return { total: casos.length, ok: casos.length - fallos.length, fallos: fallos.map(([i, [real, esperado]]) => \`#\${i}: \${JSON.stringify(real)} ≠ \${JSON.stringify(esperado)}\`) };
  })()`);
  comprobar('Los 14 vectores de formatearTiempoRelativo pasan (es, numeric auto)', vectores.ok === vectores.total && vectores.total === 14,
    `${vectores.ok}/${vectores.total}${vectores.fallos.length ? ' · ' + vectores.fallos.join(' · ') : ''}`);

  /* --- Persistencia: marca de ayer y recarga ------------------------------ */
  console.log('\nPersistencia');
  await cdp.evaluar(`(async () => {
    const scope = (await navigator.serviceWorker.ready).scope;
    const cache = await caches.open(${JSON.stringify(CACHE_SINCRONIZACION)});
    const cuando = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await cache.put(new URL('./estado-sincronizacion.json', scope).href, new Response(JSON.stringify({ cuando, origen: 'prueba' }), { headers: { 'Content-Type': 'application/json' } }));
  })()`);
  await cdp.enviar('Page.navigate', { url: URL_APP });
  const mostroAyer = await esperarA(cdp, `document.getElementById('ultima-sincronizacion').textContent === 'Última sincronización: ayer'`, 60);
  comprobar('Tras recargar, el pie lee la marca de Cache Storage y muestra «Última sincronización: ayer»', mostroAyer,
    await cdp.evaluar(`document.getElementById('ultima-sincronizacion').textContent`));
  await esperarA(cdp, `!!navigator.serviceWorker.controller`, 40);

  /* --- Sin red: reintento diferido --------------------------------------- */
  console.log('\nSin conexión (patrón «se intentará más tarde»)');
  const sesionSw = await sesionServiceWorker(cdp);
  await emularRed(cdp, sesionSw, true);
  const sinRed = await esperarA(cdp, `navigator.onLine === false`, 20);
  const marcaAntes = (await cdp.evaluar(ESTADO_CACHES)).estado?.cuando;
  await cdp.evaluar(`(async () => { document.getElementById('control-ayuda').click(); await new Promise(r => setTimeout(r, 200)); document.getElementById('buscar-actualizaciones').click(); })()`);
  const anuncioOffline = soporte.sync
    ? 'Sin conexión: Termia se actualizará automáticamente cuando vuelva la red.'
    : 'Sin conexión: Termia se actualizará al abrirla con conexión.';
  const anuncio = await esperarA(cdp, `document.getElementById('estado-sincronizacion').textContent === ${JSON.stringify(anuncioOffline)}`, 40);
  const offline = await cdp.evaluar(`(async () => {
    const registro = await navigator.serviceWorker.ready;
    return {
      dialogo: document.getElementById('estado-sincronizacion').textContent,
      pie: document.getElementById('estado-pwa').textContent,
      etiquetas: registro.sync ? await registro.sync.getTags() : [],
      habilitado: !document.getElementById('buscar-actualizaciones').disabled,
    };
  })()`);
  comprobar('navigator.onLine pasa a false al emular «Sin conexión» (página y service worker)', sinRed && !!sesionSw,
    sesionSw ? 'sesión CDP del SW adjunta' : 'no se encontró el target del SW');
  comprobar(`Sin red, la acción anuncia «${anuncioOffline}»`, anuncio && offline.pie === anuncioOffline && offline.habilitado, offline.dialogo);
  comprobar(`Sin red, la página registra el reintento ${ETIQUETA_REINTENTO} con registration.sync`,
    !soporte.sync || offline.etiquetas.includes(ETIQUETA_REINTENTO), `etiquetas: ${JSON.stringify(offline.etiquetas)}`);

  const refrescoOffline = await cdp.evaluar(REFRESCO_DIRECTO);
  const cachesOffline = await cdp.evaluar(ESTADO_CACHES);
  comprobar('Sin red, REFRESCAR responde { ok: false } y conserva la marca anterior sin pisarla',
    refrescoOffline?.ok === false && refrescoOffline.cuando === marcaAntes && cachesOffline.estado?.cuando === marcaAntes,
    `${JSON.stringify(refrescoOffline)}`);
  comprobar(`Sin red, la precarga ${CACHE_ESTATICO} conserva sus ${RECURSOS_PRECACHE} copias buenas`,
    cachesOffline.precache === RECURSOS_PRECACHE, `${cachesOffline.precache} recursos`);
  await cdp.evaluar(`document.getElementById('dialogo-ayuda').close()`);

  /* --- Vuelve la red: eventos sync y periodicsync simulados (DevTools) ---- */
  console.log('\nCon conexión de nuevo: eventos simulados');
  await emularRed(cdp, sesionSw, false);
  await esperarA(cdp, `navigator.onLine === true`, 20);
  await cdp.evaluar(`document.getElementById('estado-pwa').textContent = ''`);

  const registroSw = cdp.eventos
    .filter((e) => e.method === 'ServiceWorker.workerRegistrationUpdated')
    .flatMap((e) => e.params.registrations)
    .find((r) => !r.isDeleted && new URL(URL_APP).href.startsWith(r.scopeURL));
  const origen = new URL(URL_APP).origin;
  let syncOk = false;
  let detalleSync = '';
  try {
    if (!registroSw) throw new Error('CDP no informó del registro del SW');
    await cdp.enviar('ServiceWorker.dispatchSyncEvent', { origin: origen, registrationId: registroSw.registrationId, tag: ETIQUETA_REINTENTO, lastChance: false });
    syncOk = await esperarA(cdp, `document.getElementById('estado-pwa').textContent === 'Actualizado en segundo plano.' && document.getElementById('ultima-sincronizacion').textContent === 'Última sincronización: hace un momento'`, 80);
    const marcaNueva = await esperarA(cdp, `${ESTADO_CACHES}.then(e => e.estado?.origen === 'sync' && e.estado.cuando !== ${JSON.stringify(marcaAntes)})`, 40);
    const estado = await cdp.evaluar(ESTADO_CACHES);
    detalleSync = `origen ${estado.estado?.origen} · ${estado.estado?.cuando}`;
    syncOk = syncOk && marcaNueva;
  } catch (error) {
    detalleSync = error.message;
  }
  comprobar(`El evento sync «${ETIQUETA_REINTENTO}» (simulado como en DevTools) refresca y anuncia «Actualizado en segundo plano.»`, syncOk, detalleSync);

  await cdp.evaluar(`document.getElementById('estado-pwa').textContent = ''`);
  let periodicOk = false;
  let detallePeriodic = '';
  try {
    if (!registroSw) throw new Error('CDP no informó del registro del SW');
    await cdp.enviar('ServiceWorker.dispatchPeriodicSyncEvent', { origin: origen, registrationId: registroSw.registrationId, tag: ETIQUETA_REFRESCO });
    periodicOk = await esperarA(cdp, `document.getElementById('estado-pwa').textContent === 'Actualizado en segundo plano.'`, 80);
    const marcaPeriodica = await esperarA(cdp, `${ESTADO_CACHES}.then(e => e.estado?.origen === 'periodicsync' && e.precache === ${RECURSOS_PRECACHE})`, 40);
    const estado = await cdp.evaluar(ESTADO_CACHES);
    detallePeriodic = `origen ${estado.estado?.origen} · precarga ${estado.precache}`;
    periodicOk = periodicOk && marcaPeriodica;
  } catch (error) {
    detallePeriodic = `sin soporte en este Chrome: ${error.message}`;
    periodicOk = /wasn't found|not found|not supported|no soporte/i.test(error.message);
  }
  comprobar(`El evento periodicsync «${ETIQUETA_REFRESCO}» (simulado) refresca el shell y el widget o degrada sin fallar`, periodicOk, detallePeriodic);

  /* --- Consola limpia ---------------------------------------------------------- */
  console.log('\nConsola');
  const errores = cdp.eventos
    .filter((e) =>
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) =>
      e.params.entry?.text ??
      e.params.exceptionDetails?.exception?.description ??
      e.params.args?.map((a) => a.value ?? a.description).join(' '))
    // Al emular offline es normal que fetch falle: ese error lo provoca la prueba.
    .filter((texto) => texto && !/ERR_INTERNET_DISCONNECTED|Failed to load resource.*offline/i.test(texto));
  comprobar('Sin errores de consola ni excepciones', errores.length === 0,
    errores.length ? `\n      ${errores.join('\n      ')}` : '');

  /* --- Resumen ------------------------------------------------------------------ */
  const fallos = resultados.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${resultados.length - fallos.length}/${resultados.length} comprobaciones correctas`);
  if (fallos.length) {
    console.log('  Fallos:');
    for (const f of fallos) console.log(`    ✗ ${f.nombre} ${f.detalle}`);
    codigoSalida = 1;
  }
  console.log('─'.repeat(58));
} catch (error) {
  console.error('\nLa verificación no pudo completarse:', error.message);
  codigoSalida = 1;
} finally {
  cdp?.cerrar();
  chrome.kill('SIGKILL');
  await espera(300);
  rmSync(perfil, { recursive: true, force: true });
  process.exit(codigoSalida);
}
