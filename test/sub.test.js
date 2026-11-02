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

/* ---------- Cards stage 5: station draw and the station card ---------- */

import { putDestinationRefs } from '../src/server/store.js';
import { handleInboxRequest } from '../src/inbox/api.js';
import { stationMatches, needsAppReview } from '../src/mcp/tools.js';

const LINES = [{ id: '2', label: '2호선', group: '#00A84D' }, { id: 'GJ', label: '경의중앙선', group: '#77C4A3' }];
const STATIONS = [
  { id: '2.0', label: '가상시청', group: '2호선' }, { id: '2.1', label: '가상신촌', group: '2호선' }, { id: '2.2', label: '가상망원', group: '2호선' },
  { id: 'GJ.0', label: '가상신촌(경의중앙)', group: '경의중앙선' }, { id: 'GJ.1', label: '가상시청', group: '경의중앙선' },
];
const share = (db, kind, items, revision = 1) => putDestinationRefs(db, 'demo-owner', 'sub', kind, revision, items, '2026-11-02T03:00:00.000Z');
const claude = (db) => ({ ...ctx(db), scopes: ['hub:propose', 'hub:approve'], source: 'claude', appUrls: { sub: 'https://apps.example/sub/' } });

test('station_draw: date, line and station only', () => {
  assert.ok(toSubCandidate(hub({ date: '2026-11-02', line: '2호선', station: '가상망원' }, { candidate_type: 'station_draw' })));
  for (const payload of [{ date: '2026-11-02', line: '2호선' }, { date: '2026-11-02', station: '가상망원' }, { line: '2호선', station: '가상망원' },
    { date: '2026-11-02', line: '2호선', station: '가상망원', stamp: true }])
    assert.throws(() => toSubCandidate(hub(payload, { candidate_type: 'station_draw' })));
});

test('the draw takes no input, uses only the shared pool, and the card gets lines and that line\'s stations, never the pool', async () => {
  const db = new TestD1();
  try {
    const none = await callTool('propose_station_draw', {}, claude(db));
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /has not shared which stations/);
    assert.equal((await callTool('propose_station_draw', { station: '가상망원' }, claude(db))).isError, true);

    await share(db, 'lines', LINES);
    await share(db, 'stations', STATIONS);
    await share(db, 'pool', [{ id: '2.2', label: '가상망원', group: '2호선' }]);
    const r = await callTool('propose_station_draw', {}, claude(db));
    assert.equal(r.structuredContent.station, '가상망원');
    assert.equal(r.structuredContent.line, '2호선');
    assert.equal(r.structuredContent.card.label, '역 뽑기');
    assert.equal(r.structuredContent.card.refs, undefined);
    assert.match(r.content[0].text, /가상망원역 on 2호선/);
    const ticket = r._meta['life-hub/card'].ticket;
    const id = r.structuredContent.candidate_id;
    const refreshed = await callTool('card_refresh', { candidate_id: id, ticket }, claude(db));
    assert.deepEqual(Object.keys(refreshed.structuredContent.card.refs).sort(), ['lines', 'stations']);
    assert.deepEqual(refreshed.structuredContent.card.refs.stations.map((s) => s.group), ['2호선', '2호선', '2호선'], 'only the drawn line');
    const approved = await callTool('card_approve', { candidate_id: id, ticket, revision: 0 }, claude(db));
    assert.equal(approved.structuredContent.card.status, 'approved');
    assert.equal(approved.structuredContent.card.needs_app_review, false);
  } finally { db.close(); }
});

test('a visit is stamped without asking only when its name means exactly one station', async () => {
  assert.deepEqual(stationMatches('가상망원역', STATIONS), ['가상망원']);
  assert.deepEqual(stationMatches('가상신촌', STATIONS).sort(), ['가상신촌', '가상신촌(경의중앙)']);
  assert.deepEqual(stationMatches('가상신촌(경의중앙)', STATIONS), ['가상신촌(경의중앙)']);
  assert.deepEqual(stationMatches('가상시청', STATIONS), ['가상시청'], 'a transfer station is one station');
  const refs = { stations: STATIONS };
  assert.equal(needsAppReview('sub', 'station_visit', { station: '가상망원', date: '2026-11-01' }, refs), false);
  assert.equal(needsAppReview('sub', 'station_visit', { station: '가상신촌', date: '2026-11-01' }, refs), true);
  assert.equal(needsAppReview('sub', 'station_visit', { station: '없는역', date: '2026-11-01' }, refs), true);
  assert.equal(needsAppReview('sub', 'station_visit', { station: '가상망원', date: '2026-11-01' }, undefined), true);
  assert.equal(needsAppReview('sub', 'station_draw', { date: '2026-11-01', line: '2호선', station: '가상망원' }, refs), false);
});

test('sub may share larger station lists than the default 500 items / 32 KB', async () => {
  const db = new TestD1();
  const api = async (path, body) => {
    const response = await handleInboxRequest(new Request('https://hub.example' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), destination: 'sub', prefix: '/sub/v1' });
    return response.status;
  };
  try {
    const many = Array.from({ length: 700 }, (_, i) => ({ id: 'L.' + i, label: '가상역' + i, group: '가상선' }));
    assert.equal(await api('/sub/v1/refs/stations', { revision: 1, items: many }), 200);
    assert.equal(await api('/sub/v1/refs/pool', { revision: 1, items: many }), 200);
    assert.equal(await api('/sub/v1/refs/lines', { revision: 1, items: many }), 400, 'lines keep the default limit');
    assert.equal(await api('/sub/v1/refs/stations', { revision: 2, items: [...many, ...many].map((x, i) => ({ ...x, id: 'L.' + i })) }), 400);
  } finally { db.close(); }
});
