'use strict';

/**
 * Almacén dual del Asistente Puente.
 *
 * - Si existe la variable DATABASE_URL: usa PostgreSQL (persistente:
 *   los borradores y los audios/fotos sobreviven reinicios y redespliegues).
 * - Si no existe: usa data.json + ./media/ en disco local (modo prototipo).
 *
 * La interfaz es asíncrona en ambos modos. index.js siempre la usa con await.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const MEDIA_DIR = path.join(__dirname, '..', 'media');

const usePostgres = Boolean(process.env.DATABASE_URL);
const backend = usePostgres ? 'postgres' : 'json';

// ---------------------------------------------------------------------------
// Backend JSON local (modo prototipo / DRY_RUN)
// ---------------------------------------------------------------------------

function emptyDb() {
  return { processedMessages: {}, sessions: {}, activities: [], seq: 0 };
}

function loadJson() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const db = JSON.parse(raw);
    db.processedMessages = db.processedMessages || {};
    db.sessions = db.sessions || {};
    db.activities = db.activities || [];
    db.seq = db.seq || 0;
    return db;
  } catch {
    return emptyDb();
  }
}

let jsonDb = null;
function jdb() {
  if (!jsonDb) jsonDb = loadJson();
  return jsonDb;
}
function jsave() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(jdb(), null, 2));
}

// ---------------------------------------------------------------------------
// Backend PostgreSQL
// ---------------------------------------------------------------------------

let pool = null;

/** Gancho solo para pruebas: permite inyectar un pool falso/emulado. */
function __setPoolForTests(p) {
  pool = p;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS puente_processed (
  message_id TEXT PRIMARY KEY,
  info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS puente_sessions (
  wa_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS puente_activities (
  id TEXT PRIMARY KEY,
  user_wa_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_puente_activities_user ON puente_activities (user_wa_id);
CREATE TABLE IF NOT EXISTS puente_media (
  id SERIAL PRIMARY KEY,
  activity_id TEXT,
  kind TEXT,
  filename TEXT,
  mime TEXT,
  meta JSONB,
  bytes BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS puente_activity_seq START WITH 10000;
`;

async function pgInit() {
  if (pool) {
    await pool.query(SCHEMA_SQL);
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render/Supabase/Neon exigen SSL; en Postgres local sin SSL esto tambien funciona.
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// Interfaz pública (asíncrona)
// ---------------------------------------------------------------------------

async function init() {
  if (usePostgres) await pgInit();
  else jdb();
}

async function isProcessed(messageId) {
  if (usePostgres) {
    const r = await pool.query('SELECT 1 FROM puente_processed WHERE message_id = $1', [messageId]);
    return r.rowCount > 0;
  }
  return Boolean(jdb().processedMessages[messageId]);
}

async function markProcessed(messageId, info) {
  if (usePostgres) {
    await pool.query(
      'INSERT INTO puente_processed (message_id, info) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING',
      [messageId, info || {}]
    );
    return;
  }
  jdb().processedMessages[messageId] = { at: new Date().toISOString(), ...(info || {}) };
  jsave();
}

function defaultSession(waId) {
  return { waId, openActivityId: null };
}

async function getSession(waId) {
  if (usePostgres) {
    const r = await pool.query('SELECT data FROM puente_sessions WHERE wa_id = $1', [waId]);
    if (r.rowCount === 0) return defaultSession(waId);
    return { ...defaultSession(waId), ...r.rows[0].data };
  }
  const db = jdb();
  if (!db.sessions[waId]) db.sessions[waId] = defaultSession(waId);
  return db.sessions[waId];
}

async function saveSession(session) {
  if (usePostgres) {
    await pool.query(
      `INSERT INTO puente_sessions (wa_id, data) VALUES ($1, $2)
       ON CONFLICT (wa_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [session.waId, session]
    );
    return;
  }
  jdb().sessions[session.waId] = session;
  jsave();
}

async function clearOpenActivity(waId) {
  const s = await getSession(waId);
  s.openActivityId = null;
  await saveSession(s);
}

async function openActivity(waId) {
  const s = await getSession(waId);
  if (!s.openActivityId) return null;
  return getActivity(s.openActivityId);
}

async function nextActivityId() {
  if (usePostgres) {
    const r = await pool.query("SELECT nextval('puente_activity_seq') AS n");
    return `act-${String(r.rows[0].n).padStart(4, '0')}`;
  }
  const db = jdb();
  db.seq += 1;
  jsave();
  return `act-${String(db.seq).padStart(4, '0')}`;
}

async function addActivity(activity) {
  if (usePostgres) {
    await pool.query(
      'INSERT INTO puente_activities (id, user_wa_id, data) VALUES ($1, $2, $3)',
      [activity.id, activity.userWaId, activity]
    );
    return activity;
  }
  jdb().activities.push(activity);
  jsave();
  return activity;
}

async function getActivity(id) {
  if (usePostgres) {
    const r = await pool.query('SELECT data FROM puente_activities WHERE id = $1', [id]);
    return r.rowCount ? r.rows[0].data : null;
  }
  return jdb().activities.find((a) => a.id === id) || null;
}

async function updateActivity(id, patch) {
  if (usePostgres) {
    const current = await getActivity(id);
    if (!current) return null;
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await pool.query(
      'UPDATE puente_activities SET data = $2, updated_at = now() WHERE id = $1',
      [id, merged]
    );
    return merged;
  }
  const db = jdb();
  const a = db.activities.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  jsave();
  return a;
}

async function listActivities(waId) {
  if (usePostgres) {
    const r = await pool.query(
      'SELECT data FROM puente_activities WHERE user_wa_id = $1 ORDER BY created_at DESC LIMIT 50',
      [waId]
    );
    return r.rows.map((row) => row.data);
  }
  return jdb()
    .activities.filter((a) => a.userWaId === waId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Guarda un archivo descargado (foto o audio).
 * - Modo postgres: guarda los bytes en la tabla puente_media, devuelve
 *   { storage: 'db', ref: 'db:<id>', mime, filename }.
 * - Modo json: escribe en ./media/, devuelve { storage: 'file', path, mime }.
 */
async function saveMediaFile({ activityId, kind, filename, mime, bytes, meta }) {
  if (usePostgres) {
    const r = await pool.query(
      `INSERT INTO puente_media (activity_id, kind, filename, mime, meta, bytes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [activityId || null, kind || null, filename || null, mime || null, meta || {}, bytes]
    );
    return { storage: 'db', ref: `db:${r.rows[0].id}`, mime, filename };
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const dest = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(dest, bytes);
  return { storage: 'file', path: dest, mime };
}

/** Vincula un medio guardado con su actividad (solo tiene efecto en postgres). */
async function linkMedia(ref, activityId) {
  if (!usePostgres || !ref || !String(ref).startsWith('db:')) return;
  const id = Number(String(ref).slice(3));
  if (!Number.isFinite(id)) return;
  await pool.query('UPDATE puente_media SET activity_id = $2 WHERE id = $1', [id, activityId]);
}

/** Recupera un medio guardado en postgres por su ref ('db:<id>'). */
async function getMediaFile(ref) {
  if (!usePostgres || !ref || !String(ref).startsWith('db:')) return null;
  const id = Number(String(ref).slice(3));
  if (!Number.isFinite(id)) return null;
  const r = await pool.query('SELECT id, kind, filename, mime, meta, bytes FROM puente_media WHERE id = $1', [id]);
  return r.rowCount ? r.rows[0] : null;
}

module.exports = {
  backend,
  init,
  markProcessed,
  isProcessed,
  getSession,
  saveSession,
  clearOpenActivity,
  openActivity,
  nextActivityId,
  addActivity,
  getActivity,
  updateActivity,
  listActivities,
  saveMediaFile,
  linkMedia,
  getMediaFile,
  __setPoolForTests,
};
