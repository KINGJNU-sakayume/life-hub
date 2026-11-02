import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toSubCandidate } from '../src/adapters/sub.js';
import { callTool } from '../src/mcp/tools.js';
import { ADAPTER_ERROR } from '../src/destinations.js';

const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'sub', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 's'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'station_visit', payload, ...extra,
});
const ctx = (db) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes: ['hub:propose'] });

test('station_visit: a station and the visit date; no photos or codes', () => {
  assert.ok(toSubCandidate(hub({ station: '가상역', date: '2026-11-01' })));
  assert.ok(toSubCandidate(hub({ station: '가상', line: '2호선', date: '2026-11-01', note: '가상 메모' })));
  for (const payload of [
    { date: '2026-11-01' }, { station: '가상역' }, { station: '가상역', date: '11월 1일' },
    { station: 'x'.repeat(41), date: '2026-11-01' }, { station: '가상역', date: '2026-11-01', photo: 'data:image/png;base64,AA' },
    { station: '가상역', date: '2026-11-01', code: '0239' },
  ]) assert.throws(() => toSubCandidate(hub(payload)), (e) => ADAPTER_ERROR.test(e.message), JSON.stringify(payload));
});

test('propose_station_visit stores a pending sub candidate', async () => {
  const db = new TestD1();
  try {
    const args = { station: '가상역', line: '9호선', date: '2026-11-01' };
    const ok = await callTool('propose_station_visit', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.match(ok.content[0].text, /역 도장깨기/);
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'sub');
    assert.deepEqual(JSON.parse(row.envelope_json).payload, args);
    assert.equal((await callTool('propose_station_visit', { station: '가상역' }, ctx(db))).isError, true);
  } finally { db.close(); }
});
