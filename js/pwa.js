const raiz = document.documentElement;
const metaTema = document.querySelector('meta[name="theme-color"]');
const botonInstalar = document.querySelector('#control-instalar');
const botonCompartir = document.querySelector('#control-compartir');
const botonTema = document.querySelector('#control-tema');
const botonRestablecer = document.querySelector('#control-restablecer');
const botonAyuda = document.querySelector('#control-ayuda');
const dialogoAyuda = document.querySelector('#dialogo-ayuda');
const cerrarAyuda = document.querySelector('#cerrar-ayuda');
const dialogoCompartir = document.querySelector('#dialogo-compartir');
const cerrarCompartir = document.querySelector('#cerrar-compartir');
const enlaceWhatsApp = document.querySelector('#compartir-whatsapp');
const enlaceTelegram = document.querySelector('#compartir-telegram');
const enlaceFacebook = document.querySelector('#compartir-facebook');
const enlaceX = document.querySelector('#compartir-x');
const enlaceCorreo = document.querySelector('#compartir-correo');
const botonCopiar = document.querySelector('#copiar-enlace');
const botonMasApps = document.querySelector('#mas-apps');
const avisoMasApps = document.querySelector('#mas-apps-no-disponible');
const estadoCompartir = document.querySelector('#estado-compartir');
const copiaManual = document.querySelector('#copia-manual');
const enlaceCopiaManual = document.querySelector('#enlace-copia-manual');
const estadoPwa = document.querySelector('#estado-pwa');
const TITULO_COMPARTIR = 'Termia — Convertidor de temperatura';
const TEXTO_COMPARTIR = 'Convierte temperaturas con Termia.';
let solicitudInstalacion = null;
let recargaAceptada = false;
let focoAntesDeAyuda = null;
let focoAntesDeCompartir = null;
let temporizadorCierreCompartir = null;
let temporizadorGeometria = null;

function estaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function anunciar(mensaje) {
  estadoPwa.textContent = mensaje;
}

function anunciarCompartir(mensaje) {
  estadoCompartir.textContent = mensaje;
}

function actualizarInstalacion() {
  if (estaInstalada()) {
    botonInstalar.setAttribute('aria-label', 'Aplicación instalada');
    botonInstalar.title = 'Aplicación instalada';
    botonInstalar.querySelector('span').textContent = 'Instalada';
  }
}

window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault();
  solicitudInstalacion = evento;
  botonInstalar.title = 'Instalar aplicación';
  anunciar('Termia está lista para instalarse.');
});

window.addEventListener('appinstalled', () => {
  solicitudInstalacion = null;
  actualizarInstalacion();
  anunciar('Termia se instaló correctamente.');
});

botonInstalar.addEventListener('click', async () => {
  if (estaInstalada()) {
    anunciar('Termia ya está instalada en este dispositivo.');
    return;
  }
  if (!solicitudInstalacion) {
    anunciar('Usa la opción «Instalar aplicación» del menú de tu navegador.');
    return;
  }
  await solicitudInstalacion.prompt();
  const eleccion = await solicitudInstalacion.userChoice;
  solicitudInstalacion = null;
  anunciar(eleccion.outcome === 'accepted' ? 'Instalación aceptada.' : 'Instalación cancelada.');
});

function construirUrlCompartir(base, parametros) {
  const destino = new URL(base);
  destino.search = new URLSearchParams(parametros).toString();
  return destino.href;
}

function actualizarDisponibilidadMasApps(disponible) {
  botonMasApps.disabled = !disponible;
  avisoMasApps.hidden = disponible;
  if (disponible) {
    botonMasApps.removeAttribute('aria-describedby');
  } else {
    botonMasApps.setAttribute('aria-describedby', 'mas-apps-no-disponible');
  }
}

