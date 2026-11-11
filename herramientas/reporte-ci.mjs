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
const lineas = resumen.split('\n');

// Métricas del runner de pruebas (reporter spec): "ℹ tests 61", "ℹ pass 61", ...
// Se toma la última aparición, que corresponde al resumen final de la ejecución.
const metrica = (nombre) => {
  let valor = null;
  for (const linea of lineas) {
    const partes = linea.trim().split(/\s+/);
    if (partes.length >= 2 && partes.at(-2) === nombre && Number.isFinite(Number(partes.at(-1)))) valor = Number(partes.at(-1));
  }
  return valor;
};
const pruebas = { total: metrica('tests'), pass: metrica('pass'), fail: metrica('fail'), skipped: metrica('skipped'), ms: metrica('duration_ms') };

// Tabla de cobertura: "ℹ  conversion.js | 100.00 | 96.49 | 100.00 | 60-64 ..."
const esPorcentaje = (celda) => celda !== '' && Number.isFinite(Number(celda));
const filas = [];
for (const linea of lineas) {
  const celdas = linea.split('|').map((c) => c.trim());
  if (celdas.length < 5 || !celdas.slice(1, 4).every(esPorcentaje)) continue;
  const archivo = celdas[0].split(/\s+/).slice(1).join(' '); // quita el prefijo "ℹ" del reporter
  filas.push({ archivo, lineas: celdas[1], ramas: celdas[2], funciones: celdas[3], sinCubrir: celdas[4] });
}
const total = filas.find((f) => f.archivo === 'all files');
const porArchivo = filas.filter((f) => f !== total);

const recortar = (texto, max = 60) => {
  if (!texto) return '—';
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
};
const ok = pruebas.fail === 0 && pruebas.total > 0;
const estado = ok ? '✅' : '❌';
const cobertura = total ? `${total.lineas} % líneas · ${total.ramas} % ramas · ${total.funciones} % funciones` : 'sin datos';
const ejecucion = build.ejecucion ? `, ejecución #${build.ejecucion}` : '';
const md = [
  '## Reporte de ejecución CI',
  '',
  '| Métrica | Valor |',
  '|---|---|',
  `| Build | ✅ ${build.archivos} archivos publicables, ${(build.bytes / 1024).toFixed(1)} KiB (${build.nombre} v${build.version}, commit \`${build.commit?.slice(0, 7)}\`) |`,
  `| Pruebas | ${estado} ${pruebas.pass} aprobadas / ${pruebas.fail} fallidas / ${pruebas.skipped ?? 0} omitidas de ${pruebas.total} (${(pruebas.ms / 1000).toFixed(2)} s) |`,
  `| Cobertura | ${cobertura} |`,
  '| Artefactos | `build` (dist/) y `coverage-report` (lcov.info + resumen.txt) |',
  `| Generado | ${build.generadoPor}${ejecucion}, ${build.fecha} |`,
  '',
  '### Cobertura por archivo',
  '',
  '| Archivo | Líneas % | Ramas % | Funciones % | Líneas sin cubrir |',
  '|---|---:|---:|---:|---|',
  ...porArchivo.map((f) => `| \`${f.archivo}\` | ${f.lineas} | ${f.ramas} | ${f.funciones} | ${recortar(f.sinCubrir)} |`),
  '',
  `**Resultado:** ${ok ? '✅ aprobado' : '❌ rechazado'}: build completo, ${pruebas.pass}/${pruebas.total} pruebas y cobertura global de ${total?.lineas ?? '?'} % de líneas.`,
  '',
].join('\n');

writeFileSync(join(RAIZ, 'reporte-ci.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.stdout.write(md);
process.exit(ok ? 0 : 1);
