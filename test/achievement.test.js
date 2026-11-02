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
  assert.deepEqual(DESTINATIONS.map((d) => d.id), ['food', 'kyeokyeoi', 'potcast', 'achievement', 'letterbookxd', 'sub']);
  assert.ok(ALL_SCOPES.includes('achievement:inbox') && ALL_SCOPES.includes('hub:propose') && ALL_SCOPES.includes('food:propose'));
  const off = clientProfiles({});
  assert.deepEqual(off.map((p) => p.id), ['claude']);
  const on = clientProfiles({ HUB_ACHIEVEMENT_REDIRECT_URI: 'https://owner.github.io/achievement/lifehub/', HUB_PALATE_REDIRECT_URI: 'https://owner.github.io/food/' });
  assert.deepEqual(on.map((p) => [p.id, p.resourcePath, p.scopes.join()]), [
    ['claude', '/mcp', 'hub:propose'], ['palate', '/palate', 'food:inbox'], ['achievement', '/achievement', 'achievement:inbox'],
  ]);
  assert.deepEqual(clientProfiles({ HUB_ACHIEVEMENT_REDIRECT_URI: 'http://insecure.example/' }).map((p) => p.id), ['claude']);
});
