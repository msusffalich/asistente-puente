# Asistente Puente — Prototipo Fase 1 (v5)

> v5: puente con Legado Vivo. Cada recuerdo completado se envía como borrador
> ("Pendiente de completar") a la app pública de Legado Vivo en Railway.

Prototipo del webhook **Asistente Puente** según la especificación funcional v1.0
(`workspace/user/files/Asistente_Puente.docx`, secciones 5 y 7).

**Alcance del piloto:** solo WhatsApp Cloud API + intención **"recuerdo"** hacia
**Legado Vivo**. El borrador se guarda en PostgreSQL si existe `DATABASE_URL`
(persistente: sobrevive reinicios y redespliegues); si no, en un almacén local
(`data.json`). Las fotos y notas de voz se guardan en la base de datos cuando
hay Postgres, o en `./media/` en modo local. Las notas de voz se transcriben
a texto con Whisper si existe `OPENAI_API_KEY`.

## Qué hace

1. `GET /webhook` — verificación del challenge de Meta.
2. `POST /webhook` — recibe eventos de WhatsApp:
   - Valida la firma `X-Hub-Signature-256` con `APP_SECRET`.
   - Responde `200` de inmediato y procesa en segundo plano.
   - **Idempotencia:** el ID de cada mensaje de Meta se registra; si el evento se
     repite, no se crea un segundo borrador.
   - Descarga fotos y audios con el token y los guarda en el almacén
     (PostgreSQL si hay `DATABASE_URL`, `./media/` en modo local).
3. Clasificador amplio de intención (local, sin API externa):
   - Normaliza el texto (minúsculas, sin tildes) y puntúa grupos de frases.
   - Intenciones: `recuerdo`, `estado`, `ayuda`, `quien_eres`, `saludo`,
     `gracias`, `despedida`, `si`, `no`, `reintentar`.
   - Entiende formulaciones libres ("te mando esta foto de mi infancia",
     "quiero conservar este momento", "¿cómo quedó lo que empezamos?").
4. Flujo "recuerdo":
   - Foto sin relato → pregunta por el relato (acepta texto o nota de voz).
   - Nota de voz → se descarga, se transcribe a texto con Whisper (si hay
     `OPENAI_API_KEY`) y el texto queda como relato del recuerdo. Sin clave,
     se guarda solo el audio.
   - Texto inicial libre → confirma y espera la foto.
   - Foto + relato (texto o audio) → crea el borrador (`act-0001`, …) con estado **terminado** y responde:
     *"Recuerdo preparado. ¿Quieres agregar personas y fecha?"* + enlace profundo
     (marcador `https://legadovivo.example/borrador/{id}`, se reemplaza por el dominio real).
   - Si respondes "sí", te pide personas y fecha y los anota en el borrador.
5. Estados: `recibido`, `requiere información`, `procesando`, `terminado`, `error`.

## Instalación

Requisitos: Node.js 18 o superior.

```bash
cd ~/workspace/asistente-puente
npm install
cp .env.example .env
```

Edita `.env` con tus valores (obtenidos en Meta for Developers):

| Variable          | Dónde obtenerla |
|-------------------|-----------------|
| `VERIFY_TOKEN`    | La inventas tú (texto largo y aleatorio). Debe coincidir con la que pegues en el panel de Meta. |
| `APP_SECRET`      | App Dashboard → Configuración → Básica → Clave secreta de la app. |
| `WHATSAPP_TOKEN`  | WhatsApp → API Setup → token temporal (pruebas) o permanente (producción). |
| `PHONE_NUMBER_ID` | WhatsApp → API Setup → identificador del número. |
| `DATABASE_URL`    | URL de PostgreSQL (Render, Supabase, Neon...). Sin ella usa `data.json` local. |
| `OPENAI_API_KEY`  | Clave de OpenAI (platform.openai.com) para transcribir notas de voz con Whisper. Opcional. |
| `DRY_RUN`         | `true` para probar sin llamadas reales a Meta. |

> **Seguridad:** nunca subas el `.env` a git ni pegues tokens en código, chats
> públicos o capturas. El `.gitignore` ya excluye `.env`, `data.json` y `media/`.

Iniciar:

```bash
npm start
```

## Probar localmente

Con `DRY_RUN=true` no se hacen llamadas reales a la API de WhatsApp: las
respuestas se muestran en la consola.

