# Seguridad

## Reportar una vulnerabilidad

No publiques secretos ni datos sensibles en un issue. Usa la función privada **Report a vulnerability** del repositorio y aporta impacto, pasos de reproducción y una prueba mínima que no afecte sistemas ajenos.

## Modelo de seguridad

Termia es una aplicación estática:

- no tiene backend, cuentas, base de datos ni analítica;
- procesa temperaturas únicamente en el navegador;
- no usa dependencias JavaScript ni recursos de CDN de terceros;
- su service worker solo intercepta solicitudes `GET` del mismo origen;
- no deben introducirse secretos en HTML, JavaScript, manifest, evidencia compartible o Git.

La alternativa AWS mantiene S3 privado con cuatro Block Public Access, `BucketOwnerEnforced`, SSE-S3 y versionado. CloudFront es el único punto público y accede al origen mediante OAC con SigV4. La política del bucket limita `s3:GetObject` a la distribución creada y deniega transporte inseguro.

CloudFront redirige HTTP a HTTPS y añade CSP sin `unsafe-inline` ni `unsafe-eval`, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, Referrer Policy y Permissions Policy. No configura el encabezado obsoleto `X-XSS-Protection`.

## Evidencia y operaciones AWS

Este workflow no hizo llamadas AWS. El único target futuro propuesto es `termia-pwa-public-prod`; cualquier existencia o resultado ambiguo obliga a STOP sin update, nombre alternativo, delete ni cleanup.

El script exige profile explícito, commit e identidad aprobados, persiste la identidad normalizada antes de crear, exige un template ASCII+LF idéntico al commit, dos fuentes de ausencia ligadas al inicio capturado de `CreateChangeSet`, el request ID exacto de `DescribeStacks` corroborado por CloudTrail, `CREATE`, descripción ligada al template, client token interno, `OnStackFailure=DO_NOTHING`, opciones fuera de alcance vacías, placeholder vacío, un único change set y exactamente cinco `Add`. Antes de execute repite toda la conjunción con un snapshot cuyas observaciones TOCTOU, desde la primera, tienen máximo 300 segundos y vuelve a validarla inmediatamente antes de la llamada usando el mismo timestamp UTC que la captura de ejecución. La validación no depende de `ChangeSetType` como campo de respuesta, pero rechaza contradicciones.

Los valores completos se conservan exclusivamente en `.aws-attempts/<attempt-id>/` (`0700`, archivos `0600`) y `.aws-change-set.json` (`0600`), ambos ignorados. Los reportes compartibles contienen solo hashes y booleanos. Nunca compartas el directorio, el puntero o `.aws-deployment.json`.

`DO_NOTHING`, `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain` y versionado pueden conservar recursos y costos. No hay limpieza automática. Toda ejecución CREATE y cualquier recuperación posterior requieren autorizaciones trazables separadas; no desactives termination protection ni políticas de retención para evitar ese proceso.
