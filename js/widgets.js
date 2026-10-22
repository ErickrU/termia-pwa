/**
 * Panel de widgets: simulador del Widgets Board de Windows 11 para macOS y
 * renderizador minimo de Adaptive Cards.
 *
 * El mismo modulo vive en las tres PWA del curso (ranking-lan, calculadora de
 * varillas y Termia) con logica identica. No depende de nada y no toca
 * `document`, `window` ni `navigator` en el nivel superior, asi puede
 * importarse en Node para probar la logica pura (resolvedor de expresiones y
 * enlace de plantillas).
 *
 * Contrato de mensajes pagina <-> service worker:
 *   pagina -> SW  { tipo: 'WIDGET_DATOS', tag, datos }   publica datos nuevos
 *   pagina -> SW  { tipo: 'WIDGET_DATOS', tag }          consulta los datos actuales
 *   pagina -> SW  { tipo: 'WIDGET_ACCION', tag, verb }   ejecuta un Action.Execute
 *   SW -> pagina  { tipo: 'WIDGET_ACTUALIZADO', tag, datos }
 *
 * Reglas: nunca se inyecta HTML como texto ni se escriben atributos `style`
 * (la CSP de produccion es `style-src 'self'`); solo `createElement`,
 * `textContent`, `dataset` y asignaciones CSSOM puntuales.
 */

export const MENSAJES = Object.freeze({
  DATOS: 'WIDGET_DATOS',
  ACCION: 'WIDGET_ACCION',
  ACTUALIZADO: 'WIDGET_ACTUALIZADO'
});

export const TEXTOS = Object.freeze({
  titulo: 'Widgets',
  panelAria: 'Panel de widgets',
  cerrar: 'Cerrar panel de widgets',
  agregar: '+ Agregar widget',
  agregarTitulo: 'Agregar widgets',
  agregarAccion: 'Agregar',
  yaAgregado: 'Ya está en el panel',
  quitar: 'Quitar widget',
  volver: 'Volver al panel',
  agregado: 'Widget agregado',
  quitado: 'Widget quitado',
  actualizado: 'Widget actualizado',
  vacio: 'No tienes widgets. Usa «+ Agregar widget» para añadir uno.',
  cargando: 'Cargando widget…',
  error: 'No se pudo cargar el widget.',
  sinSw: 'Sin service worker: las acciones del widget no están disponibles.',
  noSoportado: 'Elemento no soportado: {tipo}',
  simulacion: 'Simulación del Panel de widgets de Windows 11. En Microsoft Edge para Windows estos widgets se instalan en el panel del sistema.',
  masInfo: 'Más información'
});

const URL_DOCUMENTACION = 'https://learn.microsoft.com/es-es/microsoft-edge/progressive-web-apps/how-to/widgets';
const PLAZO_SW_LISTO = 3000;
const PLAZO_RESPUESTA_SW = 4000;
const INTERVALO_MINIMO_S = 15;

/* ================================================================
   Utilidades
   ================================================================ */

/** Sustituye `{nombre}` por `vars.nombre`; deja intactos los que no existan. */
function interpolar(texto, vars = {}) {
  return String(texto).replace(/\{(\w+)\}/g, (coincidencia, nombre) => (
    Object.hasOwn(vars, nombre) ? String(vars[nombre]) : coincidencia
  ));
}

/** Traductor por defecto: diccionario español del modulo. */
function traducirPorDefecto(clave, vars) {
  return interpolar(TEXTOS[clave] ?? clave, vars);
}

/** Convierte cualquier valor a texto; `null`/`undefined` quedan vacios. */
function aTexto(valor) {
  return valor === null || valor === undefined ? '' : String(valor);
}

