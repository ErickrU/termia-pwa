# Infraestructura AWS

`cloudformation.yaml` define exactamente cinco recursos para una creación nueva de Termia:

1. bucket S3 privado, cifrado y versionado;
2. Origin Access Control de CloudFront con SigV4 permanente;
3. política de cabeceras de seguridad;
4. distribución CloudFront HTTPS;
5. política del bucket limitada al ARN de esa distribución.

S3 mantiene activos los cuatro controles de Block Public Access, usa `BucketOwnerEnforced` y no expone website endpoint, CORS ni ACL pública. CloudFront permite únicamente `GET` y `HEAD`, redirige HTTP a HTTPS y aplica CSP sin inline/eval, `DENY`, `nosniff`, HSTS, Referrer Policy y Permissions Policy.

No hay nombres físicos, cuentas, ARN, buckets, distribuciones ni dominios reales en el repositorio. Tampoco se crean IAM, DNS, certificados propios, WAF, logs o funciones de borde.

La plantilla usa `DeletionPolicy: Retain`, que conserva el bucket incluso durante un rollback de la creación, al eliminar el stack o al reemplazar el recurso, y mantiene `UpdateReplacePolicy: Retain`. El almacenamiento y las versiones retenidas pueden generar costos y no existe limpieza automática. La stack policy niega toda actualización. El script admite únicamente las fases separadas `review`, `prepare` y `execute`; consulta [`../docs/AWS-DEPLOYMENT.md`](../docs/AWS-DEPLOYMENT.md) antes de usarlo.
