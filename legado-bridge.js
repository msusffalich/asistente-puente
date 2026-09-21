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

async function forwardDraft(activity, store, log) {
  const c = bridgeConfig();
  if (!bridgeEnabled()) return { ok: false, error: 'puente no configurado' };
  const logger = log || console;
  const relato = (activity.relato || '').trim();
  const detalles = (activity.detalles || '').trim();
  const photo = await mediaToBase64(activity.photo && activity.photo.ref, store.getMediaFile);
  const audio = await mediaToBase64(
    activity.relatoAudio && activity.relatoAudio.ref,
    store.getMediaFile
  );
  const body = {
    draftId: `wa-${activity.id}`,
    familyId: c.familyId,
    title: relato.split('\n')[0].slice(0, 80) || 'Recuerdo de WhatsApp',
    text: detalles ? `${relato}\n\n${detalles}` : relato,
    transcription: activity.relatoOrigen === 'transcripcion' ? relato : '',
    people: [],
    photoBase64: photo ? photo.base64 : undefined,
    photoFilename: photo ? photo.filename : undefined,
    audioBase64: audio ? audio.base64 : undefined,
    audioFilename: audio ? audio.filename : undefined,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${c.baseUrl}/api/bridge/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': c.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      logger.error({ status: res.status, data }, 'Puente Legado Vivo: la app rechazó el borrador.');
      return { ok: false, error: data.error || `http ${res.status}` };
    }
    return { ok: true, memoryId: data.memoryId, duplicate: !!data.duplicate };
  } catch (err) {
    logger.error(err, 'Puente Legado Vivo: no se pudo enviar el borrador.');
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { bridgeConfig, bridgeEnabled, forwardDraft };
