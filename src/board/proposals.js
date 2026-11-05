/**
 * Life Board → proposal (docs/P7_BOARD.md section 8, stage B5): the board's roulette sends the station it drew to
 * 역 도장깨기 as a `station_draw` proposal, the same candidate Claude's `propose_station_draw` makes.
 *
 *   POST /board/v1/proposals   { destination: 'sub', type: 'station_draw', idempotency_key, payload: { station, line? } }
 *
 * - Only that one pair is allowed (403 otherwise). Provenance is the validated board token: inbox source `board`.
 * - The station must be in the pool the sub app shares now (lines switched on, area, unvisited if chosen); the Hub
 *   picks the line from the pool (the first match when a name is on several lines, or the given `line`), so a board
 *   cannot propose a station the app would not draw. Date is today in KST, like the MCP draw.
 * - The board makes the idempotency key once per finished draw and reuses it on retry; the same key with another
 *   station is a 409.
 * Nothing in the request is logged or echoed in an error.
 */
import { insertCandidate, getDestinationRefs, StoreFailure } from '../server/store.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const MAX_BYTES = 4096;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** @param {{ db: any, ownerId: string, now: () => number }} context */
export async function handleBoardProposal(request, context) {
  try {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
    if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? '')) return json(415, { error: 'application/json required' });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BYTES) return json(413, { error: 'Request too large' });
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (!isObject(body) || Object.keys(body).some((k) => !['destination', 'type', 'idempotency_key', 'payload'].includes(k)))
      return json(400, { error: 'Invalid proposal' });
    if (body.destination !== 'sub' || body.type !== 'station_draw') return json(403, { error: 'The board may only propose a station draw to 역 도장깨기' });
    const p = body.payload;
    if (typeof body.idempotency_key !== 'string' || !KEY.test(body.idempotency_key) || !isObject(p) ||
      Object.keys(p).some((k) => !['station', 'line'].includes(k)) || !text(p.station, 40) || (p.line !== undefined && !text(p.line, 20)))
      return json(400, { error: 'Invalid proposal' });

    const refs = await getDestinationRefs(context.db, context.ownerId, 'sub');
    const pool = (refs.pool?.items ?? []).filter((s) => s && typeof s.group === 'string' && typeof s.label === 'string');
    const match = pool.find((s) => s.label === p.station && (p.line === undefined || s.group === p.line));
    if (!match) return json(409, { error: '이 역은 지금 뽑을 수 있는 역이 아니에요' });

    const nowMs = context.now();
    const createdAt = new Date(nowMs).toISOString();
    const date = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
    const envelope = {
      hub_version: 1, destination: 'sub', source: 'board', source_ref: 'board:' + date, idempotency_key: body.idempotency_key,
      created_at: createdAt, candidate_type: 'station_draw', payload: { date, line: match.group, station: match.label },
    };
    let result;
    try { result = await insertCandidate(context.db, context.ownerId, envelope, createdAt); }
    catch (error) {
      if (error instanceof StoreFailure && error.status === 409) return json(409, { error: 'This key was already used for another proposal' });
      if (/^Invalid|^Unsupported/.test(String(error?.message))) return json(400, { error: 'Invalid proposal' });
      throw error;
    }
    return json(200, { candidate_id: result.id, status: result.status, duplicate: result.duplicate, line: match.group, station: match.label, date });
  } catch {
    return json(500, { error: 'Internal error' });
  }
}
