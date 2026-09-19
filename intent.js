'use strict';

/**
 * Clasificador amplio de intenciones (local, sin API externa).
 * Normaliza el texto (minusculas, sin tildes) y puntua grupos de frases
 * por intencion; gana la de mayor puntaje sobre un umbral minimo.
 * Devuelve { intent, score }.
 */

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matches(t, phrase) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(t);
}

// [frase, peso]
const INTENTS = [
  {
    name: 'recuerdo',
    phrases: [
      ['guarda esta foto', 6], ['guarda la foto', 6], ['guardame esta', 5],
      ['guardar', 3], ['guarda', 3], ['guardame', 4], ['guardalo', 3], ['guardala', 3],
      ['recuerdo', 4], ['recuerdos', 4],
      ['foto', 2], ['fotos', 2], ['fotito', 2], ['imagen', 2], ['imagenes', 2],
      ['fotografia', 2], ['fotografias', 2], ['retrato', 2],
      ['te mando', 3], ['te envio', 3], ['te paso', 3], ['te comparto', 3],
      ['te muestro', 2], ['mira esta', 2],
      ['contar', 2], ['contarte', 2], ['te cuento', 3], ['te voy a contar', 5],
      ['lo que te voy a contar', 5], ['quiero contarte', 4],
      ['historia', 2], ['historias', 2], ['relato', 3], ['anecdota', 3],
      ['anécdota', 3], ['memoria', 3], ['memorias', 3],
      ['momento', 2], ['momentos', 2], ['album', 2],
      ['no quiero olvidar', 4], ['para no olvidar', 4], ['inolvidable', 3],
      ['cuando era', 2], ['de mi infancia', 3], ['de mi familia', 2],
      ['de mis abuelos', 3], ['de mis padres', 2], ['de mi mama', 2], ['de mi papa', 2],
      ['legado', 3], ['legado vivo', 5],
      ['quiero conservar', 3], ['conservar', 2], ['preservar', 2],
      ['esto paso', 2], ['me acuerdo', 2], ['me acuerdo de', 3],
    ],
  },
  {
    name: 'estado',
    phrases: [
      ['estado', 3], ['como va', 3], ['como quedo', 4], ['como quedaron', 4],
      ['como quedo lo', 5], ['en que quedo', 4],
      ['mis actividades', 5], ['mis recuerdos', 4], ['mis borradores', 5],
      ['que tienes', 2], ['que hay de nuevo', 2], ['lista', 2],
      ['muestrame', 3], ['ver mis', 3], ['ver lo', 2],
      ['pendiente', 2], ['pendientes', 2], ['en proceso', 2], ['progreso', 2],
    ],
  },
  {
    name: 'ayuda',
    phrases: [
      ['ayuda', 4], ['que puedes hacer', 5], ['que sabes hacer', 5],
      ['como funciona', 3], ['como se usa', 3], ['como te uso', 3],
      ['opciones', 2], ['menu', 2], ['instrucciones', 3], ['para que sirves', 4],
    ],
  },
  {
    name: 'quien_eres',
    phrases: [
      ['quien eres', 5], ['que eres', 3], ['como te llamas', 4],
      ['tu nombre', 3], ['presentate', 3],
    ],
  },
  {
    name: 'gracias',
    phrases: [
      ['gracias', 4], ['te agradezco', 3], ['mil gracias', 5], ['muchas gracias', 5],
    ],
  },
  {
    name: 'despedida',
    phrases: [
      ['adios', 3], ['chao', 3], ['nos vemos', 3], ['hasta luego', 3],
      ['hasta pronto', 3], ['me voy', 2],
    ],
  },
  {
    name: 'saludo',
    phrases: [
      ['hola', 3], ['buenas', 2], ['buenos dias', 3], ['buenas tardes', 3],
      ['buenas noches', 3], ['hey', 2], ['que tal', 2],
    ],
  },
  {
    name: 'reintentar',
    phrases: [
      ['reintentar', 5], ['intenta de nuevo', 4], ['intentalo de nuevo', 4],
      ['otra vez', 2], ['de nuevo', 2],
    ],
  },
  {
    name: 'si',
    phrases: [
      ['si', 3], ['dale', 3], ['ok', 2], ['vale', 2], ['correcto', 3],
      ['confirmo', 3], ['adelante', 2], ['de acuerdo', 3], ['por supuesto', 3],
      ['claro que si', 4],
    ],
  },
  {
    name: 'no',
    phrases: [
      ['mejor no', 5], ['no quiero', 4], ['cancelalo', 5], ['cancela', 4],
      ['olvídalo', 4], ['dejalo asi', 4], ['asi esta bien', 3], ['no gracias', 4],
      ['no', 3],
    ],
  },
];

const UMBRAL = 2;

function classify(text) {
  const t = normalize(text);
  if (!t) return { intent: 'desconocido', score: 0 };

  let best = { intent: 'desconocido', score: 0 };
  for (const def of INTENTS) {
    let score = 0;
    for (const [phrase, weight] of def.phrases) {
      if (matches(t, phrase)) score += weight;
    }
    if (score > best.score) best = { intent: def.name, score };
  }
  if (best.score < UMBRAL) return { intent: 'desconocido', score: best.score };
  return best;
}

module.exports = { classify, normalize };