/** Devuelve la URL absoluta solo si es http(s); si no, `null`. */
function urlSegura(ruta, base) {
  if (typeof ruta !== 'string' || ruta === '') return null;
  try {
    const url = new URL(ruta, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/* ================================================================
   Resolvedor de expresiones `${...}`
   ================================================================ */

const RE_RUTA = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const RE_SEGMENTO = /([A-Za-z_$][\w$]*)|\[(\d+)\]/g;
const RE_NUMERO = /^-?\d+(?:\.\d+)?$/;
const RE_IF = /^if\((.*)\)$/s;
const OPERADORES = ['==', '!=', '<=', '>=', '<', '>'];
const expresionesAvisadas = new Set();

/** Avisa una sola vez por expresion distinta; nunca lanza. */
function avisarExpresion(expresion) {
  if (expresionesAvisadas.has(expresion)) return;
  expresionesAvisadas.add(expresion);
  console.warn(`[widgets] Expresión no reconocida: ${expresion}`);
}

/** Literal simple: 'texto', "texto", numero, true, false o null. */
function resolverLiteral(expresion) {
  if (expresion.length >= 2) {
    const primera = expresion[0];
    const ultima = expresion[expresion.length - 1];
    if ((primera === '\'' || primera === '"') && ultima === primera) {
      const interior = expresion.slice(1, -1);
      if (!interior.includes(primera)) return { valor: interior };
    }
  }
  if (RE_NUMERO.test(expresion)) return { valor: Number(expresion) };
  if (expresion === 'true') return { valor: true };
  if (expresion === 'false') return { valor: false };
  if (expresion === 'null') return { valor: null };
  return null;
}

/** Recorre `datos` por una ruta `a.b[0].c`; cualquier eslabon ausente => null. */
function recorrerRuta(ruta, datos) {
  let actual = datos;
  RE_SEGMENTO.lastIndex = 0;
  let segmento;
  while ((segmento = RE_SEGMENTO.exec(ruta)) !== null) {
    if (actual === null || actual === undefined || typeof actual !== 'object') return null;
    const clave = segmento[1] !== undefined ? segmento[1] : Number(segmento[2]);
    if (!Object.hasOwn(actual, clave)) return null;
    actual = actual[clave];
  }
  return actual === undefined ? null : actual;
}

/** Separa argumentos por comas de nivel superior (fuera de comillas y parentesis). */
function separarArgumentos(texto) {
  const partes = [];
  let actual = '';
  let comilla = null;
  let profundidad = 0;
  for (const caracter of texto) {
    if (comilla) {
      actual += caracter;
      if (caracter === comilla) comilla = null;
    } else if (caracter === '\'' || caracter === '"') {
      comilla = caracter;
      actual += caracter;
    } else if (caracter === '(') {
      profundidad += 1;
      actual += caracter;
    } else if (caracter === ')') {
      profundidad -= 1;
      actual += caracter;
    } else if (caracter === ',' && profundidad === 0) {
      partes.push(actual.trim());
      actual = '';
    } else {
      actual += caracter;
    }
  }
  partes.push(actual.trim());
  return partes;
}

/** Busca el primer operador de comparacion fuera de comillas. */
function buscarOperador(condicion) {
  let comilla = null;
  for (let i = 0; i < condicion.length; i += 1) {
    const caracter = condicion[i];
    if (comilla) {
      if (caracter === comilla) comilla = null;
      continue;
    }
    if (caracter === '\'' || caracter === '"') {
      comilla = caracter;
      continue;
    }
    for (const operador of OPERADORES) {
      if (condicion.startsWith(operador, i)) return { operador, indice: i };
    }
  }
  return null;
}

function sonIguales(a, b) {
  return a === b || String(a) === String(b);
}

/** Evalua `operando [op operando]`; sin operador usa la veracidad JS. */
function evaluarCondicion(condicion, datos) {
  const posicion = buscarOperador(condicion);
  if (!posicion) return Boolean(resolverExpresion(condicion, datos));

  const izquierda = resolverExpresion(condicion.slice(0, posicion.indice).trim(), datos);
  const derecha = resolverExpresion(condicion.slice(posicion.indice + posicion.operador.length).trim(), datos);
  switch (posicion.operador) {
    case '==': return sonIguales(izquierda, derecha);
    case '!=': return !sonIguales(izquierda, derecha);
    case '<': return Number(izquierda) < Number(derecha);
    case '<=': return Number(izquierda) <= Number(derecha);
    case '>': return Number(izquierda) > Number(derecha);
    case '>=': return Number(izquierda) >= Number(derecha);
    default: return false;
  }
}

/**
 * Resuelve una expresion de plantilla a su valor crudo.
 * Acepta literales, rutas (`a.b[0].c`) e `if(cond, a, b)`. Lo demas => null.
 */
export function resolverExpresion(expresion, datos) {
  if (typeof expresion !== 'string') return null;
  const texto = expresion.trim();
  if (texto === '') return null;

  try {
    const literal = resolverLiteral(texto);
    if (literal) return literal.valor;

    if (RE_RUTA.test(texto)) return recorrerRuta(texto, datos);

    const condicional = RE_IF.exec(texto);
    if (condicional) {
      const argumentos = separarArgumentos(condicional[1]);
      if (argumentos.length !== 3) {
        avisarExpresion(texto);
        return null;
      }
      return evaluarCondicion(argumentos[0], datos)
        ? resolverExpresion(argumentos[1], datos)
        : resolverExpresion(argumentos[2], datos);
    }
  } catch {
    // Una expresion rota nunca debe tumbar el renderizado.
  }

  avisarExpresion(texto);
  return null;
}

/** Sustituye cada `${...}` de un texto; devuelve SIEMPRE string si recibe string. */
export function enlazarTexto(texto, datos) {
  if (typeof texto !== 'string') return texto;
  return texto.replace(/\$\{([^{}]*)\}/g, (coincidencia, expresion) => (
    aTexto(resolverExpresion(expresion.trim(), datos))
  ));
}

/** Clon profundo de la plantilla con todos sus strings enlazados. No muta el original. */
export function enlazarPlantilla(nodo, datos) {
  if (typeof nodo === 'string') return enlazarTexto(nodo, datos);
  if (Array.isArray(nodo)) return nodo.map((elemento) => enlazarPlantilla(elemento, datos));
  if (nodo && typeof nodo === 'object') {
    const salida = {};
    for (const [clave, valor] of Object.entries(nodo)) salida[clave] = enlazarPlantilla(valor, datos);
    return salida;
  }
  return nodo;
}

/* ================================================================
   Renderizador de Adaptive Cards (DOM, clases ac-*)
   ================================================================ */

/** Escribe un valor enumerado del esquema en `data-*`, en minusculas. */
function fijarEnumerado(elemento, nombre, valor) {
  if (typeof valor === 'string' && valor !== '') elemento.dataset[nombre] = valor.toLowerCase();
}

/** `spacing` y `separator` los acepta cualquier elemento. */
function aplicarComunes(nodo, elemento) {
  fijarEnumerado(nodo, 'spacing', elemento.spacing);
  if (elemento.separator === true) nodo.dataset.separator = 'true';
}

function renderizarDesconocido(elemento, contexto) {
  const caja = contexto.documento.createElement('div');
  caja.className = 'ac-desconocido';
  caja.setAttribute('role', 'note');
  const tipo = elemento && typeof elemento === 'object' && typeof elemento.type === 'string' ? elemento.type : '?';
  caja.textContent = contexto.t('noSoportado', { tipo });
  return caja;
}

function renderizarHijos(contenedor, items, contexto) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const nodo = renderizarElemento(item, contexto);
    if (nodo) contenedor.append(nodo);
  }
}

const ELEMENTOS = {
  TextBlock(elemento, contexto) {
    const parrafo = contexto.documento.createElement('p');
    parrafo.className = 'ac-texto';
    parrafo.textContent = aTexto(elemento.text);
    fijarEnumerado(parrafo, 'size', elemento.size);
    fijarEnumerado(parrafo, 'weight', elemento.weight);
    fijarEnumerado(parrafo, 'color', elemento.color);
    fijarEnumerado(parrafo, 'align', elemento.horizontalAlignment);
    if (elemento.isSubtle === true) parrafo.dataset.subtle = 'true';
    if (elemento.wrap === false) parrafo.dataset.wrap = 'false';
    return parrafo;
  },

  Container(elemento, contexto) {
    const contenedor = contexto.documento.createElement('div');
    contenedor.className = 'ac-contenedor';
    fijarEnumerado(contenedor, 'style', elemento.style);
    renderizarHijos(contenedor, elemento.items, contexto);
    return contenedor;
  },

  ColumnSet(elemento, contexto) {
    const columnas = contexto.documento.createElement('div');
    columnas.className = 'ac-columnas';
    if (Array.isArray(elemento.columns)) {
      for (const columna of elemento.columns) {
        const nodo = renderizarElemento({ ...columna, type: 'Column' }, contexto);
        if (nodo) columnas.append(nodo);
      }
    }
    return columnas;
  },

  Column(elemento, contexto) {
    const columna = contexto.documento.createElement('div');
    columna.className = 'ac-columna';
    const ancho = elemento.width;
    if (ancho === 'auto') {
      columna.dataset.ancho = 'auto';
    } else if (typeof ancho === 'number' || (typeof ancho === 'string' && RE_NUMERO.test(ancho))) {
      columna.dataset.ancho = 'peso';
      columna.style.flexGrow = String(Number(ancho));
    } else if (typeof ancho === 'string' && /^\d+(?:\.\d+)?px$/.test(ancho)) {
      columna.dataset.ancho = 'px';
      columna.style.flexBasis = ancho;
    } else {
      columna.dataset.ancho = 'stretch';
    }
    fijarEnumerado(columna, 'valign', elemento.verticalContentAlignment);
    renderizarHijos(columna, elemento.items, contexto);
    return columna;
  },

  Image(elemento, contexto) {
    const url = urlSegura(elemento.url, contexto.base);
    if (!url) return null;
    const imagen = contexto.documento.createElement('img');
    imagen.className = 'ac-imagen';
    imagen.alt = aTexto(elemento.altText);
    imagen.src = url;
    fijarEnumerado(imagen, 'size', elemento.size);
    fijarEnumerado(imagen, 'align', elemento.horizontalAlignment);
    if (elemento.style === 'person') imagen.dataset.style = 'person';
    return imagen;
  },

  FactSet(elemento, contexto) {
    const lista = contexto.documento.createElement('dl');
    lista.className = 'ac-hechos';
    if (Array.isArray(elemento.facts)) {
      for (const hecho of elemento.facts) {
        const fila = contexto.documento.createElement('div');
        fila.className = 'ac-hecho';
        const titulo = contexto.documento.createElement('dt');
        titulo.textContent = aTexto(hecho?.title);
        const valor = contexto.documento.createElement('dd');
        valor.textContent = aTexto(hecho?.value);
        fila.append(titulo, valor);
        lista.append(fila);
      }
    }
    return lista;
  }
};

/** Renderiza un elemento del cuerpo; cualquier fallo se sustituye por `.ac-desconocido`. */
function renderizarElemento(elemento, contexto) {
  try {
    if (!elemento || typeof elemento !== 'object' || typeof elemento.type !== 'string') {
      return renderizarDesconocido(elemento, contexto);
    }
    const fabrica = ELEMENTOS[elemento.type];
    if (!fabrica) return renderizarDesconocido(elemento, contexto);
    const nodo = fabrica(elemento, contexto);
    if (nodo) aplicarComunes(nodo, elemento);
    return nodo;
  } catch (error) {
    console.warn('[widgets] Elemento no renderizable', error);
    return renderizarDesconocido(elemento, contexto);
  }
}

function renderizarAccion(accion, contexto) {
  const { documento } = contexto;
  try {
    if (accion?.type === 'Action.Execute') {
      const boton = documento.createElement('button');
      boton.type = 'button';
      boton.className = 'ac-accion';
      boton.textContent = aTexto(accion.title);
      if (typeof accion.verb === 'string') boton.dataset.verb = accion.verb;
      fijarEnumerado(boton, 'style', accion.style);
      boton.addEventListener('click', () => {
        if (typeof contexto.alEjecutar === 'function') contexto.alEjecutar(accion.verb, accion);
      });
      return boton;
    }

    if (accion?.type === 'Action.OpenUrl') {
      const url = urlSegura(accion.url, contexto.base);
      if (url) {
        const enlace = documento.createElement('a');
        enlace.className = 'ac-accion ac-accion--enlace';
        enlace.href = url;
        enlace.target = '_blank';
        enlace.rel = 'noopener noreferrer';
        enlace.textContent = aTexto(accion.title);
        fijarEnumerado(enlace, 'style', accion.style);
        return enlace;
      }
      const boton = documento.createElement('button');
      boton.type = 'button';
      boton.className = 'ac-accion';
      boton.disabled = true;
      boton.textContent = aTexto(accion.title);
      return boton;
    }

    const boton = documento.createElement('button');
    boton.type = 'button';
    boton.className = 'ac-accion';
    boton.disabled = true;
    boton.textContent = aTexto(accion?.title);
    boton.title = contexto.t('noSoportado', { tipo: aTexto(accion?.type) || '?' });
    return boton;
  } catch (error) {
    console.warn('[widgets] Acción no renderizable', error);
    return null;
  }
}

/**
 * Convierte una Adaptive Card (enlazada o no) en un `div.ac-tarjeta`.
 * `opciones`: { alEjecutar(verb, accion), base, t }.
 */
export function renderizarTarjeta(plantilla, datos, opciones = {}) {
  const documento = globalThis.document;
  const contexto = {
    documento,
    alEjecutar: opciones.alEjecutar,
    base: opciones.base ?? globalThis.location?.href,
    t: typeof opciones.t === 'function' ? opciones.t : traducirPorDefecto
  };
  const tarjeta = datos ? enlazarPlantilla(plantilla, datos) : plantilla;

  const raiz = documento.createElement('div');
  raiz.className = 'ac-tarjeta';

  const cuerpo = documento.createElement('div');
  cuerpo.className = 'ac-cuerpo';
  renderizarHijos(cuerpo, tarjeta?.body, contexto);
  raiz.append(cuerpo);

  if (Array.isArray(tarjeta?.actions) && tarjeta.actions.length > 0) {
    const acciones = documento.createElement('div');
    acciones.className = 'ac-acciones';
    for (const accion of tarjeta.actions) {
      const nodo = renderizarAccion(accion, contexto);
      if (nodo) acciones.append(nodo);
    }
    raiz.append(acciones);
  }

  return raiz;
}

/* ================================================================
   Mensajeria pagina -> service worker
   ================================================================ */

function haySw() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Publica en el SW los datos mas recientes del widget (silencioso sin SW). */
export function enviarDatosWidget(tag, datos) {
  if (!haySw()) return;
  navigator.serviceWorker.ready
    .then((registro) => registro.active?.postMessage({ tipo: MENSAJES.DATOS, tag, datos }))
    .catch(() => {});
}

/** Suscribe `callback(datos)` a los WIDGET_ACTUALIZADO de un tag; devuelve la baja. */
export function alActualizarWidget(tag, callback) {
  if (!haySw()) return () => {};
  const escucha = (evento) => {
    const mensaje = evento.data;
    if (mensaje?.tipo !== MENSAJES.ACTUALIZADO || mensaje.tag !== tag) return;
    if (mensaje.datos && typeof mensaje.datos === 'object') callback(mensaje.datos);
  };
  navigator.serviceWorker.addEventListener('message', escucha);
  return () => navigator.serviceWorker.removeEventListener('message', escucha);
}

/* ================================================================
   Panel (simulador del Widgets Board)
   ================================================================ */

/** Crea un elemento con atributos e hijos construyendo el DOM nodo a nodo. */
function crear(documento, etiqueta, atributos = {}, hijos = []) {
  const elemento = documento.createElement(etiqueta);
  for (const [nombre, valor] of Object.entries(atributos)) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (nombre === 'className') elemento.className = valor;
    else if (nombre === 'textContent') elemento.textContent = valor;
    else elemento.setAttribute(nombre, valor === true ? '' : String(valor));
  }
  for (const hijo of hijos) if (hijo) elemento.append(hijo);
  return elemento;
}