```bash
VERIFY_TOKEN=prueba123 APP_SECRET=secreto DRY_RUN=true PORT=3000 npm start
```

**1. Verificación del webhook** (simula lo que hace Meta al configurar):

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=prueba123&hub.challenge=reto456"
# responde: reto456
```

**2. Envío de un mensaje de texto** (firma HMAC-SHA256 con `APP_SECRET`):

```bash
PAYLOAD='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.TEST1","from":"51999999999","type":"text","text":{"body":"Guarda esta foto y lo que te voy a contar"}}]}}]}]}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "secreto" | sed 's/^.* //')
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$PAYLOAD"
# responde: {"ok":true}
```

En la consola verás el mensaje que se "enviaría" por WhatsApp. Revisa
`data.json`: se creó la actividad `act-0001` en estado `recibido`.

**3. Idempotencia:** repite el mismo `curl` del paso 2. No se crea una segunda
actividad (el mensaje duplicado se ignora por su ID).

**4. Comando de estado:**

```bash
PAYLOAD='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.TEST2","from":"51999999999","type":"text","text":{"body":"¿cómo quedó lo que empezamos?"}}]}}]}]}'
# (calcula $SIG igual que antes y repite el curl)
```

## Despliegue con HTTPS (ejemplo: Render)

Meta exige una URL pública **HTTPS** para el webhook. Pasos con Render (plan gratuito):

1. Sube este proyecto a un repositorio de GitHub (**sin** el archivo `.env`).
2. En [render.com](https://render.com) → **New +** → **Web Service** → conecta el repositorio.
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Agrega las variables de entorno: `VERIFY_TOKEN`, `APP_SECRET`,
     `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` (y opcionalmente `DEEP_LINK_BASE`
     con el dominio real de Legado Vivo).
4. Despliega y copia la URL pública, por ejemplo:
   `https://asistente-puente.onrender.com`

> Nota: en el plan gratuito el servicio "duerme" tras inactividad; el primer
> mensaje puede tardar ~30 s en despertar. Para un piloto es aceptable.

## Base de datos PostgreSQL (persistencia real)

Sin `DATABASE_URL`, el bot guarda todo en `data.json` y `./media/` dentro del
servidor: **ese disco se borra en cada redespliegue o reinicio** (plan gratuito
de Render). Para que los recuerdos sobrevivan:

1. Crea una base **PostgreSQL** (en Render: **New +** → **PostgreSQL**;
   también valen Supabase o Neon).
2. Copia su **External Database URL**.
3. En tu Web Service → **Environment** → agrega `DATABASE_URL` con ese valor.
4. Redespliega. Al arrancar verás en los logs `Almacén activo: postgres`.

El bot crea solo sus tablas (`puente_processed`, `puente_sessions`,
`puente_activities`, `puente_media`) y la secuencia `puente_activity_seq`
(los IDs nuevos empiezan en `act-10000` para no chocar con los del modo local).
Fotos y audios se guardan como bytes en `puente_media`, así que nada se pierde.

## Transcripción de notas de voz (Whisper)

Sin configuración extra, el bot guarda el audio y el relato queda como
`[nota de voz]`. Para que transcriba el audio a texto:

