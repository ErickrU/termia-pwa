#!/usr/bin/env bash
# Verifica de forma anónima una publicación HTTPS de Termia.
set -euo pipefail

URL="${1:-}"
[[ "$URL" == https://* ]] || { printf 'Uso: %s https://dominio\n' "$0" >&2; exit 1; }
URL="${URL%/}"
HTTP_URL="http://${URL#https://}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RETRY=(--retry 18 --retry-delay 10 --retry-all-errors)

printf 'Verificando publicación anónima de Termia...\n'
HTTP_STATUS="$(curl --silent --head "${RETRY[@]}" --dump-header "$TMP_DIR/http-headers" \
  --output /dev/null --write-out '%{http_code}' "$HTTP_URL/" 2>/dev/null)"
[[ "$HTTP_STATUS" =~ ^30[1278]$ ]] || { printf 'ERROR: HTTP no redirige a HTTPS.\n' >&2; exit 1; }
grep -Eiq '^location:[[:space:]]*https://' "$TMP_DIR/http-headers" || {
  printf 'ERROR: la redirección no apunta a HTTPS.\n' >&2
  exit 1
}

curl --fail --silent --show-error "${RETRY[@]}" --dump-header "$TMP_DIR/index-headers" \
  --output "$TMP_DIR/index.html" "$URL/"
grep -Fq '<title>Termia — Convertidor de temperatura</title>' "$TMP_DIR/index.html" || {
  printf 'ERROR: index.html no corresponde a Termia.\n' >&2
  exit 1
}

grep -Eiq '^content-security-policy:' "$TMP_DIR/index-headers" || { printf 'ERROR: falta CSP.\n' >&2; exit 1; }
grep -Eiq '^x-frame-options:[[:space:]]*DENY' "$TMP_DIR/index-headers" || { printf 'ERROR: falta X-Frame-Options: DENY.\n' >&2; exit 1; }
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' "$TMP_DIR/index-headers" || { printf 'ERROR: falta nosniff.\n' >&2; exit 1; }
grep -Eiq '^strict-transport-security:[[:space:]]*max-age=47304000' "$TMP_DIR/index-headers" || { printf 'ERROR: falta HSTS esperado.\n' >&2; exit 1; }
grep -Eiq '^referrer-policy:[[:space:]]*strict-origin-when-cross-origin' "$TMP_DIR/index-headers" || { printf 'ERROR: falta Referrer Policy.\n' >&2; exit 1; }
grep -Eiq '^permissions-policy:.*clipboard-write=\(self\)' "$TMP_DIR/index-headers" || { printf 'ERROR: falta permiso same-origin para clipboard.\n' >&2; exit 1; }
grep -Eiq '^permissions-policy:.*web-share=\(self\)' "$TMP_DIR/index-headers" || { printf 'ERROR: falta permiso same-origin para Web Share.\n' >&2; exit 1; }
! grep -Eiq '^x-xss-protection:' "$TMP_DIR/index-headers" || { printf 'ERROR: está presente X-XSS-Protection obsoleto.\n' >&2; exit 1; }
! grep -Eiq '^content-security-policy:.*unsafe-(inline|eval)' "$TMP_DIR/index-headers" || { printf 'ERROR: CSP contiene una excepción insegura.\n' >&2; exit 1; }

check_asset() {
  local path="$1"
  local expected_type="$2"
  local output="$TMP_DIR/${path//\//-}"
  local headers="$output.headers"
  curl --fail --silent --show-error "${RETRY[@]}" --dump-header "$headers" \
    --output "$output" "$URL/$path"
  grep -Eiq "^content-type:[[:space:]]*$expected_type" "$headers" || {
    printf 'ERROR: Content-Type inesperado para %s.\n' "$path" >&2
    exit 1
  }
  printf '  ✓ %s\n' "$path"
}

check_asset 'offline.html' 'text/html'
check_asset 'manifest.webmanifest' 'application/manifest\+json'
check_asset 'sw.js' '(text|application)/javascript'
check_asset 'css/estilos.css' 'text/css'
check_asset 'css/offline.css' 'text/css'
check_asset 'js/app.js' '(text|application)/javascript'
check_asset 'js/conversion.js' '(text|application)/javascript'
check_asset 'js/pwa.js' '(text|application)/javascript'
check_asset 'iconos/favicon.svg' 'image/svg\+xml'
check_asset 'iconos/icono-192.png' 'image/png'
check_asset 'iconos/icono-512.png' 'image/png'
check_asset 'iconos/icono-maskable-512.png' 'image/png'
check_asset 'iconos/apple-touch-icon.png' 'image/png'

node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" \
  "$TMP_DIR/manifest.webmanifest"
node --check "$TMP_DIR/sw.js" >/dev/null
! grep -Eiq '<style([[:space:]>])|style=' "$TMP_DIR/offline.html" || {
  printf 'ERROR: offline.html contiene estilos inline.\n' >&2
  exit 1
}

printf '  ✓ HTTPS, cabeceras, PWA e iconos\n'
printf 'Sitio publicado correctamente.\n'
