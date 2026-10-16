# Despliegue AWS seguro

Esta alternativa propone crear una instancia nueva de Termia con S3 privado y CloudFront OAC. El único nombre permitido por el script es `termia-pwa-public-prod`; no demuestra que ese nombre esté disponible ni que exista un despliegue activo.

> Este workflow preparó y verificó código exclusivamente de forma local: no hizo llamadas AWS. Toda ejecución futura requiere credenciales temporales de mínimo privilegio, revisión independiente y autorización trazable.

## Regla de parada

`termia-pwa-public-prod` solo puede usarse si la fase `prepare` futura todavía demuestra su ausencia inmediatamente antes de crear el change set. Si `DescribeStacks` o `ListChangeSets` encuentra el nombre, devuelve un resultado ambiguo o no puede correlacionarse, el resultado es **STOP**. El script nunca actualiza un stack existente, elige otro nombre, elimina un intento ni realiza cleanup automático.

El stack, entorno `prod`, `PriceClass_100`, tipo `CREATE`, nombre del change set y client token son internos. No existen opciones para inyectarlos.

## Controles conservados

- S3 privado: cuatro Block Public Access, `BucketOwnerEnforced`, SSE-S3 y versionado.
- CloudFront: OAC SigV4 `always`, HTTP→HTTPS y únicamente `GET`/`HEAD`.
- Política S3: lectura exclusiva desde la distribución creada y denegación de transporte inseguro.
- Cabeceras: CSP estricta, `DENY`, `nosniff`, HSTS, Referrer Policy y Permissions Policy; sin `X-XSS-Protection`.
- Protección: stack policy que niega updates y termination protection antes de publicar contenido en `prod`.
- PWA: allowlist exacta de 14 archivos, cinco controles WCO y un único botón Compartir.

`DeletionPolicy: Retain` conserva el bucket durante rollback de creación o eliminación del stack. `UpdateReplacePolicy: Retain` conserva el recurso anterior si alguna operación autorizada por separado lo reemplazara. S3, CloudFront, objetos versionados y recursos parciales pueden generar costos mientras permanezcan retenidos.

## Requisitos para una operación futura

- AWS CLI v2 compatible, Node.js 20+, `jq`, `curl`, `git`, `cmp` y `shasum`;
- profile explícito de un rol temporal con el mínimo privilegio necesario;
- región, commit e identidad aprobados fuera de banda;
- repositorio limpio y commit publicado y revisado;
- autorización separada para `prepare` y otra autorización explícita para `execute`.

No guardes credenciales, cuentas, ARN, tokens, nombres físicos, outputs ni URLs reales en Git. Cada intento se conserva en `.aws-attempts/<attempt-id>/` con directorio `0700` y archivos `0600`; `.aws-change-set.json` es un puntero privado `0600`. Un intento fallido permanece intacto y bloquea reintentos automáticos.

## 1. Revisar hashes

Una persona autorizada puede obtener los hashes sin crear, actualizar o eliminar infraestructura:

```bash
./scripts/deploy-aws.sh \
  --phase review \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION>
```

Esta fase sí consulta la identidad activa en AWS cuando alguien la ejecuta en el futuro. Muestra únicamente hashes del commit, template e identidad canónica. La identidad canónica liga cuenta, principal, profile y región; el valor completo queda fuera de reportes compartibles. `review` no decide que el nombre esté libre.

## 2. Preparar un CREATE sin ejecutarlo

```bash
./scripts/deploy-aws.sh \
  --phase prepare \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION> \
  --confirm-commit-sha <APPROVED_COMMIT_SHA> \
  --confirm-identity-sha <APPROVED_IDENTITY_SHA256>
```

Antes de cualquier API, el script inspecciona localmente el skeleton de AWS CLI v2 y exige soporte para `ClientToken` y `OnStackFailure`. Después:

1. crea una sola vez el attempt ID, nombre de change set y client token, y los persiste antes del request;
2. conserva los bytes exactos del template local y del blob del commit aprobado;
3. captura dos probes independientes e inmediatamente anteriores: `DescribeStacks` y `ListChangeSets`;
4. emite literalmente `--change-set-type CREATE`, `--client-token` y `--on-stack-failure DO_NOTHING`;
5. conserva request, respuesta, stdout, stderr, timestamps UTC, identidad, región, profile, hashes e identificadores de correlación;
6. exige eventos CloudTrail únicos para el probe `DescribeStacks` y para `CreateChangeSet`;
7. recupera el template del change set y exige igualdad byte por byte con el archivo enviado y el commit;
8. valida un placeholder `REVIEW_IN_PROGRESS` sin recursos, outputs ni template aplicado, un único change set disponible y exactamente cinco acciones `Add` allowlisted.

`DO_NOTHING` deja el stack y cualquier recurso parcial disponible para diagnóstico si la creación falla. No se combina con una opción de rollback incompatible. Esto evita una eliminación automática, pero puede conservar recursos facturables y no autoriza recuperarlos o borrarlos.

`DescribeChangeSet` no está obligado a devolver `ChangeSetType`. El validador no exige ese campo: demuestra `CREATE` mediante la conjunción del request revisado, ausencia previa corroborada, token correlacionado, placeholder vacío y cinco `Add`. Si el servicio devolviera un campo contradictorio, se detiene.

## 3. Ejecutar solo después de otra autorización

```bash
./scripts/deploy-aws.sh \
  --phase execute \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION> \
  --confirm-commit-sha <APPROVED_COMMIT_SHA> \
  --confirm-identity-sha <APPROVED_IDENTITY_SHA256>
```

Inmediatamente antes de `execute-change-set`, el script vuelve a comprobar identidad, commit, template remoto, placeholder vacío, único change set, parámetros, tags, modo `STANDARD`, `OnStackFailure`, ausencia de capabilities/import/nested stacks y las cinco acciones. El snapshot TOCTOU debe tener como máximo 300 segundos. Cualquier campo ausente, timestamp vencido o diferencia produce STOP y conserva todo.

Tras una creación correcta, verifica stack policy, termination protection, S3 privado, cifrado, versionado, OAC, métodos, HTTPS y cabeceras antes de subir contenido público. También exige rechazo del acceso S3 anónimo directo y valida la publicación anónima al final.

## Evidencia

Los archivos privados conservan valores completos y una cadena de hashes write-once. Los reportes `shareable-*.json` contienen exclusivamente hashes SHA-256 y booleanos. No adjuntes el directorio privado, el puntero ni el estado de despliegue a commits, issues o artefactos.

No hay ruta de update, delete o cleanup. Cualquier recuperación de un intento parcial, incluso para detener costos, requiere diagnóstico, plan y autorización trazable separados; no desactives Retain ni termination protection para sortear este límite.

## Verificación independiente de una publicación autorizada

```bash
./scripts/verify-site.sh <YOUR_CLOUDFRONT_HTTPS_URL>
```

Comprueba HTTPS, cabeceras, manifest, service worker, CSS, JavaScript, iconos, exactamente cinco controles y el único Compartir con Web Share, Clipboard API, fallback y feedback accesible.

## Fuentes

- [AWS: restringir un origen S3 mediante OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [AWS: CreateChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html)
- [AWS: DescribeChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html)

Contenido reformulado para cumplir restricciones de licencia.
