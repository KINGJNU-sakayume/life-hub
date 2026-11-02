/**
 * Claude conversation cards (MCP Apps): resources, tool visibility and the approval guarantees.
 * The model must never be able to approve: card_* tools are app-only, need hub:approve on a Claude grant,
 * and need the single-use ticket that only travels in the proposal result's _meta. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { handleMcpRequest } from '../src/mcp/protocol.js';
import { destinationById } from '../src/destinations.js';

const ORIGIN = 'https://hub.example';
const NOW = Date.parse('2026-11-02T00:00:00Z');
const APPROVE = ['hub:propose', 'hub:approve'];
const ctx = (db, { source = 'claude', scopes = APPROVE, now = NOW } = {}) => ({
  db, ownerId: 'demo-owner', now: () => now, allowedOrigins: [ORIGIN], scopes, source,
  appUrls: { food: 'https://apps.example/food/' },
});
let seq = 0;
async function rpc(db, method, params, options) {
  const response = await handleMcpRequest(new Request(ORIGIN + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  }), ctx(db, options));
  return (await response.json());
}
const call = async (db, name, args, options) => (await rpc(db, 'tools/call', { name, arguments: args }, options)).result;
const statusOf = async (db, id) => (await db.prepare('SELECT status FROM inbox WHERE id=?').bind(id).first()).status;
const MEAL = { menu_name: 'Synthetic ramen', place_name: 'Fictional shop', eaten_on: '2026-11-02', verdict: 'LIKE' };

async function withApproval(fn) {
  const card = destinationById('food').card;
  card.approve = true;
  try { await fn(); } finally { card.approve = false; }
}
async function proposed(db, args = MEAL, options) {
  const result = await call(db, 'propose_food_meal', args, options);
  return { result, id: result.structuredContent.candidate_id, ticket: result._meta?.['life-hub/card']?.ticket };
}

test('tools/list: card tools are app-only and only for a Claude grant with hub:approve', async () => {
  const db = new TestD1();
  try {
    const names = (r) => r.result.tools.map((t) => t.name);
    const plain = await rpc(db, 'tools/list', {}, { scopes: ['hub:propose'] });
    assert.ok(!names(plain).some((n) => n.startsWith('card_')));
    const meal = plain.result.tools.find((t) => t.name === 'propose_food_meal');
    assert.equal(meal._meta.ui.resourceUri, 'ui://life-hub/card-food.html');
    assert.equal(meal._meta['ui/resourceUri'], 'ui://life-hub/card-food.html');
    assert.ok(plain.result.ttlMs <= 300000, 'a deploy must reach open chats within minutes');
    // Destinations without a card keep a plain tool.
    assert.equal(plain.result.tools.find((t) => t.name === 'propose_memory')._meta, undefined);

    const full = await rpc(db, 'tools/list', {});
    const cards = full.result.tools.filter((t) => t.name.startsWith('card_'));
    assert.deepEqual(cards.map((t) => t.name), ['card_refresh', 'card_edit', 'card_approve', 'card_reject']);
    for (const t of cards) assert.deepEqual(t._meta.ui.visibility, ['app']);
    // Every model-visible tool stays model-visible (no visibility restriction).
    for (const t of full.result.tools.filter((x) => !x.name.startsWith('card_'))) assert.equal(t._meta?.ui?.visibility, undefined);

    for (const source of ['codex', 'chatgpt']) {
      const other = await rpc(db, 'tools/list', {}, { source, scopes: APPROVE });
      assert.ok(!names(other).some((n) => n.startsWith('card_')), source);
      assert.equal(other.result.tools.find((t) => t.name === 'propose_food_meal')._meta, undefined, source);
    }
  } finally { db.close(); }
});

test('resources: the food card is a small self-contained mcp-app page with no external domains', async () => {
  const db = new TestD1();
  try {
    const list = await rpc(db, 'resources/list', {});
    assert.deepEqual(list.result.resources.map((r) => [r.uri, r.mimeType]), [['ui://life-hub/card-food.html', 'text/html;profile=mcp-app']]);
    const read = await rpc(db, 'resources/read', { uri: 'ui://life-hub/card-food.html' });
    const [content] = read.result.contents;
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(content._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.ok(content.text.length < 25000, `card is ${content.text.length} bytes`);
    assert.match(content.text, /^<!doctype html>/);
    // No remote code, styles, images or network calls.
    assert.doesNotMatch(content.text, /<script[^>]+src=|<link[^>]+href=|<img|url\(|@import|fetch\(|XMLHttpRequest|WebSocket|EventSource/);
    assert.match(content.text, /ui\/initialize/);
    // The card answers host requests (liveness ping) and talks only after the handshake, like the SDK's App.
    assert.match(content.text, /m\.method==='ping'/);
    assert.match(content.text, /-32601/);
    assert.ok(content.text.indexOf("method:'ui/notifications/initialized'") < content.text.indexOf('size();if(window.ResizeObserver)'));
    assert.equal((await rpc(db, 'resources/list', {}, { source: 'codex' })).error.code, -32601);
  } finally { db.close(); }
});

test('propose: the ticket is only in _meta, never in model-visible content or structuredContent', async () => {
  const db = new TestD1();
  try {
    const { result, ticket, id } = await proposed(db);
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    const visible = JSON.stringify(result.content) + JSON.stringify(result.structuredContent);
    assert.ok(!visible.includes(ticket));
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'life-hub');
    assert.deepEqual(result.structuredContent.card.payload, { menu_name: 'Synthetic ramen', place_name: 'Fictional shop', verdict: 'LIKE', eaten_at: '2026-11-02' });
    assert.equal(result.structuredContent.card.approve, 'app', 'PALATE does not accept card approval yet');
    assert.equal(result.structuredContent.card.app_url, 'https://apps.example/food/');
    // Only a hash is stored.
    const row = await db.prepare('SELECT * FROM card_tickets WHERE candidate_id=?').bind(id).first();
    assert.equal(row.ticket_hash.length, 64);
    assert.notEqual(row.ticket_hash, ticket);

    // Without hub:approve (or for Codex/ChatGPT) no ticket is issued at all.
    for (const options of [{ scopes: ['hub:propose'] }, { source: 'codex' }, { source: 'chatgpt' }]) {
      const other = await call(db, 'propose_food_wish', { wish_kind: 'try_menu', name: 'Synthetic tart ' + options.source }, options);
      assert.equal(other._meta?.['life-hub/card'], undefined);
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM card_tickets').bind().first()).n, 1);
  } finally { db.close(); }
});

test('card approval is refused while the destination does not sync approved candidates', async () => {
  const db = new TestD1();
  try {
    const { id, ticket } = await proposed(db);
    const r = await call(db, 'card_approve', { candidate_id: id, ticket, revision: 0 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /review it in the app/);
    assert.equal(await statusOf(db, id), 'pending');
    // Edit and reject still work there.
    const rejected = await call(db, 'card_reject', { candidate_id: id, ticket });
    assert.equal(rejected.structuredContent.card.status, 'rejected');
  } finally { db.close(); }
});

test('no approval without the right connection, scope and ticket', async () => {
  const db = new TestD1();
  try {
    await withApproval(async () => {
      const { id, ticket } = await proposed(db);
      const other = await proposed(db, { ...MEAL, menu_name: 'Another synthetic dish' });
      const attempts = [
        [{ candidate_id: id, revision: 0 }, {}],                                   // no ticket (what a model could try)
        [{ candidate_id: id, ticket: 'A'.repeat(43), revision: 0 }, {}],           // guessed ticket
        [{ candidate_id: id, ticket: other.ticket, revision: 0 }, {}],             // another candidate's ticket
        [{ candidate_id: id, ticket, revision: 0 }, { scopes: ['hub:propose'] }],  // grant without hub:approve
        [{ candidate_id: id, ticket, revision: 0 }, { source: 'codex' }],          // Codex, even with the ticket
        [{ candidate_id: id, ticket, revision: 0 }, { source: 'chatgpt' }],
        [{ candidate_id: id, ticket, revision: 0 }, { now: NOW + 8 * 86400000 }],  // expired
      ];
      for (const [args, options] of attempts) {
        const response = await rpc(db, 'tools/call', { name: 'card_approve', arguments: args }, options);
        assert.ok(response.error || response.result.isError, JSON.stringify(args) + JSON.stringify(options));
        assert.equal(await statusOf(db, id), 'pending');
      }
      // A different owner's context cannot use it either.
      const foreign = await handleMcpRequest(new Request(ORIGIN + '/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'card_approve', arguments: { candidate_id: id, ticket, revision: 0 } } }),
      }), { ...ctx(db), ownerId: 'someone-else' });
      assert.equal((await foreign.json()).result.isError, true);
      assert.equal(await statusOf(db, id), 'pending');

      const ok = await call(db, 'card_approve', { candidate_id: id, ticket, revision: 0 });
      assert.equal(ok.isError, undefined);
      assert.equal(ok.structuredContent.card.status, 'approved');
      assert.match(ok.content[0].text, /not saved yet/);
      // Double click: same result, still one approval event.
      const again = await call(db, 'card_approve', { candidate_id: id, ticket, revision: 0 });
      assert.equal(again.structuredContent.card.status, 'approved');
      const events = (await db.prepare(`SELECT COUNT(*) AS n FROM inbox_changes WHERE candidate_id=? AND status='approved'`).bind(id).first()).n;
      assert.equal(events, 1);
      // The used ticket cannot reject.
      const reject = await call(db, 'card_reject', { candidate_id: id, ticket });
      assert.equal(reject.isError, true);
      assert.equal(reject.structuredContent.error, 'conflict');
      assert.equal(await statusOf(db, id), 'approved');
    });
  } finally { db.close(); }
});

test('edits are validated, keep the original proposal, and lock by revision', async () => {
  const db = new TestD1();
  try {
    await withApproval(async () => {
      const { id, ticket } = await proposed(db);
      const bad = await call(db, 'card_edit', { candidate_id: id, ticket, revision: 0, payload: { menu_name: 'X', verdict: 'GREAT' } });
      assert.equal(bad.isError, true);
      const unknownField = await call(db, 'card_edit', { candidate_id: id, ticket, revision: 0, payload: { menu_name: 'X', secret: 'y' } });
      assert.equal(unknownField.isError, true);
      const edited = await call(db, 'card_edit', { candidate_id: id, ticket, revision: 0, payload: { menu_name: 'Synthetic ramen with egg', reorder_intent: 'YES' } });
      assert.equal(edited.structuredContent.card.revision, 1);
      assert.deepEqual(edited.structuredContent.card.payload, { menu_name: 'Synthetic ramen with egg', reorder_intent: 'YES' });
      const row = await db.prepare('SELECT * FROM inbox WHERE id=?').bind(id).first();
      assert.equal(JSON.parse(row.envelope_json).payload.menu_name, 'Synthetic ramen');

      const stale = await call(db, 'card_approve', { candidate_id: id, ticket, revision: 0 });
      assert.equal(stale.structuredContent.error, 'conflict');
      assert.equal(await statusOf(db, id), 'pending');
      const refreshed = await call(db, 'card_refresh', { candidate_id: id, ticket });
      assert.equal(refreshed.structuredContent.card.revision, 1);
      const ok = await call(db, 'card_approve', { candidate_id: id, ticket, revision: 1, app_review: true });
      assert.equal(ok.structuredContent.card.status, 'approved');
      assert.equal(ok.structuredContent.card.needs_app_review, true);
      const changes = (await db.prepare('SELECT change_type, status FROM inbox_changes WHERE candidate_id=? ORDER BY seq').bind(id).all()).results;
      assert.deepEqual(changes.map((c) => c.change_type + ':' + c.status), ['created:pending', 'edited:pending', 'status:approved']);
      // Once approved, no more edits.
      const late = await call(db, 'card_edit', { candidate_id: id, ticket, revision: 1, payload: { menu_name: 'Z' } });
      assert.equal(late.isError, true);
    });
  } finally { db.close(); }
});

test('a duplicate proposal of an approved candidate issues no new ticket', async () => {
  const db = new TestD1();
  try {
    await withApproval(async () => {
      const first = await proposed(db);
      await call(db, 'card_approve', { candidate_id: first.id, ticket: first.ticket, revision: 0 });
      const again = await proposed(db);
      assert.equal(again.id, first.id);
      assert.equal(again.ticket, undefined);
      assert.equal(again.result.structuredContent.card.status, 'approved');
    });
  } finally { db.close(); }
});
