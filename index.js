'use strict';

/**
 * Asistente Puente - Prototipo Fase 1 (endurecido)
 * Webhook de WhatsApp Cloud API: recibe texto, fotos y notas de voz,
 * clasifica la intencion con un clasificador amplio local y crea
 * borradores (adaptador Legado Vivo).
 *
 * Almacén: PostgreSQL si existe DATABASE_URL, data.json local si no.
 */

const Fastify = require('fastify');
const crypto = require('node:crypto');

const store = require('./store');
const { classify } = require('./intent');
const { sendText } = require('./whatsapp');
const { downloadMediaBuffer, extForMime } = require('./media');

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || '';

// Enlace profundo de marcador (placeholder): en Fase 1 apunta a un dominio
// de ejemplo. Se reemplaza por el dominio real de Legado Vivo.
const DEEP_LINK_BASE = process.env.DEEP_LINK_BASE || 'https://legadovivo.example/borrador';

const STATUS_LABEL = {
  recibido: 'Recibido',
  'requiere información': 'Requiere información',
  procesando: 'Procesando',
  terminado: 'Terminado',
  error: 'Error',
};

const fastify = Fastify({ logger: true });

// Parser JSON que conserva el cuerpo crudo para validar la firma de Meta.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body || '';
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch (err) {
    done(err);
  }
});

function signatureValid(rawBody, header) {
  if (!APP_SECRET || !header) return false;
  const m = String(header).match(/^sha256=(.+)$/);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(rawBody, 'utf8').digest();
  const received = Buffer.from(m[1], 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function now() {
  return new Date().toISOString();
}

function deepLink(activityId) {
  return `${DEEP_LINK_BASE}/${activityId}`;
}

// ---- Verificacion del webhook (la usa Meta al configurarlo) ----
fastify.get('/webhook', async (req, reply) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    fastify.log.info('Webhook verificado por Meta.');
    return reply.code(200).send(challenge);
  }
  return reply.code(403).send('Token de verificacion invalido.');
});

// ---- Recepcion de eventos ----
fastify.post('/webhook', async (req, reply) => {
  if (!signatureValid(req.rawBody, req.headers['x-hub-signature-256'])) {
    fastify.log.warn('Firma X-Hub-Signature-256 invalida.');
    return reply.code(401).send({ error: 'Firma invalida' });
  }

  // Respuesta 200 inmediata para evitar reintentos de Meta; el
  // procesamiento continua en segundo plano.
  reply.code(200).send({ ok: true });
  handleWebhook(req.body).catch((err) => fastify.log.error(err, 'Error procesando webhook'));
});

fastify.get('/', async () => ({
  servicio: 'Asistente Puente (prototipo Fase 1)',
  estado: 'activo',
  almacen: store.backend,
  hora: now(),
}));

async function handleWebhook(payload) {
  const changes = payload?.entry?.[0]?.changes || [];
  for (const change of changes) {
    const value = change?.value || {};
    // Ignorar eventos de estado (sent/delivered/read): solo nos importan mensajes.
    const messages = value?.messages || [];
    for (const msg of messages) {
      await handleMessage(msg).catch((err) => fastify.log.error(err, `Error con mensaje ${msg.id}`));
    }
  }
}

async function clearDetailState(waId) {
  const s = await store.getSession(waId);
  s.awaitingDetails = null;
  s.awaitingDetailsAnswer = false;
  await store.saveSession(s);
}

async function saveDetails(waId, activityId, text) {
  const activity = await store.getActivity(activityId);
  if (activity) {
    await store.updateActivity(activityId, { detalles: text });
    await clearDetailState(waId);
    await safeSend(waId, `Anotado: "${text}". Tu recuerdo quedó completo.\n${deepLink(activityId)}`);
  } else {
    await clearDetailState(waId);
  }
}

/**
 * Descarga un medio de WhatsApp y lo guarda en el almacén.
 * Devuelve el descriptor del archivo ({ storage, path|ref, mime, ... }) o null.
 */
async function saveIncomingMedia(mediaId, messageId, kind, meta) {
  let dl = null;
  try {
    dl = await downloadMediaBuffer(mediaId);
  } catch (err) {
    fastify.log.error(err, `No se pudo descargar el medio ${mediaId}.`);
  }
  if (!dl) return null;
  const filename = `${messageId}${extForMime(dl.mime)}`;
  const ref = await store.saveMediaFile({
    activityId: null, // se vincula con linkMedia cuando exista la actividad
    kind,
    filename,
    mime: dl.mime,
    bytes: dl.buffer,
    meta: { ...(meta || {}), mediaId },
  });
  return { ...ref, mediaId };
}

