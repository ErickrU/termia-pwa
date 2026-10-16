# Estado del despliegue AWS

## Sin estado real versionado

Este repositorio no registra ni afirma que exista un despliegue AWS activo. No contiene URL de CloudFront, cuentas, ARN, nombres físicos de buckets, IDs de distribución, outputs, fechas de despliegue o hashes aplicados.

Cada despliegue propio conserva sus datos únicamente en `.aws-change-set.json` y `.aws-deployment.json`, archivos locales ignorados con modo `0600`. No los adjuntes a issues, commits o artefactos de Pages.

## Evidencia esperada tras una creación propia

Conserva en un sistema privado apropiado:

- estado `CREATE_COMPLETE` y cinco recursos esperados;
- stack policy que niega toda actualización;
- termination protection activa para `prod`;
- S3 Block Public Access completo, Object Ownership, SSE-S3 y versionado;
- bucket vacío antes de la primera publicación;
- OAC con SigV4 permanente y política limitada al ARN de la distribución;
- acceso S3 anónimo directo rechazado;
- redirección HTTPS y solo métodos `GET`/`HEAD`;
- CSP, HSTS, `DENY`, `nosniff`, Referrer Policy y Permissions Policy;
- allowlist exacta, manifest, service worker, offline y Compartir.

## Estado público del repositorio

GitHub Pages publica exclusivamente el artefacto `_site` de 14 archivos. La infraestructura, scripts, documentación, fuentes auxiliares y estados locales quedan fuera del contenido web.
