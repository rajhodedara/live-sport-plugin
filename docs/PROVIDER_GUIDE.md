# Guía de proveedores — borrador para revisión

Esta guía describe criterios para desarrollar y revisar fuentes de Live Sport Plugin. Es una propuesta local, no una política validada en producción. Comprobar la implementación y configuración del commit integrado antes de aplicarla. Las pruebas simuladas no prueban que una fuente exista, reproduzca o funcione desde la red de Raj.

## Contrato común

- Separar la obtención del catálogo, el análisis de entradas y la resolución del stream. Conservar el contrato de entidades y los datos que el reproductor necesita.
- Validar estructuras, tipos y campos obligatorios antes de usarlos. Aislar errores por elemento cuando sea posible: una fila defectuosa no debe eliminar las siguientes. No convertir silenciosamente una respuesta truncada en datos completos.
- Deduplicar con identidades apropiadas sin perder distintas fuentes legítimas. Conservar datos de procedencia y tiempos de eventos; no adivinar si falta evidencia.
- Usar presupuestos de tiempo, límites de respuesta y de concurrencia acordes con la capa. Documentar cachés, TTL, respuestas vacías y fallos; una caché negativa o un resultado tardío no son necesariamente evidencia de fallo permanente del proveedor.
- Sanitizar logs: no registrar URLs con tokens, cookies, claves, Authorization, cabeceras privadas ni direcciones de proxy. Guardar evidencia suficiente para atribuir una prueba a SHA, entorno y resultado.

## Según el formato

### API y feeds

Validar el tipo y las propiedades de la respuesta; procesar registros de forma independiente y probar listas vacías, `null`, duplicados, errores de formato y respuestas grandes o truncadas. Para playlists/feed, probar LF y CRLF, variaciones de orden de metadatos y separación de entradas, incluyendo valores que contengan `=`. Mantener la asociación entre headers y el stream correcto; no arrastrarlos a la entrada siguiente.

### HTML, páginas puente e iframes

Resolver cada referencia relativa respecto de la URL efectiva de la página que la contiene, contemplando redirecciones y URLs protocol-relative. No confundir la URL inicial con la URL final tras un redirect. Manejar etiquetas faltantes, varias opciones, HTML inválido y errores por extractor. Priorizar formatos compatibles mediante hostnames y límites de dominio reales, no por coincidencias en el path o query; mantener un fallback explícito cuando corresponda.

Un enlace relativo puede introducir solicitudes que antes no existían. Antes de fusionar, revisar cada destino y salto, incluida la resolución DNS, redirecciones, credenciales URL y protección en el punto de conexión. Una validación `http:`/`https:` sola no evita SSRF. En #61 la cobertura real depende de la integración efectiva del guard de #59; revisar el commit final y los imports, no suponerla. Distinguir enlaces devueltos al reproductor de solicitudes efectuadas por el servidor.

### Headers, HLS y WARP

Comprobar qué headers necesita cada solicitud y quién la ejecuta: verificación del stream, manifest principal, playlists hijas y segmentos pueden tomar rutas distintas. No propagar credenciales a otros orígenes ni poner secretos en URLs o logs. Los transportes retienen solo un conjunto acotado de headers en redirecciones entre orígenes; esto puede afectar proveedores que dependen de Referer u otros headers y requiere pruebas de compatibilidad. La política no impide que un secreto se incluya en el cuerpo, una URL o un header permitido. Cualquier cambio de proxyHeaders exige revisión de seguridad y compatibilidad con Stremio/Exo y Nuvio.

La rama #61 experimenta con User-Agent para manifests AK47 y segmenta la caché por UA. Esto no garantiza que el reproductor envíe el mismo UA en segmentos descargados directamente. Verificar redirects, caché, playlists hijas y segmentos en un entorno aislado. Probar WARP solamente cuando esté configurado y autorizado para esa instancia; no inferir que funciona desde mocks ni cambiar el proxy de producción.

## Pruebas y evidencia

1. Crear fixtures sintéticas pequeñas que prueben comportamiento observable, incluidas entradas malformadas, rutas relativas, dominios parecidos, cabeceras, límites y errores. Marcar explícitamente que no son respuestas reales.
2. Simular resolución DNS y redirecciones en pruebas de seguridad; probar que destinos privados se rechazan en el punto correspondiente y que un error no hace perder entradas válidas siguientes. No afirmar protección completa a partir de una prueba de una ruta.
3. Ejecutar suites enfocadas que no lancen workers/WASM reales ni contacten proveedores. La ejecución completa o pruebas WASM reales previamente rechazadas por revisión automática no se deben eludir. Inspeccionar imports: algunas suites pueden crear workers al cargar el contenedor. Documentar si Jest queda abierto y cómo terminó.
4. En un entorno aislado de Raj, cuando sea oportuno y acordado, comprobar fixtures confirmadas, reproducción efectiva en Stremio/Exo y Nuvio, solicitudes de manifest y segmentos, redirects, headers y WARP cuando corresponda. Identificar SHA, configuración y logs completos sanitizados; no tratar una respuesta de catálogo o HTTP 200 como prueba de reproducción.

## Antes de actualizar un draft

Comparar la base real de `stable`, los heads de #59 y #61 y sus dependencias; revisar el diff integrado, conflictos y los resultados de pruebas sobre el árbol exacto. No mover el SHA que Raj esté examinando sin coordinar; comunicar el nuevo SHA y qué validaciones deben repetirse. Mantener draft, merge y despliegue bajo la coordinación acordada. Producción y su PM2 quedan fuera de las pruebas aisladas.
