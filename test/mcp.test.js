import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { handleMcpRequest } from '../src/mcp/protocol.js';
import { insertCandidate } from '../src/server/store.js';

const ORIGIN = 'https://hub.example';
const context = (db, scopes = ['food:propose', 'kyeokyeoi:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T00:00:00Z'), allowedOrigins: [ORIGIN, 'https://claude.ai'], scopes });

function post(body, headers = {}) {
  return new Request(ORIGIN + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const legacy = (method, params, id = 1) => post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, { 'MCP-Protocol-Version': '2025-06-18' });
const modern = (method, params = {}, id = 1, extraHeaders = {}) => post(
  { jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
  { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), ...extraHeaders });
async function send(db, request) {
  const response = await handleMcpRequest(request, context(db));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('legacy handshake, notification and tool listing', async () => {
  const db = new TestD1();
  try {
    const init = await send(db, post({ jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    // Unknown requested version negotiates down to the newest legacy one.
    const odd = await send(db, post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2099-01-01' } }));
    assert.equal(odd.body.result.protocolVersion, '2025-11-25');

    const note = await send(db, post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-06-18' }));
    assert.equal(note.status, 202);
    assert.equal(note.body, null);

    const list = await send(db, legacy('tools/list'));
    assert.deepEqual(list.body.result.tools.map((t) => t.name),
      ['get_proposal_status', 'propose_food_meal', 'propose_food_wish', 'propose_album_listening', 'propose_activity_record', 'propose_reading_record', 'propose_station_visit', 'propose_memory', 'propose_region_visit']);
    assert.equal((await send(db, legacy('ping'))).body.result.resultType, 'complete');
  } finally { db.close(); }
});

test('propose_food_meal stores a pending claude candidate and de-duplicates identical proposals', async () => {
  const db = new TestD1();
  try {
    const args = { menu_name: 'Synthetic noodles', place_name: 'Fictional cafe', eaten_on: '2026-11-01', verdict: 'LIKE' };
    const first = await send(db, legacy('tools/call', { name: 'propose_food_meal', arguments: args }));
    assert.equal(first.status, 200);
    assert.equal(first.body.result.isError, undefined);
    const { candidate_id, status, duplicate } = first.body.result.structuredContent;
    assert.equal(status, 'pending');
    assert.equal(duplicate, false);
    assert.match(first.body.result.content[0].text, /PENDING proposal only/);

    const row = await db.prepare('SELECT * FROM inbox WHERE id=?').bind(candidate_id).first();
    assert.equal(row.source, 'claude');
    assert.equal(row.owner_id, 'demo-owner');
    const envelope = JSON.parse(row.envelope_json);
    assert.deepEqual(envelope.payload, { menu_name: 'Synthetic noodles', place_name: 'Fictional cafe', verdict: 'LIKE', eaten_at: '2026-11-01' });
    assert.match(envelope.idempotency_key, /^mcp-[0-9a-f]{40}$/);

    // Same meaning, different key order and whitespace: same candidate.
    const again = await send(db, legacy('tools/call', { name: 'propose_food_meal',
      arguments: { verdict: 'LIKE', eaten_on: '2026-11-01', place_name: ' Fictional cafe ', menu_name: 'Synthetic noodles' } }, 2));
    assert.equal(again.body.result.structuredContent.candidate_id, candidate_id);
    assert.equal(again.body.result.structuredContent.duplicate, true);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 1);
  } finally { db.close(); }
});

test('invalid tool input is reported as a tool error, not stored', async () => {
  const db = new TestD1();
  try {
    const cases = [
      ['propose_food_meal', {}],
      ['propose_food_meal', { menu_name: 'x', eaten_on: '2026-02-30' }],
      ['propose_food_meal', { menu_name: 'x', owner_id: 'someone-else' }],
      ['propose_food_meal', { menu_name: 42 }],
      ['propose_food_wish', { wish_kind: 'visit_place', name: 'x', source_url: 'http://insecure.example' }],
      ['propose_food_wish', { wish_kind: 'teleport', name: 'x' }],
    ];
    for (const [name, args] of cases) {
      const r = await send(db, legacy('tools/call', { name, arguments: args }));
      assert.equal(r.body.result.isError, true, JSON.stringify(args));
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 0);
    const unknown = await send(db, legacy('tools/call', { name: 'delete_everything', arguments: {} }));
    assert.equal(unknown.body.error.code, -32602);
  } finally { db.close(); }
});

test('status tool only reveals candidates this connector proposed', async () => {
  const db = new TestD1();
  try {
    const made = await send(db, legacy('tools/call', { name: 'propose_food_wish', arguments: { wish_kind: 'try_menu', name: 'Imaginary pasta' } }));
    const id = made.body.result.structuredContent.candidate_id;
    const ok = await send(db, legacy('tools/call', { name: 'get_proposal_status', arguments: { candidate_id: id } }));
    assert.equal(ok.body.result.structuredContent.status, 'pending');

    const manual = await insertCandidate(db, 'demo-owner', {
      hub_version: 1, destination: 'food', source: 'manual', source_ref: 'manual:t', idempotency_key: 'manual-key-0001',
      created_at: '2026-11-01T10:00:00Z', candidate_type: 'wish', payload: { wish_kind: 'try_menu', name: 'Private' },
    }, '2026-11-01T10:00:00Z');
    const hidden = await send(db, legacy('tools/call', { name: 'get_proposal_status', arguments: { candidate_id: manual.id } }));
    assert.equal(hidden.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(hidden.body), /Private/);
  } finally { db.close(); }
});

test('modern era: discover, header validation and version negotiation', async () => {
  const db = new TestD1();
  try {
    const discover = await send(db, modern('server/discover'));
    assert.equal(discover.status, 200);
    assert.equal(discover.body.result.resultType, 'complete');
    assert.ok(discover.body.result.supportedVersions.includes('2026-07-28'));
    assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'life-hub');

    const list = await send(db, modern('tools/list'));
    assert.equal(list.body.result.cacheScope, 'private');
    assert.equal(typeof list.body.result.ttlMs, 'number');

    const call = await send(db, modern('tools/call', { name: 'propose_food_wish', arguments: { wish_kind: 'visit_place', name: 'Fictional bistro' } }));
    assert.equal(call.body.result.structuredContent.status, 'pending');

    const mismatchMethod = await send(db, modern('tools/list', {}, 1, { 'Mcp-Method': 'tools/call' }));
    assert.equal(mismatchMethod.status, 400);
    assert.equal(mismatchMethod.body.error.code, -32020);
    const mismatchName = await send(db, modern('tools/call', { name: 'propose_food_wish', arguments: {} }, 1, { 'Mcp-Name': 'other' }));
    assert.equal(mismatchName.body.error.code, -32020);
    const mismatchVersion = await send(db, modern('tools/list', {}, 1, { 'MCP-Protocol-Version': '2025-06-18' }));
    assert.equal(mismatchVersion.body.error.code, -32020);

    const missingHeader = await send(db, post({ jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { 'MCP-Protocol-Version': '2026-07-28' }));
    assert.equal(missingHeader.body.error.code, -32020);

    const future = await send(db, post({ jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }, { 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' }));
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, -32022);
    assert.equal(future.body.error.data.requested, '2099-01-01');

    const missing = await send(db, modern('resources/list'));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, -32601);
    assert.equal((await send(db, modern('ping'))).status, 404);
  } finally { db.close(); }
});

test('transport guards: origin, method, content type, malformed bodies', async () => {
  const db = new TestD1();
  try {
    assert.equal((await send(db, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Origin: 'https://evil.example' }))).status, 403);
    assert.equal((await handleMcpRequest(new Request(ORIGIN + '/mcp'), context(db))).status, 405);
    assert.equal((await handleMcpRequest(new Request(ORIGIN + '/mcp', { method: 'POST', body: '{}' }), context(db))).status, 415);
    assert.equal((await send(db, post('{not json'))).body.error.code, -32700);
    assert.equal((await send(db, post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]))).body.error.code, -32600);
    assert.equal((await send(db, post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [] }))).body.error.code, -32602);
    assert.equal((await send(db, post('{"jsonrpc":"2.0","id":1,"method":"x","pad":"' + 'a'.repeat(70000) + '"}'))).status, 413);
    // claude.ai origin is allowed.
    assert.equal((await send(db, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Origin: 'https://claude.ai', 'MCP-Protocol-Version': '2025-06-18' }))).status, 200);
  } finally { db.close(); }
});
