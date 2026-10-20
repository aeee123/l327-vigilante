# Bot de cortes de energía L-327 / SIS-L327

Versión 2. Revisión y corrección: 20 de octubre de 2026.

El bot busca avisos que mencionen explícitamente L-327, L327, SIS-L327 o línea/circuito 327. La Ceiba, Atlántida, Toronjal o San Isidro por sí solos no disparan alertas: una coincidencia geográfica no demuestra que el corte afecte tu circuito.

## Qué cambió

- Revisión programada cada minuto para ENEE y las dos cuentas de X; RSS cada cinco minutos. Se consultan hasta cuatro artículos por ciclo con rotación.
- Extracción del artículo completo, su fecha de publicación y sus imágenes/PDF. Se eliminó la mezcla con preguntas frecuentes, menús y pies de página.
- X se lee como fuente experimental. Se decodifican objetos JSON sin ejecutar código remoto; texto, comillas, autor, ID y fotos se obtienen de la misma publicación. No se adivina el ID por cercanía de horario.
- Fechas explícitas con día/mes/año, fechas numéricas, cambio de año acotado y rechazo de avisos vencidos. Ventana de publicación de siete días, o evento futuro de hasta treinta días. Reportes de interrupción sin fecha de evento: hasta veinticuatro horas.
- Los cortes programados para hoy siguen siendo programados. No se asegura que físicamente se haya ido la luz solo por encontrar una fecha. Hay estados distintos para cancelaciones y restablecimientos.
- Una cola persistente y un único Durable Object coordinan las ejecuciones. Los envíos confirmados se guardan inmediatamente; los fallidos quedan pendientes con reintentos y respeto de `retry_after`.
- Se quitó el horario de silencio. Se envía como máximo un mensaje por revisión para no saturar el mismo chat.
- Todas las rutas de administración exigen `Authorization: Bearer ADMIN_TOKEN`. Las operaciones de envío exigen POST. Se eliminó `/test-texto`.
- Se informa de fallos repetidos, X con datos visibles antiguos e imágenes/PDF sin procesar. No se cuenta HTTP 200 como prueba de que X esté entregando publicaciones.
- Lector OCR opcional gratuito con Tesseract y Poppler. Procesa cada imagen/página por separado, verifica confianza y no toma el código de circuito del título de otra página.

## Lo comprobado sobre X y ENEE

La consulta directa desde este equipo devolvió cinco publicaciones de CNDHonduras, con tres fotos. El parser anterior truncaba el texto que contenía `"cerebro"`; el nuevo conserva las comillas. La publicación más reciente visible en esa respuesta fue del 16 de octubre de 2026. Una consulta desde otro servicio recibió 403. Esto verifica que el scraping puede funcionar, pero no demuestra que el conjunto visible esté completo ni actualizado.

La lista oficial de mantenimientos consultada devolvió nueve enlaces de mayo de 2026. Un boletín semanal contenía una portada y un enlace acortado al documento. Una búsqueda de palabras en títulos nunca cubriría todos esos avisos.

La API oficial de X usa pago por consumo. No se activó ninguna API de pago ni se incluyeron cookies de sesiones personales.

## Instalación y activación

Necesitás Node.js 22 o superior y una cuenta Cloudflare. Ejecutar desde la raíz de este proyecto:

```powershell
npm ci
npm test
npm run test:runtime
npm run check
npx wrangler login
```

Crear tres secretos en el Worker. Si los dos secretos de Telegram ya existen, se conservan y no hace falta volver a introducirlos:

```powershell
npx wrangler secret put TELEGRAM_TOKEN --config worker/wrangler.toml
npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml
npm run deploy
```

ADMIN_TOKEN debe ser un valor aleatorio largo (por ejemplo, 32 bytes aleatorios); usar el mismo en el lector OCR. No publicar valores en código, capturas ni mensajes. Los comandos solicitan los valores de forma interactiva.

