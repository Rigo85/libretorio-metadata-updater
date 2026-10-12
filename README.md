# Libretorio Metadata Updater

Servicio de enriquecimiento bibliografico de Libretorio mediante Google Books
y OpenLibrary. El scanner extrae la metadata local; este servicio busca datos
web para los registros sin `webDetails` y sin edicion manual (`customDetails`).

## Entorno

- Node.js >=24.15.0 y <25, PostgreSQL y Redis.
- `cwebp` disponible en PATH para portadas. Las existentes no se reemplazan.
- Configuracion privada en `.env`: `DATABASE_URL`, `REDIS_URL`,
  `GOOGLE_API_KEYS` (separadas por comas), `PORT`, `CRON_SCHEDULE` y `ACTION`.
- `npm ci` ejecuta el build y `copyStaticAssets.ts`; revisar las rutas de
  almacenamiento de ese script antes de instalar en otro entorno.
- `npm run build-ts`, `npm run lint`, `npm test` para verificar codigo.
  `tests/integration.local.cjs` requiere PostgreSQL y Redis desechables en
  localhost:15439 y localhost:16389. Nunca apuntarlo a produccion.

## Activacion Controlada

El valor predeterminado de `METADATA_MODE` es `paused`: no busca ni escribe.

| Variable | Comportamiento |
| --- | --- |
| `METADATA_MODE` | `paused`, `preview` o `write`; solo `write` registra el cron |
| `METADATA_ARCHIVE_IDS` | Array JSON de hasta 100 IDs; obligatorio para preview |
| `METADATA_RETRY_EXHAUSTED` | `false` por defecto; `true` exige IDs explicitos |
| `METADATA_MAX_ARCHIVES_PER_RUN` | Maximo de registros, 20 por defecto |
| `METADATA_MAX_REQUESTS_PER_RUN` | Maximo HTTP por corrida, 80 por defecto |
| `METADATA_BATCH_SIZE` | Lote SQL acotado, 50 por defecto |
| `MAX_ATTEMPTS` | Intentos bibliograficos, 3 por defecto |
| `DAILY_REQUEST_LIMIT` | Cuota Google por clave, 1000 por defecto |
| `REQUEST_SAFETY_BUFFER_PER_KEY` | Reserva no utilizable, 100 por defecto |
| `REQUEST_DELAY_MS` | Separacion minima entre solicitudes, 2000 por defecto |
| `CAN_USE_OPENLIBRARY_API` | Habilita OpenLibrary; `true` por defecto |

Produccion puede tener otros presupuestos de ejecucion: conservar su `.env`,
no reemplazarlo con los valores de esta tabla. Un array de IDs vacio en modo
`write` permite recorrer todo el catalogo elegible; no usarlo para un piloto.
Rehabilitar agotados requiere respaldo y seleccion explicita, no un borrado
general de `metadata_lookup_control`.

El cron usa America/Lima. Google reserva cada solicitud, incluidos reintentos,
en Redis compartido y reinicia la cuota segun America/Los_Angeles. Sin Redis
no se realizan peticiones Google. Las corridas de escritura mantienen un
bloqueo PostgreSQL para impedir ejecuciones simultaneas.

La ruta operativa `/check/:action` dispara una corrida manual; en pausa
devuelve 409. Mantener el servicio en la red de gestion, sin publicarlo como
API de usuarios. El nombre de la accion no sustituye autenticacion.

## Politica De Datos

- Errores tecnicos no resueltos y falta de cuota dejan la busqueda pendiente,
  sin consumir un intento bibliografico. Resultados insuficientes tras una
  busqueda resuelta consumen un intento, hasta el limite configurado.
- Solo titulo y autor no se publican como enriquecimiento suficiente.
- Se acepta informacion util de la obra de otra edicion cuando la identidad
  concuerda, sin atribuirle el ISBN, idioma o editorial de esa otra edicion.
- Las inversiones locales titulo/autor requieren confirmacion independiente
  de Google, ISBN local valido coincidente y autores compatibles. Se guardan
  campos originales y procedencia en `_identityCorrection`, haya o no web util.
- La correccion y la web util se guardan atomicamente si se obtienen juntas.
  No se corrige por el nombre del archivo ni solo por OpenLibrary.
- Una edicion concurrente invalida el guardado mediante huella de origen.
  No se revisan retroactivamente registros con web existente o edicion manual.

Los logs distinguen resultados guardados, insuficientes, diferidos, correcciones
locales y errores HTTP. `completed=true` significa que termino la corrida, no
que todos los registros consiguieran metadata. Los logs de tandas explicitas
incluyen diagnostico bibliografico: tratarlos como datos privados del catalogo.
