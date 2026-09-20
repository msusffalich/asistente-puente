'use strict';

/**
 * Transcripción de notas de voz con la API Whisper de OpenAI.
 *
 * - Requiere la variable OPENAI_API_KEY (se crea en platform.openai.com).
 * - Sin clave, o en DRY_RUN, devuelve null y el bot conserva el
 *   comportamiento anterior: el audio se guarda, pero sin texto.
 * - Si la API falla (formato no soportado, red, etc.), devuelve null;
 *   nunca tumba el flujo del recuerdo.
 */

const API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

function dryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

function enabled() {
  return Boolean(process.env.OPENAI_API_KEY) && !dryRun();
}

/**
 * Transcribe un audio (Buffer) a texto en español.
 * @param {Buffer} buffer - bytes del audio (ogg/mp3/m4a/...).
 * @param {{ filename?: string, mime?: string }} opts
 * @returns {Promise<string|null>} texto transcrito o null si no se pudo.
 */
async function transcribeAudio(buffer, opts = {}) {
  if (!enabled() || !buffer || buffer.length === 0) return null;

  try {
    const filename = opts.filename || 'audio.ogg';
    const mime = opts.mime || 'audio/ogg';
    const form = new FormData();
    // Whisper usa la extensión del nombre para detectar el formato.
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', MODEL);
    form.append('language', 'es');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[transcribe] Whisper API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`
      );
      return null;
    }
    const text = String(data.text || '').trim();
    return text || null;
  } catch (err) {
    console.error('[transcribe] error:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { transcribeAudio, transcriptionEnabled: enabled };
