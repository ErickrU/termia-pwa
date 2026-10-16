# Estado del despliegue AWS

## Sin despliegue afirmado

Este repositorio no registra ni afirma un despliegue AWS activo. Este workflow no hizo llamadas AWS. No contiene cuentas, ARN, buckets físicos, IDs de distribución, tokens, outputs ni URLs reales.

El target se proporciona exclusivamente en runtime como `--stack-name <AUTHORIZED_STACK_NAME>` y no se conserva un nombre real en el repositorio. Una fase `prepare` futura debe probar su ausencia mediante `DescribeStacks` **y** `ListChangeSets`, además de correlacionar CloudTrail. Si el nombre existe o la prueba es incompleta, el resultado obligatorio es STOP; nunca update ni cambio automático de nombre.

## Evidencia local esperada

Cada intento futuro conserva datos completos únicamente en `.aws-attempts/<attempt-id>/` (`0700`, archivos `0600`) y en el puntero `.aws-change-set.json` (`0600`). El intento incluye timestamps UTC, profile, región, identidad normalizada antes de crear, stack, nombre de change set, client token, request/respuesta, inicio real de cada captura, template y commit SHA, respuestas remotas y una cadena de hashes write-once. Los reportes compartibles contienen solo hashes y booleanos.

Un intento fallido queda intacto y bloquea reintentos automáticos. `DO_NOTHING`, `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`, versionado y recursos parciales pueden conservar costos. No existe cleanup automático; la recuperación exige una autorización posterior separada.

## Conjunción obligatoria antes de execute

- commit limpio y template local idéntico al blob aprobado;
- template ASCII con LF e igualdad byte por byte con `GetTemplate`;
- identidad, profile y región iguales a sus hashes aprobados;
- dos fuentes de ausencia cuyo fin queda a menos de 60 segundos del inicio capturado de `CreateChangeSet`, con el request ID exacto de `DescribeStacks` corroborado por CloudTrail;
- request `CREATE` revisado y ligado a la captura real, con descripción ligada al template, nombre/token internos, `OnStackFailure=DO_NOTHING` y todas las opciones fuera de alcance vacías;
- respuesta y evento `CreateChangeSet` correlacionados por operación exitosa, identidad, región, tiempo, stack, nombre, token e ID del change set; sus campos opcionales pueden faltar, pero nunca contradecir el request, la respuesta o los snapshots sellados;
- placeholder `REVIEW_IN_PROGRESS` sin recursos, outputs ni template aplicado;
- un único change set `CREATE_COMPLETE/AVAILABLE`, sin role, notificaciones, imports ni rollback triggers;
- parámetros, tags, modo `STANDARD` y capabilities exactos;
- exactamente cinco acciones `Add` allowlisted;
- snapshot TOCTOU completo cuyas observaciones, desde la primera hasta la última, tienen antigüedad máxima de 300 segundos y se revalidan contra el timestamp capturado inmediatamente antes de `execute-change-set`.

`ChangeSetType` no forma parte obligatoria de la respuesta `DescribeChangeSet`; su ausencia o valor nulo no invalida la prueba. Un valor contradictorio sí la invalida.

## Estado público

GitHub Pages publica solo el artefacto `_site` de 14 archivos. Infraestructura, scripts, pruebas, documentación y evidencia privada no forman parte del sitio.
