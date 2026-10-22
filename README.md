# Termia — Convertidor de temperatura

Termia es una PWA estática, accesible y sin dependencias de ejecución que convierte temperaturas entre Celsius, Fahrenheit, Kelvin y Rankine. Funciona sin conexión después de la primera carga completa.

## Funciones

- Conversión inmediata con punto o coma decimal y validación del cero absoluto.
- Cuatro equivalencias simultáneas, referencias comunes y termómetro visual.
- Diseño adaptable, temas claro/oscuro, foco visible y navegación por teclado.
- Manifest, service worker, iconos instalables y página offline.
- Window Controls Overlay con exactamente seis controles: Instalar, Compartir, Tema, Restablecer, Ayuda y Widgets.
- Widget «Conversión rápida» para el panel de widgets de Windows 11 (Microsoft Edge): `manifest.webmanifest` declara el miembro `widgets`, la plantilla Adaptive Card y los datos viven en `widgets/`, y el service worker atiende `widgetinstall`, `widgetresume` y `widgetclick` (acciones «+1 °C» / «−1 °C»). El control Widgets abre, en cualquier sistema, un simulador del panel que renderiza esa misma plantilla con la última conversión.
- Un único control Compartir abre una hoja propia: centrada en escritorio y anclada abajo en móvil. Ofrece WhatsApp, Telegram, Facebook, X y Correo con la URL actual, además de Copiar enlace y Más apps.
- Copiar solo se ejecuta al elegirlo: primero usa Clipboard API, luego `execCommand` y, si ambos fallan, muestra el enlace seleccionado para copia manual. Más apps usa Web Share cuando existe; cancelar o encontrar un error no activa la copia.
- La hoja, Correo y Copiar enlace siguen disponibles sin conexión. Los destinos sociales requieren red y su contenido de terceros nunca entra en la caché de Termia.

## Desarrollo local

Requiere Node.js 20 o posterior. No requiere `npm install`.

```bash
npm run check
npm test
npm start
```

El servidor de desarrollo escucha exclusivamente en `127.0.0.1:4173`.

## Publicación

GitHub Pages construye un artefacto `_site` con una allowlist explícita de 18 archivos públicos; no publica la raíz del repositorio. Todas las rutas de la aplicación son relativas.

El repositorio también incluye una alternativa de despliegue mediante CloudFormation con S3 privado y CloudFront OAC. Es solo infraestructura genérica: no contiene cuentas, ARN, buckets, distribuciones, dominios ni estado de un despliegue real. Consulta [`docs/AWS-DEPLOYMENT.md`](docs/AWS-DEPLOYMENT.md) antes de usarla.

## Estructura

- `index.html`, `css/`: interfaz y estilos same-origin.
- `js/conversion.js`: conversión y validación puras.
- `js/app.js`: presentación del convertidor.
- `js/pwa.js`: WCO, Compartir, instalación, actualización PWA y panel de widgets.
- `js/widgets.js`: renderizador de Adaptive Cards y simulador del panel de widgets (sin dependencias).
- `widgets/`: plantilla, datos y captura del widget «Conversión rápida».
- `sw.js`, `manifest.webmanifest`, `offline.html`: instalación, uso sin conexión y Edge Widgets.
- `herramientas/verificar-widgets.mjs`: prueba de humo del panel en Chrome headless (CDP).
- `infra/`, `scripts/`, `docs/`: alternativa AWS segura y documentación.
- `tests/`: pruebas matemáticas con `node:test`.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
