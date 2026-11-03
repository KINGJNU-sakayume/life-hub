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

/* ---------- Cards stage 6: the AniMan progress card ---------- */

test('the AniMan card approves with the shared catalogue; a title must mean exactly one series', async () => {
  const { putDestinationRefs } = await import('../src/server/store.js');
  const { seriesMatches, needsAppReview } = await import('../src/mcp/tools.js');
  const SERIES = [
    { id: '00000000-0000-4000-8000-000000000001', label: '가상의 모험 (仮想冒険)', group: '#03acb1' },
    { id: '00000000-0000-4000-8000-000000000002', label: '가상 학원', group: '#e0457b' },
    { id: '00000000-0000-4000-8000-000000000003', label: '가상 학원 2', group: '#e0457b' },
  ];
  assert.deepEqual(seriesMatches('가상의 모험', SERIES).map((s) => s.id), [SERIES[0].id]);
  assert.deepEqual(seriesMatches('仮想冒険', SERIES).map((s) => s.id), [SERIES[0].id], 'the original title in brackets');
  assert.deepEqual(seriesMatches('가상학원', SERIES).map((s) => s.id), [SERIES[1].id], 'spacing does not matter, 2 is another series');
  assert.deepEqual(seriesMatches('모험', SERIES), [], 'no guessing from a part of a word');
  const refs = { series: SERIES };
  assert.equal(needsAppReview('animan', 'media_progress', { title: '가상 학원', kind: 'episode', up_to: 3 }, refs), false);
  assert.equal(needsAppReview('animan', 'media_progress', { title: '없는 작품', kind: 'episode', up_to: 3 }, refs), true);
  assert.equal(needsAppReview('animan', 'media_progress', { title: '가상 학원', kind: 'episode', up_to: 3 }, undefined), true);

  const db = new TestD1();
  try {
    const claude = { db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes: ['hub:propose', 'hub:approve'], source: 'claude', appUrls: {} };
    const r = await callTool('propose_media_progress', { title: '가상 학원', kind: 'episode', up_to: 12 }, claude);
    assert.equal(r.structuredContent.card.label, '진행 기록');
    assert.equal(r.structuredContent.card.approve, 'ok');
    const ticket = r._meta['life-hub/card'].ticket;
    const id = r.structuredContent.candidate_id;
    await putDestinationRefs(db, 'demo-owner', 'animan', 'series', 1, SERIES, '2026-11-02T03:00:00.000Z');
    const refreshed = await callTool('card_refresh', { candidate_id: id, ticket }, claude);
    assert.deepEqual(refreshed.structuredContent.card.refs.series, SERIES);
    const approved = await callTool('card_approve', { candidate_id: id, ticket, revision: 0 }, claude);
    assert.equal(approved.structuredContent.card.needs_app_review, false);
  } finally { db.close(); }
});
