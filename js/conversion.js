export const UNIDADES = Object.freeze({
  C: Object.freeze({ nombre: 'Celsius', simbolo: '°C' }),
  F: Object.freeze({ nombre: 'Fahrenheit', simbolo: '°F' }),
  K: Object.freeze({ nombre: 'Kelvin', simbolo: 'K' }),
  R: Object.freeze({ nombre: 'Rankine', simbolo: '°R' })
});

const CERO_ABSOLUTO_C = -273.15;
const MARGEN_FLOTANTE = 1e-9;

export function normalizarEntrada(entrada) {
  if (typeof entrada === 'number') {
    return Number.isFinite(entrada) ? entrada : null;
  }

  if (typeof entrada !== 'string' || entrada.trim() === '') {
    return null;
  }

  const texto = entrada.trim().replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(texto)) {
    return null;
  }

  const valor = Number(texto);
  return Number.isFinite(valor) ? valor : null;
}

function aKelvin(valor, unidad) {
  switch (unidad) {
    case 'C': return valor + 273.15;
    case 'F': return (valor + 459.67) * 5 / 9;
    case 'K': return valor;
    case 'R': return valor * 5 / 9;
    default: return null;
  }
}

function desdeKelvin(kelvin, unidad) {
  switch (unidad) {
    case 'C': return kelvin - 273.15;
    case 'F': return kelvin * 9 / 5 - 459.67;
    case 'K': return kelvin;
    case 'R': return kelvin * 9 / 5;
    default: return null;
  }
}

function limpiarCero(valor) {
  return Math.abs(valor) < MARGEN_FLOTANTE ? 0 : valor;
}

export function convertirTemperatura(entrada, unidadOrigen) {
  const valor = normalizarEntrada(entrada);
  if (valor === null || !Object.hasOwn(UNIDADES, unidadOrigen)) {
    return { valido: false, error: 'Introduce una temperatura válida.' };
  }

  let kelvin = aKelvin(valor, unidadOrigen);
  if (!Number.isFinite(kelvin) || kelvin < 0) {
    return { valido: false, error: 'La temperatura no puede ser inferior al cero absoluto.' };
  }

  kelvin = limpiarCero(kelvin);
  const valores = Object.fromEntries(
    Object.keys(UNIDADES).map((unidad) => [unidad, limpiarCero(desdeKelvin(kelvin, unidad))])
  );

  if (Object.values(valores).some((resultado) => !Number.isFinite(resultado))) {
    return { valido: false, error: 'No se pudo calcular una temperatura finita.' };
  }

  return { valido: true, kelvin, celsius: valores.C, valores };
}

export function formatearTemperatura(valor, maximoDecimales = 2) {
  if (!Number.isFinite(valor)) {
    return '';
  }

  return new Intl.NumberFormat('es-PE', {
    maximumFractionDigits: maximoDecimales,
    minimumFractionDigits: 0,
    useGrouping: false
  }).format(limpiarCero(valor));
}

export function obtenerEstadoTermico(celsius) {
  if (!Number.isFinite(celsius)) {
    return null;
  }

  if (celsius <= CERO_ABSOLUTO_C + MARGEN_FLOTANTE) return { categoria: 'Cero absoluto', tono: 'extremo-frio' };
  if (celsius < 0) return { categoria: 'Bajo cero', tono: 'frio' };
  if (celsius < 15) return { categoria: 'Fresco', tono: 'fresco' };
  if (celsius <= 26) return { categoria: 'Templado', tono: 'templado' };
  if (celsius < 40) return { categoria: 'Cálido', tono: 'calido' };
  return { categoria: 'Muy caliente', tono: 'muy-calido' };
}
