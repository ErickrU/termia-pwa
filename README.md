# Termia — Convertidor de temperatura

Termia es una PWA estática, accesible y sin dependencias de ejecución que convierte temperaturas entre Celsius, Fahrenheit, Kelvin y Rankine. Funciona sin conexión después de la primera carga completa.

## Funciones

- Conversión inmediata con punto o coma decimal y validación del cero absoluto.
- Cuatro equivalencias simultáneas, referencias comunes y termómetro visual.
- Diseño adaptable, temas claro/oscuro, foco visible y navegación por teclado.
- Manifest, service worker, iconos instalables y página offline.
- Window Controls Overlay con exactamente cinco controles: Instalar, Compartir, Tema, Restablecer y Ayuda.
- Un único control Compartir que usa Web Share y, cuando no está disponible, copia la URL actual al portapapeles con feedback accesible.

## Desarrollo local

Requiere Node.js 20 o posterior. No requiere `npm install`.

```bash
npm run check
npm test
npm start
```

El servidor de desarrollo escucha exclusivamente en `127.0.0.1:4173`.

## Publicación

GitHub Pages construye un artefacto `_site` con una allowlist explícita de 14 archivos públicos; no publica la raíz del repositorio. Todas las rutas de la aplicación son relativas.

El repositorio también incluye una alternativa de despliegue mediante CloudFormation con S3 privado y CloudFront OAC. Es solo infraestructura genérica: no contiene cuentas, ARN, buckets, distribuciones, dominios ni estado de un despliegue real. Consulta [`docs/AWS-DEPLOYMENT.md`](docs/AWS-DEPLOYMENT.md) antes de usarla.

## Estructura

- `index.html`, `css/`: interfaz y estilos same-origin.
- `js/conversion.js`: conversión y validación puras.
- `js/app.js`: presentación del convertidor.
- `js/pwa.js`: WCO, Compartir, instalación y actualización PWA.
- `sw.js`, `manifest.webmanifest`, `offline.html`: instalación y uso sin conexión.
- `infra/`, `scripts/`, `docs/`: alternativa AWS segura y documentación.
- `tests/`: pruebas matemáticas con `node:test`.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
