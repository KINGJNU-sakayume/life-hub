/**
 * Life Hub → 업적 라이브러리 (achievement) candidate contract v1: `activity_record`.
 *
 * The app keeps one record per activity (category, date, optional value + unit, tags, memo) and derives
 * achievements from all records. A candidate is one activity the user said they actually did:
 * - `category` is the category name as the user would call it ("러닝", "독서", "벤치 프레스"); the app
 *   matches it against the owner's own category tree, and the owner picks when it is not exact.
 * - `value`/`unit` only when the user gave an amount ("5km", "30분", "1만원"); the app converts units.
 * - No photos, no achievement IDs, no category IDs from the assistant.
 *
 * `achievement_definition` (cards stage 4): a custom achievement the user asked for ("러닝 누적 100km 업적 만들어줘").
 * Flat fields so a card can edit them: `title`, optional `description`, optional `category` (name, matched like
 * records; none = every record counts), `tier`, and one condition: `count` (records, `target`), `total`
 * (cumulative `target` in `unit`), `streak` (consecutive days, `target`), `tag` (one record tagged `tag`) or
 * `tag_count` (`target` records tagged `tag`). The app maps them onto its own condition types.
 */
import { isObject, hasOnly, validDate, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual']);
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

export const TIERS = Object.freeze(['bronze', 'silver', 'gold', 'platinum', 'diamond']);
export const CONDITION_TYPES = Object.freeze(['count', 'total', 'streak', 'tag', 'tag_count']);
const whole = (v) => Number.isInteger(v) && v >= 1 && v <= 100000;

function validDefinition(p) {
  if (!hasOnly(p, ['title', 'description', 'category', 'tier', 'condition_type', 'target', 'unit', 'tag']) ||
    !requiredText(p.title, 40) || !optionalText(p.description, 200) || !optionalText(p.category, 60) ||
    !TIERS.includes(p.tier) || !CONDITION_TYPES.includes(p.condition_type) || !optionalText(p.unit, 20) || !optionalText(p.tag, 30))
    return false;
  const t = p.condition_type;
  if (t === 'total') return typeof p.target === 'number' && Number.isFinite(p.target) && p.target > 0 && p.target <= 1e9 && p.unit !== undefined && p.tag === undefined;
  if (p.unit !== undefined) return false;
  if (t === 'tag') return p.tag !== undefined && p.target === undefined;
  if (t === 'tag_count') return p.tag !== undefined && whole(p.target);
  return p.tag === undefined && whole(p.target); // count, streak
}

export function validateAchievementCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid achievement candidate');
  if (candidate.candidate_type === 'activity_record') {
    if (!validRecord(candidate.payload)) throw new Error('Invalid achievement activity_record candidate');
  } else if (candidate.candidate_type === 'achievement_definition') {
    if (!validDefinition(candidate.payload)) throw new Error('Invalid achievement achievement_definition candidate');
  } else throw new Error('Unsupported achievement candidate type');
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
