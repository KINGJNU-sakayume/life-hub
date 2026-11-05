import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toAchievementCandidate } from '../src/adapters/achievement.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { clientProfiles, ALL_SCOPES } from '../src/auth/clients.js';
import { DESTINATIONS, ADAPTER_ERROR } from '../src/destinations.js';

const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'achievement', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'a'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'activity_record', payload, ...extra,
});
const ctx = (db, scopes = ['hub:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes });

test('activity_record: category and date, an amount only with its unit rules, tags as words', () => {
  assert.ok(toAchievementCandidate(hub({ category: '러닝', date: '2026-11-02', value: 5, unit: 'km', tags: ['새벽', '한강'], memo: '가상의 아침 달리기' })));
  assert.ok(toAchievementCandidate(hub({ category: '명상', date: '2026-11-01' })));
  assert.ok(toAchievementCandidate(hub({ category: '독서', date: '2026-11-01', value: 2 })));
  for (const payload of [
    { date: '2026-11-02' },
    { category: '러닝' },
    { category: ' ', date: '2026-11-02' },
    { category: '러닝', date: '2026-02-30' },
    { category: '러닝', date: '2026-11-02', unit: 'km' },
    { category: '러닝', date: '2026-11-02', value: -1 },
    { category: '러닝', date: '2026-11-02', value: '5' },
    { category: '러닝', date: '2026-11-02', value: Infinity },
    { category: '러닝', date: '2026-11-02', tags: [] },
    { category: '러닝', date: '2026-11-02', tags: ['a', 'a'] },
    { category: '러닝', date: '2026-11-02', tags: Array.from({ length: 11 }, (_, i) => 't' + i) },
    { category: '러닝', date: '2026-11-02', photoUrl: 'https://example.com/x.jpg' },
    { category: '러닝', date: '2026-11-02', categoryId: 'cat-running' },
    { category: 'x'.repeat(61), date: '2026-11-02' },
  ]) assert.throws(() => toAchievementCandidate(hub(payload)), (e) => ADAPTER_ERROR.test(e.message), JSON.stringify(payload).slice(0, 100));
  assert.throws(() => toAchievementCandidate(hub({ category: '러닝', date: '2026-11-02' }, { candidate_type: 'achievement' })), (e) => ADAPTER_ERROR.test(e.message));
});

test('propose_activity_record stores a pending achievement candidate under hub:propose only', async () => {
  const db = new TestD1();
  try {
    assert.ok(TOOLS.some((t) => t.name === 'propose_activity_record'));
    const args = { category: '등산', date: '2026-11-01', value: 3.5, unit: '시간', tags: ['남산'], memo: '가상의 산행' };
    const ok = await callTool('propose_activity_record', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.match(ok.content[0].text, /업적 라이브러리/);
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'achievement');
    assert.deepEqual(JSON.parse(row.envelope_json).payload, args);
    assert.equal((await callTool('propose_activity_record', args, ctx(db))).structuredContent.duplicate, true);
    const old = await callTool('propose_activity_record', args, ctx(db, ['food:propose', 'kyeokyeoi:propose']));
    assert.equal(old.isError, true);
    assert.match(old.content[0].text, /reconnect/);
    for (const bad of [{ ...args, value: '3' }, { ...args, unit: 'km', value: undefined }, { ...args, date: '어제' }, { ...args, tags: '남산' }]) {
      const r = await callTool('propose_activity_record', bad, ctx(db));
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
  } finally { db.close(); }
});

test('the registry drives profiles and scopes', () => {
  assert.deepEqual(DESTINATIONS.map((d) => d.id), ['food', 'kyeokyeoi', 'potcast', 'achievement', 'letterbookxd', 'sub', 'animan', 'diaryroulette', 'elosorter', 'board']);
  assert.ok(ALL_SCOPES.includes('achievement:inbox') && ALL_SCOPES.includes('hub:propose') && ALL_SCOPES.includes('food:propose'));
  const off = clientProfiles({});
  assert.deepEqual(off.map((p) => p.id), ['claude']);
  const on = clientProfiles({ HUB_ACHIEVEMENT_REDIRECT_URI: 'https://owner.github.io/achievement/lifehub/', HUB_PALATE_REDIRECT_URI: 'https://owner.github.io/food/' });
  assert.deepEqual(on.map((p) => [p.id, p.resourcePath, p.scopes.join()]), [
    ['claude', '/mcp', 'hub:propose'], ['palate', '/palate', 'food:inbox,food:board'], ['achievement', '/achievement', 'achievement:inbox,achievement:board'],
  ]);
  assert.deepEqual(clientProfiles({ HUB_ACHIEVEMENT_REDIRECT_URI: 'http://insecure.example/' }).map((p) => p.id), ['claude']);
});

/* ---------- Stage 4: custom achievements and the achievement card ---------- */

const def = (payload) => hub(payload, { candidate_type: 'achievement_definition' });

test('achievement_definition: one flat condition of count / total / streak / tag / tag_count', () => {
  for (const payload of [
    { title: '한강 100km', category: '러닝', tier: 'gold', condition_type: 'total', target: 100, unit: 'km', description: '러닝 기록을 모두 더해 100km를 달려 보세요.' },
    { title: '새벽 러너', category: '러닝', tier: 'silver', condition_type: 'tag_count', tag: '새벽', target: 10 },
    { title: '첫 남산', tier: 'bronze', condition_type: 'tag', tag: '남산' },
    { title: '한 달 독서', category: '독서', tier: 'gold', condition_type: 'streak', target: 30 },
    { title: '기록 100번', tier: 'platinum', condition_type: 'count', target: 100 },
  ]) assert.ok(toAchievementCandidate(def(payload)), JSON.stringify(payload));
  for (const payload of [
    { tier: 'gold', condition_type: 'count', target: 3 },
    { title: 'x', tier: 'legend', condition_type: 'count', target: 3 },
    { title: 'x', tier: 'gold', condition_type: 'days', target: 3 },
    { title: 'x', tier: 'gold', condition_type: 'total', target: 100 },
    { title: 'x', tier: 'gold', condition_type: 'count', target: 2.5 },
    { title: 'x', tier: 'gold', condition_type: 'count', target: 0 },
    { title: 'x', tier: 'gold', condition_type: 'count', target: 3, unit: 'km' },
    { title: 'x', tier: 'gold', condition_type: 'tag' },
    { title: 'x', tier: 'gold', condition_type: 'tag', tag: '남산', target: 2 },
    { title: 'x', tier: 'gold', condition_type: 'streak', target: 7, tag: '새벽' },
    { title: 'x', tier: 'gold', condition_type: 'count', target: 3, condition: { type: 'count' } },
    { title: 'x'.repeat(41), tier: 'gold', condition_type: 'count', target: 3 },
  ]) assert.throws(() => toAchievementCandidate(def(payload)), undefined, JSON.stringify(payload));
});

test('propose_achievement stores a pending definition; the card approves with the owner\'s categories', async () => {
  const { putDestinationRefs } = await import('../src/server/store.js');
  const { needsAppReview } = await import('../src/mcp/tools.js');
  const db = new TestD1();
  try {
    const claude = { ...ctx(db, ['hub:propose', 'hub:approve']), source: 'claude', appUrls: {} };
    const r = await callTool('propose_achievement', { title: '한강 100km', category: '러닝', tier: 'gold', condition_type: 'total', target: 100, unit: 'km' }, claude);
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.card.label, '새 업적');
    assert.equal(r.structuredContent.card.approve, 'ok');
    const ticket = r._meta['life-hub/card'].ticket;
    const id = r.structuredContent.candidate_id;
    // No shared categories yet: approval is kept for a last check in the app.
    const noRefs = await callTool('card_refresh', { candidate_id: id, ticket }, claude);
    assert.deepEqual(noRefs.structuredContent.card.refs, { categories: [] });

    await putDestinationRefs(db, 'demo-owner', 'achievement', 'categories', 1,
      [{ id: 'cat-fitness', label: '피트니스', group: '피트니스' }, { id: 'cat-running', label: '러닝', group: '피트니스' }], '2026-11-02T03:00:00.000Z');
    const approved = await callTool('card_approve', { candidate_id: id, ticket, revision: 0 }, claude);
    assert.equal(approved.structuredContent.card.status, 'approved');
    assert.equal(approved.structuredContent.card.needs_app_review, false);

    const refs = { categories: [{ id: 'a', label: '러닝', group: '피트니스' }, { id: 'b', label: '기타', group: '생활' }, { id: 'c', label: '기타', group: '취미' }] };
    assert.equal(needsAppReview('achievement', 'activity_record', { category: '러닝', date: '2026-11-02' }, refs), false);
    assert.equal(needsAppReview('achievement', 'activity_record', { category: '달리기', date: '2026-11-02' }, refs), true);
    assert.equal(needsAppReview('achievement', 'activity_record', { category: '기타', date: '2026-11-02' }, refs), true, 'two categories share the name');
    assert.equal(needsAppReview('achievement', 'achievement_definition', { title: 't', tier: 'gold', condition_type: 'count', target: 3 }, refs), false, 'no category = every record');
    assert.equal(needsAppReview('achievement', 'achievement_definition', { title: 't', category: '달리기', tier: 'gold', condition_type: 'count', target: 3 }, refs), true);

    // ChatGPT gets the same tool, no card.
    const gpt = await callTool('propose_achievement', { title: '기록 100번', tier: 'platinum', condition_type: 'count', target: 100 }, { ...ctx(db), source: 'chatgpt' });
    assert.equal(gpt.structuredContent.card, undefined);
    const bad = await callTool('propose_achievement', { title: 'x', tier: 'gold', condition_type: 'total', target: 100 }, claude);
    assert.equal(bad.isError, true);
  } finally { db.close(); }
});
