/**
 * Compatibility with food/src/lib/lifehub-contract.ts v1.
 * Converts a Life Hub candidate to the exact PALATE local-inbox candidate format.
 * This does NOT call PALATE or approve a meal.
 */
import { isObject, hasOnly, validTimestamp, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual']);
const VERDICT = new Set(['LIKE', 'NEUTRAL', 'DISLIKE']);
const REORDER = new Set(['YES', 'MAYBE', 'NO']);
const WISH = new Set(['visit_place', 'try_menu']);

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/** Mirrors the destination's v1 validation constraints. */
export function validateFoodCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) ||
    !requiredText(candidate.source_ref, 200) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(candidate.source_ref) ||
    !requiredText(candidate.idempotency_key, 128) || !/^[A-Za-z0-9_.:-]{8,128}$/.test(candidate.idempotency_key) ||
    !validTimestamp(candidate.created_at) || !isObject(candidate.payload)) throw new Error('Invalid PALATE candidate');
  const p = candidate.payload;
  if (candidate.candidate_type === 'meal') {
    if (!hasOnly(p, ['menu_name', 'place_name', 'eaten_at', 'verdict', 'reorder_intent', 'note']) ||
      !requiredText(p.menu_name, 200) || !optionalText(p.place_name, 200) ||
      (p.eaten_at !== undefined && !validDate(p.eaten_at)) ||
      (p.verdict !== undefined && !VERDICT.has(p.verdict)) ||
      (p.reorder_intent !== undefined && !REORDER.has(p.reorder_intent)) ||
      !optionalText(p.note, 1000)) throw new Error('Invalid PALATE meal candidate');
  } else if (candidate.candidate_type === 'wish') {
    if (!hasOnly(p, ['wish_kind', 'name', 'source_url', 'note']) ||
      !WISH.has(p.wish_kind) || !requiredText(p.name, 200) ||
      (p.source_url !== undefined && !httpsUrl(p.source_url)) ||
      !optionalText(p.note, 1000)) throw new Error('Invalid PALATE wish candidate');
  } else throw new Error('Unsupported PALATE candidate type');
  return structuredClone(candidate);
}

/** Must receive an already authenticated, validated Hub envelope. */
export function toFoodCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'food') throw new Error('Wrong destination');
  return validateFoodCandidate({
    schema_version: 1,
    source: hub.source,
    source_ref: hub.source_ref,
    idempotency_key: hub.idempotency_key,
    created_at: hub.created_at,
    candidate_type: hub.candidate_type,
    payload: hub.payload,
  });
}