function prepararOpcionesCompartir() {
  const enlace = window.location.href;
  enlaceWhatsApp.href = construirUrlCompartir('https://wa.me/', {
    text: `${TEXTO_COMPARTIR} ${enlace}`
  });
  enlaceTelegram.href = construirUrlCompartir('https://t.me/share/url', {
    url: enlace,
    text: TEXTO_COMPARTIR
  });
  enlaceFacebook.href = construirUrlCompartir('https://www.facebook.com/sharer/sharer.php', {
    u: enlace
  });
  enlaceX.href = construirUrlCompartir('https://twitter.com/intent/tweet', {
    text: TEXTO_COMPARTIR,
    url: enlace
  });
  enlaceCorreo.href = `mailto:?${new URLSearchParams({
    subject: TITULO_COMPARTIR,
    body: `${TEXTO_COMPARTIR}\n\n${enlace}`
  }).toString()}`;

  const compartirNativoDisponible = typeof navigator.share === 'function';
  actualizarDisponibilidadMasApps(compartirNativoDisponible);
}

function ocultarCopiaManual() {
  copiaManual.hidden = true;
  enlaceCopiaManual.value = '';
}

function abrirCompartir() {
  focoAntesDeCompartir = botonCompartir;
  window.clearTimeout(temporizadorCierreCompartir);
  temporizadorCierreCompartir = null;
  anunciarCompartir('');
  ocultarCopiaManual();
  prepararOpcionesCompartir();
  dialogoCompartir.showModal();
  cerrarCompartir.focus({ preventScroll: true });
}

function cerrarDialogoCompartir() {
  window.clearTimeout(temporizadorCierreCompartir);
  temporizadorCierreCompartir = null;
  if (dialogoCompartir.open) dialogoCompartir.close();
}

function cerrarCompartirTrasConfirmacion() {
  window.clearTimeout(temporizadorCierreCompartir);
  temporizadorCierreCompartir = window.setTimeout(() => {
    temporizadorCierreCompartir = null;
    if (dialogoCompartir.open) dialogoCompartir.close();
  }, 900);
}

function confirmarCopia() {
  anunciarCompartir('Enlace copiado al portapapeles.');
  cerrarCompartirTrasConfirmacion();
}

function copiarConComando(enlace) {
  const focoAnterior = document.activeElement;
  const campo = document.createElement('textarea');
  campo.value = enlace;
  campo.className = 'campo-copia-portapapeles';
  campo.setAttribute('readonly', '');
  campo.setAttribute('aria-hidden', 'true');
  document.body.append(campo);
  campo.focus({ preventScroll: true });
  campo.select();
  campo.setSelectionRange(0, campo.value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    campo.remove();
    if (focoAnterior?.isConnected) focoAnterior.focus({ preventScroll: true });
  }
}

async function copiarEnlace() {
  const enlace = window.location.href;
  ocultarCopiaManual();
  anunciarCompartir('');

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(enlace);
      confirmarCopia();
      return;
    } catch {
      // Continúa con el fallback iniciado por la misma selección explícita.
    }
  }

  if (copiarConComando(enlace)) {
    confirmarCopia();
    return;
  }

  enlaceCopiaManual.value = enlace;
  copiaManual.hidden = false;
  anunciarCompartir('No se pudo copiar automáticamente. El enlace está seleccionado para copiarlo manualmente.');
  enlaceCopiaManual.focus({ preventScroll: true });
  enlaceCopiaManual.select();
}

function manejarResultadoCompartir(error) {
  if (error?.name === 'AbortError') {
    anunciarCompartir('');
    return;
  }
  anunciarCompartir('No se pudo abrir el menú de aplicaciones. Elige otra opción.');
}

botonCompartir.addEventListener('click', abrirCompartir);
cerrarCompartir.addEventListener('click', cerrarDialogoCompartir);
dialogoCompartir.addEventListener('click', (evento) => {
  if (evento.target === dialogoCompartir) cerrarDialogoCompartir();
});
dialogoCompartir.addEventListener('close', () => {
  window.clearTimeout(temporizadorCierreCompartir);
  temporizadorCierreCompartir = null;
  if (focoAntesDeCompartir?.isConnected) focoAntesDeCompartir.focus({ preventScroll: true });
});

for (const enlaceDestino of [enlaceWhatsApp, enlaceTelegram, enlaceFacebook, enlaceX, enlaceCorreo]) {
  enlaceDestino.addEventListener('click', () => {
    window.setTimeout(cerrarDialogoCompartir, 0);
  });
}

