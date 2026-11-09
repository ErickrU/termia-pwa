# Termia — Convertidor de temperatura

[![CI Pipeline](https://github.com/ErickrU/termia-pwa/actions/workflows/ci.yml/badge.svg)](https://github.com/ErickrU/termia-pwa/actions/workflows/ci.yml)

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
- Sincronización en segundo plano: el service worker (`termia-v5`) refresca el app shell y el widget con la API de sincronización periódica y reintenta sin red con la API de sincronización en segundo plano. El diálogo de ayuda ofrece «Buscar actualizaciones» y el pie muestra la última sincronización.

## Sincronización en segundo plano

Sigue la guía de Microsoft Edge [Sincronización y actualización de una PWA en segundo plano](https://learn.microsoft.com/es-es/microsoft-edge/progressive-web-apps/how-to/background-syncs). Termia no tiene servidor ni datos de usuario que enviar, así que usa estas API para mantener fresca su copia sin conexión:

- **Sincronización periódica** (`periodicsync`, etiqueta `termia-refresco`, `minInterval` de 24 h): la página la registra tras `navigator.serviceWorker.ready` solo si existe `registration.periodicSync` y el permiso `periodic-background-sync` ya está `granted` (lo concede el navegador según el uso de la app instalada; nunca se pide). El service worker vuelve a descargar los 18 recursos del shell con `cache: 'reload'`, sustituye cada copia solo si la respuesta es correcta, refresca `widgets/*.json`, vuelve a pintar el widget con `updateByTag` y guarda la marca del último refresco como `Response` JSON en la caché `termia-sync-v1`, que sobrevive a los cambios de versión.
- **Sincronización en segundo plano** (`sync`, etiqueta `termia-reintento`): reintento diferido. Si un refresco falla sin red, el service worker registra la etiqueta y el navegador vuelve a disparar el evento cuando hay conexión. «Buscar actualizaciones» hace lo mismo desde la página cuando `navigator.onLine` es `false` y anuncia «Sin conexión: Termia se actualizará automáticamente cuando vuelva la red» (el patrón «se intentará más tarde» de la demo de la guía).
- **Captura en segundo plano** (Background Fetch): descartada. Termia no descarga archivos grandes; la copia completa del shell cabe en la precarga del service worker.

Con red, «Buscar actualizaciones» envía `{ tipo: 'REFRESCAR' }` al service worker, que responde `{ tipo: 'REFRESCADO', ok, cuando }`; el pie muestra «Última sincronización: hace X» con `Intl.RelativeTimeFormat('es')`. Todo está detrás de comprobaciones de capacidad (`registration.sync`, `registration.periodicSync`, `navigator.permissions`): en Safari o Firefox la app se comporta igual que antes y sin errores de consola. Las dos API funcionan en navegadores basados en Chromium (Microsoft Edge, Google Chrome) con la app instalada.

Para probarlo sin esperar al intervalo, como describe la guía: DevTools → Application → Service Workers, escribe `termia-reintento` en el campo **Sync** o `termia-refresco` en **Periodic Sync** y pulsa el botón correspondiente; Application → Background Sync / Periodic Background Sync registra la actividad. También puedes ejecutar la prueba de humo `node herramientas/verificar-sincronizacion.mjs --url http://localhost:8171/ --cdp 9431`, que simula esos mismos eventos por CDP.

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
- `js/pwa.js`: WCO, Compartir, instalación, actualización PWA, sincronización en segundo plano y panel de widgets.
- `js/widgets.js`: renderizador de Adaptive Cards y simulador del panel de widgets (sin dependencias).
- `widgets/`: plantilla, datos y captura del widget «Conversión rápida».
- `sw.js`, `manifest.webmanifest`, `offline.html`: instalación, uso sin conexión, Edge Widgets y eventos `periodicsync`/`sync`.
- `herramientas/verificar-widgets.mjs`, `herramientas/verificar-sincronizacion.mjs`: pruebas de humo en Chrome headless (CDP) del panel de widgets y de la sincronización en segundo plano.
- `infra/`, `scripts/`, `docs/`: alternativa AWS segura y documentación.
- `tests/`: pruebas matemáticas con `node:test`.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
