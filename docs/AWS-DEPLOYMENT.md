# Despliegue AWS seguro

Esta alternativa crea una instancia nueva de Termia con S3 privado y CloudFront OAC. El repositorio no contiene ni afirma un despliegue activo.

> S3, CloudFront, solicitudes, transferencia e invalidaciones pueden generar costos. Usa credenciales temporales de mínimo privilegio y un entorno controlado. Si no puedes determinar si la cuenta es de producción, trátala como producción y detente antes de escribir.

## Controles principales

- S3: cuatro Block Public Access, `BucketOwnerEnforced`, SSE-S3 y versionado.
- Origen: endpoint REST privado; no website endpoint ni CORS.
- CloudFront: OAC SigV4 `always`, HTTP→HTTPS y solo `GET`/`HEAD`.
- Política S3: lectura exclusiva desde la distribución creada y denegación de transporte inseguro.
- Respuestas: CSP estricta, `DENY`, `nosniff`, HSTS, Referrer Policy y Permissions Policy; sin `X-XSS-Protection`.
- Operación: creación única en dos fases de escritura, stack policy inmutable y protección de terminación para `prod` antes de publicar objetos.

## Requisitos

- AWS CLI v2, Node.js 20+, `jq`, `curl` y `shasum`;
- un perfil SSO/rol temporal de mínimo privilegio o la cadena estándar de credenciales;
- permisos para validar/crear la plantilla, configurar sus protecciones, cargar la allowlist y crear una invalidación.

No guardes credenciales, cuentas, ARN ni outputs en Git. Los estados locales `.aws-change-set.json` y `.aws-deployment.json` están ignorados y el script los crea con modo `0600`.

## 1. Revisar sin escribir

```bash
./scripts/deploy-aws.sh \
  --phase review \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION> \
  --stack <YOUR_NEW_STACK_NAME> \
  --environment prod
```

`--profile` es opcional. La fase valida archivos, sintaxis, identidad, plantilla y que el nombre de stack no exista. Solo muestra el SHA-256 de la plantilla; no imprime cuenta, ARN ni identificadores físicos.

Comprueba la cuenta activa por un canal local seguro y conserva su ID fuera del repositorio. No continúes si la identidad no es la esperada o tiene permisos más amplios de lo necesario.

## 2. Preparar un change set CREATE

```bash
./scripts/deploy-aws.sh \
  --phase prepare \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION> \
  --stack <YOUR_NEW_STACK_NAME> \
  --environment prod \
  --confirm-account <YOUR_AWS_ACCOUNT_ID> \
  --confirm-template-sha <YOUR_TEMPLATE_SHA256>
```

La fase vuelve a verificar todo, exige que el stack no exista y crea un change set `CREATE` sin ejecutarlo. Rechaza cualquier conjunto que no agregue exactamente los cinco recursos esperados. Su referencia queda solo en `.aws-change-set.json`.

## 3. Ejecutar exactamente el change set preparado

Revisa el cambio en la consola o CLI sin copiar identificadores al repositorio. Si es correcto, repite los mismos argumentos con `execute`:

```bash
./scripts/deploy-aws.sh \
  --phase execute \
  --profile <YOUR_AWS_PROFILE> \
  --region <YOUR_AWS_REGION> \
  --stack <YOUR_NEW_STACK_NAME> \
  --environment prod \
  --confirm-account <YOUR_AWS_ACCOUNT_ID> \
  --confirm-template-sha <YOUR_TEMPLATE_SHA256>
```

La fase `execute`:

1. valida modo y contenido del estado local;
2. comprueba que el mismo change set continúa disponible y es exclusivamente `CREATE`;
3. confirma que el stack está en revisión y no tiene recursos previos;
4. ejecuta una sola vez y espera `CREATE_COMPLETE`;
5. confirma identidad, cinco recursos y bucket vacío;
6. aplica y verifica la stack policy; en `prod`, activa y verifica termination protection;
7. verifica privacidad S3, cifrado, versionado, OAC, métodos, HTTPS y cabeceras antes de cargar contenido;
8. exige `403` al acceso S3 anónimo directo;
9. carga solo 14 archivos: recursos primero, luego HTML principal y service worker al final;
10. invalida únicamente la distribución creada, ejecuta la verificación anónima y guarda estado local `0600`.

No existe una ruta de actualización, destrucción o limpieza en estos scripts. Una operación futura sobre infraestructura desplegada requiere una revisión y autorización separadas. Nunca desactives protecciones de producción para sortear este límite.

## Verificación independiente

```bash
./scripts/verify-site.sh <YOUR_CLOUDFRONT_HTTPS_URL>
```

Comprueba redirección HTTPS, respuesta 200, cabeceras, ausencia de `X-XSS-Protection`, manifest, service worker, CSS, JavaScript e iconos. Prueba también instalación, segunda carga offline, vista móvil, teclado y ambos caminos de Compartir en un navegador compatible.

## Fuentes

- [AWS: restringir un origen S3 mediante OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [AWS: requerir HTTPS entre clientes y CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-viewers-to-cloudfront.html)
- [AWS: políticas de cabeceras de respuesta](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html)

Contenido reformulado para cumplir restricciones de licencia.