async function handleMessage(msg) {
  const messageId = msg.id;
  const waId = msg.from;
  const type = msg.type;

  // Idempotencia: si Meta repite el evento, no se crea otro borrador.
  if (await store.isProcessed(messageId)) {
    fastify.log.info({ messageId }, 'Mensaje duplicado ignorado.');
    return;
  }
  await store.markProcessed(messageId, { from: waId, type });

  const text = type === 'text' ? msg.text?.body || '' : '';
  const cls =
    type === 'image'
      ? { intent: 'recuerdo', score: 99 }
      : type === 'audio'
        ? { intent: 'audio', score: 99 }
        : classify(text);
  fastify.log.info({ messageId, waId, type, intent: cls.intent }, 'Mensaje recibido.');

  // Tipos aun no soportados (video, documento, sticker, ubicacion...).
  if (!['text', 'image', 'audio'].includes(type)) {
    await safeSend(
      waId,
      'Por ahora solo entiendo texto, fotos y notas de voz. Mándame una foto del recuerdo y cuéntame su historia.'
    );
    return;
  }

  if (type === 'audio') {
    await handleAudio(waId, messageId, msg);
    return;
  }

  const session = await store.getSession(waId);

  // --- Captura de personas/fecha pendiente (pregunta "¿Quieres agregar personas y fecha?") ---
  if (session.awaitingDetailsAnswer) {
    if (cls.intent === 'no') {
      await clearDetailState(waId);
      await safeSend(waId, 'Sin problema, el recuerdo quedó guardado.');
      return;
    }
    await saveDetails(waId, session.awaitingDetails, text);
    return;
  }
  if (session.awaitingDetails) {
    if (cls.intent === 'no') {
      await clearDetailState(waId);
      await safeSend(waId, 'De acuerdo, el recuerdo quedó guardado igual.');
      return;
    }
    if (cls.intent === 'si') {
      session.awaitingDetailsAnswer = true;
      await store.saveSession(session);
      await safeSend(waId, 'Cuéntame: ¿qué personas aparecen y de qué fecha es el recuerdo?');
      return;
    }
    // El usuario dio los datos directamente sin decir "si": se guardan igual.
    await saveDetails(waId, session.awaitingDetails, text);
    return;
  }

  // --- Intenciones conversacionales ---
  switch (cls.intent) {
    case 'estado':
      await handleStatusCommand(waId);
      return;
    case 'ayuda':
      await safeSend(
        waId,
        'Soy el Asistente Puente (piloto). Puedo:\n' +
          '• Guardar un recuerdo: mándame una foto y cuéntame su historia (por texto o nota de voz).\n' +
          '• Agregar personas y fecha a tu recuerdo.\n' +
          '• Mostrarte tus actividades: escribe "estado".'
      );
      return;
    case 'saludo': {
      const open = await store.openActivity(waId);
      const extra = open
        ? ' Veo que tienes un recuerdo en curso: ' +
          (!open.photoReceived ? 'todavía me falta la foto.' : 'ya tengo la foto, solo me falta el relato.')
        : ' ¿Guardamos un recuerdo? Mándame una foto.';
      await safeSend(waId, `Hola. Soy el Asistente Puente.${extra}`);
      return;
    }
    case 'gracias':
      await safeSend(waId, 'De nada. Aquí estoy cuando quieras guardar otro recuerdo.');
      return;
    case 'despedida':
      await safeSend(waId, 'Hasta luego. Tus recuerdos quedan guardados.');
      return;
    case 'quien_eres':
      await safeSend(
        waId,
        'Soy el Asistente Puente: recibo lo que me mandas por WhatsApp y lo convierto en borradores para tus apps. En este piloto trabajo con recuerdos.'
      );
      return;
    case 'reintentar': {
      const acts = await store.listActivities(waId);
      const failed = acts.find((a) => a.status === 'error');
      if (failed) {
        await finishRecuerdo(waId, failed);
      } else {
        await safeSend(waId, 'No veo ningún recuerdo con error. ¿Creamos uno nuevo? Mándame una foto.');
      }
      return;
    }
    case 'recuerdo':
      await handleRecuerdo(waId, messageId, type, msg, text);
      return;
    case 'si':
    case 'no': {
      // "si"/"no" sin contexto de pregunta: si hay un recuerdo abierto,
      // se trata como parte de la conversacion del recuerdo.
      const open = await store.openActivity(waId);
      if (open) {
        await handleRecuerdo(waId, messageId, type, msg, text);
      } else {
        await safeSend(waId, '¿En qué te ayudo? Puedo guardar un recuerdo con una foto o mostrarte tus actividades con "estado".');
      }
      return;
    }
    default: {
      // Texto libre: si hay un recuerdo abierto, se toma como parte de el
      // (relato o contexto). Si no, se ofrece ayuda.
      const open = await store.openActivity(waId);
      if (open) {
        await handleRecuerdo(waId, messageId, type, msg, text);
      } else {
        await safeSend(
          waId,
          'Hola, soy el Asistente Puente (piloto). Puedo guardar un recuerdo: envíame una foto y cuéntame la historia (también vale una nota de voz). Escribe "ayuda" para ver qué sé hacer.'
        );
      }
    }
  }
}

