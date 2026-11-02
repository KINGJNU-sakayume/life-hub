/** Cloudflare Worker entry point. P1 only: no approval/confirmation route until PALATE can return a verifiable receipt. */
import { validateHubEnvelope } from '../core/candidates.js';
import { toDestinationCandidate } from '../adapters/index.js';
import { authenticate, AuthFailure, assertSource, requireRole } from './auth.js';
import { insertCandidate, listCandidates, readChanges, rejectCandidate, StoreFailure } from './store.js';
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const send = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
function fail(status, message) { return send({ error: message }, status); }
async function readBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? ''))
    throw new StoreFailure(415, 'application/json required');
  const stream = request.body;
  if (!stream) throw new StoreFailure(400, 'JSON body required');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        throw new StoreFailure(413, 'Candidate exceeds 16 KiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { raw.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new StoreFailure(400, 'Invalid JSON'); }
}
function boundedInteger(value, fallback, max, min = 0) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]{0,14})$/.test(value)) throw new StoreFailure(400, 'Invalid pagination argument');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new StoreFailure(400, 'Invalid pagination argument');
  return number;
}
export async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET')
      return send({ service: 'life-hub', status: 'ready-for-configuration' });
    const actor = await authenticate(request, env);
    if (!env.DB || typeof env.DB.prepare !== 'function')
      throw new AuthFailure(503, 'Private database is not configured');
    if (url.pathname === '/v1/candidates' && request.method === 'POST') {
      requireRole(actor, ['owner', 'chatgpt', 'claude']);
      const candidate = validateHubEnvelope(await readBody(request));
      assertSource(actor, candidate.source);
      toDestinationCandidate(candidate);
      const result = await insertCandidate(env.DB, actor.ownerId, candidate, new Date().toISOString());
      return send({ id: result.id, status: result.status, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
    }
    if (url.pathname === '/v1/candidates' && request.method === 'GET') {
      requireRole(actor, ['owner']);
      const status = url.searchParams.get('status');
      if (status !== null && !['pending', 'rejected', 'confirmed'].includes(status))
        throw new StoreFailure(400, 'Invalid status filter');
      const limit = boundedInteger(url.searchParams.get('limit'), 50, 100, 1);
      return send({ candidates: await listCandidates(env.DB, actor.ownerId, status, limit) });
    }
    if (url.pathname === '/v1/changes' && request.method === 'GET') {
      requireRole(actor, ['owner', 'food_reader']);
      const cursor = boundedInteger(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
      const limit = boundedInteger(url.searchParams.get('limit'), 50, 100, 1);
      return send(await readChanges(env.DB, actor.ownerId, cursor, limit));
    }
    const match = /^\/v1\/candidates\/([0-9a-f-]{36})\/reject$/.exec(url.pathname);
    if (match && request.method === 'POST') {
      requireRole(actor, ['owner']);
      return send({ candidate: await rejectCandidate(env.DB, actor.ownerId, match[1], new Date().toISOString()) });
    }
    return fail(404, 'Not found');
  } catch (error) {
    if (error instanceof AuthFailure || error instanceof StoreFailure) return fail(error.status, error.message);
    if (error instanceof SyntaxError || /Invalid Life Hub|Invalid PALATE|Unsupported PALATE|Invalid kyeokyeoi|Unsupported kyeokyeoi|Invalid potcast|Unsupported potcast/.test(String(error?.message)))
      return fail(400, 'Invalid candidate');
    // Never log untrusted payload, database rows or secrets in error reports.
    return fail(500, 'Internal error');
  }
}
export default { fetch: handleRequest };
