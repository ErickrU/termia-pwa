#!/usr/bin/env bash
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "No se encontró Google Chrome en: $CHROME" >&2
  exit 1
fi

generar() {
  local fuente="$1"
  local salida="$2"
  local tamano="$3"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=1 --window-size="${tamano},${tamano}" \
    --screenshot="$salida" "file://${fuente}" >/dev/null 2>&1
}

generar "$RAIZ/iconos/icono.svg" "$RAIZ/iconos/icono-192.png" 192
generar "$RAIZ/iconos/icono.svg" "$RAIZ/iconos/icono-512.png" 512
generar "$RAIZ/iconos/icono-maskable.svg" "$RAIZ/iconos/icono-maskable-512.png" 512
generar "$RAIZ/iconos/icono.svg" "$RAIZ/iconos/apple-touch-icon.png" 180

echo "Iconos PNG generados con Google Chrome."
