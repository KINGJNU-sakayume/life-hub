/**
 * Life Hub → 역 도장깨기 (sub) candidate contract v1: `station_visit`.
 *
 * The app keeps one stamp per subway station the user actually visited (random draws never stamp by
 * themselves). A candidate is one station the user said they went to:
 * - `station` is the station name as the user said it ("망원", "홍대입구역"); `line` only when they said
 *   it or the name is shared by different stations. The app finds the station and the owner confirms.
 * - `date` is the day of the visit, resolved by the assistant.
 * - No photos (stickers are made in the app), no station codes.
 *
 * `station_draw` (cards stage 5): a station Life Hub drew from the pool the app shared (lines switched on,
 * scope, and "unvisited only"), never one the assistant chose: `{ date, line, station }` with the app's own
 * station name and line name. Approved, it becomes the app's current destination; it never stamps.
 * Since P7 B5 a `station_draw` may also come from Life Board's roulette (source `board`, docs/P7_BOARD.md section 8):
 * the Hub accepts it only for a station in the app's shared pool. The board never proposes visits.
 */
import { isObject, hasOnly, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual', 'board']);

function validVisit(p) {
  return hasOnly(p, ['station', 'line', 'date', 'note']) && requiredText(p.station, 40) && optionalText(p.line, 20) &&
    validDate(p.date) && optionalText(p.note, 300);
}

function validDraw(p) {
  return hasOnly(p, ['date', 'line', 'station']) && validDate(p.date) && requiredText(p.line, 20) && requiredText(p.station, 40);
}

export function validateSubCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid sub candidate');
  if (candidate.source === 'board' && candidate.candidate_type !== 'station_draw') throw new Error('Invalid sub candidate');
  if (candidate.candidate_type === 'station_visit') {
    if (!validVisit(candidate.payload)) throw new Error('Invalid sub station_visit candidate');
  } else if (candidate.candidate_type === 'station_draw') {
    if (!validDraw(candidate.payload)) throw new Error('Invalid sub station_draw candidate');
  } else throw new Error('Unsupported sub candidate type');
  return structuredClone(candidate);
}

export function toSubCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'sub') throw new Error('Wrong destination');
  return validateSubCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
