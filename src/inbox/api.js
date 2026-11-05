/**
 * Destination inbox API, one instance per destination app (each its own OAuth resource):
 *   PALATE    → prefix /palate/v1,    destination food,      scope food:inbox
 *   켜켜이     → prefix /kyeokyeoi/v1, destination kyeokyeoi, scope kyeokyeoi:inbox
 *   potcast   → prefix /potcast/v1,   destination potcast,   scope potcast:inbox
 *   (and every other entry of src/destinations.js the same way)
 *
 * After the owner signs in, the app may:
 *   GET  <prefix>/candidates?status=pending|approved|open|all&limit=N   read its candidates (its own v1 shape)
 *   POST <prefix>/receipts    { key, entity_type, entity_id }   the app saved it (pending or approved before)
 *   POST <prefix>/rejections  { key }                          owner rejected it in the app
 *   PUT  <prefix>/refs/<kind> { revision, items: [{id,label,group?}] }   reference list for card pickers (≤ 500 items / 32 KB
 *                                                                   unless the destination's `refLimits` raise it)
 * `key` is `<source>:<idempotency_key>`. `open` = pending + approved. An `approved` candidate was approved by
 * the owner in a Claude card: save `final_candidate` (the owner's edit, or `candidate` when absent) without
 * asking again unless `needs_app_review` is true or the app's auto-apply setting is off, then send a receipt.
 *
 * Every write is idempotent so the app can retry from its outbox. Nothing here creates candidates.
 */
import { toDestinationCandidate } from '../adapters/index.js';
import { destinationById } from '../destinations.js';
import {
  listDestinationCandidates, confirmCandidateByKey, rejectCandidateByKey, putDestinationRefs, finalEnvelope, StoreFailure,
} from '../server/store.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual', 'spotify', 'board']);
const STATUS_FILTERS = { pending: 'pending', approved: 'approved', open: ['pending', 'approved'], all: null };
const REF_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Candidate types each destination can confirm, i.e. the allowed receipt `entity_type`s. */
const entityTypes = (destination) => destinationById(destination)?.types ?? [];
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: HEADERS });

class InputError extends Error {}

function parseKey(value) {
  if (typeof value !== 'string' || value.length > 140) throw new InputError('Invalid key');
  const colon = value.indexOf(':');
  const source = value.slice(0, colon);
  const idempotencyKey = value.slice(colon + 1);
  if (colon < 1 || !SOURCES.has(source) || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new InputError('Invalid key');
  return { source, idempotencyKey };
}

async function readJson(request, allowed, maxBytes = 4096) {
  if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? '')) throw new InputError('application/json required');
  const text = await request.text();
  if (text.length > maxBytes) throw new InputError('Body too large');
  let body;
  try { body = JSON.parse(text); } catch { throw new InputError('Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !allowed.includes(k)))
    throw new InputError('Unexpected fields');
  return body;
}

function view(record) {
  return {
    key: `${record.source}:${record.candidate.idempotency_key}`,
    hub_id: record.id,
    status: record.status,
    received_at: record.received_at,
    reviewed_at: record.reviewed_at ?? null,
    confirmed_entity_id: record.confirmed_entity_id ?? null,
    candidate: toDestinationCandidate(record.candidate),
    // Card review (0008): the owner's edited version, approval time and whether the app should still ask.
    revision: record.revision,
    final_candidate: record.final_payload ? toDestinationCandidate(finalEnvelope(record)) : null,
    approved_at: record.approved_at,
    needs_app_review: record.needs_app_review,
  };
}

/** Default limits of a reference list; a destination may raise them per kind (`refLimits`, e.g. sub's stations). */
const REF_LIMITS = Object.freeze({ items: 500, bytes: 32768 });
const refLimits = (destination, kind) => ({ ...REF_LIMITS, ...(destinationById(destination)?.refLimits?.[kind] ?? {}) });

/** A small reference list from the app (ids and labels only). */
function refItems(body, maxItems = REF_LIMITS.items) {
  if (!Number.isInteger(body.revision) || body.revision < 1 || body.revision > Number.MAX_SAFE_INTEGER) throw new InputError('Invalid revision');
  if (!Array.isArray(body.items) || body.items.length > maxItems) throw new InputError('Invalid items');
  const seen = new Set();
  return body.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((k) => !['id', 'label', 'group'].includes(k)) ||
        typeof item.id !== 'string' || !REF_ID.test(item.id) || seen.has(item.id) ||
        typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80 ||
        (item.group !== undefined && (typeof item.group !== 'string' || !item.group.trim() || item.group.length > 40)))
      throw new InputError('Invalid items');
    seen.add(item.id);
    return item.group === undefined ? { id: item.id, label: item.label.trim() } : { id: item.id, label: item.label.trim(), group: item.group.trim() };
  });
}

/** @param {{ db: any, ownerId: string, now: () => number, destination: string, prefix: string }} context */
export async function handleInboxRequest(request, context) {
  const url = new URL(request.url);
  const at = new Date(context.now()).toISOString();
  const { destination, prefix } = context;
  try {
    if (url.pathname === prefix + '/candidates' && request.method === 'GET') {
      const status = url.searchParams.get('status') ?? 'pending';
      if (!Object.hasOwn(STATUS_FILTERS, status)) throw new InputError('Invalid status');
      const limitText = url.searchParams.get('limit') ?? '50';
      if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw new InputError('Invalid limit');
      const records = await listDestinationCandidates(context.db, context.ownerId, destination, STATUS_FILTERS[status], Number(limitText));
      return json(200, { candidates: records.map(view) });
    }
    if (url.pathname === prefix + '/receipts' && request.method === 'POST') {
      const body = await readJson(request, ['key', 'entity_type', 'entity_id']);
      const { source, idempotencyKey } = parseKey(body.key);
      if (!entityTypes(destination).includes(body.entity_type) || typeof body.entity_id !== 'string' || !ENTITY_ID.test(body.entity_id))
        throw new InputError('Invalid receipt');
      const record = await confirmCandidateByKey(context.db, context.ownerId, destination, source, idempotencyKey, body.entity_type, body.entity_id, at);
      return json(200, { candidate: view(record) });
    }
    if (url.pathname === prefix + '/rejections' && request.method === 'POST') {
      const body = await readJson(request, ['key']);
      const { source, idempotencyKey } = parseKey(body.key);
      const record = await rejectCandidateByKey(context.db, context.ownerId, destination, source, idempotencyKey, at);
      return json(200, { candidate: view(record) });
    }
    const refs = url.pathname.startsWith(prefix + '/') ? /^\/refs\/([a-z_]{1,40})$/.exec(url.pathname.slice(prefix.length)) : null;
    if (refs && request.method === 'PUT') {
      if (!(destinationById(destination)?.refKinds ?? []).includes(refs[1])) return json(404, { error: 'Not found' });
      const limits = refLimits(destination, refs[1]);
      const body = await readJson(request, ['revision', 'items'], limits.bytes);
      const stored = await putDestinationRefs(context.db, context.ownerId, destination, refs[1], body.revision, refItems(body, limits.items), at);
      return json(200, stored);
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof InputError) return json(400, { error: error.message });
    if (error instanceof StoreFailure) return json(error.status, { error: error.message });
    return json(500, { error: 'Internal error' });
  }
}
