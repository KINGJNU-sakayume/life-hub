/**
 * Life Hub → 업적 라이브러리 (achievement) candidate contract v1: `activity_record`.
 *
 * The app keeps one record per activity (category, date, optional value + unit, tags, memo) and derives
 * achievements from all records. A candidate is one activity the user said they actually did:
 * - `category` is the category name as the user would call it ("러닝", "독서", "벤치 프레스"); the app
 *   matches it against the owner's own category tree, and the owner picks when it is not exact.
 * - `value`/`unit` only when the user gave an amount ("5km", "30분", "1만원"); the app converts units.
 * - No photos, no achievement IDs, no category IDs from the assistant.
 */
import { isObject, hasOnly, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'manual']);
export const MAX_TAGS = 10;

function validRecord(p) {
  if (!hasOnly(p, ['category', 'date', 'value', 'unit', 'tags', 'memo']) ||
    !requiredText(p.category, 60) || !validDate(p.date) || !optionalText(p.unit, 20) || !optionalText(p.memo, 500))
    return false;
  if (p.value !== undefined && (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0 || p.value > 1e9)) return false;
  // A unit without a value means nothing.
  if (p.unit !== undefined && p.value === undefined) return false;
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || p.tags.length === 0 || p.tags.length > MAX_TAGS || !p.tags.every((t) => requiredText(t, 30))) return false;
    if (new Set(p.tags.map((t) => t.trim())).size !== p.tags.length) return false;
  }
  return true;
}

export function validateAchievementCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid achievement candidate');
  if (candidate.candidate_type !== 'activity_record') throw new Error('Unsupported achievement candidate type');
  if (!validRecord(candidate.payload)) throw new Error('Invalid achievement activity_record candidate');
  return structuredClone(candidate);
}

export function toAchievementCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'achievement') throw new Error('Wrong destination');
  return validateAchievementCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
