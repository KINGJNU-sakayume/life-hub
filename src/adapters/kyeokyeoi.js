/**
 * Life Hub → 켜켜이 (kyeokyeoi) candidate contract v1.
 *
 * 켜켜이 keeps memories and independently confirmed region visits. Rules from its integration contract
 * (kyeokyeoi docs/LIFEHUB_INTEGRATION.md), enforced by keeping the shapes minimal:
 * - A memory never implies a visit; a visit candidate exists only when the user says they went.
 * - Place and time stay in the user's words (`place_text`, `time_text`); 켜켜이 resolves the region
 *   code and time type during the owner's review. Optional numeric date parts only when stated.
 * - No photos, no transcripts, no region codes from the assistant.
 */
import { isObject, hasOnly, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'manual']);
/** Labels of 켜켜이's fixed emotion tags (src/utils/emotions.ts); the app maps them to its emoji. */
export const KYEOKYEOI_EMOTIONS = Object.freeze(['행복', '설렘', '신남', '웃김', '평온', '감동', '슬픔', '우울', '두려움', '화남']);
const intIn = (v, lo, hi) => v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);

function validMemory(p) {
  if (!hasOnly(p, ['title', 'memo', 'time_text', 'year', 'month', 'day', 'place_text', 'emotions']) ||
    !requiredText(p.title, 80) || !optionalText(p.memo, 2000) || !optionalText(p.time_text, 100) ||
    !optionalText(p.place_text, 100) || !intIn(p.year, 1900, 2100) || !intIn(p.month, 1, 12) || !intIn(p.day, 1, 31))
    return false;
  if (p.month !== undefined && p.year === undefined) return false;
  if (p.day !== undefined) {
    if (p.month === undefined) return false;
    const iso = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (!validDate(iso)) return false;
  }
  if (p.emotions !== undefined && (!Array.isArray(p.emotions) || p.emotions.length > 5 ||
    new Set(p.emotions).size !== p.emotions.length || p.emotions.some((e) => !KYEOKYEOI_EMOTIONS.includes(e))))
    return false;
  return true;
}
function validVisit(p) {
  return hasOnly(p, ['place_text', 'visited_on', 'note']) && requiredText(p.place_text, 100) &&
    (p.visited_on === undefined || validDate(p.visited_on)) && optionalText(p.note, 500);
}

/** The exact shape 켜켜이 receives (mirrors the PALATE v1 envelope style). */
export function validateKyeokyeoiCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid kyeokyeoi candidate');
  if (candidate.candidate_type === 'memory') {
    if (!validMemory(candidate.payload)) throw new Error('Invalid kyeokyeoi memory candidate');
  } else if (candidate.candidate_type === 'visit') {
    if (!validVisit(candidate.payload)) throw new Error('Invalid kyeokyeoi visit candidate');
  } else throw new Error('Unsupported kyeokyeoi candidate type');
  return structuredClone(candidate);
}

export function toKyeokyeoiCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'kyeokyeoi') throw new Error('Wrong destination');
  return validateKyeokyeoiCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
