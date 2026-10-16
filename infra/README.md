# Infraestructura AWS

`cloudformation.yaml` define exactamente cinco recursos para una creación nueva propuesta de Termia:

1. bucket S3 privado, cifrado y versionado;
2. Origin Access Control de CloudFront con SigV4 permanente;
3. política de cabeceras de seguridad;
4. distribución CloudFront HTTPS;
5. política del bucket limitada al ARN de esa distribución.

S3 mantiene los cuatro controles de Block Public Access, usa `BucketOwnerEnforced` y no expone website endpoint, CORS ni ACL pública. CloudFront permite únicamente `GET` y `HEAD`, redirige HTTP a HTTPS y aplica CSP sin inline/eval, `DENY`, `nosniff`, HSTS, Referrer Policy y Permissions Policy.

La plantilla no fija nombres físicos ni contiene cuentas, ARN, buckets, distribuciones o dominios reales. Tampoco crea IAM, DNS, certificados propios, WAF, logs, funciones de borde, macros, nested stacks o imports. Su texto no funcional es ASCII y el archivo usa LF para que `GetTemplate`, el archivo enviado y el blob aprobado puedan compararse byte por byte sin normalización ni relajación de hash.

`DeletionPolicy: Retain` conserva el bucket ante rollback de creación o eliminación del stack. `UpdateReplacePolicy: Retain` conserva el recurso anterior ante un reemplazo autorizado por separado. El almacenamiento, las versiones y los recursos parciales pueden generar costos; no existe cleanup automático.

El único target propuesto por `deploy-aws.sh` es `termia-pwa-public-prod`. Si ya existe o no puede probarse su ausencia, el script hace STOP y nunca update, delete ni cambio de nombre. `prepare` usa `CREATE`, un client token generado internamente y `OnStackFailure=DO_NOTHING`; `execute` exige una segunda autorización y repite la validación con TOCTOU máximo de 300 segundos.

La evidencia completa se guarda fuera de Git en `.aws-attempts/` con modos `0700/0600`; los reportes compartibles solo contienen hashes y booleanos. La validación no exige `ChangeSetType` en la respuesta de `DescribeChangeSet`, pero rechaza cualquier valor contradictorio y exige exactamente cinco `Add` allowlisted.

Este workflow no hizo llamadas AWS. Consulta [`../docs/AWS-DEPLOYMENT.md`](../docs/AWS-DEPLOYMENT.md) antes de cualquier operación futura.
