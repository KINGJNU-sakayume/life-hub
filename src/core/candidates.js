/**
 * Storage-independent candidate state machine.
 *
 * This package intentionally has NO network transport, user credentials,
 * persistence, LLM connection, or write access to destination applications.
 * The authenticated service must enforce tenant isolation, atomic uniqueness,
 * authorization, and explicit destination receipts at the persistence layer.
 */

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual', 'spotify']);
const DESTINATIONS = new Set(['food', 'kyeokyeoi', 'potcast', 'achievement', 'letterbookxd', 'sub', 'animan']);
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,200}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const hasOnly = (value, keys) => Object.keys(value).every(key => keys.includes(key));
export const validTimestamp = (v) => typeof v === 'string' && v.length <= 40 && ISO.test(v) && !Number.isNaN(Date.parse(v));
export const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(new Date(v).getTime()) && new Date(v).toISOString().slice(0, 10) === v;
export const requiredText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const optionalText = (v, max) => v === undefined || requiredText(v, max);

/**
 * No raw conversation or credentials allowed. `source` is an unverified claim,
 * not proof that ChatGPT/Claude sent the operation.
 */
export function validateHubEnvelope(value) {
  if (!isObject(value) || !hasOnly(value, [
    'hub_version', 'destination', 'source', 'source_ref', 'idempotency_key',
    'created_at', 'candidate_type', 'payload',
  ]) || value.hub_version !== 1 || !DESTINATIONS.has(value.destination) ||
    !SOURCES.has(value.source) || !requiredText(value.source_ref, 200) ||
    !SOURCE_REF.test(value.source_ref) || !requiredText(value.idempotency_key, 128) ||
    !KEY.test(value.idempotency_key) || !validTimestamp(value.created_at) ||
    !isObject(value.payload)) throw new Error('Invalid Life Hub candidate envelope');
  return structuredClone(value);
}

/**
 * Tenant identity is supplied by verified auth and never by a client field.
 * Do not treat the returned string as an authorization decision.
 */
export function candidateIdentity(tenantId, candidate) {
  if (!requiredText(tenantId, 256)) throw new Error('Verified tenant ID required');
  return JSON.stringify([tenantId, candidate.destination, candidate.source, candidate.idempotency_key]);
}

/** Timestamps and message references may change on retry; meaning must not. */
export function candidateMeaning(candidate) {
  return JSON.stringify([candidate.destination, candidate.source, candidate.idempotency_key,
    candidate.candidate_type, canonical(candidate.payload)]);
}

export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

/** Example-only deterministic reducer. Production uniqueness must be atomic. */
export function enqueueCandidate(entries, tenantId, untrusted, receivedAt, validateDestination) {
  const candidate = validateHubEnvelope(untrusted);
  if (typeof validateDestination !== 'function') throw new Error('Destination adapter validation required');
  validateDestination(candidate);
  if (!validTimestamp(receivedAt)) throw new Error('Invalid received_at');
  const key = candidateIdentity(tenantId, candidate);
  const previous = entries.find(v => v.key === key);
  if (previous) {
    if (candidateMeaning(previous.candidate) !== candidateMeaning(candidate))
      throw new Error('Conflicting replay of idempotency key');
    return { entries, key, duplicate: true };
  }
  const entry = { key, candidate, status: 'pending', received_at: receivedAt };
  return { entries: [...entries, entry], key, duplicate: false };
}

export function rejectCandidate(entries, key, reviewedAt) {
  if (!validTimestamp(reviewedAt)) throw new Error('Invalid reviewed_at');
  const entry = entries.find(v => v.key === key);
  if (!entry) throw new Error('Candidate not found');
  if (entry.status === 'confirmed') throw new Error('Confirmed record cannot be rejected');
  if (entry.status === 'rejected') return entries;
  return entries.map(e => e.key === key ? { ...e, status: 'rejected', reviewed_at: reviewedAt } : e);
}

/**
 * Called only AFTER the destination confirms a committed entity/receipt.
 * The Hub cannot infer approval from a generated ID or a chat message.
 */
export function acknowledgeConfirmed(entries, key, { destinationEntityId, receiptVerified, reviewedAt }) {
  if (receiptVerified !== true) throw new Error('Destination receipt must be verified');
  if (!requiredText(destinationEntityId, 256) || !validTimestamp(reviewedAt)) throw new Error('Invalid acknowledgement');
  const entry = entries.find(v => v.key === key);
  if (!entry) throw new Error('Candidate not found');
  if (entry.status === 'rejected') throw new Error('Rejected candidate cannot be confirmed');
  if (entry.status === 'confirmed') {
    if (entry.confirmed_entity_id !== destinationEntityId) throw new Error('Conflicting destination receipt');
    return entries;
  }
  return entries.map(e => e.key === key ? {
    ...e, status: 'confirmed', confirmed_entity_id: destinationEntityId, reviewed_at: reviewedAt,
  } : e);
}