botonCopiar.addEventListener('click', copiarEnlace);
botonMasApps.addEventListener('click', () => {
  if (typeof navigator.share !== 'function') {
    actualizarDisponibilidadMasApps(false);
    anunciarCompartir('El menú de aplicaciones no está disponible en este navegador.');
    return;
  }

  try {
    const operacion = navigator.share({
      title: TITULO_COMPARTIR,
      text: TEXTO_COMPARTIR,
      url: window.location.href
    });
    Promise.resolve(operacion).then(() => {
      anunciar('Termia se compartió correctamente.');
      cerrarDialogoCompartir();
    }, manejarResultadoCompartir);
  } catch (error) {
    manejarResultadoCompartir(error);
  }
});

function aplicarTema(tema, guardar = true) {
  raiz.dataset.tema = tema;
  metaTema.content = tema === 'oscuro' ? '#171525' : '#f7f4ff';
  botonTema.setAttribute('aria-pressed', String(tema === 'oscuro'));
  botonTema.title = tema === 'oscuro' ? 'Usar tema claro' : 'Usar tema oscuro';
  if (guardar) localStorage.setItem('termia-tema', tema);
}

const temaGuardado = localStorage.getItem('termia-tema');
const temaInicial = temaGuardado || (matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro');
aplicarTema(temaInicial, false);
botonTema.addEventListener('click', () => aplicarTema(raiz.dataset.tema === 'oscuro' ? 'claro' : 'oscuro'));

botonRestablecer.addEventListener('click', () => {
  window.dispatchEvent(new CustomEvent('termia:restablecer'));
  anunciar('Conversión restablecida a 20 °C.');
});

function abrirAyuda() {
  focoAntesDeAyuda = document.activeElement;
  dialogoAyuda.showModal();
  cerrarAyuda.focus();
}

function cerrarDialogoAyuda() {
  dialogoAyuda.close();
}

botonAyuda.addEventListener('click', abrirAyuda);
cerrarAyuda.addEventListener('click', cerrarDialogoAyuda);
dialogoAyuda.addEventListener('click', (evento) => {
  if (evento.target === dialogoAyuda) cerrarDialogoAyuda();
});
dialogoAyuda.addEventListener('close', () => {
  if (focoAntesDeAyuda?.isConnected) focoAntesDeAyuda.focus();
});

function sincronizarWco() {
  const wco = navigator.windowControlsOverlay;
  if (!wco) {
    document.body.classList.remove('wco-visible', 'wco-angosto');
    document.body.dataset.wco = 'no-disponible';
    return;
  }

  const rectangulo = wco.getTitlebarAreaRect();
  document.body.classList.toggle('wco-visible', wco.visible);
  document.body.classList.toggle('wco-angosto', wco.visible && rectangulo.width < 620);
  document.body.dataset.wco = wco.visible ? 'visible' : 'oculto';
  document.body.dataset.wcoAncho = String(Math.round(rectangulo.width));
}

sincronizarWco();
if (navigator.windowControlsOverlay) {
  navigator.windowControlsOverlay.addEventListener('geometrychange', () => {
    clearTimeout(temporizadorGeometria);
    temporizadorGeometria = setTimeout(sincronizarWco, 200);
  });
}

window.addEventListener('online', () => anunciar('Con conexión. El modo sin conexión sigue disponible.'));
window.addEventListener('offline', () => anunciar('Sin conexión: estás usando la copia guardada.'));
actualizarInstalacion();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((registro) => {
    anunciar(navigator.onLine ? 'Lista para funcionar sin conexión.' : 'Sin conexión: estás usando la copia guardada.');

    function ofrecerActualizacion(worker) {
      if (!worker) return;
      const aceptar = window.confirm('Hay una nueva versión de Termia. ¿Quieres actualizar ahora?');
      if (aceptar) {
        recargaAceptada = true;
        worker.postMessage({ tipo: 'ACTIVAR_ACTUALIZACION' });
      } else {
        anunciar('Actualización pendiente para más tarde.');
      }
    }

    if (registro.waiting) ofrecerActualizacion(registro.waiting);
    registro.addEventListener('updatefound', () => {
      const nuevoWorker = registro.installing;
      nuevoWorker?.addEventListener('statechange', () => {
        if (nuevoWorker.state === 'installed' && navigator.serviceWorker.controller) {
          ofrecerActualizacion(nuevoWorker);
        }
      });
    });
  }).catch(() => anunciar('No se pudo preparar el modo sin conexión.'));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recargaAceptada) window.location.reload();
  });
}
