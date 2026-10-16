import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convertirTemperatura,
  formatearTemperatura,
  normalizarEntrada
} from '../js/conversion.js';

function cerca(actual, esperado, tolerancia = 1e-9) {
  assert.ok(Math.abs(actual - esperado) <= tolerancia, `${actual} no equivale a ${esperado}`);
}

test('convierte los puntos de referencia entre las cuatro unidades', () => {
  const cero = convertirTemperatura('0', 'C');
  assert.equal(cero.valido, true);
  cerca(cero.valores.F, 32);
  cerca(cero.valores.K, 273.15);
  cerca(cero.valores.R, 491.67);

  const menosCuarenta = convertirTemperatura('-40', 'C');
  cerca(menosCuarenta.valores.F, -40);
});

test('acepta exactamente el cero absoluto desde todas las unidades', () => {
  for (const [entrada, unidad] of [['-273.15', 'C'], ['-459.67', 'F'], ['0', 'K'], ['0', 'R']]) {
    const resultado = convertirTemperatura(entrada, unidad);
    assert.equal(resultado.valido, true);
    assert.equal(resultado.valores.K, 0);
    assert.equal(resultado.valores.R, 0);
  }
});

test('rechaza temperaturas inferiores al cero absoluto', () => {
  const casos = [
    ['-273.151', 'C'], ['-459.671', 'F'], ['-0.001', 'K'], ['-0.001', 'R'],
    ['-273.1500000005', 'C'], ['-459.6700000005', 'F'], ['-0.0000000005', 'K'], ['-0.0000000005', 'R']
  ];

  for (const [entrada, unidad] of casos) {
    assert.equal(convertirTemperatura(entrada, unidad).valido, false, `${entrada} ${unidad} debe ser inválido`);
  }
});

test('normaliza decimales con punto o coma y rechaza entradas inválidas', () => {
  assert.equal(normalizarEntrada('20,5'), 20.5);
  assert.equal(normalizarEntrada('20.5'), 20.5);
  for (const entrada of ['', '   ', 'texto', 'NaN', 'Infinity', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizarEntrada(entrada), null);
  }
});

test('nunca entrega NaN, Infinity ni cero negativo', () => {
  const resultado = convertirTemperatura('-273,15', 'C');
  assert.equal(resultado.valido, true);
  for (const valor of Object.values(resultado.valores)) {
    assert.equal(Number.isFinite(valor), true);
    assert.equal(Object.is(valor, -0), false);
  }
  assert.equal(formatearTemperatura(Number.NaN), '');
  assert.equal(formatearTemperatura(Number.POSITIVE_INFINITY), '');
});
