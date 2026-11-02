import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toLetterbookxdCandidate } from '../src/adapters/letterbookxd.js';
import { callTool } from '../src/mcp/tools.js';
import { ADAPTER_ERROR } from '../src/destinations.js';

const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'letterbookxd', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'b'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'reading_record', payload, ...extra,
});
const ctx = (db, scopes = ['hub:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes });

test('reading_record: finished books carry stars and 인생책, books in progress a page', () => {
  assert.ok(toLetterbookxdCandidate(hub({ title: '가상의 책', author: '가상 작가', state: 'completed', rating: 4, liked: true, date: '2026-11-01' })));
  assert.ok(toLetterbookxdCandidate(hub({ title: '가상의 대하소설', volume: 3, publisher: '가상출판', state: 'reading', current_page: 120 })));
  for (const payload of [
    { state: 'completed' },
    { title: '가상의 책' },
    { title: '가상의 책', state: 'wishlist' },
    { title: '가상의 책', state: 'completed', current_page: 10 },
    { title: '가상의 책', state: 'reading', rating: 3 },
    { title: '가상의 책', state: 'reading', liked: true },
    { title: '가상의 책', state: 'completed', rating: 4.5 },
    { title: '가상의 책', state: 'completed', rating: 0 },
    { title: '가상의 책', state: 'completed', liked: false },
    { title: '가상의 책', state: 'completed', volume: 0 },
    { title: '가상의 책', state: 'completed', date: '2026-13-01' },
    { title: '가상의 책', state: 'completed', isbn: '9780000000000' },
  ]) assert.throws(() => toLetterbookxdCandidate(hub(payload)), (e) => ADAPTER_ERROR.test(e.message), JSON.stringify(payload));
});

test('propose_reading_record stores a pending 책장 candidate', async () => {
  const db = new TestD1();
  try {
    const args = { title: '가상의 책', author: '가상 작가', state: 'completed', rating: 5, liked: true, date: '2026-11-01' };
    const ok = await callTool('propose_reading_record', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.match(ok.content[0].text, /책장/);
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'letterbookxd');
    assert.deepEqual(JSON.parse(row.envelope_json).payload, args);
    // liked:false is simply not sent; a page on a finished book is an input error.
    const plain = await callTool('propose_reading_record', { title: '가상의 다른 책', state: 'completed', liked: false }, ctx(db));
    assert.equal(plain.isError, undefined);
    for (const bad of [{ ...args, current_page: 10 }, { ...args, rating: '5' }, { title: 'x', state: 'reading', rating: 2 }]) {
      const r = await callTool('propose_reading_record', bad, ctx(db));
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
  } finally { db.close(); }
});
