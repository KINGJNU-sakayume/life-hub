/**
 * Device sync API (docs/P6_SYNC.md), one instance per destination app that declares `sync`:
 *   GET    <prefix>                 newest document: { version, sha256, size_bytes, written_at, device, doc }
 *   GET    <prefix>/meta            the same without `doc`
 *   PUT    <prefix>                 replace it; If-Match: "<version>", or If-None-Match: * for the first write
 *   DELETE <prefix>                 remove every version; If-Match: "<version>"
 *   GET    <prefix>/versions        meta of the kept versions, newest first
 *   GET    <prefix>/versions/<n>    one kept version, like GET <prefix>
 *
 * The Hub never interprets a document: it checks size, JSON and a minimal shape (src/sync/checks.js) and
 * decides only whether the client's base version is still the newest. Merging is the app's job.
 * Document text is never logged and never appears in an error body.
 */
import { checkSyncDocument } from './checks.js';
import {
  currentSyncMeta, readCurrentSyncDoc, readSyncVersion, listSyncVersions, writeSyncDoc, deleteSyncDocs,
} from './store.js';

export const DEFAULT_SYNC_LIMITS = Object.freeze({ maxBytes: 1048576, keep: 10 });
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, value, extra) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });

class SyncError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

const metaView = (row) => ({
  version: row.version, sha256: row.sha256, size_bytes: row.size_bytes, written_at: row.written_at, device: row.device ?? null,
});
const withDoc = (row) => ({ ...metaView(row), doc: JSON.parse(row.body_json) });
const stale = (current) => new SyncError(412, 'Precondition failed', { current: current ? metaView(current) : null });

/** If-Match / If-None-Match → the version the client based its write on (0 = no document yet). */
function baseVersion(request, { allowCreate }) {
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifMatch !== null && ifNoneMatch !== null) throw new SyncError(400, 'Use either If-Match or If-None-Match');
  if (ifMatch === null && ifNoneMatch === null) throw new SyncError(428, 'If-Match is required');
  if (ifNoneMatch !== null) {
    if (!allowCreate || ifNoneMatch.trim() !== '*') throw new SyncError(400, 'Invalid If-None-Match');
    return 0;
  }
  const match = /^(?:"([1-9][0-9]{0,14})"|([1-9][0-9]{0,14}))$/.exec(ifMatch.trim());
  if (!match) throw new SyncError(400, 'Invalid If-Match');
  return Number(match[1] ?? match[2]);
}

/** Optional, display only, never authentication. Printable ASCII so any browser can send it. */
function deviceLabel(request) {
  const value = request.headers.get('X-Device-Label');
  if (value === null) return null;
  const label = value.trim();
  if (!/^[\x20-\x7e]{1,40}$/.test(label)) throw new SyncError(400, 'Invalid X-Device-Label');
  return label;
}

async function readBody(request, maxBytes) {
  if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? '')) throw new SyncError(415, 'application/json required');
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SyncError(413, 'Document too large');
  const reader = request.body?.getReader();
  if (!reader) throw new SyncError(400, 'JSON body required');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new SyncError(413, 'Document too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new SyncError(400, 'Invalid JSON'); }
  return { text, bytes, size };
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {{ db: any, ownerId: string, now: () => number, destination: string, prefix: string, limits?: { maxBytes?: number, keep?: number } }} context */
export async function handleSyncRequest(request, context) {
  const { db, ownerId, destination, prefix } = context;
  const limits = {
    maxBytes: context.limits?.maxBytes ?? DEFAULT_SYNC_LIMITS.maxBytes,
    keep: context.limits?.keep ?? DEFAULT_SYNC_LIMITS.keep,
  };
  const url = new URL(request.url);
  const method = request.method;
  const allow = (...methods) => json(405, { error: 'Method not allowed' }, { Allow: methods.join(', ') });
  try {
    const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (rest === null) return json(404, { error: 'Not found' });

    if (rest === '') {
      if (method === 'GET') {
        const row = await readCurrentSyncDoc(db, ownerId, destination);
        return row ? json(200, withDoc(row)) : json(404, { error: 'No document yet' });
      }
      if (method === 'PUT') {
        const base = baseVersion(request, { allowCreate: true });
        const device = deviceLabel(request);
        const { text, bytes, size } = await readBody(request, limits.maxBytes);
        let doc;
        try { doc = JSON.parse(text); } catch { throw new SyncError(400, 'Invalid JSON'); }
        if (!checkSyncDocument(destination, doc)) throw new SyncError(400, 'Invalid document');
        const at = new Date(context.now()).toISOString();
        const written = await writeSyncDoc(db, ownerId, destination, base,
          { body: text, size, sha256: await sha256Hex(bytes), device }, at, limits.keep);
        if (!written.ok) throw stale(written.current);
        return json(200, metaView(written.meta));
      }
      if (method === 'DELETE') {
        const base = baseVersion(request, { allowCreate: false });
        const result = await deleteSyncDocs(db, ownerId, destination, base);
        if (result.status === 'none') return json(404, { error: 'No document yet' });
        if (result.status === 'stale') throw stale(result.current);
        return new Response(null, { status: 204, headers: HEADERS });
      }
      return allow('GET', 'PUT', 'DELETE');
    }

    if (rest === '/meta') {
      if (method !== 'GET') return allow('GET');
      const row = await currentSyncMeta(db, ownerId, destination);
      return row ? json(200, metaView(row)) : json(404, { error: 'No document yet' });
    }
    if (rest === '/versions') {
      if (method !== 'GET') return allow('GET');
      return json(200, { versions: (await listSyncVersions(db, ownerId, destination, limits.keep)).map(metaView) });
    }
    const one = /^\/versions\/([1-9][0-9]{0,14})$/.exec(rest);
    if (one) {
      if (method !== 'GET') return allow('GET');
      const row = await readSyncVersion(db, ownerId, destination, Number(one[1]));
      return row ? json(200, withDoc(row)) : json(404, { error: 'Version not found' });
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof SyncError) return json(error.status, { error: error.message, ...error.body });
    // Never log the document, database rows or secrets.
    return json(500, { error: 'Internal error' });
  }
}
