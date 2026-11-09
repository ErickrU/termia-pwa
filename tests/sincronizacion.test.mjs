import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contrato estático de la sincronización en segundo plano (guía de Microsoft
// Edge «Sincronización y actualización de una PWA en segundo plano»):
// periodicsync para refrescar el shell y el widget, sync como reintento
// diferido, detección de soporte y degradación limpia. La parte dinámica se
// cubre con herramientas/verificar-sincronizacion.mjs en Chrome headless.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = readFileSync(join(root, 'sw.js'), 'utf8');
const pwa = readFileSync(join(root, 'js', 'pwa.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const styles = readFileSync(join(root, 'css', 'estilos.css'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const architecture = readFileSync(join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
const widgetsSmoke = readFileSync(join(root, 'herramientas', 'verificar-widgets.mjs'), 'utf8');
const syncSmoke = readFileSync(join(root, 'herramientas', 'verificar-sincronizacion.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ARTICULO = 'https://learn.microsoft.com/es-es/microsoft-edge/progressive-web-apps/how-to/background-syncs';

function bloque(texto, inicio, fin) {
  const desde = texto.indexOf(inicio);
  assert.notEqual(desde, -1, `No se encontró «${inicio}»`);
  const hasta = texto.indexOf(fin, desde);
  return hasta === -1 ? texto.slice(desde) : texto.slice(desde, hasta);
}

test('el service worker es termia-v5 y conserva termia-sync-v1 al activar', () => {
  assert.match(worker, /const VERSION = 'termia-v5'/);
  assert.match(worker, /const CACHE_SINCRONIZACION = 'termia-sync-v1'/);
  const activate = bloque(worker, "self.addEventListener('activate'", "self.addEventListener('message'");
  assert.match(activate, /\[CACHE_ESTATICO, CACHE_PAGINAS, CACHE_WIDGETS, CACHE_SINCRONIZACION\]\.includes\(clave\)/);
  assert.match(worker, /RUTA_ESTADO_SINCRONIZACION = '\.\/estado-sincronizacion\.json'/);
  assert.match(worker, /caches\.open\(CACHE_SINCRONIZACION\)[\s\S]*?cache\.put\(absoluta\(RUTA_ESTADO_SINCRONIZACION\), new Response\(JSON\.stringify\(estado\)/);
});

test('el service worker atiende periodicsync (termia-refresco) y sync (termia-reintento)', () => {
  assert.match(worker, /const ETIQUETA_REFRESCO = 'termia-refresco'/);
  assert.match(worker, /const ETIQUETA_REINTENTO = 'termia-reintento'/);
  const periodic = bloque(worker, "self.addEventListener('periodicsync'", "self.addEventListener('sync'");
  assert.match(periodic, /evento\.tag !== ETIQUETA_REFRESCO/);
  assert.match(periodic, /evento\.waitUntil\(\s*refrescarEnSegundoPlano\(/);
  const sync = bloque(worker, "self.addEventListener('sync'", '\n});') + '\n});';
  assert.match(sync, /evento\.tag !== ETIQUETA_REINTENTO/);
  assert.match(sync, /evento\.waitUntil\(\s*refrescarEnSegundoPlano\(\{ origen: 'sync', reintentar: false \}\)/);
  assert.match(sync, /evento\.lastChance/);
});

test('refrescarEnSegundoPlano recarga el shell sin pisar copias buenas y programa el reintento', () => {
  const refrescar = bloque(worker, 'async function refrescarRecurso', 'async function difundirRefresco');
  assert.match(refrescar, /fetch\(url, \{ cache: 'reload' \}\)/);
  assert.match(refrescar, /if \(!respuesta\.ok\) throw/);
  assert.match(refrescar, /Promise\.allSettled\(RECURSOS\.map/);
  assert.match(refrescar, /guardarEstadoSincronizacion\(\{ cuando, origen \}\)/);
  assert.match(refrescar, /if \('widgets' in self\)[\s\S]*?await updateWidgets\(\)/);
  assert.match(refrescar, /if \(!\('sync' in self\.registration\)\) return false/);
  assert.match(refrescar, /self\.registration\.sync\.register\(ETIQUETA_REINTENTO\)/);
  assert.match(worker, /mensaje\.tipo === 'REFRESCAR'[\s\S]*?refrescarPorPeticion\(evento\.source\)/);
  assert.match(worker, /tipo: 'REFRESCADO', ok: resultado\.ok, cuando: resultado\.cuando, origen/);
  // Background Fetch queda descartada: no hay archivos grandes que descargar.
  assert.doesNotMatch(worker, /backgroundFetch|BackgroundFetchManager/);
  assert.doesNotMatch(pwa, /backgroundFetch|BackgroundFetchManager/);
});

test('la página detecta soporte como la guía y registra el refresco diario solo con permiso', () => {
  assert.match(pwa, /const ETIQUETA_REFRESCO = 'termia-refresco'/);
  assert.match(pwa, /const ETIQUETA_REINTENTO = 'termia-reintento'/);
  assert.match(pwa, /const INTERVALO_MINIMO_REFRESCO = 24 \* 60 \* 60 \* 1000/);
  const periodica = bloque(pwa, 'async function registrarSincronizacionPeriodica', 'function pedirRefresco');
  assert.match(periodica, /if \(!registro\.periodicSync\) return 'no-soportada'/);
  assert.match(periodica, /if \(!navigator\.permissions\?\.query\) return 'sin-permiso'/);
  assert.match(periodica, /try \{\s*permiso = await navigator\.permissions\.query\(\{ name: 'periodic-background-sync' \}\);\s*\} catch/);
  assert.match(periodica, /permiso\.state !== 'granted'/);
  assert.match(periodica, /registro\.periodicSync\.register\(ETIQUETA_REFRESCO, \{ minInterval: INTERVALO_MINIMO_REFRESCO \}\)/);
  assert.doesNotMatch(periodica, /permissions\.request|Notification\.requestPermission/);

  const reintento = bloque(pwa, 'async function programarReintentoDesdePagina', 'function esperarRegistro');
  assert.match(reintento, /if \(!registro\.sync\)/);
  assert.match(reintento, /registro\.sync\.register\(ETIQUETA_REINTENTO\)/);
  assert.match(reintento, /Sin conexión: Termia se actualizará automáticamente cuando vuelva la red\./);
  assert.match(reintento, /Sin conexión: Termia se actualizará al abrirla con conexión\./);

  const buscar = bloque(pwa, 'async function buscarActualizaciones', 'function recibirRefresco');
  assert.match(buscar, /Buscando actualizaciones…/);
  assert.match(buscar, /if \(!navigator\.onLine\)[\s\S]*?programarReintentoDesdePagina\(registro\)/);
  assert.match(buscar, /await pedirRefresco\(worker\)/);
  assert.match(pwa, /worker\.postMessage\(\{ tipo: 'REFRESCAR' \}\)/);
  assert.match(buscar, /Termia está al día \(actualizado \$\{formatearTiempoRelativo\(respuesta\.cuando\)\}\)\./);
  assert.match(pwa, /anunciar\('Actualizado en segundo plano\.'\)/);
  assert.match(pwa, /navigator\.serviceWorker\.addEventListener\('message', recibirRefresco\)/);
  assert.doesNotMatch(pwa, /innerHTML/);
});

test('la última sincronización se lee de Cache Storage y se muestra en formato relativo español', () => {
  assert.match(pwa, /export function formatearTiempoRelativo\(desde, ahora = Date\.now\(\)\)/);
  assert.match(pwa, /new Intl\.RelativeTimeFormat\('es', \{ numeric: 'auto' \}\)/);
  assert.match(pwa, /caches\.open\(CACHE_SINCRONIZACION\)[\s\S]*?cache\.match\(new URL\(RUTA_ESTADO_SINCRONIZACION, registro\.scope\)\.href\)/);
  assert.match(pwa, /ultimaSincronizacion\.textContent = `Última sincronización: \$\{relativo\}`/);
  assert.match(pwa, /ultimaSincronizacion\.hidden = true/);
  assert.match(pwa, /window\.setInterval\(pintarUltimaSincronizacion, 60_000\)/);
});

test('el HTML añade la acción al diálogo de ayuda sin tocar los seis controles', () => {
  assert.equal([...html.matchAll(/\bdata-control-ventana\b/g)].length, 6);
  const ayuda = html.match(/<dialog id="dialogo-ayuda"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(ayuda, /<section class="ayuda-sincronizacion" aria-labelledby="titulo-sincronizacion">/);
  assert.match(ayuda, /Chromium \(Microsoft Edge o Google Chrome\) con la app instalada/);
  assert.match(ayuda, /<button type="button" id="buscar-actualizaciones"[^>]*>Buscar actualizaciones<\/button>/);
  assert.match(ayuda, /id="estado-sincronizacion"[^>]+role="status"[^>]+aria-live="polite"/);
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0] || '';
  assert.match(footer, /id="estado-pwa"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(footer, /<small id="ultima-sincronizacion" hidden><\/small>/);
  assert.match(styles, /\.boton-sincronizacion \{[^}]*min-height: 44px/);
  assert.match(styles, /\.estado-sincronizacion \{[^}]*min-height: 1\.5rem/);
});

test('documentación, verificación y scripts acompañan a la versión termia-v5', () => {
  assert.ok(readme.includes(ARTICULO), 'README debe enlazar el artículo de Microsoft Edge');
  assert.match(readme, /## Sincronización en segundo plano/);
  assert.match(readme, /termia-refresco/);
  assert.match(readme, /termia-reintento/);
  assert.match(readme, /Periodic Sync/);
  assert.match(architecture, /periodicsync/);
  assert.match(architecture, /termia-sync-v1/);
  assert.match(architecture, /Background Fetch/);
  assert.doesNotMatch(widgetsSmoke, /termia-v4/);
  assert.match(widgetsSmoke, /const VERSION_SW = /);
  assert.match(syncSmoke, /tipo: 'REFRESCAR'/);
  assert.match(syncSmoke, /termia-sync-v1/);
  assert.match(syncSmoke, /Network\.emulateNetworkConditions/);
  assert.match(syncSmoke, /ServiceWorker\.dispatchSyncEvent/);
  assert.match(pkg.scripts.check, /node --check herramientas\/verificar-sincronizacion\.mjs/);
});