async function handleAudio(waId, messageId, msg) {
  const session = await store.getSession(waId);
  const audioFile = await saveIncomingMedia(msg.audio?.id, messageId, 'audio', {});

  let activity = await store.openActivity(waId);

  if (!activity) {
    // Nota de voz sin recuerdo abierto: se guarda como relato pendiente.
    activity = await store.addActivity({
      id: await store.nextActivityId(),
      userWaId: waId,
      app: 'legado-vivo',
      intent: 'recuerdo',
      status: 'requiere información',
      photoReceived: false,
      photo: null,
      relato: '[nota de voz]',
      relatoAudio: audioFile ? { ...audioFile } : null,
      relatoAudioError: audioFile ? null : 'No se pudo descargar el audio.',
      idempotencyKey: messageId,
      createdAt: now(),
      updatedAt: now(),
    });
    if (audioFile) await store.linkMedia(audioFile.ref, activity.id);
    session.openActivityId = activity.id;
    await store.saveSession(session);
    await safeSend(waId, 'Recibí tu nota de voz y la guardé como relato. Ahora envíame la foto del recuerdo.');
    return;
  }

  if (!activity.photoReceived) {
    await store.updateActivity(activity.id, {
      relatoAudio: audioFile ? { ...audioFile } : activity.relatoAudio,
      relatoAudioError: audioFile ? null : 'No se pudo descargar el audio.',
      ...(activity.relato ? {} : { relato: '[nota de voz]' }),
      status: 'requiere información',
    });
    if (audioFile) await store.linkMedia(audioFile.ref, activity.id);
    await safeSend(waId, 'Nota de voz guardada como relato. Ahora envíame la foto del recuerdo.');
    return;
  }

  // Ya hay foto: la nota de voz completa el relato.
  await store.updateActivity(activity.id, {
    relatoAudio: audioFile ? { ...audioFile } : activity.relatoAudio,
    relatoAudioError: audioFile ? null : 'No se pudo descargar el audio.',
    ...(activity.relato ? {} : { relato: '[nota de voz]' }),
    status: 'procesando',
  });
  if (audioFile) await store.linkMedia(audioFile.ref, activity.id);
  await finishRecuerdo(waId, await store.getActivity(activity.id));
}

