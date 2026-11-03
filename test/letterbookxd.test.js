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

/* ---------- Cards stage 6: the 책장 reading card ---------- */

test('the 책장 card approves with the shared catalogue; the book, publisher and volume must be clear', async () => {
  const { putDestinationRefs } = await import('../src/server/store.js');
  const { bookMatch, needsAppReview } = await import('../src/mcp/tools.js');
  const W = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const WORKS = [
    { id: W(1), label: '가상의 책', group: '가상 작가' },
    { id: W(2), label: '가상의 대하소설', group: '다른 작가' },
    { id: W(3), label: '같은 제목', group: '작가 갑' },
    { id: W(4), label: '같은 제목', group: '작가 을' },
  ];
  const EDITIONS = [
    { id: 'e1', label: '가상출판', group: W(1) + '/1' },
    { id: 'e2', label: '가상출판', group: W(2) + '/1' }, { id: 'e3', label: '가상출판', group: W(2) + '/2' },
    { id: 'e4', label: '다른출판', group: W(2) + '/1' },
    { id: 'e5', label: '갑출판', group: W(3) + '/1' }, { id: 'e6', label: '을출판', group: W(4) + '/1' },
  ];
  const refs = { works: WORKS, editions: EDITIONS };
  const ok = (payload) => bookMatch(payload, refs);
  assert.equal(ok({ title: '가상의책' }), true, 'one work, one edition; spacing does not matter');
  assert.equal(ok({ title: '가상의 대하소설' }), false, 'two publishers');
  assert.equal(ok({ title: '가상의 대하소설', publisher: '가상 출판' }), false, 'two volumes there');
  assert.equal(ok({ title: '가상의 대하소설', publisher: '가상출판', volume: 2 }), true);
  assert.equal(ok({ title: '가상의 대하소설', publisher: '다른출판' }), true, 'one volume there');
  assert.equal(ok({ title: '가상의 대하소설', publisher: '가상출판', volume: 9 }), false, 'no such volume');
  assert.equal(ok({ title: '같은 제목' }), false, 'two works');
  assert.equal(ok({ title: '같은 제목', author: '작가 을' }), true, 'the author tells them apart');
  assert.equal(ok({ title: '가상' }), false, 'no guessing from a part of a title');
  assert.equal(needsAppReview('letterbookxd', 'reading_record', { title: '가상의 책', state: 'completed' }, refs), false);
  assert.equal(needsAppReview('letterbookxd', 'reading_record', { title: '가상의 책', state: 'completed' }, undefined), true);

  const db = new TestD1();
  try {
    const claude = { db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes: ['hub:propose', 'hub:approve'], source: 'claude', appUrls: {} };
    const r = await callTool('propose_reading_record', { title: '가상의 대하소설', publisher: '가상출판', volume: 2, state: 'reading', current_page: 40 }, claude);
    assert.equal(r.structuredContent.card.label, '독서 기록');
    assert.equal(r.structuredContent.card.approve, 'ok');
    assert.equal(r.structuredContent.card.refs, undefined, 'refs only travel in card_* results');
    const ticket = r._meta['life-hub/card'].ticket;
    const id = r.structuredContent.candidate_id;
    await putDestinationRefs(db, 'demo-owner', 'letterbookxd', 'works', 1, WORKS, '2026-11-02T03:00:00.000Z');
    await putDestinationRefs(db, 'demo-owner', 'letterbookxd', 'editions', 1, EDITIONS, '2026-11-02T03:00:00.000Z');
    const refreshed = await callTool('card_refresh', { candidate_id: id, ticket }, claude);
    assert.deepEqual(refreshed.structuredContent.card.refs, refs);
    const approved = await callTool('card_approve', { candidate_id: id, ticket, revision: 0 }, claude);
    assert.equal(approved.structuredContent.card.needs_app_review, false);

    const r2 = await callTool('propose_reading_record', { title: '같은 제목', state: 'completed', rating: 5 }, claude);
    const t2 = r2._meta['life-hub/card'].ticket;
    const a2 = await callTool('card_approve', { candidate_id: r2.structuredContent.candidate_id, ticket: t2, revision: 0 }, claude);
    assert.equal(a2.structuredContent.card.needs_app_review, true, 'two works with that title: the app asks');
  } finally { db.close(); }
});
