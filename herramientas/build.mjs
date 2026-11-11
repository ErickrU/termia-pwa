/**
 * Etapa Build del pipeline: genera la versión distribuible de Termia en `dist/`.
 *
 * La PWA no se compila ni se empaqueta con un bundler, así que el build consiste
 * en copiar únicamente los archivos que un servidor web necesita publicar (la
 * misma allowlist de 18 archivos que usa el workflow de GitHub Pages), dejando
 * fuera pruebas, herramientas, documentación e infraestructura. Además verifica
 * que el conjunto esté completo y escribe `BUILD-INFO.json` con la versión, el
 * commit y el número de ejecución para que el artefacto sea trazable a su origen.
 *
 * Uso:  npm run build   →   node herramientas/build.mjs [--salida dist]
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (nombre, porDefecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
};
const SALIDA = resolve(RAIZ, flag('salida', 'dist'));

/** Allowlist de lo que se distribuye (idéntica a la del workflow de Pages). */
const DISTRIBUIBLES = [
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'sw.js',
  'css/estilos.css',
  'css/offline.css',
  'js/app.js',
  'js/conversion.js',
  'js/pwa.js',
  'js/widgets.js',
  'iconos/favicon.svg',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/apple-touch-icon.png',
  'widgets/conversion-rapida-plantilla.json',
  'widgets/conversion-rapida-datos.json',
  'widgets/conversion-rapida-captura.png',
];

if (SALIDA === RAIZ || !SALIDA.startsWith(RAIZ)) {
  console.error(`La salida debe estar dentro del proyecto: ${SALIDA}`);
  process.exit(1);
}

const faltantes = DISTRIBUIBLES.filter((ruta) => !existsSync(join(RAIZ, ruta)));
if (faltantes.length) {
  console.error(`Build fallido: faltan archivos publicables:\n  ${faltantes.join('\n  ')}`);
  process.exit(1);
}

rmSync(SALIDA, { recursive: true, force: true });
const archivos = [];
for (const ruta of DISTRIBUIBLES) {
  const destino = join(SALIDA, ruta);
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(join(RAIZ, ruta), destino);
  archivos.push({ ruta, bytes: statSync(destino).size });
}

const paquete = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'));
const git = (cmd) => {
  try { return execSync(cmd, { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
};
const info = {
  nombre: paquete.name,
  version: paquete.version,
  commit: process.env.GITHUB_SHA ?? git('git rev-parse HEAD'),
  rama: process.env.GITHUB_REF_NAME ?? git('git rev-parse --abbrev-ref HEAD'),
  ejecucion: process.env.GITHUB_RUN_NUMBER ? Number(process.env.GITHUB_RUN_NUMBER) : null,
  generadoPor: process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'local',
  fecha: new Date().toISOString(),
  node: process.version,
  archivos: archivos.length,
  bytes: archivos.reduce((s, a) => s + a.bytes, 0),
};
writeFileSync(join(SALIDA, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');

// Resumen legible para el log del pipeline.
console.log(`Build de ${info.nombre} v${info.version} (${info.commit?.slice(0, 7) ?? 'sin git'}) → ${SALIDA}`);
for (const a of archivos) console.log(`  ${String(a.bytes).padStart(7)}  ${a.ruta}`);
console.log(`  ${archivos.length} archivos publicables, ${(info.bytes / 1024).toFixed(1)} KiB en total (+ BUILD-INFO.json)`);