El archivo `wrangler.toml` incluye la creación del Durable Object con SQLite, disponible en Cloudflare Free. Conserva el binding KV anterior para no borrar el historial antiguo, aunque la versión nueva no lo usa para coordinar envíos. No hay migración de hashes antiguos: en el primer arranque puede repetirse un aviso reciente que la versión anterior ya hubiera enviado. La deduplicación nueva guarda huellas de textos completos durante noventa días; no identifica como iguales todas las redacciones diferentes del mismo evento.

Versión publicada el 20 de octubre de 2026 en https://l327-vigilante.l327bot.workers.dev, con cron cada minuto y prueba de Telegram aceptada. El OCR de GitHub está habilitado en este repositorio, con secretos configurados y ejecución programada cada cinco minutos. Se comprobó su comunicación con Cloudflare y la lectura de imágenes reales.

### Comprobar el bot

Guardar la URL real del Worker y el token en variables de la sesión de PowerShell. No sustituirlos dentro de archivos versionados.

```powershell
$botUrl = 'https://TU-WORKER.workers.dev'
$adminHeaders = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
Invoke-RestMethod "$botUrl/status" -Headers $adminHeaders
Invoke-RestMethod "$botUrl/test-alert" -Method Post -Headers $adminHeaders
Invoke-RestMethod "$botUrl/run" -Method Post -Headers $adminHeaders
```

`/status` muestra última revisión, resultado y antigüedad de cada fuente, cola, errores de Telegram y documentos pendientes. `/media` lista hasta doce documentos pendientes que no hayan agotado tres intentos. Los errores agotados siguen visibles en `/status`; requieren revisar la fuente o reiniciar su procesamiento mediante una futura herramienta administrativa. El bot no los declara exitosos.

`/test-alert` manda una prueba claramente identificada, sin fingir un corte. Sin token, devuelve 401; con GET, 405. Hay un límite de una prueba por minuto.

## OCR gratuito: dos alternativas

### A. Equipo propio encendido

Instalar Python 3, Tesseract con idiomas `spa` y `eng`, y Poppler (`pdfinfo`, `pdftoppm`) en PATH. No requiere paquetes Python adicionales. Configurar `BOT_URL` y `ADMIN_TOKEN` como variables de entorno y ejecutar:

```powershell
python tools/ocr_reader.py
```

Programar esa ejecución cada uno o dos minutos con el programador del sistema. Si ese equipo se apaga o pierde internet durante un corte, el OCR deja de funcionar; el Worker continúa y registra contenido pendiente. Puede ejecutarse en otro equipo con conexión estable.

### B. GitHub Actions

El flujo `.github/workflows/ocr.yml` ya está preparado, pero empieza deshabilitado. En el repositorio de GitHub, configurar:

1. Secret `BOT_URL`: origen HTTPS del Worker, sin ruta ni barra final.
2. Secret `ADMIN_TOKEN`: el mismo secreto configurado en Cloudflare.
3. Variable `ENABLE_OCR`: `true`.
4. Habilitar Actions y mantener el flujo en la rama predeterminada.

En repositorios públicos, los runners estándar son gratuitos. En privados hay una cuota de minutos: un flujo cada cinco minutos puede superarla. No se cambió la visibilidad de ningún repositorio ni se publicó el proyecto. GitHub programa como mínimo cada cinco minutos y puede retrasar las ejecuciones; además deshabilita horarios en repositorios públicos tras sesenta días sin actividad. No es una garantía de notificación instantánea.

El lector acepta solo hosts explícitos, HTTPS y destinos públicos; no reenvía el token administrativo a los documentos. Limita cada documento a 20 MB y cada PDF a veinte páginas. Los enlaces acortados que no terminen en un formato permitido quedan pendientes para revisión.

## Opciones y costo

