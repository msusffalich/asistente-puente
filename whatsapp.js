'use strict';

/**
 * Envio de mensajes por WhatsApp Cloud API (Graph API).
 * Si DRY_RUN=true solo registra en consola (para pruebas locales).
 */

const GRAPH_VERSION = 'v22.0';

function dryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

async function sendText(to, body) {
  const text = String(body || '').slice(0, 4000);

  if (dryRun()) {
    console.log(`[DRY_RUN] -> ${to}: ${text}`);
    return { dryRun: true };
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error('Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID en el entorno.');
  }

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Graph API ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

module.exports = { sendText };
