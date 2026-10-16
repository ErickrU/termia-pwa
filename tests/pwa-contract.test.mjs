import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const pwa = readFileSync(join(root, 'js', 'pwa.js'), 'utf8');
const styles = readFileSync(join(root, 'css', 'estilos.css'), 'utf8');
const worker = readFileSync(join(root, 'sw.js'), 'utf8');
const pages = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const deploy = readFileSync(join(root, 'scripts', 'deploy-aws.sh'), 'utf8');
const verifySite = readFileSync(join(root, 'scripts', 'verify-site.sh'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
const publicFiles = [
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'sw.js',
  'css/estilos.css',
  'css/offline.css',
  'js/app.js',
  'js/conversion.js',
  'js/pwa.js',
  'iconos/favicon.svg',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/apple-touch-icon.png'
];

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

test('conserva cinco controles y añade una única hoja Compartir accesible', () => {
  assert.equal(occurrences(html, /\bdata-control-ventana\b/g), 5);
  assert.equal(occurrences(html, /\bid="control-compartir"/g), 1);
  assert.match(html, /<button[^>]+id="control-compartir"[^>]+data-control-ventana/);

  const shareDialog = html.match(/<dialog id="dialogo-compartir"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(shareDialog, /aria-labelledby="titulo-compartir"/);
  assert.match(shareDialog, /aria-describedby="descripcion-compartir"/);
  assert.match(shareDialog, /id="cerrar-compartir"[^>]+aria-label=/);
  assert.equal(occurrences(shareDialog, /class="opcion-compartir(?:\s[^"\n]*)?"/g), 7);
  for (const label of ['WhatsApp', 'Telegram', 'Facebook', 'X', 'Correo', 'Copiar enlace', 'Más apps']) {
    assert.match(shareDialog, new RegExp(`>${label}<`));
  }
  for (const id of ['compartir-whatsapp', 'compartir-telegram', 'compartir-facebook', 'compartir-x']) {
    assert.match(shareDialog, new RegExp(`id="${id}"[^>]+target="_blank"[^>]+rel="noopener noreferrer"`));
  }
  assert.match(shareDialog, /id="compartir-correo"[^>]+href="mailto:"/);
  assert.match(shareDialog, /id="estado-compartir"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(shareDialog, /id="enlace-copia-manual"[^>]+readonly/);
  assert.ok(occurrences(shareDialog, /<svg\b/g) >= 8);
  assert.doesNotMatch(shareDialog, /<img\b|https?:\/\/[^"']+\.(png|jpe?g|webp)/i);
});

test('genera destinos desde la URL actual y separa compartir de copiar', () => {
  for (const endpoint of [
    'https://wa.me/',
    'https://t.me/share/url',
    'https://www.facebook.com/sharer/sharer.php',
    'https://twitter.com/intent/tweet',
    'mailto:?'
  ]) {
    assert.ok(pwa.includes(endpoint), `Falta el destino ${endpoint}`);
  }
  assert.match(pwa, /new URLSearchParams\(/);
  assert.ok(occurrences(pwa, /window\.location\.href/g) >= 3);
  assert.doesNotMatch(pwa, /github\.com|github\.io|cloudfront\.net/i);
  assert.match(pwa, /botonCompartir\.addEventListener\('click', abrirCompartir\)/);
  assert.match(pwa, /function abrirCompartir\(\)[\s\S]*?prepararOpcionesCompartir\(\)[\s\S]*?showModal\(\)/);

  assert.match(pwa, /botonMasApps\.addEventListener\('click',[\s\S]*?navigator\.share\(\{[\s\S]*?url: window\.location\.href/);
  assert.match(pwa, /typeof navigator\.share !== 'function'[\s\S]*?botonMasApps\.disabled = true/);
  assert.match(pwa, /compartirNativoDisponible[\s\S]*?avisoMasApps\.hidden = compartirNativoDisponible/);
  assert.match(pwa, /error\?\.name === 'AbortError'[\s\S]*?anunciarCompartir\(''\)/);

  assert.equal(occurrences(pwa, /\bcopiarEnlace\b/g), 2);
  assert.match(pwa, /botonCopiar\.addEventListener\('click', copiarEnlace\)/);
  assert.match(pwa, /navigator\.clipboard\?\.writeText/);
  assert.match(pwa, /navigator\.clipboard\.writeText\(enlace\)/);
  assert.match(pwa, /document\.execCommand\('copy'\)/);
  assert.match(pwa, /copiaManual\.hidden = false[\s\S]*?enlaceCopiaManual\.select\(\)/);
  assert.doesNotMatch(pwa, /manejarResultadoCompartir[\s\S]{0,500}copiarEnlace/);
});

test('mantiene accesibilidad, diálogos aislados y presentación adaptable', () => {
  assert.match(pwa, /let focoAntesDeAyuda = null;/);
  assert.match(pwa, /let focoAntesDeCompartir = null;/);
  assert.match(pwa, /dialogoCompartir\.showModal\(\)[\s\S]*?cerrarCompartir\.focus/);
  assert.match(pwa, /dialogoCompartir\.addEventListener\('close',[\s\S]*?focoAntesDeCompartir\.focus/);
  assert.match(pwa, /dialogoAyuda\.addEventListener\('close',[\s\S]*?focoAntesDeAyuda\.focus/);
  assert.match(pwa, /evento\.target === dialogoCompartir/);
  assert.match(html, /id="mas-apps-no-disponible"[^>]+hidden/);

  assert.match(styles, /\.opcion-compartir[\s\S]*?min-height: 96px/);
  assert.match(styles, /\.dialogo-compartir \*[^{]*\{[^}]*app-region: no-drag/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.dialogo-compartir[\s\S]*?inset: auto 0 0/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible[^{]*\{[^}]*outline:/);

  assert.deepEqual(manifest.display_override, ['window-controls-overlay', 'standalone']);
  assert.equal(manifest.display, 'standalone');
});

test('actualiza el shell sin ampliar caché ni allowlists públicas', () => {
  assert.match(worker, /const VERSION = 'termia-v3'/);
  const resourceBlock = worker.match(/const RECURSOS = \[([\s\S]*?)\];/)?.[1] || '';
  const resources = [...resourceBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...resources].sort(), publicFiles.map((file) => `./${file}`).sort());
  assert.match(worker, /new URL\(evento\.request\.url\)\.origin !== self\.location\.origin/);
  assert.doesNotMatch(worker, /https?:\/\/(?:wa\.me|t\.me|www\.facebook\.com|twitter\.com)/);

  assert.match(pages, /find _site -type f \| wc -l[^\n]+"14"/);
  for (const file of publicFiles) assert.ok(pages.includes(file), `Pages omite ${file}`);
  const deployBlock = deploy.match(/PUBLIC_FILES=\(([\s\S]*?)\n\)/)?.[1] || '';
  assert.deepEqual(deployBlock.trim().split(/\s+/), publicFiles);

  assert.match(verifySite, /dialogo-compartir/);
  assert.match(verifySite, /wa\.me/);
  assert.match(verifySite, /AbortError/);
  assert.match(verifySite, /enlace-copia-manual/);
});
