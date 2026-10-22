import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENSAJES,
  TEXTOS,
  enlazarPlantilla,
  enlazarTexto,
  resolverExpresion
} from '../js/widgets.js';
import { construirDatosWidget } from '../js/conversion.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const datos = { a: { b: [{ c: 'x' }, { c: 7 }] }, n: 5, s: 'demo', v: true, f: false, z: 0, nulo: null };

// Vectores obligatorios del resolvedor (§1.8 del plan), compartidos por las tres PWA.
const vectoresTexto = [
  ['${a.b[1].c}', '7'],
  ['Valor: ${a.b[0].c}!', 'Valor: x!'],
  ['${no.existe}', ''],
  ['${a.b[5].c} fin', ' fin'],
  ["${if(s == 'demo', 'Demo', 'Vivo')}", 'Demo'],
  ["${if(n > 3, 'mayor', 'menor')}", 'mayor'],
  ["${if(v, 'sí', 'no')}", 'sí'],
  ["${if(f, 'sí', 'no')}", 'no'],
  ["${if(z, 'sí', 'no')}", 'no'],
  ["${if(nulo == null, 'nulo', 'algo')}", 'nulo'],
  ["${if(no.existe == null, 'nulo', 'algo')}", 'nulo'],
  ["${if(n == '5', 'igual', 'dif')}", 'igual'],
  ["${if(s == 'a, b', 'coma', 'sin')}", 'sin'],
  ['${n} y ${s}', '5 y demo'],
  ['sin expresiones', 'sin expresiones'],
  ['${', '${']
];

test('enlazarTexto resuelve rutas, condicionales y literales (vectores 1-16)', () => {
  for (const [texto, esperado] of vectoresTexto) {
    assert.equal(enlazarTexto(texto, datos), esperado, `Vector ${texto}`);
  }
  assert.equal(enlazarTexto(42, datos), 42, 'los no-strings se devuelven tal cual');
});

test('resolverExpresion devuelve valores crudos y nunca lanza (vectores 17-20)', () => {
  assert.equal(resolverExpresion('a.b[1].c', datos), 7);
  assert.equal(resolverExpresion('if(n >= 5, n, 0)', datos), 5);
  assert.equal(resolverExpresion("'lit'", datos), 'lit');
  assert.equal(resolverExpresion('3.5', datos), 3.5);
  assert.equal(resolverExpresion('true', datos), true);
  assert.equal(resolverExpresion('null', datos), null);
  assert.equal(resolverExpresion('expresion invalida ++', datos), null);
  assert.equal(resolverExpresion('if(n, 1)', datos), null, 'un if con dos argumentos es inválido');
  assert.equal(resolverExpresion('', datos), null);
  assert.equal(resolverExpresion(undefined, datos), null);
  assert.equal(resolverExpresion('a.b[1].c', null), null, 'sin datos no hay ruta');
  assert.equal(resolverExpresion('constructor', datos), null, 'solo propiedades propias');
});

test('enlazarPlantilla devuelve un clon profundo enlazado sin mutar el original (vector 21)', () => {
  const plantilla = { type: 'TextBlock', text: '${s}', items: [{ text: '${n}' }], wrap: true };
  const copia = JSON.stringify(plantilla);
  assert.deepEqual(enlazarPlantilla(plantilla, datos), {
    type: 'TextBlock', text: 'demo', items: [{ text: '5' }], wrap: true
  });
  assert.equal(JSON.stringify(plantilla), copia);
});

