const raiz = document.documentElement;
const metaTema = document.querySelector('meta[name="theme-color"]');
const botonInstalar = document.querySelector('#control-instalar');
const botonCompartir = document.querySelector('#control-compartir');
const botonTema = document.querySelector('#control-tema');
const botonRestablecer = document.querySelector('#control-restablecer');
const botonAyuda = document.querySelector('#control-ayuda');
const dialogo = document.querySelector('#dialogo-ayuda');
const cerrarAyuda = document.querySelector('#cerrar-ayuda');
const estadoPwa = document.querySelector('#estado-pwa');
let solicitudInstalacion = null;
let recargaAceptada = false;
let focoAntesDelDialogo = null;
let temporizadorGeometria = null;

function estaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function anunciar(mensaje) {
  estadoPwa.textContent = mensaje;
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

function copiarConComando(enlace) {
  const campo = document.createElement('textarea');
  campo.value = enlace;
  campo.className = 'campo-copia-portapapeles';
  campo.setAttribute('readonly', '');
  campo.setAttribute('aria-hidden', 'true');
  document.body.append(campo);
  campo.select();
  campo.setSelectionRange(0, campo.value.length);
  const copiado = document.execCommand('copy');
  campo.remove();
  if (!copiado) throw new Error('El navegador rechazó la copia.');
}

async function copiarEnlace() {
  const enlace = window.location.href;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(enlace);
      anunciar('Enlace copiado al portapapeles.');
      return;
    } catch {
      // Continúa con el fallback compatible con navegadores anteriores.
    }
  }

  copiarConComando(enlace);
  anunciar('Enlace copiado al portapapeles.');
}

botonCompartir.addEventListener('click', async () => {
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({
        title: document.title,
        text: 'Convierte temperaturas con Termia.',
        url: window.location.href
      });
      anunciar('Termia se compartió correctamente.');
    } else {
      await copiarEnlace();
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      anunciar('Se canceló la acción de compartir.');
      return;
    }

    try {
      await copiarEnlace();
    } catch {
      anunciar('No se pudo compartir. Copia la dirección desde el navegador.');
    }
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
  focoAntesDelDialogo = document.activeElement;
  dialogo.showModal();
  cerrarAyuda.focus();
}

function cerrarDialogo() {
  dialogo.close();
}

botonAyuda.addEventListener('click', abrirAyuda);
cerrarAyuda.addEventListener('click', cerrarDialogo);
dialogo.addEventListener('click', (evento) => {
  if (evento.target === dialogo) cerrarDialogo();
});
dialogo.addEventListener('close', () => {
  if (focoAntesDelDialogo?.isConnected) focoAntesDelDialogo.focus();
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
