import {
  UNIDADES,
  convertirTemperatura,
  formatearTemperatura,
  obtenerEstadoTermico
} from './conversion.js';

const entrada = document.querySelector('#temperatura');
const selector = document.querySelector('#unidad-origen');
const error = document.querySelector('#error-entrada');
const categoria = document.querySelector('#categoria');
const saturacion = document.querySelector('#saturacion');
const nivel = document.querySelector('#nivel-termometro');
const termometro = document.querySelector('.termometro');
const equivalencias = document.querySelector('#equivalencias');

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

renderizar();