test('la plantilla real del widget se enlaza con los datos estáticos', () => {
  const plantilla = JSON.parse(readFileSync(join(root, 'widgets', 'conversion-rapida-plantilla.json'), 'utf8'));
  const estaticos = JSON.parse(readFileSync(join(root, 'widgets', 'conversion-rapida-datos.json'), 'utf8'));
  const enlazada = enlazarPlantilla(plantilla, estaticos);
  assert.equal(enlazada.type, 'AdaptiveCard');
  assert.equal(enlazada.version, '1.5');
  assert.equal(enlazada.body[1].text, '20 °C');
  assert.equal(enlazada.body[1].color, 'Attention');
  assert.equal(enlazada.body[2].text, 'Templado');
  assert.deepEqual(enlazada.body[3].facts.map((hecho) => hecho.value), ['68 °F', '293.15 K', '527.67 °R']);
  assert.deepEqual(enlazada.actions.map((accion) => accion.verb ?? accion.url), ['bajar', 'subir', './']);
  const fria = enlazarPlantilla(plantilla, { ...estaticos, celsius: 3 });
  assert.equal(fria.body[1].color, 'Accent');
  assert.doesNotMatch(JSON.stringify(enlazada), /\$\{/, 'no quedan expresiones sin resolver');
});

test('construirDatosWidget produce los datos del widget Conversión rápida', () => {
  const fecha = new Date('2025-01-01T12:00:00Z');
  const ambiente = construirDatosWidget('20', 'C', fecha);
  assert.equal(ambiente.valorOrigen, '20');
  assert.equal(ambiente.unidadOrigen, 'C');
  assert.equal(ambiente.simboloOrigen, '°C');
  assert.equal(ambiente.celsius, 20);
  assert.equal(ambiente.fahrenheit, 68);
  assert.equal(ambiente.kelvin, 293.15);
  assert.equal(ambiente.rankine, 527.67);
  assert.equal(ambiente.estado, 'Templado');
  assert.equal(ambiente.tono, 'templado');
  assert.equal(ambiente.actualizado, '2025-01-01T12:00:00.000Z');
  assert.match(ambiente.actualizadoTexto, /^Actualizado el /);
  assert.equal(ambiente.urlApp, './');

  const congelacion = construirDatosWidget('32', 'F');
  assert.equal(congelacion.celsius, 0);
  assert.equal(congelacion.estado, 'Fresco');
  assert.equal(congelacion.simboloOrigen, '°F');
  assert.equal(construirDatosWidget(' 25,5 ', 'C').valorOrigen, '25,5');
  assert.equal(construirDatosWidget('abc', 'C'), null);
  assert.equal(construirDatosWidget('-300', 'C'), null);
});

test('los verbos ±1 °C del service worker recalculan las cuatro unidades y el estado', () => {
  // El SW es un script clásico: se evalúa su espejo de conversión sin registrar eventos.
  const fuente = readFileSync(join(root, 'sw.js'), 'utf8');
  const inicio = fuente.indexOf('function estadoTermico');
  const fin = fuente.indexOf('/** Única ruta para los verbos');
  assert.ok(inicio > 0 && fin > inicio, 'sw.js conserva estadoTermico y datosDesdeCelsius');
  const { datosDesdeCelsius } = new Function(`${fuente.slice(inicio, fin)}; return { datosDesdeCelsius };`)();

  const base = { valorOrigen: '25', unidadOrigen: 'C', celsius: 25, urlApp: './' };
  const subir = datosDesdeCelsius(Number(base.celsius) + 1, base);
  assert.equal(subir.celsius, 26);
  assert.equal(subir.fahrenheit, 78.8);
  assert.equal(subir.kelvin, 299.15);
  assert.equal(subir.rankine, 538.47);
  assert.equal(subir.estado, 'Templado');
  assert.equal(subir.valorOrigen, '26');
  assert.equal(subir.simboloOrigen, '°C');
  assert.equal(subir.urlApp, './');

  const bajar = datosDesdeCelsius(Number(subir.celsius) - 1, subir);
  assert.equal(bajar.celsius, 25);
  assert.equal(bajar.fahrenheit, 77);

  const calido = datosDesdeCelsius(26 + 1, base);
  assert.equal(calido.estado, 'Cálido');
  assert.equal(calido.tono, 'calido');
  const minimo = datosDesdeCelsius(-273.15 - 1, base);
  assert.equal(minimo.celsius, -273.15, 'nunca baja del cero absoluto');
  assert.equal(minimo.estado, 'Cero absoluto');
  assert.equal(datosDesdeCelsius(Number('–') + 1, base).celsius, 20, 'datos no numéricos vuelven a 20 °C');
  assert.match(fuente, /self\.addEventListener\('widgetclick'[\s\S]*manejarAccionWidget\(TAG_WIDGET, evento\.action\)/);
  assert.match(fuente, /mensaje\.tipo === 'WIDGET_ACCION'[\s\S]*manejarAccionWidget\(mensaje\.tag, mensaje\.verb\)/);
});

test('el contrato de mensajes y los textos del simulador son los acordados', () => {
  assert.deepEqual(MENSAJES, { DATOS: 'WIDGET_DATOS', ACCION: 'WIDGET_ACCION', ACTUALIZADO: 'WIDGET_ACTUALIZADO' });
  assert.equal(
    TEXTOS.simulacion,
    'Simulación del Panel de widgets de Windows 11. En Microsoft Edge para Windows estos widgets se instalan en el panel del sistema.'
  );
  assert.equal(TEXTOS.agregado, 'Widget agregado');
  assert.equal(TEXTOS.quitado, 'Widget quitado');
  assert.equal(TEXTOS.noSoportado, 'Elemento no soportado: {tipo}');
});

test('el manifest declara el widget con los campos que exige Edge', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.widgets.length, 1);
  const [widget] = manifest.widgets;
  assert.equal(widget.tag, 'conversion-rapida');
  assert.equal(widget.name, 'Conversión rápida');
  assert.equal(widget.ms_ac_template, './widgets/conversion-rapida-plantilla.json');
  assert.equal(widget.data, './widgets/conversion-rapida-datos.json');
  assert.equal(widget.type, 'application/json');
  assert.equal(widget.auth, false);
  assert.equal(typeof widget.update, 'number');
  assert.ok(widget.screenshots.length >= 1 && widget.icons.length >= 1);
  assert.match(widget.screenshots[0].label, /Conversión rápida/);
  for (const campo of ['name', 'short_name', 'description', 'template']) {
    assert.equal(typeof widget[campo], 'string', `falta ${campo}`);
  }
  assert.deepEqual(manifest.display_override, ['window-controls-overlay', 'standalone']);
});
