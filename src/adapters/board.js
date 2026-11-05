/**
 * Life Hub → Life Board candidate contract v1: `memo` (docs/P7_BOARD.md section 7).
 *
 * A memo is one short observation Claude writes for the owner's board ("시청은 늘고 독서는 잠시 쉬었어요.").
 * It appears on the board only after the owner approves it with a Claude conversation card (the board has no
 * approve buttons), and only Claude may propose it, because only Claude's cards can approve.
 * - `text`: 1–160 characters of plain text, one paragraph (no line breaks or control characters).
 */
import { isObject, hasOnly, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['claude']);
export const MEMO_MAX = 160;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function validateBoardCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid board candidate');
  if (candidate.candidate_type !== 'memo') throw new Error('Unsupported board candidate type');
  const p = candidate.payload;
  if (!hasOnly(p, ['text']) || typeof p.text !== 'string' || p.text.trim().length === 0 || p.text.length > MEMO_MAX ||
    p.text !== p.text.trim() || CONTROL.test(p.text))
    throw new Error('Invalid board memo candidate');
  return structuredClone(candidate);
}

export function toBoardCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'board') throw new Error('Wrong destination');
  return validateBoardCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
