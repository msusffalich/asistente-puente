# Asistente Puente — Prototipo Fase 1

Prototipo del webhook **Asistente Puente** según la especificación funcional v1.0
(`workspace/user/files/Asistente_Puente.docx`, secciones 5 y 7).

**Alcance del piloto:** solo WhatsApp Cloud API + intención **"recuerdo"** hacia
**Legado Vivo**. El borrador se guarda en PostgreSQL si existe `DATABASE_URL`
(persistente: sobrevive reinicios y redespliegues); si no, en un almacén local
(`data.json`). Las fotos y notas de voz se guardan en la base de datos cuando
hay Postgres, o en `./media/` en modo local.

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
   - Nota de voz → se descarga y se guarda como relato del recuerdo.
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
├── src/
│   ├── index.js      # Servidor Fastify, rutas GET/POST /webhook, flujo recuerdo
│   ├── store.js      # Almacén dual: PostgreSQL (DATABASE_URL) o JSON local
│   ├── intent.js     # Clasificador de intención por reglas
│   ├── whatsapp.js   # Envío de mensajes por Graph API
│   └── media.js      # Descarga de fotos/audios a memoria (los guarda store.js)
├── media/            # Fotos descargadas (ignorado por git)
├── data.json         # Base local (se crea sola, ignorada por git)
├── package.json
├── .env.example
└── README.md
```

## Limitaciones conocidas del prototipo

- El "borrador de Legado Vivo" es un registro en la base de datos; no existe
  aún la app real.
- El enlace profundo es un marcador (`legadovivo.example`).
- Sin cola de trabajos ni reintentos persistentes (Fase 1: flujo síncrono simple).
- El audio se guarda como archivo del recuerdo; no hay transcripción a texto
  (requeriría un servicio como Whisper).
