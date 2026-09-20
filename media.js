'use strict';

/**
 * Descarga de medios (fotos y audios) desde WhatsApp Cloud API.
 * downloadMediaBuffer devuelve { buffer, mime } o null si la descarga
 * falla o estamos en DRY_RUN. Quien llama decide donde guardarlo
 * (store.saveMediaFile: disco local o PostgreSQL).
 */

const GRAPH_VERSION = 'v22.0';
const path = require('node:path');
const MEDIA_DIR = path.join(__dirname, '..', 'media');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  // Notas de voz y audios de WhatsApp (las notas de voz llegan como audio/ogg)
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

const MAX_BYTES = 25 * 1024 * 1024;

function dryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  if (m.startsWith('audio/')) return '.ogg';
  if (m.startsWith('image/')) return '.jpg';
  return '.bin';
}

async function downloadMediaBuffer(mediaId) {
  if (dryRun()) {
    console.log(`[DRY_RUN] descarga de media ${mediaId} omitida`);
    return null;
  }

  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('Falta WHATSAPP_TOKEN en el entorno.');

  // 1. Obtener la URL firmada del medio.
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) {
    throw new Error(`No se pudo obtener la URL del medio: ${JSON.stringify(meta)}`);
  }

  // 2. Descargar el binario con autorizacion.
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) throw new Error(`Descarga de medio fallo con ${fileRes.status}`);

  const mime = (meta.mime_type || fileRes.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Archivo demasiado grande (>25MB).');

  return { buffer: buf, mime };
}

module.exports = { downloadMediaBuffer, extForMime, MEDIA_DIR };