| Opción | Costo y utilidad | Limitación |
|---|---|---|
| Cloudflare Worker + Durable Object SQLite | Plan gratuito dentro de sus cuotas; revisión por minuto, persistencia y coordinación | No asegura que las fuentes publiquen contenido nuevo o completo |
| Web oficial ENEE | Sin API de pago; fuente primaria de mantenimiento | La lista consultada parecía atrasada; parte del contenido está en imágenes/documentos |
| Scraping X actual | Sin API de pago; conserva publicaciones y fotos cuando la respuesta las incluye | Bloqueos, contenido parcial y cambios de estructura; siempre experimental |
| Google News RSS | Respaldo gratuito por código exacto del circuito | Depende de indexación; no sirve como señal inmediata garantizada |
| Tesseract/Poppler en equipo propio | Software gratuito; puede ejecutarse cada minuto | Equipo e internet disponibles; OCR puede equivocarse |
| Tesseract/Poppler en Actions público | Runner estándar gratuito | Cinco minutos o más; atrasos e inactividad; exige habilitación |
| RSSHub autohospedado para X | Software abierto, adaptable como fuente futura | Requiere servidor y normalmente sesión/cookie; mantenimiento y fallos documentados. No se añadió un intermediario público no verificado |
| API oficial X | Pago por consumo | No encaja con costo cero; no activada |

Cloudflare KV Free permite 1.000 escrituras/día: guardar un estado cada minuto consumiría 1.440 incluso sin alertas. Por eso la coordinación nueva usa SQLite de Durable Objects, cuyo plan gratuito contempla 100.000 filas escritas/día y 100.000 solicitudes/día, además de otras cuotas. El consumo exacto depende del tráfico y de cuántos avisos se reciban; mantener la cuenta en Free si se requiere costo cero.

## Límites de exactitud y entrega

- Un anuncio leído como texto puede detectarse en el siguiente ciclo de un minuto; artículos nuevos, reintentos, cola, imágenes y feeds pueden tardar más. No se puede prometer avisar en el instante de publicación con estas fuentes gratuitas.
- OCR tiene errores. Se exige confianza media mínima de 55, pero esa media no garantiza que cada carácter sea correcto. No se convierte un código parecido en L-327 mediante coincidencias aproximadas.
- Si una página menciona varios circuitos, el mensaje pide revisar alcance y fechas en el original; no atribuye todas las filas a L-327. Si el circuito solo aparece en una imagen que no se pudo leer, no se inventa una coincidencia.
- Si Telegram acepta un mensaje y se pierde la respuesta o el proceso cae antes de guardar la confirmación, un reintento puede duplicarlo. Telegram no ofrece aquí una clave de idempotencia; el estado marca las respuestas inciertas. Los éxitos confirmados se guardan antes de intentar otro envío.
- Un enlace o imagen que cambie sus bytes manteniendo la misma URL y sin cambios en el documento padre puede requerir una revisión manual para volver a leerlo.

## Validación

```powershell
npm test
npm run test:runtime
python -m unittest discover -s tests -p 'test_*.py'
npm run check
```

Incluye pruebas de regresión de fechas, circuito, antigüedad, parser X, contenido de artículos, autorización, reintentos, 429, persistencia, concurrencia y separación de páginas OCR. La prueba de runtime usa el motor local de Cloudflare con SQLite. Las pruebas Python verifican el lector y sus controles con procesos simulados; Tesseract/Poppler no estaban instalados en el equipo de auditoría, y el OCR real se validó posteriormente en el runner de GitHub. No se enviaron mensajes reales durante las pruebas.

## Documentación consultada

- X, precios oficiales: https://docs.x.com/x-api/getting-started/pricing
- ENEE, mantenimientos: https://www.eneeutcd.hn/es/inoticias/listar/G2/249/1/mantenimientos-programados/
- Cloudflare Durable Objects, precios: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare KV, límites: https://developers.cloudflare.com/kv/platform/limits/
- GitHub Actions, facturación: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- GitHub Actions, horarios: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- Tesseract: https://github.com/tesseract-ocr/tesseract
- RSSHub, implementación X: https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/api/web-api/utils.ts
- Telegram, límites de envío: https://core.telegram.org/bots/faq


