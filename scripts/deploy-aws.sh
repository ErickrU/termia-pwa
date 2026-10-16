#!/usr/bin/env bash
# Prepara y ejecuta únicamente una creación trazable de Termia.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$ROOT/infra/cloudformation.yaml"
STACK_POLICY="$ROOT/infra/stack-policy.json"
VALIDATOR="$ROOT/scripts/validate-aws-proof.mjs"
ATTEMPTS_ROOT="$ROOT/.aws-attempts"
CHANGE_STATE="$ROOT/.aws-change-set.json"
DEPLOYMENT_STATE="$ROOT/.aws-deployment.json"
TARGET_STACK='termia-pwa-public-prod'
ENVIRONMENT='prod'
PRICE_CLASS='PriceClass_100'
MARKER='termia-pwa-cloudfront-oac-v1'
PROJECT='termia-pwa'
REPOSITORY='ErickrU-termia-pwa'

PHASE=''
PROFILE=''
REGION=''
CONFIRM_COMMIT_SHA=''
CONFIRM_IDENTITY_SHA=''
HEAD_SHA=''
TEMPLATE_SHA=''
ATTEMPT_DIR=''
CAPTURE_EXIT=0

usage() {
  cat <<'USAGE'
Revisar hashes sin cambiar infraestructura:
  ./scripts/deploy-aws.sh --phase review \
    --profile <YOUR_AWS_PROFILE> --region <YOUR_AWS_REGION>

Preparar el único target CREATE propuesto sin ejecutarlo:
  ./scripts/deploy-aws.sh --phase prepare \
    --profile <YOUR_AWS_PROFILE> --region <YOUR_AWS_REGION> \
    --confirm-commit-sha <APPROVED_COMMIT_SHA> \
    --confirm-identity-sha <APPROVED_IDENTITY_SHA256>

Ejecutar únicamente el change set ya preparado y revalidado:
  ./scripts/deploy-aws.sh --phase execute \
    --profile <YOUR_AWS_PROFILE> --region <YOUR_AWS_REGION> \
    --confirm-commit-sha <APPROVED_COMMIT_SHA> \
    --confirm-identity-sha <APPROVED_IDENTITY_SHA256>

Opciones:
  --phase FASE                 review | prepare | execute
  --profile PERFIL             Perfil temporal explícito
  --region REGION              Región explícita
  --confirm-commit-sha SHA     Commit aprobado y limpio
  --confirm-identity-sha SHA   Hash canónico aprobado de identidad/profile/región
  -h, --help                   Muestra esta ayuda

El stack, entorno, price class, nombre del change set y client token son internos.
Si termia-pwa-public-prod ya existe, el resultado siempre es STOP: nunca update,
cambio automático de nombre, eliminación ni limpieza.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) [[ $# -ge 2 ]] || fail 'Falta el valor de --phase.'; PHASE="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || fail 'Falta el valor de --profile.'; PROFILE="$2"; shift 2 ;;
    --region) [[ $# -ge 2 ]] || fail 'Falta el valor de --region.'; REGION="$2"; shift 2 ;;
    --confirm-commit-sha) [[ $# -ge 2 ]] || fail 'Falta el valor de --confirm-commit-sha.'; CONFIRM_COMMIT_SHA="$2"; shift 2 ;;
    --confirm-identity-sha) [[ $# -ge 2 ]] || fail 'Falta el valor de --confirm-identity-sha.'; CONFIRM_IDENTITY_SHA="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Argumento desconocido: $1" ;;
  esac
done

[[ "$PHASE" =~ ^(review|prepare|execute)$ ]] || fail '--phase debe ser review, prepare o execute.'
[[ "$PROFILE" =~ ^[A-Za-z0-9_+=,.@-]{1,128}$ ]] || fail 'Debes indicar un --profile explícito válido.'
[[ "$REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail 'La región no tiene un formato válido.'

for tool in aws node curl git jq shasum cmp; do
  command -v "$tool" >/dev/null 2>&1 || fail "No se encontró $tool en PATH."
done

AWS=(aws --profile "$PROFILE" --region "$REGION" --no-cli-pager)

PUBLIC_FILES=(
  index.html
  offline.html
  manifest.webmanifest
  sw.js
  css/estilos.css
  css/offline.css
  js/app.js
  js/conversion.js
  js/pwa.js
  iconos/favicon.svg
  iconos/icono-192.png
  iconos/icono-512.png
  iconos/icono-maskable-512.png
  iconos/apple-touch-icon.png
)

validate_local() {
  [[ -f "$TEMPLATE" ]] || fail 'Falta la plantilla CloudFormation.'
  [[ -f "$STACK_POLICY" ]] || fail 'Falta la stack policy.'
  [[ -f "$VALIDATOR" ]] || fail 'Falta el validador local.'
  [[ -x "$ROOT/scripts/verify-site.sh" ]] || fail 'verify-site.sh debe ser ejecutable.'

  local relative
  for relative in "${PUBLIC_FILES[@]}"; do
    [[ -f "$ROOT/$relative" ]] || fail "Falta un archivo publicable: $relative"
    [[ ! -L "$ROOT/$relative" ]] || fail "No se publican enlaces simbólicos: $relative"
  done

  local script
  for script in "$ROOT"/js/*.js "$ROOT/sw.js" "$ROOT/herramientas/servidor.mjs" "$ROOT/scripts/aws-proof.mjs" "$VALIDATOR"; do
    node --check "$script" >/dev/null
  done
  node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" "$ROOT/manifest.webmanifest"
  bash -n "$ROOT/scripts/verify-site.sh"
  node "$VALIDATOR" check-template --template "$TEMPLATE" >/dev/null

  local control_count share_count
  control_count="$(grep -o 'data-control-ventana' "$ROOT/index.html" | wc -l | tr -d ' ')"
  share_count="$(grep -o 'id="control-compartir"' "$ROOT/index.html" | wc -l | tr -d ' ')"
  [[ "$control_count" == '5' ]] || fail 'La aplicación debe conservar exactamente cinco controles WCO.'
  [[ "$share_count" == '1' ]] || fail 'La aplicación debe conservar exactamente un control Compartir.'
  ! grep -Eiq '<style([[:space:]>])|style=' "$ROOT/offline.html" || fail 'offline.html contiene CSS inline.'
  ! grep -Eiq 'unsafe-inline|unsafe-eval' "$TEMPLATE" || fail 'La plantilla contiene una excepción CSP insegura.'

  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]] || fail 'El repositorio debe estar limpio antes de usar AWS.'
  HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
  [[ "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'No se pudo determinar HEAD.'
  read -r TEMPLATE_SHA _ < <(shasum -a 256 "$TEMPLATE")
  [[ "$TEMPLATE_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'No se pudo calcular el SHA-256 de la plantilla.'
}

write_once_from_command() {
  local output="$1"
  shift
  [[ ! -e "$output" ]] || fail 'Un archivo de evidencia ya existe; no se sobrescribirá.'
  set -o noclobber
  if "$@" >"$output"; then
    set +o noclobber
  else
    local result=$?
    set +o noclobber
    return "$result"
  fi
  chmod 600 "$output"
  [[ "$(file_mode "$output")" == '600' ]] || fail 'No se pudo proteger un archivo de evidencia.'
}

capture_command_at() {
  local prefix="$1"
  local requested_at="$2"
  shift 2
  local stdout_file="$ATTEMPT_DIR/$prefix.stdout"
  local stderr_file="$ATTEMPT_DIR/$prefix.stderr"
  local capture_file="$ATTEMPT_DIR/$prefix.capture.json"
  local responded_at result
  [[ "$requested_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail 'El inicio capturado debe ser UTC.'
  [[ ! -e "$stdout_file" && ! -e "$stderr_file" && ! -e "$capture_file" ]] || fail 'La evidencia es write-once; no se sobrescribirá.'
  set -o noclobber
  if "$@" >"$stdout_file" 2>"$stderr_file"; then
    result=0
  else
    result=$?
  fi
  set +o noclobber
  responded_at="$(utc_now)"
  chmod 600 "$stdout_file" "$stderr_file"
  node "$VALIDATOR" capture-record \
    --output "$capture_file" \
    --requested-at "$requested_at" \
    --responded-at "$responded_at" \
    --exit-code "$result" \
    --stdout "$stdout_file" \
    --stderr "$stderr_file" >/dev/null
  CAPTURE_EXIT="$result"
}

capture_command() {
  local prefix="$1"
  shift
  capture_command_at "$prefix" "$(utc_now)" "$@"
}

require_capture_success() {
  [[ "$CAPTURE_EXIT" == '0' ]] || fail "$1"
}

require_confirmations() {
  [[ "$CONFIRM_COMMIT_SHA" =~ ^[a-f0-9]{40}$ && "$CONFIRM_COMMIT_SHA" == "$HEAD_SHA" ]] || fail 'El commit confirmado no coincide con HEAD limpio.'
  [[ "$CONFIRM_IDENTITY_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'Debes aportar el hash canónico de identidad aprobado.'
}

review_hashes() {
  local review_directory identity_hash
  review_directory="$(mktemp -d)"
  chmod 700 "$review_directory"
  ATTEMPT_DIR="$review_directory"
  trap 'rm -rf "$review_directory"' EXIT

  capture_command cli-skeleton "${AWS[@]}" cloudformation create-change-set --generate-cli-skeleton input
  require_capture_success 'AWS CLI v2 no pudo generar el skeleton local.'
  node "$VALIDATOR" check-skeleton --skeleton "$ATTEMPT_DIR/cli-skeleton.stdout" >/dev/null

  capture_command identity "${AWS[@]}" sts get-caller-identity --output json
  require_capture_success 'No se pudo verificar la identidad activa.'
  jq -n --arg profile "$PROFILE" --arg region "$REGION" '{profile: $profile, region: $region}' >"$review_directory/review-context.json"
  chmod 600 "$review_directory/review-context.json"
  identity_hash="$(node "$VALIDATOR" identity-hash --attempt "$review_directory/review-context.json" --identity "$review_directory/identity.stdout")"
  [[ "$identity_hash" =~ ^[a-f0-9]{64}$ ]] || fail 'No se pudo generar el hash de identidad.'

  printf 'Validación local: OK\n'
  printf 'Target propuesto ausente: no determinado; prepare debe demostrarlo o hacer STOP.\n'
  printf 'Commit SHA aprobado: %s\n' "$HEAD_SHA"
  printf 'Template SHA-256: %s\n' "$TEMPLATE_SHA"
  printf 'Identity SHA-256: %s\n' "$identity_hash"
  printf 'MODO REVIEW: no se creó, actualizó ni eliminó infraestructura.\n'
  rm -rf "$review_directory"
  trap - EXIT
}

collect_cloudtrail_event() {
  local kind="$1"
  local event_name="$2"
  local output_name="$3"
  local attempt_file="$ATTEMPT_DIR/attempt.json"
  local identity_file="$ATTEMPT_DIR/identity.json"
  local start_time end_time suffix selection_result
  start_time="$(jq -er '.createdAt' "$attempt_file")"

  local index
  for index in {1..30}; do
    printf -v suffix '%02d' "$index"
    end_time="$(utc_now)"
    capture_command "cloudtrail-${kind}-${suffix}" "${AWS[@]}" cloudtrail lookup-events \
      --lookup-attributes "AttributeKey=EventName,AttributeValue=$event_name" \
      --start-time "$start_time" --end-time "$end_time" --max-results 50 --output json
    if [[ "$CAPTURE_EXIT" == '0' ]]; then
      if [[ "$kind" == 'absence' ]]; then
        if node "$VALIDATOR" select-cloudtrail \
          --kind "$kind" \
          --attempt "$attempt_file" \
          --identity "$identity_file" \
          --attempt-dir "$ATTEMPT_DIR" \
          --probe-prefix preflight-describe-stacks \
          --input "$ATTEMPT_DIR/cloudtrail-${kind}-${suffix}.stdout" \
          --output "$ATTEMPT_DIR/$output_name" >/dev/null 2>/dev/null; then
          selection_result=0
        else
          selection_result=$?
        fi
      else
        if node "$VALIDATOR" select-cloudtrail \
          --kind "$kind" \
          --attempt "$attempt_file" \
          --identity "$identity_file" \
          --input "$ATTEMPT_DIR/cloudtrail-${kind}-${suffix}.stdout" \
          --output "$ATTEMPT_DIR/$output_name" >/dev/null 2>/dev/null; then
          selection_result=0
        else
          selection_result=$?
        fi
      fi
      if [[ "$selection_result" == '0' ]]; then
        return 0
      fi
      [[ "$selection_result" != '2' ]] || fail 'CloudTrail devolvió evidencia ambigua; STOP.'
    fi
    [[ "$index" == '30' ]] || sleep 10
  done
  fail 'CloudTrail no devolvió una correlación única dentro de la ventana permitida; el intento queda intacto.'
}

capture_snapshot() {
  local prefix="$1"
  local stack_id="$2"
  local change_set_id="$3"

  capture_command "$prefix-describe-change-set" "${AWS[@]}" cloudformation describe-change-set \
    --change-set-name "$change_set_id" --stack-name "$stack_id" --output json
  require_capture_success 'No se pudo describir el change set exacto.'
  capture_command "$prefix-list-change-sets" "${AWS[@]}" cloudformation list-change-sets \
    --stack-name "$stack_id" --output json
  require_capture_success 'No se pudo enumerar los change sets del placeholder.'
  capture_command "$prefix-describe-stacks" "${AWS[@]}" cloudformation describe-stacks \
    --stack-name "$stack_id" --output json
  require_capture_success 'No se pudo describir el placeholder.'
  capture_command "$prefix-list-stack-resources" "${AWS[@]}" cloudformation list-stack-resources \
    --stack-name "$stack_id" --output json
  require_capture_success 'No se pudo demostrar que el placeholder esté vacío.'
  capture_command "$prefix-get-change-template" "${AWS[@]}" cloudformation get-template \
    --change-set-name "$change_set_id" --stack-name "$stack_id" --template-stage Original --output json
  require_capture_success 'No se pudo recuperar el template exacto del change set.'
  capture_command "$prefix-get-stack-template" "${AWS[@]}" cloudformation get-template \
    --stack-name "$stack_id" --template-stage Original --output json
  [[ "$CAPTURE_EXIT" != '0' ]] || fail 'El placeholder ya tiene un template aplicado; STOP.'
}

output_value() {
  local stack_file="$1"
  local key="$2"
  jq -er --arg key "$key" '.Stacks[0].Outputs[] | select(.OutputKey == $key) | .OutputValue' "$stack_file"
}

validate_local

if [[ "$PHASE" == 'review' ]]; then
  review_hashes
  exit 0
fi

require_confirmations

if [[ "$PHASE" == 'prepare' ]]; then
  [[ ! -e "$CHANGE_STATE" ]] || fail 'Ya existe un intento preparado; no se creará otro.'
  [[ ! -e "$DEPLOYMENT_STATE" ]] || fail 'Ya existe estado de despliegue; no se creará otro.'

  ATTEMPT_DIR="$(node "$VALIDATOR" init-attempt \
    --attempts-root "$ATTEMPTS_ROOT" \
    --template "$TEMPLATE" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --commit-sha "$HEAD_SHA" \
    --confirm-commit-sha "$CONFIRM_COMMIT_SHA" \
    --confirm-identity-sha "$CONFIRM_IDENTITY_SHA")"
  [[ "$ATTEMPT_DIR" == "$ATTEMPTS_ROOT/"* && "$(file_mode "$ATTEMPT_DIR")" == '700' ]] || fail 'No se pudo proteger el intento.'

  write_once_from_command "$ATTEMPT_DIR/commit-template.yaml" git -C "$ROOT" show "$HEAD_SHA:infra/cloudformation.yaml" || fail 'No se pudo conservar la plantilla del commit.'
  cmp -s "$ATTEMPT_DIR/submitted-template.yaml" "$ATTEMPT_DIR/commit-template.yaml" || fail 'La plantilla local difiere del commit aprobado.'

  capture_command cli-skeleton "${AWS[@]}" cloudformation create-change-set --generate-cli-skeleton input
  require_capture_success 'AWS CLI v2 no pudo generar el skeleton local.'
  node "$VALIDATOR" check-skeleton --skeleton "$ATTEMPT_DIR/cli-skeleton.stdout" >/dev/null

  capture_command identity "${AWS[@]}" sts get-caller-identity --output json
  require_capture_success 'No se pudo verificar la identidad activa.'
  node "$VALIDATOR" normalize-identity \
    --attempt "$ATTEMPT_DIR/attempt.json" \
    --identity "$ATTEMPT_DIR/identity.stdout" \
    --output "$ATTEMPT_DIR/identity.json"
  IDENTITY_HASH="$(node "$VALIDATOR" identity-hash --attempt "$ATTEMPT_DIR/attempt.json" --identity "$ATTEMPT_DIR/identity.json")"
  [[ "$IDENTITY_HASH" == "$CONFIRM_IDENTITY_SHA" ]] || fail 'La identidad activa no coincide con el hash aprobado; STOP.'

  capture_command preflight-describe-stacks "${AWS[@]}" --debug cloudformation describe-stacks \
    --stack-name "$TARGET_STACK" --output json
  node "$VALIDATOR" check-absence \
    --attempt-dir "$ATTEMPT_DIR" --prefix preflight-describe-stacks --operation DescribeStacks \
    --attempt "$ATTEMPT_DIR/attempt.json" --identity "$ATTEMPT_DIR/identity.json" >/dev/null || \
    fail 'El target existe, su ausencia es ambigua o falta el request ID exacto; STOP sin update ni nombre alternativo.'

  capture_command preflight-list-change-sets "${AWS[@]}" cloudformation list-change-sets \
    --stack-name "$TARGET_STACK" --output json
  node "$VALIDATOR" check-absence \
    --attempt-dir "$ATTEMPT_DIR" --prefix preflight-list-change-sets --operation ListChangeSets \
    --attempt "$ATTEMPT_DIR/attempt.json" --identity "$ATTEMPT_DIR/identity.json" >/dev/null || \
    fail 'La segunda fuente no demuestra ausencia; STOP sin crear.'

  node "$VALIDATOR" create-request \
    --attempt "$ATTEMPT_DIR/attempt.json" \
    --identity "$ATTEMPT_DIR/identity.json" \
    --output "$ATTEMPT_DIR/create-request.json"
  CHANGE_SET_NAME="$(jq -er '.changeSetName' "$ATTEMPT_DIR/attempt.json")"
  CLIENT_TOKEN="$(jq -er '.clientToken' "$ATTEMPT_DIR/attempt.json")"
  DEPLOYMENT_ID="$(jq -er '.parameters[] | select(.ParameterKey == "DeploymentId") | .ParameterValue' "$ATTEMPT_DIR/create-request.json")"

  info 'Creando un change set CREATE trazable sin ejecutarlo'
  capture_command create-change-set "${AWS[@]}" cloudformation create-change-set \
    --stack-name "$TARGET_STACK" \
    --change-set-name "$CHANGE_SET_NAME" \
    --change-set-type CREATE \
    --client-token "$CLIENT_TOKEN" \
    --on-stack-failure DO_NOTHING \
    --description "Termia template $TEMPLATE_SHA" \
    --template-body "file://$TEMPLATE" \
    --parameters \
      "ParameterKey=ProjectSlug,ParameterValue=$PROJECT" \
      "ParameterKey=Environment,ParameterValue=$ENVIRONMENT" \
      "ParameterKey=DeploymentId,ParameterValue=$DEPLOYMENT_ID" \
      "ParameterKey=PriceClass,ParameterValue=$PRICE_CLASS" \
    --tags \
      "Key=Project,Value=$PROJECT" \
      "Key=Environment,Value=$ENVIRONMENT" \
      'Key=ManagedBy,Value=CloudFormation' \
      "Key=Repository,Value=$REPOSITORY" \
      "Key=DeploymentId,Value=$DEPLOYMENT_ID" \
    --output json
  require_capture_success 'No se pudo preparar el change set; el intento queda intacto.'
  CHANGE_SET_ID="$(jq -er '.Id' "$ATTEMPT_DIR/create-change-set.stdout")" || fail 'La respuesta no contiene el change set ID.'
  STACK_ID="$(jq -er '.StackId' "$ATTEMPT_DIR/create-change-set.stdout")" || fail 'La respuesta no contiene el stack ID.'

  capture_command wait-change-set "${AWS[@]}" cloudformation wait change-set-create-complete \
    --change-set-name "$CHANGE_SET_ID" --stack-name "$STACK_ID"
  require_capture_success 'El change set no alcanzó CREATE_COMPLETE; el intento queda intacto.'

  collect_cloudtrail_event absence DescribeStacks cloudtrail-describe-event.json
  collect_cloudtrail_event create CreateChangeSet cloudtrail-create-event.json
  capture_snapshot prepare "$STACK_ID" "$CHANGE_SET_ID"

  node "$VALIDATOR" seal --attempt-dir "$ATTEMPT_DIR" --output-name chain-input-prepare.json
  node "$VALIDATOR" build \
    --phase prepare --attempt-dir "$ATTEMPT_DIR" \
    --input-chain "$ATTEMPT_DIR/chain-input-prepare.json" \
    --output "$ATTEMPT_DIR/proof-prepare.json"
  node "$VALIDATOR" validate \
    --phase prepare \
    --evidence "$ATTEMPT_DIR/proof-prepare.json" \
    --template "$TEMPLATE" \
    --commit-template "$ATTEMPT_DIR/commit-template.yaml" \
    --chain "$ATTEMPT_DIR/chain-input-prepare.json" \
    --expected-commit-sha "$CONFIRM_COMMIT_SHA" \
    --expected-identity-sha "$CONFIRM_IDENTITY_SHA" \
    --summary-output "$ATTEMPT_DIR/summary-prepare.json" >/dev/null
  node "$VALIDATOR" report \
    --evidence "$ATTEMPT_DIR/proof-prepare.json" \
    --chain "$ATTEMPT_DIR/chain-input-prepare.json" \
    --summary "$ATTEMPT_DIR/summary-prepare.json" \
    --output "$ATTEMPT_DIR/shareable-prepare.json"
  node "$VALIDATOR" seal \
    --attempt-dir "$ATTEMPT_DIR" --output-name chain-prepare.json \
    --previous "$ATTEMPT_DIR/chain-input-prepare.json"
  node "$VALIDATOR" pointer \
    --evidence "$ATTEMPT_DIR/proof-prepare.json" \
    --attempt-dir "$ATTEMPT_DIR" --output "$CHANGE_STATE"
  node "$VALIDATOR" check-permissions --attempt-dir "$ATTEMPT_DIR"
  [[ "$(file_mode "$CHANGE_STATE")" == '600' ]] || fail 'El puntero privado debe tener modo 0600.'

  printf 'Change set CREATE preparado y validado; no fue ejecutado.\n'
  printf 'Evidencia privada write-once preservada; el reporte compartible contiene solo hashes y booleanos.\n'
  exit 0
fi

[[ -f "$CHANGE_STATE" && "$(file_mode "$CHANGE_STATE")" == '600' ]] || fail 'Falta el puntero privado 0600 del intento preparado.'
[[ ! -e "$DEPLOYMENT_STATE" ]] || fail 'Ya existe estado local de despliegue; no se ejecutará otro.'
ATTEMPT_POINTER="$(jq -er '.attemptDirectory' "$CHANGE_STATE")"
[[ -d "$ATTEMPT_POINTER" && ! -L "$ATTEMPT_POINTER" ]] || fail 'El puntero no identifica un directorio regular.'
ATTEMPTS_REAL="$(cd "$ATTEMPTS_ROOT" && pwd -P)"
ATTEMPT_DIR="$(cd "$ATTEMPT_POINTER" && pwd -P)"
ATTEMPT_NAME="${ATTEMPT_DIR##*/}"
[[ "${ATTEMPT_DIR%/*}" == "$ATTEMPTS_REAL" && "$ATTEMPT_NAME" =~ ^[a-f0-9-]{36}$ ]] || fail 'El puntero sale del directorio privado permitido.'
[[ "$(file_mode "$ATTEMPT_DIR")" == '700' ]] || fail 'El directorio del intento debe tener modo 0700.'
node "$VALIDATOR" check-permissions --attempt-dir "$ATTEMPT_DIR"
node "$VALIDATOR" verify-chain --attempt-dir "$ATTEMPT_DIR" --chain "$ATTEMPT_DIR/chain-input-prepare.json" >/dev/null
node "$VALIDATOR" verify-chain --attempt-dir "$ATTEMPT_DIR" --chain "$ATTEMPT_DIR/chain-prepare.json" >/dev/null
read -r PREPARE_PROOF_SHA _ < <(shasum -a 256 "$ATTEMPT_DIR/proof-prepare.json")
[[ "$PREPARE_PROOF_SHA" == "$(jq -er '.prepareEvidenceSha256' "$CHANGE_STATE")" ]] || fail 'La evidencia prepare cambió; STOP.'

jq -e \
  --arg stack "$TARGET_STACK" \
  --arg profile "$PROFILE" \
  --arg region "$REGION" \
  --arg commit "$CONFIRM_COMMIT_SHA" \
  --arg identity "$CONFIRM_IDENTITY_SHA" \
  --arg template "$TEMPLATE_SHA" \
  '.stackName == $stack and .profile == $profile and .region == $region and
   .commitSha == $commit and .identitySha256 == $identity and .templateSha256 == $template and
   (.stackId | type == "string") and (.changeSetId | type == "string") and
   (.clientToken | type == "string")' "$CHANGE_STATE" >/dev/null || fail 'El puntero no coincide con esta ejecución.'
cmp -s "$TEMPLATE" "$ATTEMPT_DIR/submitted-template.yaml" || fail 'La plantilla cambió después de prepare.'
write_once_from_command "$ATTEMPT_DIR/toctou-commit-template.yaml" git -C "$ROOT" show "$HEAD_SHA:infra/cloudformation.yaml" || fail 'No se pudo releer la plantilla aprobada.'
cmp -s "$TEMPLATE" "$ATTEMPT_DIR/toctou-commit-template.yaml" || fail 'HEAD ya no contiene la plantilla aprobada.'

STACK_ID="$(jq -er '.stackId' "$CHANGE_STATE")"
CHANGE_SET_ID="$(jq -er '.changeSetId' "$CHANGE_STATE")"

capture_command toctou-identity "${AWS[@]}" sts get-caller-identity --output json
require_capture_success 'No se pudo verificar la identidad inmediatamente antes de execute.'
TOCTOU_IDENTITY_HASH="$(node "$VALIDATOR" identity-hash --attempt "$ATTEMPT_DIR/attempt.json" --identity "$ATTEMPT_DIR/toctou-identity.stdout")"
[[ "$TOCTOU_IDENTITY_HASH" == "$CONFIRM_IDENTITY_SHA" ]] || fail 'La identidad cambió antes de execute; STOP.'

capture_snapshot toctou "$STACK_ID" "$CHANGE_SET_ID"
node "$VALIDATOR" seal \
  --attempt-dir "$ATTEMPT_DIR" --output-name chain-input-execute.json \
  --previous "$ATTEMPT_DIR/chain-prepare.json"
node "$VALIDATOR" build \
  --phase execute --attempt-dir "$ATTEMPT_DIR" \
  --input-chain "$ATTEMPT_DIR/chain-input-execute.json" \
  --output "$ATTEMPT_DIR/proof-execute.json"
node "$VALIDATOR" validate \
  --phase execute \
  --evidence "$ATTEMPT_DIR/proof-execute.json" \
  --template "$TEMPLATE" \
  --commit-template "$ATTEMPT_DIR/commit-template.yaml" \
  --chain "$ATTEMPT_DIR/chain-input-execute.json" \
  --expected-commit-sha "$CONFIRM_COMMIT_SHA" \
  --expected-identity-sha "$CONFIRM_IDENTITY_SHA" \
  --summary-output "$ATTEMPT_DIR/summary-execute.json" >/dev/null
node "$VALIDATOR" report \
  --evidence "$ATTEMPT_DIR/proof-execute.json" \
  --chain "$ATTEMPT_DIR/chain-input-execute.json" \
  --summary "$ATTEMPT_DIR/summary-execute.json" \
  --output "$ATTEMPT_DIR/shareable-execute.json"
node "$VALIDATOR" seal \
  --attempt-dir "$ATTEMPT_DIR" --output-name chain-execute-reviewed.json \
  --previous "$ATTEMPT_DIR/chain-input-execute.json"

info 'Ejecutando exactamente el change set CREATE validado'
EXECUTE_REQUESTED_AT="$(utc_now)"
node "$VALIDATOR" guard-execute \
  --phase execute \
  --evidence "$ATTEMPT_DIR/proof-execute.json" \
  --template "$TEMPLATE" \
  --commit-template "$ATTEMPT_DIR/commit-template.yaml" \
  --chain "$ATTEMPT_DIR/chain-input-execute.json" \
  --pointer "$CHANGE_STATE" \
  --attempt "$ATTEMPT_DIR/attempt.json" \
  --expected-commit-sha "$CONFIRM_COMMIT_SHA" \
  --expected-identity-sha "$CONFIRM_IDENTITY_SHA" \
  --requested-at "$EXECUTE_REQUESTED_AT" \
  --output "$ATTEMPT_DIR/execute-guard.json"
STACK_ID="$(jq -er '.execution.stackId' "$ATTEMPT_DIR/execute-guard.json")"
CHANGE_SET_ID="$(jq -er '.execution.changeSetId' "$ATTEMPT_DIR/execute-guard.json")"
CLIENT_TOKEN="$(jq -er '.execution.clientToken' "$ATTEMPT_DIR/execute-guard.json")"
capture_command_at execute-change-set "$EXECUTE_REQUESTED_AT" "${AWS[@]}" cloudformation execute-change-set \
  --change-set-name "$CHANGE_SET_ID" --stack-name "$STACK_ID" \
  --client-request-token "$CLIENT_TOKEN"
node "$VALIDATOR" verify-execute-capture \
  --guard "$ATTEMPT_DIR/execute-guard.json" \
  --capture "$ATTEMPT_DIR/execute-change-set.capture.json" \
  --evidence "$ATTEMPT_DIR/proof-execute.json"
require_capture_success 'CloudFormation no aceptó la ejecución; no se hará cleanup automático.'
capture_command wait-stack-create "${AWS[@]}" cloudformation wait stack-create-complete --stack-name "$STACK_ID"
require_capture_success 'El stack no alcanzó CREATE_COMPLETE; recursos parciales permanecen para recuperación autorizada.'

capture_command post-describe-stacks "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK_ID" --output json
require_capture_success 'No se pudo verificar el stack creado.'
STACK_FILE="$ATTEMPT_DIR/post-describe-stacks.stdout"
jq -e \
  --arg project "$PROJECT" \
  --arg repository "$REPOSITORY" \
  --arg environment "$ENVIRONMENT" \
  --arg marker "$MARKER" \
  '.Stacks[0].StackStatus == "CREATE_COMPLETE" and
   any(.Stacks[0].Tags[]; .Key == "Project" and .Value == $project) and
   any(.Stacks[0].Tags[]; .Key == "Repository" and .Value == $repository) and
   any(.Stacks[0].Tags[]; .Key == "ManagedBy" and .Value == "CloudFormation") and
   any(.Stacks[0].Parameters[]; .ParameterKey == "Environment" and .ParameterValue == $environment) and
   any(.Stacks[0].Outputs[]; .OutputKey == "DeploymentMarker" and .OutputValue == $marker)' \
  "$STACK_FILE" >/dev/null || fail 'La identidad del stack creado no coincide.'

capture_command post-list-stack-resources "${AWS[@]}" cloudformation list-stack-resources --stack-name "$STACK_ID" --output json
require_capture_success 'No se pudieron verificar los recursos creados.'
jq -e '
  (.StackResourceSummaries | length == 5) and
  (([.StackResourceSummaries[].LogicalResourceId] | sort) ==
    ["ContentBucket", "ContentBucketPolicy", "Distribution", "OriginAccessControl", "SecurityHeadersPolicy"]) and
  (([.StackResourceSummaries[].ResourceType] | sort) ==
    ["AWS::CloudFront::Distribution", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::ResponseHeadersPolicy", "AWS::S3::Bucket", "AWS::S3::BucketPolicy"])
' "$ATTEMPT_DIR/post-list-stack-resources.stdout" >/dev/null || fail 'CloudFormation creó recursos inesperados.'

BUCKET="$(output_value "$STACK_FILE" ContentBucketName)"
BUCKET_ARN="$(output_value "$STACK_FILE" ContentBucketArn)"
BUCKET_DOMAIN="$(output_value "$STACK_FILE" ContentBucketRegionalDomainName)"
DISTRIBUTION_ID="$(output_value "$STACK_FILE" DistributionId)"
DISTRIBUTION_ARN="$(output_value "$STACK_FILE" DistributionArn)"
DISTRIBUTION_DOMAIN="$(output_value "$STACK_FILE" DistributionDomainName)"
OAC_ID="$(output_value "$STACK_FILE" OriginAccessControlId)"
HEADERS_POLICY_ID="$(output_value "$STACK_FILE" SecurityHeadersPolicyId)"
SITE_URL="$(output_value "$STACK_FILE" SiteUrl)"
[[ "$SITE_URL" == "https://$DISTRIBUTION_DOMAIN" ]] || fail 'La URL pública no coincide con la distribución.'
ACCOUNT_ID="$(jq -er '.Account' "$ATTEMPT_DIR/identity.stdout")"

capture_command post-list-objects "${AWS[@]}" s3api list-objects-v2 --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --max-keys 1 --output json
require_capture_success 'No se pudo comprobar que el bucket esté vacío.'
[[ "$(jq -er '.KeyCount' "$ATTEMPT_DIR/post-list-objects.stdout")" == '0' ]] || fail 'El bucket nuevo no está vacío; no se publicará contenido.'

info 'Aplicando protecciones antes de publicar contenido público'
capture_command post-set-stack-policy "${AWS[@]}" cloudformation set-stack-policy --stack-name "$STACK_ID" \
  --stack-policy-body "file://$STACK_POLICY"
require_capture_success 'No se pudo aplicar la stack policy.'
capture_command post-get-stack-policy "${AWS[@]}" cloudformation get-stack-policy --stack-name "$STACK_ID" --output json
require_capture_success 'No se pudo verificar la stack policy.'
REMOTE_STACK_POLICY="$(jq -er '.StackPolicyBody' "$ATTEMPT_DIR/post-get-stack-policy.stdout")"
[[ "$(jq -cS . <<<"$REMOTE_STACK_POLICY")" == "$(jq -cS . "$STACK_POLICY")" ]] || fail 'La stack policy aplicada no coincide.'

capture_command post-enable-termination-protection "${AWS[@]}" cloudformation update-termination-protection \
  --enable-termination-protection --stack-name "$STACK_ID" --output json
require_capture_success 'No se pudo activar termination protection.'
capture_command post-check-termination-protection "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK_ID" --output json
require_capture_success 'No se pudo verificar termination protection.'
jq -e '.Stacks[0].EnableTerminationProtection == true' "$ATTEMPT_DIR/post-check-termination-protection.stdout" >/dev/null || fail 'Termination protection no quedó activa.'

info 'Verificando S3 privado, OAC, HTTPS y cabeceras antes del upload'
capture_command post-public-access-block "${AWS[@]}" s3api get-public-access-block --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json
require_capture_success 'No se pudo verificar Block Public Access.'
jq -e '.PublicAccessBlockConfiguration |
  .BlockPublicAcls == true and .IgnorePublicAcls == true and
  .BlockPublicPolicy == true and .RestrictPublicBuckets == true' \
  "$ATTEMPT_DIR/post-public-access-block.stdout" >/dev/null || fail 'Block Public Access no está completo.'

capture_command post-ownership "${AWS[@]}" s3api get-bucket-ownership-controls --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json
require_capture_success 'No se pudo verificar Object Ownership.'
jq -e '.OwnershipControls.Rules | length == 1 and .[0].ObjectOwnership == "BucketOwnerEnforced"' \
  "$ATTEMPT_DIR/post-ownership.stdout" >/dev/null || fail 'Object Ownership no es BucketOwnerEnforced.'

capture_command post-encryption "${AWS[@]}" s3api get-bucket-encryption --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json
require_capture_success 'No se pudo verificar el cifrado.'
jq -e '.ServerSideEncryptionConfiguration.Rules | length >= 1 and
  all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256")' \
  "$ATTEMPT_DIR/post-encryption.stdout" >/dev/null || fail 'El bucket no usa exclusivamente SSE-S3.'

capture_command post-versioning "${AWS[@]}" s3api get-bucket-versioning --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json
require_capture_success 'No se pudo verificar el versionado.'
[[ "$(jq -er '.Status' "$ATTEMPT_DIR/post-versioning.stdout")" == 'Enabled' ]] || fail 'El versionado no está activo.'

capture_command post-bucket-policy "${AWS[@]}" s3api get-bucket-policy --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json
require_capture_success 'No se pudo verificar la política del bucket.'
POLICY_TEXT="$(jq -er '.Policy' "$ATTEMPT_DIR/post-bucket-policy.stdout")"
jq -e --arg bucketArn "$BUCKET_ARN" --arg distributionArn "$DISTRIBUTION_ARN" '
  any(.Statement[];
    .Sid == "AllowCloudFrontReadOnly" and .Effect == "Allow" and
    .Principal.Service == "cloudfront.amazonaws.com" and
    (.Action == ["s3:GetObject"] or .Action == "s3:GetObject") and
    .Resource == ($bucketArn + "/*") and
    .Condition.StringEquals["AWS:SourceArn"] == $distributionArn) and
  any(.Statement[];
    .Sid == "DenyInsecureTransport" and .Effect == "Deny" and
    .Principal == "*" and .Condition.Bool["aws:SecureTransport"] == "false") and
  all(.Statement[]; .Effect != "Allow" or .Principal != "*")
' <<<"$POLICY_TEXT" >/dev/null || fail 'La política del bucket no coincide con el acceso privado esperado.'

capture_command post-distribution "${AWS[@]}" cloudfront get-distribution-config --id "$DISTRIBUTION_ID" --output json
require_capture_success 'No se pudo verificar CloudFront.'
jq -e --arg oac "$OAC_ID" --arg headers "$HEADERS_POLICY_ID" '
  .DistributionConfig.Origins.Quantity == 1 and
  .DistributionConfig.Origins.Items[0].OriginAccessControlId == $oac and
  .DistributionConfig.Origins.Items[0].S3OriginConfig.OriginAccessIdentity == "" and
  .DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy == "redirect-to-https" and
  ((.DistributionConfig.DefaultCacheBehavior.AllowedMethods.Items | sort) == ["GET", "HEAD"]) and
  ((.DistributionConfig.DefaultCacheBehavior.AllowedMethods.CachedMethods.Items | sort) == ["GET", "HEAD"]) and
  .DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId == $headers
' "$ATTEMPT_DIR/post-distribution.stdout" >/dev/null || fail 'La distribución no conserva el origen o métodos esperados.'

capture_command post-oac "${AWS[@]}" cloudfront get-origin-access-control --id "$OAC_ID" --output json
require_capture_success 'No se pudo verificar el OAC.'
jq -e '.OriginAccessControl.OriginAccessControlConfig |
  .OriginAccessControlOriginType == "s3" and .SigningBehavior == "always" and .SigningProtocol == "sigv4"' \
  "$ATTEMPT_DIR/post-oac.stdout" >/dev/null || fail 'El OAC no usa firma SigV4 permanente.'

capture_command post-headers "${AWS[@]}" cloudfront get-response-headers-policy-config --id "$HEADERS_POLICY_ID" --output json
require_capture_success 'No se pudo verificar la política de cabeceras.'
jq -e '
  .ResponseHeadersPolicyConfig.SecurityHeadersConfig as $security |
  ($security.ContentSecurityPolicy.ContentSecurityPolicy | contains("default-src '\''self'\''")) and
  ($security.ContentSecurityPolicy.ContentSecurityPolicy | contains("unsafe-inline") | not) and
  ($security.ContentSecurityPolicy.ContentSecurityPolicy | contains("unsafe-eval") | not) and
  $security.FrameOptions.FrameOption == "DENY" and
  $security.ContentTypeOptions.Override == true and
  $security.StrictTransportSecurity.AccessControlMaxAgeSec == 47304000 and
  $security.StrictTransportSecurity.IncludeSubdomains == false and
  $security.ReferrerPolicy.ReferrerPolicy == "strict-origin-when-cross-origin" and
  ($security | has("XSSProtection") | not) and
  any(.ResponseHeadersPolicyConfig.CustomHeadersConfig.Items[];
    (.Header | ascii_downcase) == "permissions-policy" and
    (.Value | contains("clipboard-write=(self)")) and (.Value | contains("web-share=(self)")))
' "$ATTEMPT_DIR/post-headers.stdout" >/dev/null || fail 'Las cabeceras configuradas no cumplen la política esperada.'

capture_command post-http-redirect curl --silent --output /dev/null --write-out '%{http_code}|%{redirect_url}' \
  "http://$DISTRIBUTION_DOMAIN/"
require_capture_success 'No se pudo comprobar la redirección HTTPS.'
HTTP_RESULT="$(<"$ATTEMPT_DIR/post-http-redirect.stdout")"
HTTP_CODE="${HTTP_RESULT%%|*}"
HTTP_LOCATION="${HTTP_RESULT#*|}"
[[ "$HTTP_CODE" =~ ^30[1278]$ && "$HTTP_LOCATION" == "https://$DISTRIBUTION_DOMAIN/" ]] || fail 'CloudFront no redirige HTTP a HTTPS.'

PREUPLOAD_HEADERS="$ATTEMPT_DIR/post-preupload.headers"
[[ ! -e "$PREUPLOAD_HEADERS" ]] || fail 'La evidencia preupload ya existe.'
capture_command post-preupload curl --silent --head --dump-header "$PREUPLOAD_HEADERS" --output /dev/null \
  --write-out '%{http_code}' "$SITE_URL/"
chmod 600 "$PREUPLOAD_HEADERS"
require_capture_success 'No se pudo comprobar CloudFront antes del upload.'
[[ "$(<"$ATTEMPT_DIR/post-preupload.stdout")" == '403' ]] || fail 'CloudFront no confirmó un origen vacío y privado antes del upload.'
grep -Eiq '^content-security-policy:' "$PREUPLOAD_HEADERS" || fail 'Falta CSP antes del upload.'
grep -Eiq '^strict-transport-security:[[:space:]]*max-age=47304000' "$PREUPLOAD_HEADERS" || fail 'Falta HSTS antes del upload.'
! grep -Eiq '^x-xss-protection:' "$PREUPLOAD_HEADERS" || fail 'CloudFront añadió X-XSS-Protection obsoleto.'

capture_command post-direct-s3 curl --silent --head --output /dev/null --write-out '%{http_code}' \
  "https://$BUCKET_DOMAIN/index.html"
require_capture_success 'No se pudo comprobar el acceso S3 directo.'
[[ "$(<"$ATTEMPT_DIR/post-direct-s3.stdout")" == '403' ]] || fail 'El acceso S3 anónimo directo no devolvió 403.'

upload() {
  local relative="$1"
  local content_type="$2"
  local cache_control="$3"
  local evidence_name="upload-${relative//\//-}"
  capture_command "$evidence_name" "${AWS[@]}" s3api put-object \
    --bucket "$BUCKET" --key "$relative" --body "$ROOT/$relative" \
    --expected-bucket-owner "$ACCOUNT_ID" --content-type "$content_type" \
    --cache-control "$cache_control" --server-side-encryption AES256 --output json
  require_capture_success "No se pudo publicar $relative"
  printf '  ✓ %s\n' "$relative"
}

info 'Publicando la allowlist exacta de contenido anónimo'
NO_CACHE='no-cache, max-age=0, must-revalidate'
SHORT_CACHE='public, max-age=3600, must-revalidate'
ICON_CACHE='public, max-age=86400, must-revalidate'
upload css/estilos.css 'text/css; charset=utf-8' "$SHORT_CACHE"
upload css/offline.css 'text/css; charset=utf-8' "$SHORT_CACHE"
upload js/app.js 'text/javascript; charset=utf-8' "$SHORT_CACHE"
upload js/conversion.js 'text/javascript; charset=utf-8' "$SHORT_CACHE"
upload js/pwa.js 'text/javascript; charset=utf-8' "$SHORT_CACHE"
upload iconos/favicon.svg 'image/svg+xml' "$ICON_CACHE"
upload iconos/icono-192.png 'image/png' "$ICON_CACHE"
upload iconos/icono-512.png 'image/png' "$ICON_CACHE"
upload iconos/icono-maskable-512.png 'image/png' "$ICON_CACHE"
upload iconos/apple-touch-icon.png 'image/png' "$ICON_CACHE"
upload offline.html 'text/html; charset=utf-8' "$NO_CACHE"
upload manifest.webmanifest 'application/manifest+json; charset=utf-8' "$NO_CACHE"
upload index.html 'text/html; charset=utf-8' "$NO_CACHE"
upload sw.js 'text/javascript; charset=utf-8' "$NO_CACHE"

capture_command post-create-invalidation "${AWS[@]}" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" --paths '/*' --output json
require_capture_success 'No se pudo crear la invalidación.'
INVALIDATION_ID="$(jq -er '.Invalidation.Id' "$ATTEMPT_DIR/post-create-invalidation.stdout")"
capture_command post-wait-invalidation "${AWS[@]}" cloudfront wait invalidation-completed \
  --distribution-id "$DISTRIBUTION_ID" --id "$INVALIDATION_ID"
require_capture_success 'La invalidación no se completó.'

capture_command post-verify-site "$ROOT/scripts/verify-site.sh" "$SITE_URL"
require_capture_success 'La verificación anónima final falló.'

[[ ! -e "$DEPLOYMENT_STATE" ]] || fail 'El estado de despliegue ya existe.'
set -o noclobber
jq -n \
  --arg stack "$TARGET_STACK" \
  --arg stackId "$STACK_ID" \
  --arg region "$REGION" \
  --arg environment "$ENVIRONMENT" \
  --arg templateSha256 "$TEMPLATE_SHA" \
  --arg contentBucket "$BUCKET" \
  --arg distributionId "$DISTRIBUTION_ID" \
  --arg siteUrl "$SITE_URL" \
  --arg deployedAt "$(utc_now)" \
  '{stack: $stack, stackId: $stackId, region: $region, environment: $environment,
    templateSha256: $templateSha256, contentBucket: $contentBucket,
    distributionId: $distributionId, siteUrl: $siteUrl, deployedAt: $deployedAt}' >"$DEPLOYMENT_STATE"
set +o noclobber
chmod 600 "$DEPLOYMENT_STATE"
[[ "$(file_mode "$DEPLOYMENT_STATE")" == '600' ]] || fail 'No se pudo proteger el estado de despliegue.'
node "$VALIDATOR" seal \
  --attempt-dir "$ATTEMPT_DIR" --output-name chain-deployment.json \
  --previous "$ATTEMPT_DIR/chain-execute-reviewed.json"
node "$VALIDATOR" check-permissions --attempt-dir "$ATTEMPT_DIR"

printf '\nDESPLIEGUE COMPLETADO. La URL y los identificadores permanecen solo en el estado privado 0600.\n'
