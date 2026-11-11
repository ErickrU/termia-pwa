/**
 * Etapa Reporte del pipeline: reúne en un solo documento Markdown las métricas
 * de las etapas anteriores (build, pruebas y cobertura) para que el resultado
 * de cada ejecución se lea de un vistazo, sin abrir los logs.
 *
 * Lee `dist/BUILD-INFO.json` (etapa Build) y `coverage/resumen.txt` (etapa
 * Pruebas), escribe `reporte-ci.md` y, cuando corre en GitHub Actions, lo
 * publica también en el resumen del job ($GITHUB_STEP_SUMMARY).
 *
 * Uso:  npm run reporte   →   node herramientas/reporte-ci.mjs
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (ruta) => (existsSync(join(RAIZ, ruta)) ? readFileSync(join(RAIZ, ruta), 'utf8') : null);

const build = JSON.parse(leer('dist/BUILD-INFO.json') ?? 'null');
const resumen = leer('coverage/resumen.txt');
if (!build || !resumen) {
  console.error('Faltan insumos: se requieren dist/BUILD-INFO.json (npm run build) y coverage/resumen.txt (npm run coverage).');
  process.exit(1);
}

// Métricas del runner de pruebas (reporter spec): "ℹ tests 61", "ℹ pass 61", ...
const metrica = (nombre) => {
  const m = resumen.match(new RegExp(`^.*\\b${nombre} ([0-9.]+)\\s*$`, 'm'));
  return m ? Number(m[1]) : null;
};
const pruebas = { total: metrica('tests'), pass: metrica('pass'), fail: metrica('fail'), skipped: metrica('skipped'), ms: metrica('duration_ms') };

// Tabla de cobertura: "ℹ  conversion.js | 100.00 | 96.49 | 100.00 | ..."
const filas = [];
for (const linea of resumen.split('\n')) {
  const m = linea.match(/^\S*\s*([\w./-]+(?: [\w./-]+)*)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|(.*)$/);
  if (m && m[1] !== 'file') filas.push({ archivo: m[1], lineas: m[2], ramas: m[3], funciones: m[4], sinCubrir: m[5].trim() });
}
const total = filas.find((f) => f.archivo === 'all files') ?? filas.find((f) => f.archivo === 'files');
const porArchivo = filas.filter((f) => f !== total);

const ok = pruebas.fail === 0 && pruebas.total > 0;
const md = [
  '## Reporte de ejecución CI',
  '',
  '| Métrica | Valor |',
  '|---|---|',
  `| Build | ✅ ${build.archivos} archivos publicables, ${(build.bytes / 1024).toFixed(1)} KiB (${build.nombre} v${build.version}, commit \`${build.commit?.slice(0, 7)}\`) |`,
  `| Pruebas | ${ok ? '✅' : '❌'} ${pruebas.pass} aprobadas / ${pruebas.fail} fallidas / ${pruebas.skipped ?? 0} omitidas de ${pruebas.total} (${(pruebas.ms / 1000).toFixed(2)} s) |`,
  `| Cobertura | ${total ? `${total.lineas} % líneas · ${total.ramas} % ramas · ${total.funciones} % funciones` : 'sin datos'} |`,
  `| Artefactos | \`build\` (dist/) y \`coverage-report\` (lcov.info + resumen.txt) |`,
  `| Generado | ${build.generadoPor}${build.ejecucion ? `, ejecución #${build.ejecucion}` : ''}, ${build.fecha} |`,
  '',
  '### Cobertura por archivo',
  '',
  '| Archivo | Líneas % | Ramas % | Funciones % | Líneas sin cubrir |',
  '|---|---:|---:|---:|---|',
  ...porArchivo.map((f) => `| \`${f.archivo}\` | ${f.lineas} | ${f.ramas} | ${f.funciones} | ${f.sinCubrir ? f.sinCubrir.slice(0, 60) + (f.sinCubrir.length > 60 ? '…' : '') : '—'} |`),
  '',
  `**Resultado:** ${ok ? '✅ aprobado' : '❌ rechazado'}: build completo, ${pruebas.pass}/${pruebas.total} pruebas y cobertura global de ${total?.lineas ?? '?'} % de líneas.`,
  '',
].join('\n');

writeFileSync(join(RAIZ, 'reporte-ci.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.stdout.write(md);
process.exit(ok ? 0 : 1);
