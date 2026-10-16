#!/usr/bin/env bash
# Crea una instancia nueva de Termia mediante CloudFormation, S3 y CloudFront.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/infra/cloudformation.yaml"
STACK_POLICY="$ROOT/infra/stack-policy.json"
CHANGE_STATE="$ROOT/.aws-change-set.json"
DEPLOYMENT_STATE="$ROOT/.aws-deployment.json"
MARKER='termia-pwa-cloudfront-oac-v1'
PROJECT='termia-pwa'
REPOSITORY='ErickrU-termia-pwa'

PHASE=''
PROFILE=''
REGION=''
STACK=''
ENVIRONMENT=''
PRICE_CLASS='PriceClass_100'
CONFIRM_ACCOUNT=''
CONFIRM_TEMPLATE_SHA=''
TEMPLATE_SHA=''
ACCOUNT_ID=''
DEPLOYMENT_ID=''

usage() {
  cat <<'USAGE'
Uso de solo lectura:
  ./scripts/deploy-aws.sh --phase review [--profile <YOUR_AWS_PROFILE>] \
    --region <YOUR_AWS_REGION> --stack <YOUR_NEW_STACK_NAME> \
    --environment dev|test|stage|prod

Preparar un change set CREATE sin ejecutarlo:
  ./scripts/deploy-aws.sh --phase prepare [--profile <YOUR_AWS_PROFILE>] \
    --region <YOUR_AWS_REGION> --stack <YOUR_NEW_STACK_NAME> \
    --environment dev|test|stage|prod \
    --confirm-account <YOUR_AWS_ACCOUNT_ID> \
    --confirm-template-sha <YOUR_TEMPLATE_SHA256>

Ejecutar únicamente el change set CREATE ya preparado:
  ./scripts/deploy-aws.sh --phase execute [--profile <YOUR_AWS_PROFILE>] \
    --region <YOUR_AWS_REGION> --stack <YOUR_NEW_STACK_NAME> \
    --environment dev|test|stage|prod \
    --confirm-account <YOUR_AWS_ACCOUNT_ID> \
    --confirm-template-sha <YOUR_TEMPLATE_SHA256>

Opciones:
  --phase FASE              review | prepare | execute
  --profile PERFIL          Perfil normal o SSO (opcional)
  --region REGION           Región explícita del stack y bucket
  --stack NOMBRE            Nombre nuevo del stack
  --environment ENTORNO     dev | test | stage | prod
  --price-class CLASE       PriceClass_100 (pred.) | PriceClass_200 | PriceClass_All
  --confirm-account ID      Confirmación fuera de banda de la cuenta activa
  --confirm-template-sha SHA Confirmación del SHA-256 mostrado por review
  -h, --help                Muestra esta ayuda

Las fases de escritura son deliberadamente separadas. No se admiten cambios sobre
un stack existente. Usa credenciales temporales de mínimo privilegio.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) [[ $# -ge 2 ]] || fail 'Falta el valor de --phase.'; PHASE="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || fail 'Falta el valor de --profile.'; PROFILE="$2"; shift 2 ;;
    --region) [[ $# -ge 2 ]] || fail 'Falta el valor de --region.'; REGION="$2"; shift 2 ;;
    --stack) [[ $# -ge 2 ]] || fail 'Falta el valor de --stack.'; STACK="$2"; shift 2 ;;
    --environment) [[ $# -ge 2 ]] || fail 'Falta el valor de --environment.'; ENVIRONMENT="$2"; shift 2 ;;
    --price-class) [[ $# -ge 2 ]] || fail 'Falta el valor de --price-class.'; PRICE_CLASS="$2"; shift 2 ;;
    --confirm-account) [[ $# -ge 2 ]] || fail 'Falta el valor de --confirm-account.'; CONFIRM_ACCOUNT="$2"; shift 2 ;;
    --confirm-template-sha) [[ $# -ge 2 ]] || fail 'Falta el valor de --confirm-template-sha.'; CONFIRM_TEMPLATE_SHA="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Argumento desconocido: $1" ;;
  esac
done

[[ "$PHASE" =~ ^(review|prepare|execute)$ ]] || fail '--phase debe ser review, prepare o execute.'
[[ -n "$REGION" ]] || fail 'Debes indicar --region.'
[[ -n "$STACK" ]] || fail 'Debes indicar --stack.'
[[ -n "$ENVIRONMENT" ]] || fail 'Debes indicar --environment.'
[[ "$REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail 'La región no tiene un formato válido.'
[[ "$STACK" =~ ^[a-zA-Z][a-zA-Z0-9-]{0,99}$ ]] || fail 'El nombre del stack no es válido.'
[[ "$ENVIRONMENT" =~ ^(dev|test|stage|prod)$ ]] || fail 'El entorno no es válido.'
[[ "$PRICE_CLASS" =~ ^(PriceClass_100|PriceClass_200|PriceClass_All)$ ]] || fail 'La clase de precio no es válida.'

for tool in aws node curl jq shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "No se encontró $tool en PATH."
done

AWS=(aws --region "$REGION" --no-cli-pager)
if [[ -n "$PROFILE" ]]; then
  AWS=(aws --profile "$PROFILE" --region "$REGION" --no-cli-pager)
fi

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
  [[ -x "$ROOT/scripts/verify-site.sh" ]] || fail 'verify-site.sh debe ser ejecutable.'

  local relative
  for relative in "${PUBLIC_FILES[@]}"; do
    [[ -f "$ROOT/$relative" ]] || fail "Falta un archivo publicable: $relative"
    [[ ! -L "$ROOT/$relative" ]] || fail "No se publican enlaces simbólicos: $relative"
  done

  local script
  for script in "$ROOT"/js/*.js "$ROOT/sw.js" "$ROOT/herramientas/servidor.mjs"; do
    node --check "$script" >/dev/null
  done
  node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" \
    "$ROOT/manifest.webmanifest"
  bash -n "$ROOT/scripts/verify-site.sh"

  local control_count share_count
  control_count="$(grep -o 'data-control-ventana' "$ROOT/index.html" | wc -l | tr -d ' ')"
  share_count="$(grep -o 'id="control-compartir"' "$ROOT/index.html" | wc -l | tr -d ' ')"
  [[ "$control_count" == '5' ]] || \
    fail 'La aplicación debe conservar exactamente cinco controles WCO.'
  [[ "$share_count" == '1' ]] || \
    fail 'La aplicación debe conservar exactamente un control Compartir.'
  ! grep -Eiq '<style([[:space:]>])|style=' "$ROOT/offline.html" || \
    fail 'offline.html contiene CSS inline.'
  ! grep -Eiq "unsafe-inline|unsafe-eval" "$TEMPLATE" || \
    fail 'La plantilla contiene una excepción CSP insegura.'

  read -r TEMPLATE_SHA _ < <(shasum -a 256 "$TEMPLATE")
  [[ "$TEMPLATE_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'No se pudo calcular el SHA-256.'
}

read_identity() {
  ACCOUNT_ID="$("${AWS[@]}" sts get-caller-identity --query Account --output text 2>/dev/null)" || \
    fail 'No se pudo verificar la identidad AWS activa.'
  [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail 'AWS devolvió una identidad inesperada.'
  local digest
  read -r digest _ < <(printf '%s' "$ACCOUNT_ID:$REGION:$STACK" | shasum -a 256)
  DEPLOYMENT_ID="${digest:0:10}"
}

validate_template() {
  "${AWS[@]}" cloudformation validate-template --template-body "file://$TEMPLATE" \
    >/dev/null 2>&1 || fail 'CloudFormation rechazó la plantilla.'
}

require_stack_absent() {
  local error_file
  error_file="$(mktemp)"
  if "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
    >/dev/null 2>"$error_file"; then
    rm -f "$error_file"
    fail 'El nombre ya corresponde a un stack existente; este script solo crea stacks nuevos.'
  fi
  if ! grep -Fq 'does not exist' "$error_file"; then
    rm -f "$error_file"
    fail 'No se pudo demostrar que el nombre del stack esté libre.'
  fi
  rm -f "$error_file"
}

require_confirmations() {
  [[ "$CONFIRM_ACCOUNT" =~ ^[0-9]{12}$ ]] || \
    fail 'La fase solicitada exige --confirm-account con 12 dígitos.'
  [[ "$CONFIRM_ACCOUNT" == "$ACCOUNT_ID" ]] || \
    fail 'La cuenta confirmada no coincide con la identidad activa.'
  [[ "$CONFIRM_TEMPLATE_SHA" == "$TEMPLATE_SHA" ]] || \
    fail 'El SHA confirmado no coincide con la plantilla actual.'
}

validate_change_set_json() {
  local document="$1"
  jq -e '
    .Status == "CREATE_COMPLETE" and
    .ExecutionStatus == "AVAILABLE" and
    .ChangeSetType == "CREATE" and
    (.Changes | length == 5) and
    (all(.Changes[]; .ResourceChange.Action == "Add")) and
    (([.Changes[].ResourceChange.LogicalResourceId] | sort) ==
      ["ContentBucket", "ContentBucketPolicy", "Distribution", "OriginAccessControl", "SecurityHeadersPolicy"]) and
    (([.Changes[].ResourceChange.ResourceType] | sort) ==
      ["AWS::CloudFront::Distribution", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::ResponseHeadersPolicy", "AWS::S3::Bucket", "AWS::S3::BucketPolicy"])
  ' <<<"$document" >/dev/null || fail 'El change set no agrega exactamente los cinco recursos permitidos.'
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

output_value() {
  local stack_json="$1"
  local key="$2"
  jq -er --arg key "$key" '.Stacks[0].Outputs[] | select(.OutputKey == $key) | .OutputValue' \
    <<<"$stack_json"
}

validate_local
read_identity
validate_template

if [[ "$PHASE" == 'review' ]]; then
  require_stack_absent
  printf 'Validación local y de CloudFormation: OK\n'
  printf 'Nombre de stack disponible: sí\n'
  printf 'Template SHA-256: %s\n' "$TEMPLATE_SHA"
  printf 'MODO REVIEW: no se creó ni modificó ningún recurso.\n'
  exit 0
fi

require_confirmations

if [[ "$PHASE" == 'prepare' ]]; then
  [[ ! -e "$CHANGE_STATE" ]] || fail 'Ya existe estado local de un change set; revísalo antes de continuar.'
  [[ ! -e "$DEPLOYMENT_STATE" ]] || fail 'Ya existe estado local de un despliegue; no se creará otro.'
  require_stack_absent

  info 'Creando un change set CREATE sin ejecutarlo'
  CHANGE_SET_NAME="${PROJECT}-create-$(date -u +%Y%m%dT%H%M%SZ)"
  CHANGE_SET_ARN="$("${AWS[@]}" cloudformation create-change-set \
    --stack-name "$STACK" \
    --change-set-name "$CHANGE_SET_NAME" \
    --change-set-type CREATE \
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
    --query Id --output text 2>/dev/null)" || fail 'No se pudo preparar el change set.'

  "${AWS[@]}" cloudformation wait change-set-create-complete \
    --change-set-name "$CHANGE_SET_ARN" --stack-name "$STACK" \
    >/dev/null 2>&1 || fail 'El change set no alcanzó CREATE_COMPLETE.'

  CHANGE_SET_JSON="$("${AWS[@]}" cloudformation describe-change-set \
    --change-set-name "$CHANGE_SET_ARN" --stack-name "$STACK" --output json 2>/dev/null)" || \
    fail 'No se pudo volver a leer el change set.'
  validate_change_set_json "$CHANGE_SET_JSON"
  STACK_ID="$(jq -er '.StackId' <<<"$CHANGE_SET_JSON")"

  jq -n \
    --arg stack "$STACK" \
    --arg stackId "$STACK_ID" \
    --arg changeSetArn "$CHANGE_SET_ARN" \
    --arg region "$REGION" \
    --arg environment "$ENVIRONMENT" \
    --arg priceClass "$PRICE_CLASS" \
    --arg account "$ACCOUNT_ID" \
    --arg deploymentId "$DEPLOYMENT_ID" \
    --arg templateSha256 "$TEMPLATE_SHA" \
    --arg preparedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{stack: $stack, stackId: $stackId, changeSetArn: $changeSetArn, region: $region,
      environment: $environment, priceClass: $priceClass, account: $account,
      deploymentId: $deploymentId, templateSha256: $templateSha256,
      preparedAt: $preparedAt}' >"$CHANGE_STATE"
  chmod 600 "$CHANGE_STATE"
  [[ "$(file_mode "$CHANGE_STATE")" == '600' ]] || fail 'No se pudo proteger el estado local.'

  printf 'Change set CREATE preparado y validado; no fue ejecutado.\n'
  printf 'Estado local protegido en .aws-change-set.json.\n'
  exit 0
fi

[[ -f "$CHANGE_STATE" ]] || fail 'Falta .aws-change-set.json; ejecuta primero la fase prepare.'
[[ "$(file_mode "$CHANGE_STATE")" == '600' ]] || fail '.aws-change-set.json debe tener modo 0600.'
[[ ! -e "$DEPLOYMENT_STATE" ]] || fail 'Ya existe estado local de un despliegue; no se ejecutará otro.'

jq -e \
  --arg stack "$STACK" \
  --arg region "$REGION" \
  --arg environment "$ENVIRONMENT" \
  --arg priceClass "$PRICE_CLASS" \
  --arg account "$ACCOUNT_ID" \
  --arg deploymentId "$DEPLOYMENT_ID" \
  --arg templateSha256 "$TEMPLATE_SHA" \
  '.stack == $stack and .region == $region and .environment == $environment and
   .priceClass == $priceClass and .account == $account and
   .deploymentId == $deploymentId and .templateSha256 == $templateSha256 and
   (.stackId | type == "string") and (.changeSetArn | type == "string")' \
  "$CHANGE_STATE" >/dev/null || fail 'El estado preparado no coincide con esta ejecución.'

STACK_ID="$(jq -er '.stackId' "$CHANGE_STATE")"
CHANGE_SET_ARN="$(jq -er '.changeSetArn' "$CHANGE_STATE")"
CHANGE_SET_JSON="$("${AWS[@]}" cloudformation describe-change-set \
  --change-set-name "$CHANGE_SET_ARN" --stack-name "$STACK_ID" --output json 2>/dev/null)" || \
  fail 'El change set preparado ya no está disponible.'
validate_change_set_json "$CHANGE_SET_JSON"
[[ "$(jq -r '.StackId' <<<"$CHANGE_SET_JSON")" == "$STACK_ID" ]] || \
  fail 'El change set ya no pertenece al stack preparado.'

STACK_STATUS="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK_ID" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null)" || \
  fail 'No se pudo verificar el stack en revisión.'
[[ "$STACK_STATUS" == 'REVIEW_IN_PROGRESS' ]] || \
  fail 'El stack ya no está exclusivamente en estado de revisión.'
PREVIOUS_RESOURCES="$("${AWS[@]}" cloudformation list-stack-resources --stack-name "$STACK_ID" \
  --query 'length(StackResourceSummaries)' --output text 2>/dev/null)" || \
  fail 'No se pudo comprobar que el stack esté vacío.'
[[ "$PREVIOUS_RESOURCES" == '0' ]] || fail 'El stack preparado ya contiene recursos.'

info 'Ejecutando una vez el change set CREATE validado'
"${AWS[@]}" cloudformation execute-change-set \
  --change-set-name "$CHANGE_SET_ARN" --stack-name "$STACK_ID" \
  >/dev/null 2>&1 || fail 'CloudFormation no aceptó la ejecución.'
"${AWS[@]}" cloudformation wait stack-create-complete --stack-name "$STACK_ID" \
  >/dev/null 2>&1 || fail 'El stack no alcanzó CREATE_COMPLETE; no se publicaron archivos.'

STACK_JSON="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK_ID" --output json 2>/dev/null)" || \
  fail 'No se pudo verificar el stack creado.'
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
  <<<"$STACK_JSON" >/dev/null || fail 'La identidad del stack creado no coincide.'

RESOURCES_JSON="$("${AWS[@]}" cloudformation list-stack-resources --stack-name "$STACK_ID" --output json 2>/dev/null)" || \
  fail 'No se pudieron verificar los recursos creados.'
jq -e '
  (.StackResourceSummaries | length == 5) and
  (([.StackResourceSummaries[].LogicalResourceId] | sort) ==
    ["ContentBucket", "ContentBucketPolicy", "Distribution", "OriginAccessControl", "SecurityHeadersPolicy"]) and
  (([.StackResourceSummaries[].ResourceType] | sort) ==
    ["AWS::CloudFront::Distribution", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::ResponseHeadersPolicy", "AWS::S3::Bucket", "AWS::S3::BucketPolicy"])
' <<<"$RESOURCES_JSON" >/dev/null || fail 'CloudFormation creó recursos inesperados.'

BUCKET="$(output_value "$STACK_JSON" ContentBucketName)"
BUCKET_ARN="$(output_value "$STACK_JSON" ContentBucketArn)"
BUCKET_DOMAIN="$(output_value "$STACK_JSON" ContentBucketRegionalDomainName)"
DISTRIBUTION_ID="$(output_value "$STACK_JSON" DistributionId)"
DISTRIBUTION_ARN="$(output_value "$STACK_JSON" DistributionArn)"
DISTRIBUTION_DOMAIN="$(output_value "$STACK_JSON" DistributionDomainName)"
OAC_ID="$(output_value "$STACK_JSON" OriginAccessControlId)"
HEADERS_POLICY_ID="$(output_value "$STACK_JSON" SecurityHeadersPolicyId)"
SITE_URL="$(output_value "$STACK_JSON" SiteUrl)"
[[ "$SITE_URL" == "https://$DISTRIBUTION_DOMAIN" ]] || fail 'La URL pública no coincide con la distribución.'

OBJECT_COUNT="$("${AWS[@]}" s3api list-objects-v2 --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --max-keys 1 --query KeyCount --output text 2>/dev/null)" || \
  fail 'No se pudo comprobar que el bucket esté vacío.'
[[ "$OBJECT_COUNT" == '0' ]] || fail 'El bucket nuevo no está vacío; no se publicará contenido.'

info 'Aplicando protecciones antes de publicar contenido'
"${AWS[@]}" cloudformation set-stack-policy --stack-name "$STACK_ID" \
  --stack-policy-body "file://$STACK_POLICY" >/dev/null 2>&1 || \
  fail 'No se pudo aplicar la stack policy.'
REMOTE_STACK_POLICY="$("${AWS[@]}" cloudformation get-stack-policy --stack-name "$STACK_ID" \
  --query StackPolicyBody --output text 2>/dev/null)" || fail 'No se pudo verificar la stack policy.'
[[ "$(jq -cS . <<<"$REMOTE_STACK_POLICY")" == "$(jq -cS . "$STACK_POLICY")" ]] || \
  fail 'La stack policy aplicada no coincide.'

if [[ "$ENVIRONMENT" == 'prod' ]]; then
  "${AWS[@]}" cloudformation update-termination-protection \
    --enable-termination-protection --stack-name "$STACK_ID" >/dev/null 2>&1 || \
    fail 'No se pudo activar termination protection.'
  TERMINATION_PROTECTION="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK_ID" \
    --query 'Stacks[0].EnableTerminationProtection' --output text 2>/dev/null)"
  [[ "$TERMINATION_PROTECTION" == 'True' || "$TERMINATION_PROTECTION" == 'true' ]] || \
    fail 'Termination protection no quedó activa.'
fi

info 'Verificando privacidad, OAC, HTTPS y cabeceras antes del upload'
PUBLIC_BLOCK_JSON="$("${AWS[@]}" s3api get-public-access-block --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json 2>/dev/null)" || fail 'No se pudo verificar Block Public Access.'
jq -e '.PublicAccessBlockConfiguration |
  .BlockPublicAcls == true and .IgnorePublicAcls == true and
  .BlockPublicPolicy == true and .RestrictPublicBuckets == true' \
  <<<"$PUBLIC_BLOCK_JSON" >/dev/null || fail 'Block Public Access no está completo.'

OWNERSHIP_JSON="$("${AWS[@]}" s3api get-bucket-ownership-controls --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json 2>/dev/null)" || fail 'No se pudo verificar Object Ownership.'
jq -e '.OwnershipControls.Rules | length == 1 and .[0].ObjectOwnership == "BucketOwnerEnforced"' \
  <<<"$OWNERSHIP_JSON" >/dev/null || fail 'Object Ownership no es BucketOwnerEnforced.'

ENCRYPTION_JSON="$("${AWS[@]}" s3api get-bucket-encryption --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --output json 2>/dev/null)" || fail 'No se pudo verificar el cifrado.'
jq -e '.ServerSideEncryptionConfiguration.Rules | length >= 1 and
  all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256")' \
  <<<"$ENCRYPTION_JSON" >/dev/null || fail 'El bucket no usa exclusivamente SSE-S3.'

VERSIONING_STATUS="$("${AWS[@]}" s3api get-bucket-versioning --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --query Status --output text 2>/dev/null)" || \
  fail 'No se pudo verificar el versionado.'
[[ "$VERSIONING_STATUS" == 'Enabled' ]] || fail 'El versionado no está activo.'

POLICY_TEXT="$("${AWS[@]}" s3api get-bucket-policy --bucket "$BUCKET" \
  --expected-bucket-owner "$ACCOUNT_ID" --query Policy --output text 2>/dev/null)" || \
  fail 'No se pudo verificar la política del bucket.'
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

DISTRIBUTION_JSON="$("${AWS[@]}" cloudfront get-distribution-config --id "$DISTRIBUTION_ID" \
  --output json 2>/dev/null)" || fail 'No se pudo verificar CloudFront.'
jq -e --arg oac "$OAC_ID" --arg headers "$HEADERS_POLICY_ID" '
  .DistributionConfig.Origins.Quantity == 1 and
  .DistributionConfig.Origins.Items[0].OriginAccessControlId == $oac and
  .DistributionConfig.Origins.Items[0].S3OriginConfig.OriginAccessIdentity == "" and
  .DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy == "redirect-to-https" and
  ((.DistributionConfig.DefaultCacheBehavior.AllowedMethods.Items | sort) == ["GET", "HEAD"]) and
  ((.DistributionConfig.DefaultCacheBehavior.AllowedMethods.CachedMethods.Items | sort) == ["GET", "HEAD"]) and
  .DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId == $headers
' <<<"$DISTRIBUTION_JSON" >/dev/null || fail 'La distribución no conserva el origen o métodos esperados.'

OAC_JSON="$("${AWS[@]}" cloudfront get-origin-access-control --id "$OAC_ID" --output json 2>/dev/null)" || \
  fail 'No se pudo verificar el OAC.'
jq -e '.OriginAccessControl.OriginAccessControlConfig |
  .OriginAccessControlOriginType == "s3" and .SigningBehavior == "always" and .SigningProtocol == "sigv4"' \
  <<<"$OAC_JSON" >/dev/null || fail 'El OAC no usa firma SigV4 permanente.'

HEADERS_JSON="$("${AWS[@]}" cloudfront get-response-headers-policy-config \
  --id "$HEADERS_POLICY_ID" --output json 2>/dev/null)" || fail 'No se pudo verificar la política de cabeceras.'
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
' <<<"$HEADERS_JSON" >/dev/null || fail 'Las cabeceras configuradas no cumplen la política esperada.'

HTTP_RESULT="$(curl --silent --output /dev/null --write-out '%{http_code}|%{redirect_url}' \
  "http://$DISTRIBUTION_DOMAIN/" 2>/dev/null)" || fail 'No se pudo comprobar la redirección HTTPS.'
HTTP_CODE="${HTTP_RESULT%%|*}"
HTTP_LOCATION="${HTTP_RESULT#*|}"
[[ "$HTTP_CODE" =~ ^30[1278]$ && "$HTTP_LOCATION" == "https://$DISTRIBUTION_DOMAIN/" ]] || \
  fail 'CloudFront no redirige el origen HTTP esperado a HTTPS.'

PREUPLOAD_HEADERS="$(mktemp)"
PREUPLOAD_STATUS="$(curl --silent --head --dump-header "$PREUPLOAD_HEADERS" --output /dev/null \
  --write-out '%{http_code}' "$SITE_URL/" 2>/dev/null)" || fail 'No se pudo comprobar CloudFront antes del upload.'
[[ "$PREUPLOAD_STATUS" == '403' ]] || fail 'CloudFront no confirmó un origen vacío y privado antes del upload.'
grep -Eiq '^content-security-policy:' "$PREUPLOAD_HEADERS" || fail 'Falta CSP antes del upload.'
grep -Eiq '^strict-transport-security:[[:space:]]*max-age=47304000' "$PREUPLOAD_HEADERS" || fail 'Falta HSTS antes del upload.'
! grep -Eiq '^x-xss-protection:' "$PREUPLOAD_HEADERS" || fail 'CloudFront añadió el encabezado X-XSS-Protection obsoleto.'
rm -f "$PREUPLOAD_HEADERS"

DIRECT_STATUS="$(curl --silent --head --output /dev/null --write-out '%{http_code}' \
  "https://$BUCKET_DOMAIN/index.html" 2>/dev/null)" || fail 'No se pudo comprobar el acceso S3 directo.'
[[ "$DIRECT_STATUS" == '403' ]] || fail 'El acceso S3 anónimo directo no devolvió 403.'

upload() {
  local relative="$1"
  local content_type="$2"
  local cache_control="$3"
  "${AWS[@]}" s3api put-object \
    --bucket "$BUCKET" \
    --key "$relative" \
    --body "$ROOT/$relative" \
    --expected-bucket-owner "$ACCOUNT_ID" \
    --content-type "$content_type" \
    --cache-control "$cache_control" \
    --server-side-encryption AES256 \
    >/dev/null 2>&1 || fail "No se pudo publicar $relative"
  printf '  ✓ %s\n' "$relative"
}

info 'Publicando la allowlist exacta: recursos primero'
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

info 'Invalidando únicamente la distribución creada'
INVALIDATION_ID="$("${AWS[@]}" cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" --paths '/*' --query Invalidation.Id --output text 2>/dev/null)" || \
  fail 'No se pudo crear la invalidación.'
"${AWS[@]}" cloudfront wait invalidation-completed \
  --distribution-id "$DISTRIBUTION_ID" --id "$INVALIDATION_ID" \
  >/dev/null 2>&1 || fail 'La invalidación no se completó.'

"$ROOT/scripts/verify-site.sh" "$SITE_URL"

jq -n \
  --arg stack "$STACK" \
  --arg stackId "$STACK_ID" \
  --arg region "$REGION" \
  --arg environment "$ENVIRONMENT" \
  --arg deploymentId "$DEPLOYMENT_ID" \
  --arg templateSha256 "$TEMPLATE_SHA" \
  --arg contentBucket "$BUCKET" \
  --arg distributionId "$DISTRIBUTION_ID" \
  --arg siteUrl "$SITE_URL" \
  --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{stack: $stack, stackId: $stackId, region: $region, environment: $environment,
    deploymentId: $deploymentId, templateSha256: $templateSha256,
    contentBucket: $contentBucket, distributionId: $distributionId,
    siteUrl: $siteUrl, deployedAt: $deployedAt}' >"$DEPLOYMENT_STATE"
chmod 600 "$DEPLOYMENT_STATE"
[[ "$(file_mode "$DEPLOYMENT_STATE")" == '600' ]] || fail 'No se pudo proteger el estado del despliegue.'

printf '\nDESPLIEGUE COMPLETADO\nURL: %s\n' "$SITE_URL"
