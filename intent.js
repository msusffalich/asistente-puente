'use strict';

/**
 * Clasificador de intencion por reglas (suficiente para el piloto Fase 1).
 * Devuelve: 'recuerdo' | 'estado' | 'desconocido'.
 */

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const RECUERDO_KEYS = [
  'recuerdo', 'recuerdos',
  'guarda', 'guardar', 'guardame',
  'foto', 'fotos', 'fotografia', 'fotografias',
  'contar', 'contarte', 'cuento',
  'historia', 'anécdota', 'anécdota',
];

const ESTADO_KEYS = [
  'estado', 'como quedo', 'cómo quedo',
  'mis actividades', 'mis borradores',
  'pendiente', 'pendientes',
  'ya esta', 'ya está', 'listo',
];

function classify(text) {
  const t = normalize(text);
  if (!t) return 'desconocido';
  if (ESTADO_KEYS.some((k) => t.includes(k))) return 'estado';
  if (RECUERDO_KEYS.some((k) => t.includes(k))) return 'recuerdo';
  return 'desconocido';
}

module.exports = { classify, normalize };
