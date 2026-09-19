'use strict';

/**
 * Almacen local simple en JSON (data.json).
 * Prototipo Fase 1: guarda mensajes procesados (idempotencia), sesiones
 * por usuario y actividades (borradores). En produccion se reemplazaria
 * por PostgreSQL + Redis segun la especificacion.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function emptyDb() {
  return { processedMessages: {}, sessions: {}, activities: [], seq: 0 };
}

function load() {
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

const db = load();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function nextActivityId() {
  db.seq += 1;
  save();
  return `act-${String(db.seq).padStart(4, '0')}`;
}

function markProcessed(messageId, info) {
  db.processedMessages[messageId] = { at: new Date().toISOString(), ...(info || {}) };
  save();
}

function isProcessed(messageId) {
  return Boolean(db.processedMessages[messageId]);
}

function getSession(waId) {
  if (!db.sessions[waId]) db.sessions[waId] = { waId, openActivityId: null };
  return db.sessions[waId];
}

function saveSession(session) {
  db.sessions[session.waId] = session;
  save();
}

function clearOpenActivity(waId) {
  const s = getSession(waId);
  s.openActivityId = null;
  saveSession(s);
}

function addActivity(activity) {
  db.activities.push(activity);
  save();
  return activity;
}

function getActivity(id) {
  return db.activities.find((a) => a.id === id) || null;
}

function updateActivity(id, patch) {
  const a = getActivity(id);
  if (!a) return null;
  Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  save();
  return a;
}

function listActivities(waId) {
  return db.activities
    .filter((a) => a.userWaId === waId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function openActivity(waId) {
  const s = getSession(waId);
  if (!s.openActivityId) return null;
  return getActivity(s.openActivityId);
}

module.exports = {
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
};
