/**
 * Minimal, stateless MCP server over Streamable HTTP (JSON responses only).
 *
 * Speaks both eras so Claude and Codex clients can connect:
 * - modern (2026-07-28): no handshake; version in params._meta and the MCP-Protocol-Version header,
 *   `server/discover`, `resultType` on every result, Mcp-Method / Mcp-Name header checks.
 * - legacy (2025-03-26 .. 2025-11-25): `initialize` handshake, then plain requests.
 * No sessions, no GET stream, no server-initiated requests. Authorization happens before this runs.
 */
import { TOOLS, callTool } from './tools.js';
import { READING_PREVIEW_URI, READING_PREVIEW_HTML } from './reading-widget.js';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = Object.freeze({ name: 'life-hub', title: 'Life Hub', version: '0.3.0' });
const INSTRUCTIONS = 'Life Hub collects PENDING PROPOSALS for personal archives (food, memories, music, activities, books, stations and media). ' +
  'Propose only events the user explicitly reports as having happened, or wishes explicitly stated; never turn plans into completed events. ' +
  'Each destination validates its own fields. No candidate becomes a real record until the owner approves it in the destination app. ' +
  'Never claim the record was saved, only that a proposal was submitted for review.';
const MAX_BODY = 64 * 1024;

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status, value, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
const rpcError = (status, id, code, message, data) =>
  json(status, { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Request} request
 * @param {{ db: any, ownerId: string, now: () => number, allowedOrigins: string[] }} context
 */
export async function handleMcpRequest(request, context) {
  const origin = request.headers.get('Origin');
  if (origin !== null && !context.allowedOrigins.includes(origin))
    return rpcError(403, null, -32600, 'Origin not allowed');
  if (request.method !== 'POST') return json(405, { error: 'Use POST' }, { Allow: 'POST' });
  if (!/^application\/json(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? ''))
    return rpcError(415, null, -32700, 'Content-Type must be application/json');

  const raw = await request.text();
  if (raw.length > MAX_BODY) return rpcError(413, null, -32600, 'Request too large');
  let message;
  try { message = JSON.parse(raw); } catch { return rpcError(400, null, -32700, 'Parse error'); }
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return rpcError(400, null, -32600, 'Expected a single JSON-RPC request or notification');
  const { id, method } = message;
  const params = message.params === undefined ? {} : message.params;
  if (!isObject(params)) return rpcError(400, id, -32602, 'params must be an object');
  const isNotification = !('id' in message);

  // Header ↔ body consistency (2026-07-28 Server Validation). Checked whenever the header is present.
  const headerMethod = request.headers.get('Mcp-Method');
  if (headerMethod !== null && headerMethod !== method)
    return rpcError(400, id, -32020, 'Header mismatch: Mcp-Method does not match the request body');
  const headerName = request.headers.get('Mcp-Name');
  if (headerName !== null && method === 'tools/call' && headerName !== params.name)
    return rpcError(400, id, -32020, 'Header mismatch: Mcp-Name does not match the request body');

  // Which era is this request from?
  const headerVersion = request.headers.get('MCP-Protocol-Version');
  const metaVersion = isObject(params._meta) ? params._meta[META_VERSION] : undefined;
  let era;
  if (method === 'initialize') {
    era = 'legacy';
  } else if (metaVersion !== undefined) {
    if (typeof metaVersion !== 'string') return rpcError(400, id, -32602, 'Invalid protocol version');
    if (headerVersion !== null && headerVersion !== metaVersion)
      return rpcError(400, id, -32020, 'Header mismatch: MCP-Protocol-Version does not match _meta');
    if (!MODERN_VERSIONS.includes(metaVersion))
      return rpcError(400, id, -32022, 'Unsupported protocol version', { supported: ALL_VERSIONS, requested: metaVersion });
    if (headerMethod === null) return rpcError(400, id, -32020, 'Missing required Mcp-Method header');
    if (method === 'tools/call' && headerName === null) return rpcError(400, id, -32020, 'Missing required Mcp-Name header');
    era = 'modern';
  } else {
    // Legacy clients omit _meta version; a missing header means 2025-03-26 (pre-header clients).
    const legacyVersion = headerVersion ?? '2025-03-26';
    if (!LEGACY_VERSIONS.includes(legacyVersion))
      return rpcError(400, id, -32022, 'Unsupported protocol version', { supported: ALL_VERSIONS, requested: legacyVersion });
    era = 'legacy';
  }

  if (isNotification) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });

  const ok = (result) => json(200, {
    jsonrpc: '2.0', id,
    result: { ...result, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } },
  });
  const notFound = () => rpcError(era === 'modern' ? 404 : 200, id, -32601, `Method not found: ${method}`);
  const isChatgpt = context.source === 'chatgpt';

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'server/discover':
      if (era !== 'modern') return notFound();
      return ok({ supportedVersions: ALL_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3600000, cacheScope: 'private' });
    case 'ping':
      if (era !== 'legacy') return notFound();
      return ok({});
    case 'tools/list':
      // Preserve the Claude/Codex tool list exactly. The preview card is a ChatGPT-only enhancement.
      return ok({ tools: isChatgpt ? TOOLS : TOOLS.filter((t) => t.name !== 'preview_reading_record'),
        ttlMs: 3600000, cacheScope: 'private' });
    case 'resources/list':
      if (!isChatgpt) return notFound();
      return ok({ resources: [{
        uri: READING_PREVIEW_URI, name: 'reading-preview', title: 'Reading record preview',
        mimeType: 'text/html;profile=mcp-app',
      }] });
    case 'resources/read':
      if (!isChatgpt) return notFound();
      if (params.uri !== READING_PREVIEW_URI) return rpcError(era === 'modern' ? 404 : 200, id, -32002, 'Resource not found');
      return ok({ contents: [{
        uri: READING_PREVIEW_URI, mimeType: 'text/html;profile=mcp-app', text: READING_PREVIEW_HTML,
      }] });
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(era === 'modern' ? 400 : 200, id, -32602, 'Tool name required');
      const result = await callTool(params.name, params.arguments ?? {}, context);
      if (result === null) return rpcError(era === 'modern' ? 400 : 200, id, -32602, `Unknown tool: ${params.name}`);
      return ok(result);
    }
    default:
      return notFound();
  }
}
