/**
 * Board API (docs/P7_BOARD.md), stage B1.
 *
 * Per app, under the app's own resource, scope `<id>:board`:
 *   PUT    <app path>/v1/board   store this manifest if it is newer than the stored one
 *   GET    <app path>/v1/board   { generated_at, received_at, sha256, size_bytes, manifest } or 404
 *   DELETE <app path>/v1/board   remove the app's manifest (204, or 404 when there is none)
 *
 * For Life Board, resource /board, scope `board:read`:
 *   GET    /board/v1/tiles       { generated_at, manifests: [...stored manifests + received_at, the Hub's own] }
 *
 * The manifest text is never logged and never appears in an error body.
 */
import { checkManifest, BOARD_LIMITS } from './checks.js';
import { readManifest, writeManifest, deleteManifest, listManifests, pendingCounts } from './store.js';
import { canonicalDestinationId } from '../destinations.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, value, extra) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
const allow = (...methods) => json(405, { error: 'Method not allowed' }, { Allow: methods.join(', ') });

class BoardError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function readJsonBody(request, maxBytes) {
  if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? '')) throw new BoardError(415, 'application/json required');
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BoardError(413, 'Manifest too large');
  const reader = request.body?.getReader();
  if (!reader) throw new BoardError(400, 'JSON body required');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BoardError(413, 'Manifest too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new BoardError(400, 'Invalid JSON'); }
  let value;
  try { value = JSON.parse(text); } catch { throw new BoardError(400, 'Invalid JSON'); }
  return { text, bytes, size, value };
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const metaView = (row) => ({ generated_at: row.generated_at, received_at: row.received_at, sha256: row.sha256, size_bytes: row.size_bytes });

/**
 * `legacyApps`: the app's names before a rename (`potcast` for `music`). A manifest may still name itself so, and a
 * row stored under one is read until the app uploads again; an upload or delete removes it, so the board never
 * shows the same app twice.
 * @param {{ db: any, ownerId: string, now: () => number, app: string, path: string, legacyApps?: string[] }} context
 */
export async function handleManifestRequest(request, context) {
  const { db, ownerId, app, path } = context;
  const legacyApps = context.legacyApps ?? [];
  const dropLegacy = async () => { let n = 0; for (const old of legacyApps) n += await deleteManifest(db, ownerId, old); return n; };
  try {
    if (new URL(request.url).pathname !== path) return json(404, { error: 'Not found' });
    if (request.method === 'GET') {
      let row = await readManifest(db, ownerId, app);
      for (const old of legacyApps) row ??= await readManifest(db, ownerId, old);
      return row ? json(200, { ...metaView(row), manifest: JSON.parse(row.body_json) }) : json(404, { error: 'No manifest yet' });
    }
    if (request.method === 'PUT') {
      const { text, bytes, size, value } = await readJsonBody(request, BOARD_LIMITS.maxBytes);
      const nowMs = context.now();
      const { reason, generatedAt } = checkManifest(app, value, nowMs, legacyApps);
      if (reason) throw new BoardError(400, reason);
      const result = await writeManifest(db, ownerId, app, { body: text, size, sha256: await sha256Hex(bytes), generatedAt },
        new Date(nowMs).toISOString());
      await dropLegacy();
      if (result.status === 'stored') return json(200, metaView(result.current));
      if (result.status === 'unchanged') return json(200, { unchanged: true, ...metaView(result.current) });
      return json(200, { ignored: true, current: metaView(result.current) });
    }
    if (request.method === 'DELETE') {
      const removed = (await deleteManifest(db, ownerId, app)) + (await dropLegacy());
      return removed ? new Response(null, { status: 204, headers: HEADERS }) : json(404, { error: 'No manifest yet' });
    }
    return allow('GET', 'PUT', 'DELETE');
  } catch (error) {
    if (error instanceof BoardError) return json(error.status, { error: error.message, ...error.body });
    return json(500, { error: 'Internal error' });   // never log the manifest, rows or secrets
  }
}

/** Pending counts of rows still stored under a legacy destination id (`potcast`) are added to the current one. */
function mergeLegacyCounts(counts) {
  const merged = new Map();
  for (const c of counts) {
    const id = canonicalDestinationId(c.destination);
    merged.set(id, (merged.get(id) ?? 0) + Number(c.n));
  }
  return [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([destination, n]) => ({ destination, n }));
}

/** The Hub's own manifest: proposals waiting for review, as a count (no titles). */
export function hubManifest(counts, appNames, nowIso) {
  const total = counts.reduce((sum, c) => sum + Number(c.n), 0);
  const tile = {
    id: 'inbox', name: '받은 제안', tone: 'type', form: 'num', sizes: ['1x1', '2x1'], size: '1x1',
    data: { label: '받은 제안', value: total, unit: '건' },
  };
  if (total > 0) {
    tile.detail = { title: '승인을 기다리는 제안', rows: counts.slice(0, 12).map((c) => ({ title: appNames[c.destination] ?? c.destination, value: `${Number(c.n)}건` })) };
  }
  return { version: 1, app: 'hub', generated_at: nowIso, tiles: [tile] };
}

/** @param {{ db: any, ownerId: string, now: () => number, appNames: Record<string,string> }} context */
export async function handleBoardRequest(request, context) {
  const { db, ownerId } = context;
  try {
    const path = new URL(request.url).pathname;
    if (path !== '/board/v1/tiles') return json(404, { error: 'Not found' });
    if (request.method !== 'GET') return allow('GET');
    const nowIso = new Date(context.now()).toISOString();
    const stored = (await listManifests(db, ownerId)).map((row) => ({ ...JSON.parse(row.body_json), received_at: row.received_at }));
    const hub = hubManifest(mergeLegacyCounts(await pendingCounts(db, ownerId)), context.appNames, nowIso);
    return json(200, { generated_at: nowIso, manifests: [...stored, hub] });
  } catch {
    return json(500, { error: 'Internal error' });
  }
}