async function handleRecuerdo(waId, messageId, type, msg, text) {
  const session = await store.getSession(waId);
  let activity = await store.openActivity(waId);

  if (type === 'image') {
    // Descargar la foto (si falla, se sigue con el flujo y se registra el error).
    const photo = await saveIncomingMedia(msg.image?.id, messageId, 'photo', {
      caption: msg.image?.caption || '',
    });

    if (!activity) {
      activity = await store.addActivity({
        id: await store.nextActivityId(),
        userWaId: waId,
        app: 'legado-vivo',
        intent: 'recuerdo',
        status: 'requiere información',
        photoReceived: true,
        photo: photo ? { ...photo, caption: msg.image?.caption || '' } : null,
        photoError: photo ? null : 'No se pudo descargar la foto.',
        relato: msg.image?.caption || '',
        idempotencyKey: messageId,
        createdAt: now(),
        updatedAt: now(),
      });
      if (photo) await store.linkMedia(photo.ref, activity.id);
      session.openActivityId = activity.id;
      await store.saveSession(session);
    } else if (!activity.photoReceived) {
      await store.updateActivity(activity.id, {
        photoReceived: true,
        ...(photo ? { photo: { ...photo, caption: msg.image?.caption || '' } } : {}),
        ...(photo ? {} : { photoError: 'No se pudo descargar la foto.' }),
        status: activity.relato ? 'procesando' : 'requiere información',
      });
      if (photo) await store.linkMedia(photo.ref, activity.id);
      activity = await store.getActivity(activity.id);
    }

    // Si la imagen trae caption, puede servir como relato inicial.
    if (msg.image?.caption && activity && !activity.relato) {
      await store.updateActivity(activity.id, { relato: msg.image.caption });
      activity = await store.getActivity(activity.id);
    }

    if (activity.relato) {
      await finishRecuerdo(waId, activity);
    } else {
      await safeSend(
        waId,
        'Foto recibida. Ahora cuéntame el relato: ¿qué quieres recordar de esta foto? (puedes escribirlo o mandarme una nota de voz)'
      );
    }
    return;
  }

  // type === 'text' con intencion recuerdo o texto libre dentro de un recuerdo.
  if (!activity) {
    // Mensaje inicial ("Guarda esta foto...") o relato suelto sin foto previa.
    activity = await store.addActivity({
      id: await store.nextActivityId(),
      userWaId: waId,
      app: 'legado-vivo',
      intent: 'recuerdo',
      status: 'recibido',
      photoReceived: false,
      photo: null,
      relato: '',
      pendingText: text,
      idempotencyKey: messageId,
      createdAt: now(),
      updatedAt: now(),
    });
    session.openActivityId = activity.id;
    await store.saveSession(session);
    await safeSend(waId, 'Buena idea, guardemos ese recuerdo. Envíame la foto y luego me cuentas la historia.');
    return;
  }

  if (!activity.photoReceived) {
    // Hay actividad abierta pero falta la foto: este texto queda como
    // contexto pendiente hasta que llegue la imagen.
    await store.updateActivity(activity.id, { pendingText: text, status: 'requiere información' });
    await safeSend(waId, 'Anotado. Ahora envíame la foto del recuerdo.');
    return;
  }

  if (!activity.relato) {
    // La foto ya esta: este texto es el relato -> completar el borrador.
    await store.updateActivity(activity.id, { relato: text, status: 'procesando' });
    await finishRecuerdo(waId, await store.getActivity(activity.id));
    return;
  }

  // Actividad ya completa: iniciar una nueva con este texto como contexto.
  const fresh = await store.addActivity({
    id: await store.nextActivityId(),
    userWaId: waId,
    app: 'legado-vivo',
    intent: 'recuerdo',
    status: 'recibido',
    photoReceived: false,
    photo: null,
    relato: '',
    pendingText: text,
    idempotencyKey: messageId,
    createdAt: now(),
    updatedAt: now(),
  });
  session.openActivityId = fresh.id;
  await store.saveSession(session);
  await safeSend(waId, 'Empecé un nuevo recuerdo con tu mensaje. Envíame la foto cuando quieras.');
}

async function finishRecuerdo(waId, activity) {
  try {
    await store.updateActivity(activity.id, { status: 'procesando' });
    // Aqui el adaptador crearia el borrador en Legado Vivo; en el prototipo
    // el borrador ES el registro en el almacén.
    await store.updateActivity(activity.id, { status: 'terminado' });

    // El recuerdo queda cerrado, pero se abre la ventana para personas/fecha.
    const session = await store.getSession(waId);
    session.openActivityId = null;
    session.awaitingDetails = activity.id;
    session.awaitingDetailsAnswer = false;
    await store.saveSession(session);

    await safeSend(waId, `Recuerdo preparado. ¿Quieres agregar personas y fecha?\n${deepLink(activity.id)}`);
  } catch (err) {
    fastify.log.error(err, 'Error finalizando recuerdo.');
    await store.updateActivity(activity.id, { status: 'error' });
    await safeSend(
      waId,
      'No pude terminar el recuerdo por un error. Responde "reintentar" o vuelve a intentarlo en un momento.'
    );
  }
}

async function handleStatusCommand(waId) {
  const activities = await store.listActivities(waId);
  if (activities.length === 0) {
    await safeSend(waId, 'Todavía no tienes actividades. Envíame una foto para crear tu primer recuerdo.');
    return;
  }
  const lines = activities.slice(0, 5).map((a) => {
    const fecha = new Date(a.createdAt).toLocaleDateString('es-ES');
    const extra = a.detalles ? ` — ${a.detalles}` : '';
    return `• ${a.id} — recuerdo (${STATUS_LABEL[a.status] || a.status}) — ${fecha}${extra}\n  ${deepLink(a.id)}`;
  });
  await safeSend(waId, `Tus actividades recientes:\n${lines.join('\n')}`);
}

async function safeSend(to, body) {
  try {
    await sendText(to, body);
  } catch (err) {
    // No tumbar el webhook si falla el envio: queda registrado.
    fastify.log.error(err, `No se pudo enviar mensaje a ${to}`);
  }
}

async function start() {
  await store.init();
  fastify.log.info(`Almacén activo: ${store.backend}`);
  if (!VERIFY_TOKEN) fastify.log.warn('VERIFY_TOKEN no configurado: la verificacion de Meta fallara.');
  if (!APP_SECRET) fastify.log.warn('APP_SECRET no configurado: se rechazaran los eventos entrantes.');
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Asistente Puente escuchando en puerto ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
