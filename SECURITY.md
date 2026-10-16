# Seguridad

## Reportar una vulnerabilidad

No publiques secretos ni datos sensibles en un issue. Usa la función privada **Report a vulnerability** del repositorio y aporta impacto, pasos de reproducción y una prueba mínima que no afecte sistemas ajenos.

## Modelo de seguridad

Termia es una aplicación estática:

- no tiene backend, cuentas, base de datos ni analítica;
- procesa las temperaturas únicamente en el navegador;
- no usa dependencias JavaScript ni recursos de CDN de terceros;
- su service worker solo intercepta solicitudes `GET` del mismo origen;
- no deben introducirse secretos en HTML, JavaScript, el manifest o Git.

La alternativa AWS mantiene S3 privado con los cuatro controles de Block Public Access, Object Ownership sin ACL, cifrado SSE-S3 y versionado. CloudFront es el único punto público y accede al origen mediante OAC con SigV4. La política del bucket limita `s3:GetObject` a la distribución creada y deniega transporte inseguro.

CloudFront redirige HTTP a HTTPS y añade CSP sin `unsafe-inline` ni `unsafe-eval`, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, Referrer Policy y Permissions Policy. No se configura el encabezado obsoleto `X-XSS-Protection`.

Los scripts no incluyen credenciales ni identificadores físicos. Usa credenciales temporales de mínimo privilegio, verifica la identidad activa antes de preparar cualquier cambio y conserva `.aws-change-set.json` y `.aws-deployment.json` solo como estado local ignorado con modo `0600`.
