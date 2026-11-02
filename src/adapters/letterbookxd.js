/**
 * Life Hub → 책장 (letterbookxd) candidate contract v1: `reading_record`.
 *
 * 책장 keeps reading state per volume of a catalogued edition (publisher) of a work: reading with the
 * current page, or completed with an optional 1–5 star rating and the 인생책 mark. A candidate is one
 * book the user said they are reading or finished:
 * - `title` (and `author`, `publisher`, `volume` when the user said them) identify the book; 책장 finds
 *   it in its own catalogue and the owner picks the edition and volume when it is not unique.
 * - `date` is the day it was finished (or the reading update), resolved by the assistant.
 * - No catalogue IDs, ISBNs or cover images from the assistant.
 */
import { isObject, hasOnly, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual']);
const intIn = (v, lo, hi) => v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);

function validReading(p) {
  if (!hasOnly(p, ['title', 'author', 'publisher', 'volume', 'state', 'current_page', 'rating', 'liked', 'date', 'note']) ||
    !requiredText(p.title, 200) || !optionalText(p.author, 100) || !optionalText(p.publisher, 100) || !optionalText(p.note, 500) ||
    !['reading', 'completed'].includes(p.state) || !intIn(p.volume, 1, 200) || !intIn(p.current_page, 1, 20000) ||
    !intIn(p.rating, 1, 5) || (p.liked !== undefined && p.liked !== true) || (p.date !== undefined && !validDate(p.date)))
    return false;
  // A page belongs to a book in progress; a rating and the 인생책 mark to a finished one.
  if (p.state === 'completed' && p.current_page !== undefined) return false;
  if (p.state === 'reading' && (p.rating !== undefined || p.liked !== undefined)) return false;
  return true;
}

export function validateLetterbookxdCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid letterbookxd candidate');
  if (candidate.candidate_type !== 'reading_record') throw new Error('Unsupported letterbookxd candidate type');
  if (!validReading(candidate.payload)) throw new Error('Invalid letterbookxd reading_record candidate');
  return structuredClone(candidate);
}

export function toLetterbookxdCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'letterbookxd') throw new Error('Wrong destination');
  return validateLetterbookxdCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
