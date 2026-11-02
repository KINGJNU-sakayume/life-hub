import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toAnimanCandidate } from '../src/adapters/animan.js';
import { callTool } from '../src/mcp/tools.js';
import { ADAPTER_ERROR } from '../src/destinations.js';

const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'animan', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'm'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'media_progress', payload, ...extra,
});
const ctx = (db) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes: ['hub:propose'] });

test('media_progress: up to an episode/volume, or specific ones; season only for episodes', () => {
  assert.ok(toAnimanCandidate(hub({ title: '가상 애니', kind: 'episode', up_to: 12 })));
  assert.ok(toAnimanCandidate(hub({ title: '가상 애니', kind: 'episode', season: 2, up_to: 5 })));
  assert.ok(toAnimanCandidate(hub({ title: '가상 만화', kind: 'volume', numbers: [3, 5], note: '가상' })));
  for (const payload of [
    { kind: 'episode', up_to: 1 }, { title: 'x', up_to: 1 }, { title: 'x', kind: 'chapter', up_to: 1 },
    { title: 'x', kind: 'episode' }, { title: 'x', kind: 'episode', up_to: 2, numbers: [1] },
    { title: 'x', kind: 'volume', season: 1, up_to: 2 }, { title: 'x', kind: 'episode', up_to: 0 },
    { title: 'x', kind: 'episode', up_to: 1.5 }, { title: 'x', kind: 'episode', numbers: [] },
    { title: 'x', kind: 'episode', numbers: [1, 1] }, { title: 'x', kind: 'episode', up_to: 1, series_id: 'abc' },
  ]) assert.throws(() => toAnimanCandidate(hub(payload)), (e) => ADAPTER_ERROR.test(e.message), JSON.stringify(payload));
});

test('propose_media_progress stores a pending AniMan candidate', async () => {
  const db = new TestD1();
  try {
    const args = { title: '가상 애니', kind: 'episode', season: 2, up_to: 5 };
    const ok = await callTool('propose_media_progress', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.match(ok.content[0].text, /AniMan/);
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'animan');
    assert.deepEqual(JSON.parse(row.envelope_json).payload, args);
    assert.equal((await callTool('propose_media_progress', { title: '가상 만화', kind: 'volume', numbers: [1, 2] }, ctx(db))).isError, undefined);
    for (const bad of [{ ...args, numbers: ['1'] }, { title: 'x', kind: 'episode', numbers: [1.5] }, { title: 'x', kind: 'episode' }]) {
      assert.equal((await callTool('propose_media_progress', bad, ctx(db))).isError, true, JSON.stringify(bad));
    }
  } finally { db.close(); }
});