1. Crea una cuenta en [platform.openai.com](https://platform.openai.com) y
   genera una **API key** en **API keys**.
2. En Render → tu servicio → **Environment** → agrega `OPENAI_API_KEY`
   con ese valor → **Save Changes**.
3. Al arrancar verás en los logs `Transcripción de voz: activada (Whisper)`.

Comportamiento:

- Cada nota de voz se transcribe al recibirla; el texto queda guardado como
  relato del recuerdo (campo `relato`, origen `transcripcion`) y el bot te
  responde mostrándote la transcripción para que la verifiques.
- El audio original se sigue guardando igual que antes.
- Si la transcripción falla (o no hay clave), el flujo no se interrumpe:
  el recuerdo continúa con el audio guardado.
- Costo aproximado: Whisper cuesta ~$0.006 USD por minuto de audio; una nota
  de voz típica cuesta una fracción de centavo.

> **Seguridad:** la clave de OpenAI es un secreto: guárdala solo en las
> variables de entorno de Render, nunca en el código ni en el chat.

## Migrar a tu número propio

El número de prueba de Meta solo sirve para pilotos. Para usar tu propio número:


1. **Ese número dejará de funcionar como WhatsApp normal.** Si hoy lo usas en
   la app de WhatsApp, primero elimina esa cuenta
   (WhatsApp → Ajustes → Cuenta → Eliminar mi cuenta) o cambia tu WhatsApp
   personal a otro número. Este paso es obligatorio: un número no puede estar
   en la app y en la API a la vez.
2. En [Meta for Developers](https://developers.facebook.com) → tu app
   **Asistente Puente** → **WhatsApp** → **API Setup** → **Phone numbers** →
   **Add phone number** → ingresa tu número y verifícalo con el código SMS o
   por llamada.
3. Copia el nuevo **Phone Number ID**.
4. En Render → tu servicio → **Environment** → actualiza `PHONE_NUMBER_ID`
   con el nuevo valor. El `WHATSAPP_TOKEN` permanente sigue sirviendo (el
   número pertenece a la misma app).
5. Redespliega y prueba escribiéndole a tu número desde otro teléfono.

## Configurar el webhook en Meta

1. Entra a [Meta for Developers](https://developers.facebook.com) → tu app
   **Asistente Puente** → **WhatsApp** → **Configuration**.
2. En la sección **Webhook**:
   - **Callback URL:** `https://asistente-puente.onrender.com/webhook`
     (tu URL real + `/webhook`).
   - **Verify token:** el mismo valor de `VERIFY_TOKEN` de tu `.env`.
   - Pulsa **Verify and save**. Si responde el challenge, queda verificado.
3. En **Webhook fields** pulsa **Subscribe** en el campo **`messages`**.
4. Prueba real: desde tu WhatsApp escribe al número de prueba, por ejemplo:
   *"Guarda esta foto"* + adjunta una foto, y luego envía el relato.

## Estructura del proyecto

```
asistente-puente/
├── index.js        # Servidor Fastify, rutas GET/POST /webhook, flujo recuerdo
├── store.js        # Almacén dual: PostgreSQL (DATABASE_URL) o JSON local
├── intent.js       # Clasificador de intención por reglas
├── whatsapp.js     # Envío de mensajes por Graph API
├── transcribe.js   # Transcripción de notas de voz con Whisper (OpenAI)
├── media.js        # Descarga de fotos/audios a memoria (los guarda store.js)
├── legado-bridge.js # Puente: envía cada recuerdo a Legado Vivo (Railway)
├── media/          # Fotos descargadas (ignorado por git)
├── data.json       # Base local (se crea sola, ignorada por git)
├── package.json
├── .env.example
└── README.md
```

## Puente con Legado Vivo (app pública)

Cuando un recuerdo se completa (foto + relato), el bot lo envía automáticamente
como borrador a la app de Legado Vivo, donde queda como **"Pendiente de
completar"** en la familia configurada. La foto, el audio y la transcripción
viajan con el borrador.

Configuración (variables de entorno en Render):

| Variable           | Valor |
|--------------------|-------|
| `LEGADO_VIVO_URL`  | URL pública de la app, ej. `https://web-production-c3b86.up.railway.app` |
| `BRIDGE_API_KEY`   | La MISMA clave configurada como `BRIDGE_API_KEY` en la app (Railway) |
| `LEGADO_FAMILY_ID` | Id numérico de tu familia (se ve en la URL al abrirla: `/families/3`) |

Si falta alguna de las tres, el puente queda desactivado y el bot sigue
funcionando como antes. El estado se ve en la raíz `/` del servicio
(`puente_legado: configurado | no configurado`).

Nota: las personas y la fecha que el usuario agregue después por WhatsApp
(detalles) quedan en el bot; en la app se completan abriendo el recuerdo
pendiente.

## Limitaciones conocidas del prototipo

- El enlace profundo sigue siendo un marcador (`legadovivo.example`) salvo que
  configures `DEEP_LINK_BASE` con la URL real.
- Sin cola de trabajos ni reintentos persistentes (Fase 1: flujo síncrono simple).
- La transcripción de voz requiere `OPENAI_API_KEY`; sin ella el audio se
  guarda pero sin texto.
- El puente envía el borrador al completar el recuerdo; los detalles
  (personas/fecha) que se agreguen después por WhatsApp no se reenvían:
  se completan en la app.
