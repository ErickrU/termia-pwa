import {
  UNIDADES,
  construirDatosWidget,
  convertirTemperatura,
  formatearTemperatura,
  obtenerEstadoTermico
} from './conversion.js';
import { alActualizarWidget, enviarDatosWidget } from './widgets.js';

const CLAVE_ULTIMA_CONVERSION = 'termia:ultima-conversion';
const TAG_WIDGET = 'conversion-rapida';

const entrada = document.querySelector('#temperatura');
const selector = document.querySelector('#unidad-origen');
const error = document.querySelector('#error-entrada');
const categoria = document.querySelector('#categoria');
const saturacion = document.querySelector('#saturacion');
const nivel = document.querySelector('#nivel-termometro');
const termometro = document.querySelector('.termometro');
const equivalencias = document.querySelector('#equivalencias');

// Última conversión persistida: alimenta el widget «Conversión rápida» y se
// restaura en el formulario al cargar para que app y widget muestren lo mismo.
function leerUltimaConversion() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_ULTIMA_CONVERSION) ?? 'null');
    if (datos && typeof datos.valorOrigen === 'string' && Object.hasOwn(UNIDADES, datos.unidadOrigen)) {
      return datos;
    }
  } catch {
    // JSON corrupto o almacenamiento no disponible.
  }
  return null;
}

function guardarUltimaConversion(datos) {
  try {
    localStorage.setItem(CLAVE_ULTIMA_CONVERSION, JSON.stringify(datos));
  } catch {
    // Modo privado o cuota agotada: la app sigue funcionando sin persistir.
  }
}

// Marca temporal (ISO) de lo último publicado por esta página al service worker.
let ultimaPublicacion = '';

function publicarDatosWidget(datos) {
  ultimaPublicacion = datos.actualizado;
  guardarUltimaConversion(datos);
  enviarDatosWidget(TAG_WIDGET, datos);
}

function renderizar() {
  const resultado = convertirTemperatura(entrada.value, selector.value);

  if (!resultado.valido) {
    entrada.setAttribute('aria-invalid', 'true');
    error.textContent = resultado.error;
    equivalencias.classList.add('sin-resultados');
    categoria.textContent = 'Sin lectura';
    categoria.dataset.tono = 'invalido';
    saturacion.textContent = 'Corrige el valor para ver la escala';
    nivel.style.height = '0%';
    termometro.setAttribute('aria-label', 'Termómetro sin una temperatura válida');
    return;
  }

  entrada.removeAttribute('aria-invalid');
  error.textContent = '';
  equivalencias.classList.remove('sin-resultados');

  for (const [unidad, datos] of Object.entries(UNIDADES)) {
    const elemento = document.querySelector(`#resultado-${unidad}`);
    elemento.textContent = `${formatearTemperatura(resultado.valores[unidad])} ${datos.simbolo}`;
  }

  const estado = obtenerEstadoTermico(resultado.celsius);
  categoria.textContent = estado.categoria;
  categoria.dataset.tono = estado.tono;

  const porcentaje = Math.min(100, Math.max(0, resultado.celsius + 50));
  nivel.style.height = `${porcentaje}%`;
  nivel.dataset.tono = estado.tono;

  if (resultado.celsius > 50) {
    saturacion.textContent = 'Supera el máximo de la escala visual (+50 °C)';
  } else if (resultado.celsius < -50) {
    saturacion.textContent = 'Está bajo el mínimo de la escala visual (−50 °C)';
  } else {
    saturacion.textContent = 'Dentro de la escala visual de −50 a 50 °C';
  }

  termometro.setAttribute('aria-label', `Termómetro: ${formatearTemperatura(resultado.celsius)} grados Celsius. ${saturacion.textContent}`);

  const datosWidget = construirDatosWidget(entrada.value, selector.value);
  if (datosWidget) publicarDatosWidget(datosWidget);
}

function restablecer() {
  entrada.value = '20';
  selector.value = 'C';
  renderizar();
  entrada.focus();
}

entrada.addEventListener('input', renderizar);
selector.addEventListener('change', renderizar);
document.querySelectorAll('[data-preset]').forEach((boton) => {
  boton.addEventListener('click', () => {
    entrada.value = boton.dataset.preset;
    selector.value = boton.dataset.unidad;
    renderizar();
  });
});
window.addEventListener('termia:restablecer', restablecer);

// Los «+1 °C» / «−1 °C» pulsados en el widget se persisten y se reflejan en el
// formulario, así la app y el widget muestran siempre la misma temperatura.
// Se ignoran los ecos y las difusiones anteriores a lo último publicado aquí
// (p. ej. un valor intermedio mientras se escribe) para no pisar la entrada.
alActualizarWidget(TAG_WIDGET, (datos) => {
  if (typeof datos.actualizado !== 'string' || datos.actualizado < ultimaPublicacion) return;
  guardarUltimaConversion(datos);
  if (!Object.hasOwn(UNIDADES, datos.unidadOrigen) || typeof datos.valorOrigen !== 'string') return;
  if (entrada.value.trim() === datos.valorOrigen && selector.value === datos.unidadOrigen) return;
  entrada.value = datos.valorOrigen;
  selector.value = datos.unidadOrigen;
  renderizar();
});

const ultimaConversion = leerUltimaConversion();
if (ultimaConversion) {
  entrada.value = ultimaConversion.valorOrigen;
  selector.value = ultimaConversion.unidadOrigen;
}

renderizar();
