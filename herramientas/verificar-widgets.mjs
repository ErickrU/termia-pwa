/**
 * Verificación del Panel de widgets de Termia con Chrome DevTools Protocol.
 * Sin dependencias: usa el WebSocket nativo de Node (>= 22).
 *
 * Comprueba en un navegador real que:
 *   - la conversión alimenta el widget «Conversión rápida»
 *   - el sexto control de ventana abre el panel accesible
 *   - el selector lista el widget del manifest y agregarlo pinta la tarjeta
 *     con las cuatro unidades a partir de la plantilla Adaptive Card real
 *   - «+1 °C» recorre página → service worker → página y re-renderiza
 *   - los 22 vectores del resolvedor de expresiones pasan
 *   - el botón de cerrar mide 44×44 con la esquina pulsable
 *   - widget y conversión persisten tras recargar y el SW precachea todo
 *   - no hay errores de consola
 *
 * Además genera widgets/conversion-rapida-captura.png (640×600, la captura que
 * declara el manifest) y dos capturas de revisión visual en /tmp.
 *
 * Uso:  node herramientas/verificar-widgets.mjs [--url http://localhost:8163/] [--cdp 9413]
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
const URL_APP = flag('url', 'http://localhost:8163/');
const PUERTO_CDP = Number(flag('cdp', 9413));
const TAG = 'conversion-rapida';
const CLAVE_INSTALADOS = 'termia:widgets-instalados';
const CLAVE_CONVERSION = 'termia:ultima-conversion';
// La versión del SW se lee de sw.js para no desincronizar la prueba al subirla.
const VERSION_SW = readFileSync(join(RAIZ, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)?.[1] ?? 'termia';
const CACHE_ESTATICO = `${VERSION_SW}-estatico`;

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

  enviar(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolver, rechazar) => {
      this.#pendientes.set(id, { resolver, rechazar });
      this.#ws.send(JSON.stringify({ id, method, params }));
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

/** Lee ancho y alto de la cabecera PNG. */
function dimensionesPng(ruta) {
  const cabecera = readFileSync(ruta);
  return { ancho: cabecera.readUInt32BE(16), alto: cabecera.readUInt32BE(20) };
}

/* ================================================================
   Principal
   ================================================================ */
