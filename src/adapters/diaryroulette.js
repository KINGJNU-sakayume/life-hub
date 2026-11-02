/**
 * Life Hub → 일기 룰렛 (Diaryroulette) candidate contract v1: `daily_mission`.
 *
 * The app picks one writing mission per diary day, with a 7-day cooldown it owns. A candidate is a mission
 * Life Hub drew from the list the app shared (never one the assistant chose), for one diary day:
 * - `date`: the diary day in KST; like the app, before 02:00 still counts as the previous day.
 * - `mission_id`: one of the app's mission ids. The app re-checks the day, the cooldown and whether it
 *   already has a mission that day before saving, and draws the mission's extras (e.g. a banned vowel) itself.
 * - Never diary text.
 */
import { isObject, hasOnly, validDate, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual']);
export const MISSION_ID = /^[a-z0-9_-]{1,40}$/;

export function validateDiaryrouletteCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid diaryroulette candidate');
  if (candidate.candidate_type !== 'daily_mission') throw new Error('Unsupported diaryroulette candidate type');
  const p = candidate.payload;
  if (!hasOnly(p, ['date', 'mission_id']) || !validDate(p.date) || typeof p.mission_id !== 'string' || !MISSION_ID.test(p.mission_id))
    throw new Error('Invalid diaryroulette daily_mission candidate');
  return structuredClone(candidate);
}

export function toDiaryrouletteCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'diaryroulette') throw new Error('Wrong destination');
  return validateDiaryrouletteCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}

/** The diary day in KST at `nowMs`: the app's rule (before 02:00 is still yesterday), in Asia/Seoul (UTC+9). */
export function diaryDate(nowMs) {
  return new Date(nowMs + (9 - 2) * 3600_000).toISOString().slice(0, 10);
}