/** Promesa con plazo maximo; al vencer resuelve `null`. */
function conPlazo(promesa, ms) {
  return new Promise((resolver) => {
    const temporizador = setTimeout(() => resolver(null), ms);
    Promise.resolve(promesa).then(
      (valor) => { clearTimeout(temporizador); resolver(valor); },
      () => { clearTimeout(temporizador); resolver(null); }
    );
  });
}

/**
 * Construye el `<dialog>` del panel, lo conecta al boton de la barra de titulo
 * y devuelve { abrir, cerrar, retraducir, destruir }.
 */
export function crearPanelWidgets(opciones = {}) {
  const documento = globalThis.document;
  const boton = opciones.boton ?? null;
  const anunciar = typeof opciones.anunciar === 'function' ? opciones.anunciar : () => {};
  const t = typeof opciones.t === 'function' ? opciones.t : traducirPorDefecto;
  const claveAlmacen = opciones.claveAlmacen ?? 'widgets-instalados';
  const urlManifest = new URL(
    opciones.urlManifest ?? documento.querySelector('link[rel="manifest"]')?.href ?? './manifest.webmanifest',
    documento.baseURI
  ).href;

  /* --- Estado ----------------------------------------------------------- */
  let manifest = null;
  let widgets = [];
  let cargaManifest = null;
  let focoAnterior = null;
  const plantillas = new Map();      // url -> Promise<plantilla>
  const ultimosDatos = new Map();    // tag -> datos
  const pendientes = new Map();      // tag -> { promesa, resolver }
  const tarjetas = new Map();        // tag -> { widget, articulo, cuerpo, plantilla }
  const temporizadores = new Map();  // tag -> id de setInterval
  const accionesEnCurso = new Set(); // tags con un verbo enviado al SW

  /* --- Persistencia ------------------------------------------------------- */
  function leerInstalados() {
    try {
      const lista = JSON.parse(localStorage.getItem(claveAlmacen) ?? '[]');
      return Array.isArray(lista) ? lista.filter((tag) => typeof tag === 'string') : [];
    } catch {
      return [];
    }
  }

  function guardarInstalados(lista) {
    try {
      localStorage.setItem(claveAlmacen, JSON.stringify(lista));
    } catch {
      // Modo privado o cuota agotada: el panel sigue funcionando en memoria.
    }
  }

  /* --- Estructura del dialogo ------------------------------------------- */
  const icono = crear(documento, 'img', { className: 'pw-icono', alt: '', width: '28', height: '28', hidden: true });
  icono.addEventListener('error', () => { icono.hidden = true; });
  const titulo = crear(documento, 'h2', { className: 'pw-titulo', id: 'pw-titulo', textContent: t('titulo') });
  const botonCerrar = crear(documento, 'button', { className: 'pw-cerrar', type: 'button', 'aria-label': t('cerrar'), textContent: '×' });
  const cabecera = crear(documento, 'div', { className: 'pw-cabecera' }, [icono, titulo, botonCerrar]);

  const botonAgregar = crear(documento, 'button', { className: 'pw-agregar-boton', type: 'button', textContent: t('agregar') });
  const herramientas = crear(documento, 'div', { className: 'pw-herramientas' }, [botonAgregar]);
  const rejilla = crear(documento, 'div', { className: 'pw-rejilla' });
  const vacio = crear(documento, 'p', { className: 'pw-vacio', hidden: true, textContent: t('vacio') });
  const tablero = crear(documento, 'section', { className: 'pw-tablero', 'aria-label': t('panelAria') }, [herramientas, rejilla, vacio]);

  const tituloAgregar = crear(documento, 'h3', { className: 'pw-agregar__titulo', id: 'pw-agregar-titulo', textContent: t('agregarTitulo') });
  const listaOpciones = crear(documento, 'ul', { className: 'pw-opciones' });
  const botonVolver = crear(documento, 'button', { className: 'pw-volver', type: 'button', textContent: t('volver') });
  const seccionAgregar = crear(documento, 'section', { className: 'pw-agregar', hidden: true, 'aria-labelledby': 'pw-agregar-titulo' }, [tituloAgregar, listaOpciones, botonVolver]);

  const vista = crear(documento, 'div', { className: 'pw-vista', 'data-vista': 'panel' }, [tablero, seccionAgregar]);

  const textoAviso = documento.createTextNode(`${t('simulacion')} `);
  const enlaceAviso = crear(documento, 'a', { href: URL_DOCUMENTACION, target: '_blank', rel: 'noopener noreferrer', textContent: t('masInfo') });
  const aviso = crear(documento, 'p', { className: 'pw-aviso', role: 'note' }, [textoAviso, enlaceAviso]);

  const dialogo = crear(documento, 'dialog', { className: 'pw-panel', id: 'panel-widgets', 'aria-labelledby': 'pw-titulo' }, [cabecera, vista, aviso]);
  documento.body.append(dialogo);

  /* --- Vistas ------------------------------------------------------------- */
  function mostrarVista(nombre) {
    vista.dataset.vista = nombre;
    tablero.hidden = nombre !== 'panel';
    seccionAgregar.hidden = nombre !== 'agregar';
  }

  function actualizarVacio() {
    vacio.hidden = tarjetas.size > 0;
  }

  /* --- Manifest ----------------------------------------------------------- */
  function cargarManifest() {
    if (!cargaManifest) {
      cargaManifest = fetch(urlManifest)
        .then((respuesta) => {
          if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
          return respuesta.json();
        })
        .then((json) => {
          manifest = json;
          widgets = Array.isArray(json.widgets) ? json.widgets.filter((w) => typeof w?.tag === 'string') : [];
          const srcIcono = json.icons?.[0]?.src;
          if (srcIcono) {
            icono.src = new URL(srcIcono, urlManifest).href;
            icono.hidden = false;
          }
          return widgets;
        })
        .catch((error) => {
          cargaManifest = null; // permite reintentar en la siguiente apertura
          console.warn('[widgets] No se pudo leer el manifest', error);
          return widgets;
        });
    }
    return cargaManifest;
  }

  /* --- Plantillas y datos ------------------------------------------------- */
  function obtenerPlantilla(widget) {
    const url = new URL(widget.ms_ac_template, urlManifest).href;
    if (!plantillas.has(url)) {
      const promesa = fetch(url).then((respuesta) => {
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        return respuesta.json();
      });
      promesa.catch(() => plantillas.delete(url));
      plantillas.set(url, promesa);
    }
    return plantillas.get(url);
  }

  /** Una sola promesa pendiente por tag; las peticiones concurrentes la comparten. */
  function esperarActualizacion(tag) {
    if (pendientes.has(tag)) return pendientes.get(tag).promesa;
    let resolverPromesa;
    const promesa = new Promise((resolver) => { resolverPromesa = resolver; });
    const temporizador = setTimeout(() => {
      pendientes.delete(tag);
      resolverPromesa(null);
    }, PLAZO_RESPUESTA_SW);
    pendientes.set(tag, {
      promesa,
      resolver(datos) {
        clearTimeout(temporizador);
        pendientes.delete(tag);
        resolverPromesa(datos);
      }
    });
    return promesa;
  }

  async function obtenerSwActivo() {
    if (!haySw()) return null;
    const registro = await conPlazo(navigator.serviceWorker.ready, PLAZO_SW_LISTO);
    return registro?.active ?? null;
  }

  /** Pide los datos al SW; sin SW, sin respuesta o con error cae al JSON estatico. */
  async function pedirDatos(widget) {
    const { tag } = widget;
    let datos = null;
    try {
      const activo = await obtenerSwActivo();
      if (activo) {
        const respuesta = esperarActualizacion(tag);
        activo.postMessage({ tipo: MENSAJES.DATOS, tag });
        datos = await respuesta;
      }
    } catch {
      datos = null;
    }
    if (!datos || typeof datos !== 'object') {
      const respuesta = await fetch(new URL(widget.data, urlManifest).href);
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      datos = await respuesta.json();
    }
    ultimosDatos.set(tag, datos);
    return datos;
  }

  async function ejecutarAccion(tag, verb) {
    const activo = await obtenerSwActivo();
    if (!activo) {
      anunciar(t('sinSw'));
      return;
    }
    accionesEnCurso.add(tag);
    activo.postMessage({ tipo: MENSAJES.ACCION, tag, verb });
  }

  /* --- Tarjetas ----------------------------------------------------------- */
  function pintarCuerpo(registro, datos) {
    const tarjeta = renderizarTarjeta(registro.plantilla, datos, {
      alEjecutar: (verb) => ejecutarAccion(registro.widget.tag, verb),
      t
    });
    registro.cuerpo.replaceChildren(tarjeta);
  }

  async function cargarTarjeta(registro) {
    const { widget, cuerpo } = registro;
    try {
      const [plantilla, datos] = await Promise.all([obtenerPlantilla(widget), pedirDatos(widget)]);
      if (tarjetas.get(widget.tag) !== registro) return; // se quitó mientras cargaba
      registro.plantilla = plantilla;
      pintarCuerpo(registro, datos);
    } catch (error) {
      console.warn('[widgets] No se pudo cargar el widget', error);
      cuerpo.replaceChildren(crear(documento, 'p', { className: 'pw-estado pw-estado--error', textContent: t('error') }));
    }
  }

  function desmontarTarjeta(tag) {
    const registro = tarjetas.get(tag);
    if (!registro) return;
    registro.articulo.remove();
    tarjetas.delete(tag);
    clearInterval(temporizadores.get(tag));
    temporizadores.delete(tag);
  }

  function montarTarjeta(widget) {
    desmontarTarjeta(widget.tag);
    const nombre = widget.name ?? widget.tag;

    const iconoTarjeta = crear(documento, 'img', { className: 'pw-tarjeta__icono', alt: '', width: '20', height: '20' });
    const srcIcono = widget.icons?.[0]?.src ?? manifest?.icons?.[0]?.src;
    if (srcIcono) iconoTarjeta.src = new URL(srcIcono, urlManifest).href;
    else iconoTarjeta.hidden = true;
    iconoTarjeta.addEventListener('error', () => { iconoTarjeta.hidden = true; });

    const botonQuitar = crear(documento, 'button', { className: 'pw-quitar', type: 'button', 'aria-label': `${t('quitar')} ${nombre}`, textContent: '×' });
    botonQuitar.addEventListener('click', () => quitar(widget));

    const cabeceraTarjeta = crear(documento, 'header', { className: 'pw-tarjeta__cabecera' }, [
      iconoTarjeta,
      crear(documento, 'span', { className: 'pw-tarjeta__nombre', textContent: nombre }),
      botonQuitar
    ]);
    const cuerpo = crear(documento, 'div', { className: 'pw-tarjeta__cuerpo' }, [
      crear(documento, 'p', { className: 'pw-estado', textContent: t('cargando') })
    ]);
    const articulo = crear(documento, 'article', {
      className: 'pw-tarjeta',
      role: 'group',
      'aria-label': nombre,
      'data-tag': widget.tag,
      tabindex: '-1'
    }, [cabeceraTarjeta, cuerpo]);

    rejilla.append(articulo);
    const registro = { widget, articulo, cuerpo, plantilla: null, botonQuitar };
    tarjetas.set(widget.tag, registro);
    cargarTarjeta(registro);
    arrancarTemporizador(widget);
    actualizarVacio();
    return articulo;
  }

  /* --- Refresco periodico (`update` del manifest) ------------------------- */
  async function refrescar(widget) {
    const registro = tarjetas.get(widget.tag);
    if (!registro?.plantilla || !dialogo.open) return;
    try {
      pintarCuerpo(registro, await pedirDatos(widget));
    } catch (error) {
      console.warn('[widgets] No se pudo refrescar el widget', error);
    }
  }

  function arrancarTemporizador(widget) {
    if (!dialogo.open || temporizadores.has(widget.tag)) return;
    if (typeof widget.update !== 'number' || !(widget.update > 0)) return;
    const ms = Math.max(widget.update, INTERVALO_MINIMO_S) * 1000;
    temporizadores.set(widget.tag, setInterval(() => refrescar(widget), ms));
  }

  function detenerTemporizadores() {
    for (const id of temporizadores.values()) clearInterval(id);
    temporizadores.clear();
  }

  /* --- Agregar / quitar --------------------------------------------------- */
  function agregar(widget) {
    const instalados = leerInstalados();
    if (!instalados.includes(widget.tag)) guardarInstalados([...instalados, widget.tag]);
    mostrarVista('panel');
    const articulo = montarTarjeta(widget);
    anunciar(t('agregado'));
    articulo.focus({ preventScroll: false });
  }

  function quitar(widget) {
    guardarInstalados(leerInstalados().filter((tag) => tag !== widget.tag));
    desmontarTarjeta(widget.tag);
    actualizarVacio();
    anunciar(t('quitado'));
    botonAgregar.focus();
  }

  function pintarSelector() {
    listaOpciones.replaceChildren();
    const instalados = leerInstalados();
    for (const widget of widgets) {
      const nombre = widget.name ?? widget.tag;
      const captura = Array.isArray(widget.screenshots) ? widget.screenshots[0] : null;
      let imagen = null;
      if (captura?.src) {
        imagen = crear(documento, 'img', { className: 'pw-opcion__captura', alt: captura.label ?? '', loading: 'lazy' });
        imagen.src = new URL(captura.src, urlManifest).href;
        imagen.addEventListener('error', () => { imagen.hidden = true; });
      }
      const texto = crear(documento, 'div', { className: 'pw-opcion__texto' }, [
        crear(documento, 'strong', { className: 'pw-opcion__nombre', textContent: nombre }),
        crear(documento, 'p', { className: 'pw-opcion__descripcion', textContent: widget.description ?? '' })
      ]);
      const instalado = instalados.includes(widget.tag);
      const botonOpcion = crear(documento, 'button', {
        className: 'pw-opcion__agregar',
        type: 'button',
        'aria-label': `${t('agregarAccion')} ${nombre}`,
        textContent: instalado ? t('yaAgregado') : t('agregarAccion')
      });
      botonOpcion.disabled = instalado;
      botonOpcion.addEventListener('click', () => agregar(widget));
      listaOpciones.append(crear(documento, 'li', { className: 'pw-opcion' }, [imagen, texto, botonOpcion]));
    }
  }

  async function abrirSelector() {
    await cargarManifest();
    if (!dialogo.open) return;
    pintarSelector();
    mostrarVista('agregar');
    const primero = listaOpciones.querySelector('.pw-opcion__agregar:not(:disabled)');
    (primero ?? botonVolver).focus();
  }

  function volverAlPanel() {
    mostrarVista('panel');
    botonAgregar.focus();
  }

  /* --- Apertura y cierre -------------------------------------------------- */
  async function abrir() {
    if (dialogo.open) return;
    focoAnterior = documento.activeElement;
    if (typeof dialogo.showModal === 'function') dialogo.showModal();
    else dialogo.setAttribute('open', '');
    botonCerrar.focus();
    mostrarVista('panel');

    await cargarManifest();
    if (!dialogo.open) return;

    rejilla.replaceChildren();
    tarjetas.clear();
    detenerTemporizadores();
    const instalados = leerInstalados();
    for (const widget of widgets) {
      if (instalados.includes(widget.tag)) montarTarjeta(widget);
    }
    actualizarVacio();
  }

  function cerrar() {
    if (dialogo.open) dialogo.close();
  }

  dialogo.addEventListener('close', () => {
    detenerTemporizadores();
    mostrarVista('panel');
    const destino = focoAnterior?.isConnected ? focoAnterior : boton;
    focoAnterior = null;
    destino?.focus?.({ preventScroll: true });
  });
  dialogo.addEventListener('click', (evento) => {
    if (evento.target === dialogo) cerrar();
  });
  botonCerrar.addEventListener('click', cerrar);
  botonAgregar.addEventListener('click', abrirSelector);
  botonVolver.addEventListener('click', volverAlPanel);
  boton?.addEventListener('click', abrir);

  /* --- Mensajes del service worker --------------------------------------- */
  function alRecibirMensaje(evento) {
    const mensaje = evento.data;
    if (mensaje?.tipo !== MENSAJES.ACTUALIZADO || typeof mensaje.tag !== 'string') return;
    const { tag, datos } = mensaje;
    if (datos && typeof datos === 'object') ultimosDatos.set(tag, datos);

    const pendiente = pendientes.get(tag);
    if (pendiente) {
      pendiente.resolver(datos);
    } else {
      const registro = tarjetas.get(tag);
      if (registro?.plantilla && datos && typeof datos === 'object') pintarCuerpo(registro, datos);
    }
    if (accionesEnCurso.delete(tag)) anunciar(t('actualizado'));
  }
  if (haySw()) navigator.serviceWorker.addEventListener('message', alRecibirMensaje);

  /* --- API ---------------------------------------------------------------- */
  function retraducir() {
    titulo.textContent = t('titulo');
    botonCerrar.setAttribute('aria-label', t('cerrar'));
    tablero.setAttribute('aria-label', t('panelAria'));
    botonAgregar.textContent = t('agregar');
    tituloAgregar.textContent = t('agregarTitulo');
    botonVolver.textContent = t('volver');
    vacio.textContent = t('vacio');
    textoAviso.textContent = `${t('simulacion')} `;
    enlaceAviso.textContent = t('masInfo');
    for (const [tag, registro] of tarjetas) {
      registro.botonQuitar.setAttribute('aria-label', `${t('quitar')} ${registro.widget.name ?? registro.widget.tag}`);
      const estado = registro.cuerpo.querySelector('.pw-estado');
      if (estado) estado.textContent = estado.classList.contains('pw-estado--error') ? t('error') : t('cargando');
      // Los textos de la tarjeta que dependen de t() (p. ej. elementos no
      // soportados) se vuelven a pintar con los ultimos datos conocidos.
      if (registro.plantilla && ultimosDatos.has(tag)) pintarCuerpo(registro, ultimosDatos.get(tag));
    }
    if (vista.dataset.vista === 'agregar') pintarSelector();
  }

  function destruir() {
    cerrar();
    detenerTemporizadores();
    boton?.removeEventListener('click', abrir);
    if (haySw()) navigator.serviceWorker.removeEventListener('message', alRecibirMensaje);
    dialogo.remove();
  }

  return { abrir, cerrar, retraducir, destruir };
}