const perfil = mkdtempSync(join(tmpdir(), 'chrome-termia-widgets-'));
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

  /* --- Primera carga ------------------------------------------------------ */
  console.log(`\nCargando ${URL_APP}\n`);
  await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.enviar('Page.navigate', { url: URL_APP });
  const cargada = await esperarA(cdp, `document.getElementById('resultado-C')?.textContent.trim().length > 0`, 80);
  // El service worker debe estar activo antes de usar el widget (primera instalación).
  await esperarA(cdp, `navigator.serviceWorker.getRegistration().then(r => !!r?.active)`, 80);

  console.log('Conversión');
  comprobar('La app carga con una conversión pintada', cargada,
    await cdp.evaluar(`document.getElementById('resultado-C').textContent`));

  const conversion = await cdp.evaluar(`(async () => {
    const campo = document.getElementById('temperatura');
    campo.value = '25';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return {
      F: document.getElementById('resultado-F').textContent,
      K: document.getElementById('resultado-K').textContent,
      R: document.getElementById('resultado-R').textContent,
      guardado: JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_CONVERSION)}) ?? 'null'),
    };
  })()`);
  comprobar('Escribir 25 °C actualiza las cuatro equivalencias y persiste la conversión',
    conversion.F === '77 °F' && conversion.K === '298.15 K' && conversion.R === '536.67 °R'
      && conversion.guardado?.celsius === 25 && conversion.guardado?.valorOrigen === '25',
    `${conversion.F} · ${conversion.K} · ${conversion.R}`);

  /* --- Controles de ventana ---------------------------------------------- */
  console.log('\nControles de ventana');
  const controles = await cdp.evaluar(`(() => {
    const botones = [...document.querySelectorAll('.controles-titulo [data-control-ventana]')];
    return {
      cuantos: botones.length,
      ids: botones.map(b => b.id),
      todosAccesibles: botones.every(b => b.getAttribute('aria-label') && b.title && b.querySelector('svg')),
      noDrag: botones.every(b => {
        const cs = getComputedStyle(b);
        return (cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || 'no-drag').trim() === 'no-drag';
      }),
      cabeceraDrag: (() => {
        const cs = getComputedStyle(document.querySelector('.barra-titulo'));
        return (cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region')).trim() === 'drag';
      })(),
    };
  })()`);
  comprobar('Hay seis controles accesibles (aria-label, title, icono) y no-drag',
    controles.cuantos === 6 && controles.ids.includes('control-widgets') && controles.todosAccesibles
      && controles.noDrag && controles.cabeceraDrag,
    controles.ids.join(', '));

  /* --- Panel de widgets --------------------------------------------------- */
  console.log('\nPanel de widgets');
  const manifest = await cdp.evaluar(`(async () => {
    const m = await (await fetch('./manifest.webmanifest')).json();
    const w = m.widgets?.[0] ?? {};
    const plantilla = await fetch(new URL(w.ms_ac_template, location.href));
    const datos = await fetch(new URL(w.data, location.href));
    const p = await plantilla.json();
    return {
      campos: ['name', 'short_name', 'description', 'tag', 'template', 'ms_ac_template', 'data'].every(c => typeof w[c] === 'string'),
      tag: w.tag, nombre: w.name, tipo: w.type, auth: w.auth, update: typeof w.update,
      capturas: w.screenshots?.length ?? 0, iconos: w.icons?.length ?? 0,
      plantillaOk: plantilla.ok && p.type === 'AdaptiveCard',
      verbos: (p.actions ?? []).filter(a => a.type === 'Action.Execute').map(a => a.verb),
      datosOk: datos.ok && typeof (await datos.json()).celsius === 'number',
    };
  })()`);
  comprobar('El manifest declara el widget con todos los campos requeridos',
    manifest.campos && manifest.tag === TAG && manifest.tipo === 'application/json' && manifest.auth === false
      && manifest.update === 'number' && manifest.capturas >= 1 && manifest.iconos >= 1,
    `${manifest.nombre} · tag ${manifest.tag}`);
  comprobar('La plantilla y los datos responden 200 con JSON válido y verbos ±1 °C',
    manifest.plantillaOk && manifest.datosOk && manifest.verbos.includes('subir') && manifest.verbos.includes('bajar'),
    `verbos: ${manifest.verbos.join(', ')}`);

  const apertura = await cdp.evaluar(`(async () => {
    const boton = document.getElementById('control-widgets');
    boton.focus();
    boton.click();
    await new Promise(r => setTimeout(r, 300));
    const d = document.getElementById('panel-widgets');
    return {
      abierto: !!d?.open,
      focoEnCerrar: document.activeElement?.classList.contains('pw-cerrar') ?? false,
      labelledby: d?.getAttribute('aria-labelledby'),
      titulo: document.getElementById('pw-titulo')?.textContent,
      aviso: document.querySelector('#panel-widgets .pw-aviso')?.textContent ?? '',
      enlaceDoc: document.querySelector('#panel-widgets .pw-aviso a')?.href ?? '',
      vacio: !document.querySelector('#panel-widgets .pw-vacio')?.hidden,
    };
  })()`);
  comprobar('El control Widgets abre el panel con el foco en Cerrar',
    apertura.abierto && apertura.focoEnCerrar && apertura.labelledby === 'pw-titulo' && apertura.titulo === 'Widgets',
    `foco en cerrar: ${apertura.focoEnCerrar} · vacío visible: ${apertura.vacio}`);
  comprobar('El aviso explica la simulación y enlaza a la documentación de Edge',
    /Simulación del Panel de widgets de Windows 11/.test(apertura.aviso)
      && apertura.enlaceDoc.startsWith('https://learn.microsoft.com/es-es/microsoft-edge/progressive-web-apps/how-to/widgets'));

  const selector = await cdp.evaluar(`(async () => {
    document.querySelector('#panel-widgets .pw-agregar-boton').click();
    await new Promise(r => setTimeout(r, 200));
    const opciones = [...document.querySelectorAll('#panel-widgets .pw-opcion')];
    return {
      vista: document.querySelector('#panel-widgets .pw-vista').dataset.vista,
      cuantas: opciones.length,
      nombres: opciones.map(o => o.querySelector('.pw-opcion__nombre')?.textContent),
      descripcion: opciones[0]?.querySelector('.pw-opcion__descripcion')?.textContent ?? '',
      captura: !!opciones[0]?.querySelector('.pw-opcion__captura'),
      focoEnAgregar: document.activeElement?.classList.contains('pw-opcion__agregar') ?? false,
    };
  })()`);
  comprobar('El selector lista el widget del manifest con nombre, descripción y captura',
    selector.vista === 'agregar' && selector.cuantas >= 1 && selector.nombres.includes(manifest.nombre)
      && selector.descripcion.length > 0 && selector.captura && selector.focoEnAgregar,
    selector.nombres.join(', '));

  await cdp.evaluar(`document.querySelector('#panel-widgets .pw-opcion__agregar').click()`);
  const textosTarjeta = `[...document.querySelectorAll('#panel-widgets .pw-tarjeta .ac-texto, #panel-widgets .pw-tarjeta .ac-hecho dd')].map(e => e.textContent)`;
  const pintada = await esperarA(cdp, `${textosTarjeta}.some(t => t === '25 °C')`, 40);
  const tarjeta = await cdp.evaluar(`(() => {
    const textos = ${textosTarjeta};
    const t = document.querySelector('#panel-widgets .pw-tarjeta');
    return {
      textos,
      grupo: t?.getAttribute('role') === 'group' && !!t?.getAttribute('aria-label'),
      foco: document.activeElement === t,
      quitar: !!t?.querySelector('.pw-quitar[aria-label]'),
      estado: t?.querySelector('.ac-texto[data-size="medium"]')?.textContent,
      anuncio: document.getElementById('estado-pwa').textContent,
      acciones: [...t?.querySelectorAll('.ac-accion') ?? []].map(a => a.dataset.verb ?? a.getAttribute('href')),
      enlaceSeguro: (() => { const a = t?.querySelector('.ac-accion--enlace'); return !!a && a.rel.includes('noopener') && new URL(a.href).pathname === new URL(${JSON.stringify(URL_APP)}).pathname; })(),
      instalados: JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_INSTALADOS)}) ?? '[]'),
    };
  })()`);
  const tiene = (texto) => tarjeta.textos.includes(texto);
  const origen = tarjeta.textos.find((t) => t.startsWith('Origen:')) ?? '';
  comprobar('Agregar el widget pinta la tarjeta con las cuatro unidades de 25 °C',
    pintada && tiene('25 °C') && tiene('77 °F') && tiene('298.15 K') && tiene('536.67 °R') && tarjeta.estado === 'Templado'
      && origen.includes('Origen: 25 °C'),
    tarjeta.textos.filter(t => /°C|°F|K$|°R/.test(t)).join(' · '));
  comprobar('La tarjeta es un grupo accesible, recibe el foco y se anuncia «Widget agregado»',
    tarjeta.grupo && tarjeta.foco && tarjeta.quitar && /Widget agregado/.test(tarjeta.anuncio) && tarjeta.instalados.includes(TAG),
    tarjeta.anuncio);
  comprobar('Las acciones son dos Action.Execute (bajar/subir) y un enlace seguro a la app',
    tarjeta.acciones[0] === 'bajar' && tarjeta.acciones[1] === 'subir' && tarjeta.enlaceSeguro,
    tarjeta.acciones.join(' · '));

  await cdp.evaluar(`document.querySelector('#panel-widgets .pw-tarjeta .ac-accion[data-verb="subir"]').click()`);
  const subio = await esperarA(cdp, `${textosTarjeta}.some(t => t === '26 °C')`, 24, 125);
  const trasSubir = await cdp.evaluar(`({
    textos: ${textosTarjeta},
    anuncio: document.getElementById('estado-pwa').textContent,
    entrada: document.getElementById('temperatura').value,
    guardado: JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_CONVERSION)}) ?? 'null')?.celsius,
  })`);
  comprobar('«+1 °C» recorre página → SW → página y re-renderiza con 26 °C',
    subio && trasSubir.textos.includes('26 °C') && trasSubir.textos.includes('299.15 K') && trasSubir.textos.includes('78.8 °F'),
    trasSubir.textos.filter(t => /°C|K$/.test(t)).join(' · '));
  comprobar('La acción se anuncia y sincroniza formulario y localStorage',
    /Widget actualizado/.test(trasSubir.anuncio) && trasSubir.entrada === '26' && trasSubir.guardado === 26,
    `${trasSubir.anuncio} · entrada ${trasSubir.entrada}`);

  await cdp.evaluar(`document.querySelector('#panel-widgets .pw-tarjeta .ac-accion[data-verb="bajar"]').click()`);
  const bajo = await esperarA(cdp, `${textosTarjeta}.some(t => t === '25 °C')`, 24, 125);
  comprobar('«−1 °C» vuelve a 25 °C', bajo);

  /* --- Vectores del resolvedor (los mismos que tests/widgets.test.mjs) --- */
  const vectores = await cdp.evaluar(`(async () => {
    const m = await import('./js/widgets.js');
    const d = { a: { b: [{ c: 'x' }, { c: 7 }] }, n: 5, s: 'demo', v: true, f: false, z: 0, nulo: null };
    const casos = [
      [m.enlazarTexto('\${a.b[1].c}', d), '7'],
      [m.enlazarTexto('Valor: \${a.b[0].c}!', d), 'Valor: x!'],
      [m.enlazarTexto('\${no.existe}', d), ''],
      [m.enlazarTexto('\${a.b[5].c} fin', d), ' fin'],
      [m.enlazarTexto("\${if(s == 'demo', 'Demo', 'Vivo')}", d), 'Demo'],
      [m.enlazarTexto("\${if(n > 3, 'mayor', 'menor')}", d), 'mayor'],
      [m.enlazarTexto("\${if(v, 'sí', 'no')}", d), 'sí'],
      [m.enlazarTexto("\${if(f, 'sí', 'no')}", d), 'no'],
      [m.enlazarTexto("\${if(z, 'sí', 'no')}", d), 'no'],
      [m.enlazarTexto("\${if(nulo == null, 'nulo', 'algo')}", d), 'nulo'],
      [m.enlazarTexto("\${if(no.existe == null, 'nulo', 'algo')}", d), 'nulo'],
      [m.enlazarTexto("\${if(n == '5', 'igual', 'dif')}", d), 'igual'],
      [m.enlazarTexto("\${if(s == 'a, b', 'coma', 'sin')}", d), 'sin'],
      [m.enlazarTexto('\${n} y \${s}', d), '5 y demo'],
      [m.enlazarTexto('sin expresiones', d), 'sin expresiones'],
      [m.enlazarTexto('\${', d), '\${'],
      [m.resolverExpresion('a.b[1].c', d), 7],
      [m.resolverExpresion('if(n >= 5, n, 0)', d), 5],
      [m.resolverExpresion("'lit'", d) === 'lit' && m.resolverExpresion('3.5', d) === 3.5 && m.resolverExpresion('true', d) === true, true],
      [m.resolverExpresion('expresion invalida ++', d), null],
    ];
    const original = { type: 'TextBlock', text: '\${s}', items: [{ text: '\${n}' }], wrap: true };
    const copia = JSON.stringify(original);
    const enlazada = m.enlazarPlantilla(original, d);
    casos.push([JSON.stringify(enlazada) === JSON.stringify({ type: 'TextBlock', text: 'demo', items: [{ text: '5' }], wrap: true }) && JSON.stringify(original) === copia, true]);
    let desconocido = '';
    try {
      const nodo = m.renderizarTarjeta({ type: 'AdaptiveCard', body: [{ type: 'Desconocido' }] }, {}, { t: (c, v) => m.TEXTOS[c].replace('{tipo}', v.tipo) });
      desconocido = nodo.querySelector('.ac-desconocido')?.textContent ?? '';
    } catch (e) { desconocido = 'EXCEPCIÓN ' + e.message; }
    casos.push([desconocido, 'Elemento no soportado: Desconocido']);
    const fallos = casos.map((c, i) => [i + 1, c]).filter(([, [real, esperado]]) => real !== esperado);
    return { total: casos.length, ok: casos.length - fallos.length, fallos: fallos.map(([i, [real, esperado]]) => \`#\${i}: \${JSON.stringify(real)} ≠ \${JSON.stringify(esperado)}\`) };
  })()`);
  comprobar('Los 22 vectores del resolvedor pasan', vectores.ok === vectores.total && vectores.total === 22,
    `${vectores.ok}/${vectores.total}${vectores.fallos.length ? ' · ' + vectores.fallos.join(' · ') : ''}`);

  /* --- Captura del widget para el manifest y capturas de revisión ---------- */
  console.log('\nCapturas');
  await espera(300);
  const rect = await cdp.evaluar(`(() => { const r = document.querySelector('#panel-widgets .pw-tarjeta').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const capturaWidget = await cdp.enviar('Page.captureScreenshot', {
    format: 'png', clip: { x: rect.x, y: rect.y, width: 320, height: 300, scale: 2 },
  });
  const rutaCaptura = join(RAIZ, 'widgets', 'conversion-rapida-captura.png');
  writeFileSync(rutaCaptura, Buffer.from(capturaWidget.data, 'base64'));
  const dimensiones = dimensionesPng(rutaCaptura);
  const sizesManifest = await cdp.evaluar(`fetch('./manifest.webmanifest').then(r => r.json()).then(m => m.widgets[0].screenshots[0].sizes)`);
  comprobar('La captura del widget mide 640×600, coincide con el manifest y no supera 1024 px',
    dimensiones.ancho === 640 && dimensiones.alto === 600 && sizesManifest === '640x600' && dimensiones.ancho <= 1024 && dimensiones.alto <= 1024,
    `${dimensiones.ancho}×${dimensiones.alto} · tarjeta ${Math.round(rect.w)}×${Math.round(rect.h)} px · manifest ${sizesManifest}`);

  for (const [archivo, ancho, alto, movil] of [
    ['/tmp/termia-pwa-widgets-escritorio.png', 1280, 900, false],
    ['/tmp/termia-pwa-widgets-movil.png', 412, 915, true],
  ]) {
    await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: movil });
    await espera(500);
    const captura = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
    writeFileSync(archivo, Buffer.from(captura.data, 'base64'));
    comprobar(`Captura de revisión ${archivo}`, true, `${ancho}×${alto}`);
  }
  const desbordes = await cdp.evaluar(`(() => {
    const panel = document.getElementById('panel-widgets');
    const limite = panel.getBoundingClientRect();
    const fuera = [...panel.querySelectorAll('.pw-tarjeta, .pw-cerrar, .pw-agregar-boton, .ac-accion')]
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.right > limite.right + 1 || r.left < limite.left - 1 || r.width === 0)
      .map(({ e }) => e.className);
    return { fuera, ancho: Math.round(limite.width), scrollH: panel.querySelector('.pw-vista').scrollWidth <= panel.querySelector('.pw-vista').clientWidth + 1 };
  })()`);
  comprobar('En 412 px nada se sale del panel ni hay desplazamiento horizontal',
    desbordes.fuera.length === 0 && desbordes.scrollH, `panel ${desbordes.ancho} px${desbordes.fuera.length ? ' · fuera: ' + desbordes.fuera.join(', ') : ''}`);
  await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await espera(300);

  // Vista «Agregar widgets» (selector) en escritorio y móvil, solo para revisión visual.
  await cdp.evaluar(`document.querySelector('#panel-widgets .pw-agregar-boton').click()`);
  await espera(300);
  for (const [archivo, ancho, alto, movil] of [
    ['/tmp/termia-pwa-widgets-selector.png', 1280, 900, false],
    ['/tmp/termia-pwa-widgets-selector-movil.png', 412, 915, true],
  ]) {
    await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: movil });
    await espera(400);
    const captura = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
    writeFileSync(archivo, Buffer.from(captura.data, 'base64'));
    comprobar(`Captura de revisión ${archivo}`, true, `${ancho}×${alto}`);
  }
  const selectorOk = await cdp.evaluar(`(async () => {
    const opcion = document.querySelector('#panel-widgets .pw-opcion');
    const panel = document.getElementById('panel-widgets').getBoundingClientRect();
    const r = opcion.getBoundingClientRect();
    const dentro = r.right <= panel.right + 1 && r.left >= panel.left - 1;
    const yaAgregado = opcion.querySelector('.pw-opcion__agregar').disabled;
    document.querySelector('#panel-widgets .pw-volver').click();
    await new Promise(res => setTimeout(res, 150));
    return { dentro, yaAgregado, vista: document.querySelector('#panel-widgets .pw-vista').dataset.vista, foco: document.activeElement?.classList.contains('pw-agregar-boton') };
  })()`);
  comprobar('El selector marca el widget ya agregado y «Volver al panel» devuelve el foco',
    selectorOk.dentro && selectorOk.yaAgregado && selectorOk.vista === 'panel' && selectorOk.foco);
  await cdp.enviar('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await espera(300);

  // El panel debe verse bien en ambos temas: se alterna el tema, se captura y se restaura.
  const temaInicial = await cdp.evaluar(`document.documentElement.dataset.tema`);
  await cdp.evaluar(`document.getElementById('control-tema').click()`);
  await espera(400);
  const temaAlterno = await cdp.evaluar(`document.documentElement.dataset.tema`);
  const capturaTema = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`/tmp/termia-pwa-widgets-tema-${temaAlterno}.png`, Buffer.from(capturaTema.data, 'base64'));
  await cdp.evaluar(`document.getElementById('control-tema').click()`);
  await espera(300);
  comprobar(`Captura de revisión /tmp/termia-pwa-widgets-tema-${temaAlterno}.png`,
    temaAlterno !== temaInicial && (await cdp.evaluar(`document.documentElement.dataset.tema`)) === temaInicial,
    `tema ${temaInicial} → ${temaAlterno} → ${temaInicial}`);

  /* --- Botón de cerrar ------------------------------------------------------ */
  const cierre = await cdp.evaluar(`(async () => {
    const d = document.getElementById('panel-widgets');
    const btn = d.querySelector('.pw-cerrar');
    const caja = btn.getBoundingClientRect();
    const esquina = document.elementFromPoint(caja.left + 3, caja.top + 3);
    const r = { w: Math.round(caja.width), h: Math.round(caja.height), esquinaPulsable: esquina === btn || btn.contains(esquina) };
    btn.click();
    await new Promise(res => setTimeout(res, 200));
    r.cerro = !d.open;
    r.focoVolvio = document.activeElement?.id === 'control-widgets';
    return r;
  })()`);
  comprobar('El botón de cerrar mide ≥ 44 px, su esquina es pulsable y devuelve el foco al control',
    cierre.w >= 44 && cierre.h >= 44 && cierre.esquinaPulsable && cierre.cerro && cierre.focoVolvio,
    `${cierre.w}×${cierre.h} · esquina ${cierre.esquinaPulsable ? 'ok' : 'MUERTA'} · cerró ${cierre.cerro} · foco devuelto ${cierre.focoVolvio}`);

  const reabierto = await cdp.evaluar(`(async () => {
    document.getElementById('control-widgets').click();
    await new Promise(res => setTimeout(res, 200));
    return document.getElementById('panel-widgets').open;
  })()`);
  // Escape real (teclado) para comprobar el cierre nativo del <dialog>.
  await cdp.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.enviar('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await espera(200);
  const trasEscape = await cdp.evaluar(`({ abierto: document.getElementById('panel-widgets').open, foco: document.activeElement?.id })`);
  comprobar('Escape cierra el panel y devuelve el foco al control',
    reabierto && !trasEscape.abierto && trasEscape.foco === 'control-widgets',
    `abierto antes: ${reabierto} · abierto después: ${trasEscape.abierto} · foco: ${trasEscape.foco}`);

  /* --- Persistencia tras recargar ------------------------------------------ */
  console.log('\nPersistencia');
  await cdp.enviar('Page.navigate', { url: URL_APP });
  await esperarA(cdp, `document.getElementById('resultado-C')?.textContent.trim().length > 0 && document.getElementById('panel-widgets') !== null`, 80);
  const persistencia = await cdp.evaluar(`(async () => {
    const entrada = document.getElementById('temperatura').value;
    const instalados = JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_INSTALADOS)}) ?? '[]');
    document.getElementById('control-widgets').click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (${textosTarjeta}.some(t => t === '25 °C')) break;
    }
    return {
      entrada, instalados,
      tarjetas: document.querySelectorAll('#panel-widgets .pw-tarjeta').length,
      textos: ${textosTarjeta},
      sinError: !document.querySelector('#panel-widgets .pw-estado--error'),
    };
  })()`);
  comprobar('La conversión (25 °C) y el widget instalado persisten tras recargar',
    persistencia.entrada === '25' && persistencia.instalados.includes(TAG) && persistencia.tarjetas === 1
      && persistencia.textos.includes('25 °C') && persistencia.sinError,
    `entrada ${persistencia.entrada} · ${persistencia.tarjetas} tarjeta · ${persistencia.textos.filter(t => /°C/.test(t)).join(', ')}`);

  const quitado = await cdp.evaluar(`(async () => {
    document.querySelector('#panel-widgets .pw-quitar').click();
    await new Promise(r => setTimeout(r, 200));
    const r = {
      tarjetas: document.querySelectorAll('#panel-widgets .pw-tarjeta').length,
      vacio: !document.querySelector('#panel-widgets .pw-vacio').hidden,
      anuncio: document.getElementById('estado-pwa').textContent,
      instalados: JSON.parse(localStorage.getItem(${JSON.stringify(CLAVE_INSTALADOS)}) ?? '[]'),
      foco: document.activeElement?.classList.contains('pw-agregar-boton'),
    };
    // Se vuelve a agregar para dejar el estado instalado (como un usuario real).
    document.querySelector('#panel-widgets .pw-agregar-boton').click();
    await new Promise(res => setTimeout(res, 150));
    document.querySelector('#panel-widgets .pw-opcion__agregar').click();
    await new Promise(res => setTimeout(res, 150));
    document.getElementById('panel-widgets').close();
    return r;
  })()`);
  comprobar('Quitar el widget vacía el panel, lo anuncia y actualiza localStorage',
    quitado.tarjetas === 0 && quitado.vacio && /Widget quitado/.test(quitado.anuncio) && !quitado.instalados.includes(TAG) && quitado.foco,
    quitado.anuncio);

  /* --- Service worker ------------------------------------------------------- */
  console.log('\nService worker');
  const sw = await cdp.evaluar(`(async () => {
    await navigator.serviceWorker.ready;
    const nombres = await caches.keys();
    const estatico = nombres.find(n => n === ${JSON.stringify(CACHE_ESTATICO)});
    const claves = estatico ? (await (await caches.open(estatico)).keys()).map(k => new URL(k.url).pathname) : [];
    return { nombres, claves, cuantos: claves.length };
  })()`);
  comprobar(`El service worker ${VERSION_SW} precachea el widget y el módulo del simulador`,
    sw.nombres.includes(CACHE_ESTATICO)
      && ['/widgets/conversion-rapida-plantilla.json', '/widgets/conversion-rapida-datos.json', '/widgets/conversion-rapida-captura.png', '/js/widgets.js']
        .every(ruta => sw.claves.some(c => c.endsWith(ruta))),
    `${sw.cuantos} recursos · caches: ${sw.nombres.join(', ')}`);

  /* --- Offline --------------------------------------------------------------- */
  console.log('\nOffline');
  await cdp.enviar('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await cdp.enviar('Page.reload', { ignoreCache: false });
  const cargoOffline = await esperarA(cdp, `document.getElementById('resultado-C')?.textContent.trim().length > 0 && document.getElementById('panel-widgets') !== null`, 60);
  const offline = await cdp.evaluar(`(async () => {
    document.getElementById('control-widgets').click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (${textosTarjeta}.some(t => /°C$/.test(t))) break;
    }
    const r = { textos: ${textosTarjeta}, sinError: !document.querySelector('#panel-widgets .pw-estado--error') };
    document.getElementById('panel-widgets').close();
    return r;
  })()`);
  comprobar('El panel de widgets también funciona sin red',
    cargoOffline && offline.sinError && offline.textos.some(t => /°C$/.test(t)),
    offline.textos.filter(t => /°C$/.test(t)).join(', '));
  await cdp.enviar('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

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
