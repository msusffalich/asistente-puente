'use strict';

/**
 * Descarga de medios (fotos) desde WhatsApp Cloud API a ./media/.
 * Devuelve { path, mime } o null si la descarga falla.
 */

const fs = require('node:fs');
const path = require('node:path');

const GRAPH_VERSION = 'v22.0';
const MEDIA_DIR = path.join(__dirname, '..', 'media');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function dryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

async function downloadMedia(mediaId, fileHint) {
  if (dryRun()) {
    console.log(`[DRY_RUN] descarga de media ${mediaId} omitida`);
    return null;
  }

  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('Falta WHATSAPP_TOKEN en el entorno.');

  // 1. Obtener la URL firmada del medio.
  const metaRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) {
    throw new Error(`No se pudo obtener la URL del medio: ${JSON.stringify(meta)}`);
  }

  // 2. Descargar el binario con autorizacion.
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) throw new Error(`Descarga de medio fallo con ${fileRes.status}`);

  const mime = (meta.mime_type || fileRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const ext = EXT_BY_MIME[mime] || '.jpg';
  const name = `${fileHint || mediaId}${ext}`;
  const dest = path.join(MEDIA_DIR, name);

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const buf = Buffer.from(await fileRes.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error('Archivo demasiado grande (>25MB).');
  fs.writeFileSync(dest, buf);

  return { path: dest, mime };
}

module.exports = { downloadMedia, MEDIA_DIR };
