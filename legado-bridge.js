'use strict';
// Puente hacia Legado Vivo (app pública en Railway).
// Cuando un recuerdo se completa en WhatsApp, lo envía como borrador
// ("Pendiente de completar") a POST {LEGADO_VIVO_URL}/api/bridge/drafts
// con el header x-bridge-key: {BRIDGE_API_KEY}.
//
// Variables de entorno (las 3 son obligatorias para activar el puente):
//   LEGADO_VIVO_URL  ej. https://web-production-c3b86.up.railway.app
//   BRIDGE_API_KEY    debe ser la MISMA clave configurada en la app (Railway)
//   LEGADO_FAMILY_ID  id numérico de la familia destino (se ve en la URL /families/:id)
//
// Si falta alguna, el puente queda desactivado y el bot sigue funcionando como antes.
//
// Persistencia (v6): forwardDraft reintenta con backoff porque Railway puede
// tardar en "despertar" (cold start de 30-60s). El draftId wa-<activity.id> hace
// que los reintentos sean idempotentes: la app nunca duplica el recuerdo.

const ATTEMPT_TIMEOUT_MS = 45000;      // por intento (aguanta cold start de Railway)
const RETRY_DELAYS_MS = [5000, 20000, 45000]; // esperas entre intentos (4 intentos en total)

function bridgeConfig() {
  return {
    baseUrl: (process.env.LEGADO_VIVO_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.BRIDGE_API_KEY || '',
    familyId: parseInt(process.env.LEGADO_FAMILY_ID || '', 10) || 0,
  };
}

function bridgeEnabled() {
  const c = bridgeConfig();
  return Boolean(c.baseUrl && c.apiKey && c.familyId);
}

async function mediaToBase64(ref, getMediaFile) {
  if (!ref || typeof getMediaFile !== 'function') return null;
  try {
    const f = await getMediaFile(ref);
    if (!f || !f.bytes || !f.bytes.length) return null;
    return { base64: Buffer.from(f.bytes).toString('base64'), filename: f.filename || 'archivo' };
  } catch {
    return null;
  }
}

// Calentamiento best-effort: despierta la app en Railway antes del POST real.
// Nunca falla el flujo: si no responde, igual se intenta el envío.
async function warmup(baseUrl, log) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    await fetch(baseUrl + '/', { method: 'GET', signal: ctrl.signal });
  } catch (err) {
    (log || console).info({ err: String((err && err.message) || err) }, 'Puente Legado Vivo: warmup sin respuesta (se continúa).');
  } finally {
    clearTimeout(timer);
  }
}

async function tryOnce(body, config, log) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/api/bridge/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': config.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `http ${res.status}` };
    }
    return { ok: true, memoryId: data.memoryId, duplicate: !!data.duplicate };
  } catch (err) {
    const msg = String((err && err.message) || err);
    (log || console).error({ err: msg }, 'Puente Legado Vivo: intento de envío falló.');
    return { ok: false, error: msg.includes('abort') ? 'timeout (la app tardó en responder)' : msg };
  } finally {
    clearTimeout(timer);
  }
}

function buildBody(activity, photo, audio) {
  const relato = (activity.relato || '').trim();
  const detalles = (activity.detalles || '').trim();
  return {
    draftId: `wa-${activity.id}`,
    familyId: bridgeConfig().familyId,
    title: relato.split('\n')[0].slice(0, 80) || 'Recuerdo de WhatsApp',
    text: detalles ? `${relato}\n\n${detalles}` : relato,
    transcription: activity.relatoOrigen === 'transcripcion' ? relato : '',
    people: [],
    photoBase64: photo ? photo.base64 : undefined,
    photoFilename: photo ? photo.filename : undefined,
    audioBase64: audio ? audio.base64 : undefined,
    audioFilename: audio ? audio.filename : undefined,
  };
}

// Envía el borrador con reintentos. Devuelve:
// { ok, memoryId?, duplicate?, attempts, error?, photoMissing? }
async function forwardDraft(activity, store, log) {
  const c = bridgeConfig();
  if (!bridgeEnabled()) return { ok: false, error: 'puente no configurado', attempts: 0 };
  const logger = log || console;
  const photo = await mediaToBase64(activity.photo && activity.photo.ref, store.getMediaFile);
  const audio = await mediaToBase64(
    activity.relatoAudio && activity.relatoAudio.ref,
    store.getMediaFile
  );
  if (!photo && activity.photoReceived) {
    logger.error({ activityId: activity.id }, 'Puente Legado Vivo: no se pudo descargar la foto; el borrador irá sin foto.');
  }
  const body = buildBody(activity, photo, audio);

  await warmup(c.baseUrl, logger);

  let lastError = 'desconocido';
  const total = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= total; attempt++) {
    logger.info({ activityId: activity.id, attempt, total }, 'Puente Legado Vivo: enviando borrador.');
    const r = await tryOnce(body, c, logger);
    if (r.ok) {
      return { ...r, attempts: attempt, photoMissing: !photo && !!activity.photoReceived };
    }
    lastError = r.error;
    if (attempt < total) {
      const wait = RETRY_DELAYS_MS[attempt - 1];
      logger.info({ activityId: activity.id, waitMs: wait, error: lastError }, 'Puente Legado Vivo: reintentando envío.');
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  return { ok: false, error: lastError, attempts: total, photoMissing: !photo && !!activity.photoReceived };
}

module.exports = { bridgeConfig, bridgeEnabled, forwardDraft };
