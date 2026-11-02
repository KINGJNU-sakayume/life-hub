/**
 * Destination inbox API, one instance per destination app (each its own OAuth resource):
 *   PALATE    → prefix /palate/v1,    destination food,      scope food:inbox
 *   켜켜이     → prefix /kyeokyeoi/v1, destination kyeokyeoi, scope kyeokyeoi:inbox
 *   potcast   → prefix /potcast/v1,   destination potcast,   scope potcast:inbox
 *   (and every other entry of src/destinations.js the same way)
 *
 * After the owner signs in, the app may:
 *   GET  <prefix>/candidates?status=pending|all&limit=N   read its candidates (in its own v1 shape)
 *   POST <prefix>/receipts    { key, entity_type, entity_id }   owner approved & saved it in the app
 *   POST <prefix>/rejections  { key }                          owner rejected it in the app
 * `key` is `<source>:<idempotency_key>`.
 *
 * Every write is idempotent so the app can retry from its outbox. Nothing here creates candidates.
 */
import { toDestinationCandidate } from '../adapters/index.js';
import { destinationById } from '../destinations.js';
import { listDestinationCandidates, confirmCandidateByKey, rejectCandidateByKey, StoreFailure } from '../server/store.js';

const SOURCES = new Set(['chatgpt', 'claude', 'manual', 'spotify']);
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

async function readJson(request, allowed) {
  if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? '')) throw new InputError('application/json required');
  const text = await request.text();
  if (text.length > 4096) throw new InputError('Body too large');
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
  };
}

/** @param {{ db: any, ownerId: string, now: () => number, destination: string, prefix: string }} context */
export async function handleInboxRequest(request, context) {
  const url = new URL(request.url);
  const at = new Date(context.now()).toISOString();
  const { destination, prefix } = context;
  try {
    if (url.pathname === prefix + '/candidates' && request.method === 'GET') {
      const status = url.searchParams.get('status') ?? 'pending';
      if (!['pending', 'all'].includes(status)) throw new InputError('Invalid status');
      const limitText = url.searchParams.get('limit') ?? '50';
      if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 100) throw new InputError('Invalid limit');
      const records = await listDestinationCandidates(context.db, context.ownerId, destination, status === 'all' ? null : 'pending', Number(limitText));
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
    return json(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof InputError) return json(400, { error: error.message });
    if (error instanceof StoreFailure) return json(error.status, { error: error.message });
    return json(500, { error: 'Internal error' });
  }
}
