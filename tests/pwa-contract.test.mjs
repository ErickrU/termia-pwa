import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const pwa = readFileSync(join(root, 'js', 'pwa.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

test('conserva exactamente cinco controles y un único Compartir', () => {
  assert.equal(occurrences(html, /\bdata-control-ventana\b/g), 5);
  assert.equal(occurrences(html, /\bid="control-compartir"/g), 1);
  assert.match(html, /<button[^>]+id="control-compartir"[^>]+data-control-ventana/);
});

test('Compartir usa URL actual, Web Share, Clipboard y fallback execCommand', () => {
  assert.match(pwa, /const enlace = window\.location\.href/);
  assert.match(pwa, /typeof navigator\.share === 'function'/);
  assert.match(pwa, /await navigator\.share\([\s\S]*?url: window\.location\.href[\s\S]*?\)/);
  assert.match(pwa, /navigator\.clipboard\?\.writeText/);
  assert.match(pwa, /navigator\.clipboard\.writeText\(enlace\)/);
  assert.match(pwa, /document\.execCommand\('copy'\)/);
});

test('el feedback de Compartir es accesible', () => {
  assert.match(html, /id="estado-pwa"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(pwa, /function anunciar\(mensaje\)[\s\S]*?estadoPwa\.textContent = mensaje/);
  assert.match(pwa, /Enlace copiado al portapapeles/);
  assert.match(pwa, /Termia se compartió correctamente/);
  assert.match(pwa, /Se canceló la acción de compartir/);
});

test('el manifest prioriza Window Controls Overlay con fallback standalone', () => {
  assert.deepEqual(manifest.display_override, ['window-controls-overlay', 'standalone']);
  assert.equal(manifest.display, 'standalone');
});
