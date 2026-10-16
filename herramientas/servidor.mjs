import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const argumentos = process.argv.slice(2);
const indicePuerto = argumentos.indexOf('--puerto');
const puerto = Number(indicePuerto >= 0 ? argumentos[indicePuerto + 1] : 4173);
const raiz = resolve(process.cwd());
const tipos = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

createServer((solicitud, respuesta) => {
  const rutaUrl = decodeURIComponent(new URL(solicitud.url, 'http://localhost').pathname);
  const relativa = normalize(rutaUrl).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
  let archivo = join(raiz, relativa);

  if (!archivo.startsWith(raiz) || !existsSync(archivo)) {
    respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    respuesta.end('No encontrado');
    return;
  }

  if (statSync(archivo).isDirectory()) {
    archivo = join(archivo, 'index.html');
  }

  if (!existsSync(archivo)) {
    respuesta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    respuesta.end('No encontrado');
    return;
  }

  respuesta.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Type': tipos[extname(archivo)] || 'application/octet-stream'
  });
  createReadStream(archivo).pipe(respuesta);
}).listen(puerto, '127.0.0.1', () => {
  console.log(`Termia disponible en http://127.0.0.1:${puerto}/`);
});
