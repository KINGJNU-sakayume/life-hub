/**
 * Life Hub → AniMan candidate contract v1: `media_progress`.
 *
 * AniMan tracks, per series, which anime episodes and manga volumes the user has finished (mapped onto
 * the original chapters on a timeline). A candidate is one progress update the user stated:
 * - `title` names the series as the user said it; AniMan matches it against its own catalogue.
 * - `kind`: `episode` (anime) or `volume` (manga/book volume).
 * - `up_to`: "watched up to episode 12" (everything before it counts as done too), or `numbers`:
 *   only those episodes/volumes. `season` (episodes only) when the user counted within a season
 *   ("2기 5화"); AniMan converts it to its own numbering.
 * - No catalogue IDs from the assistant.
 */
import { isObject, hasOnly, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual']);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validProgress(p) {
  if (!hasOnly(p, ['title', 'kind', 'season', 'up_to', 'numbers', 'note']) || !requiredText(p.title, 100) ||
    !['episode', 'volume'].includes(p.kind) || !optionalText(p.note, 300)) return false;
  if (p.season !== undefined && (p.kind !== 'episode' || !int(p.season, 1, 30))) return false;
  const hasUpTo = p.up_to !== undefined;
  const hasNumbers = p.numbers !== undefined;
  if (hasUpTo === hasNumbers) return false;
  if (hasUpTo && !int(p.up_to, 1, 5000)) return false;
  if (hasNumbers && (!Array.isArray(p.numbers) || p.numbers.length === 0 || p.numbers.length > 50 ||
    !p.numbers.every((n) => int(n, 1, 5000)) || new Set(p.numbers).size !== p.numbers.length)) return false;
  return true;
}

export function validateAnimanCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid animan candidate');
  if (candidate.candidate_type !== 'media_progress') throw new Error('Unsupported animan candidate type');
  if (!validProgress(candidate.payload)) throw new Error('Invalid animan media_progress candidate');
  return structuredClone(candidate);
}

export function toAnimanCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'animan') throw new Error('Wrong destination');
  return validateAnimanCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
