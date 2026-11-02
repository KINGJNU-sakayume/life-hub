/**
 * 일기 룰렛 (Diaryroulette): daily_mission contract, the server-side draw from what the app shared, the
 * already-drawn case, one mission per diary day, and the inbox API. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { handleMcpRequest } from '../src/mcp/protocol.js';
import { handleInboxRequest } from '../src/inbox/api.js';
import { diaryDate, toDiaryrouletteCandidate } from '../src/adapters/diaryroulette.js';
import { putDestinationRefs } from '../src/server/store.js';

const ORIGIN = 'https://hub.example';
const NOW = Date.parse('2026-11-02T03:00:00Z'); // 12:00 KST
const APPROVE = ['hub:propose', 'hub:approve'];
const MISSIONS = [
  { id: 'lang-1', label: 'Synthetic mission A', group: '언어' },
  { id: 'view-1', label: 'Synthetic mission B', group: '시점' },
  { id: 'time-1', label: 'Synthetic mission C', group: '시간·분량' },
];
const ctx = (db, { source = 'claude', scopes = APPROVE, now = NOW } = {}) => ({
  db, ownerId: 'demo-owner', now: () => now, allowedOrigins: [ORIGIN], scopes, source,
  appUrls: { diaryroulette: 'https://apps.example/Diaryroulette/' },
});
let seq = 0;
async function call(db, name, args, options) {
  const response = await handleMcpRequest(new Request(ORIGIN + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
  }), ctx(db, options));
  return (await response.json()).result;
}
const share = (db, kind, items, revision = 1) => putDestinationRefs(db, 'demo-owner', 'diaryroulette', kind, revision, items, new Date(NOW).toISOString());
const envelope = (payload, type = 'daily_mission') => ({
  hub_version: 1, destination: 'diaryroulette', source: 'claude', source_ref: 'claude-mcp:2026-11-02', idempotency_key: 'mcp-' + 'd'.repeat(40),
  created_at: new Date(NOW).toISOString(), candidate_type: type, payload,
});

test('contract: only a diary date and a mission id', () => {
  assert.equal(toDiaryrouletteCandidate(envelope({ date: '2026-11-02', mission_id: 'lang-1' })).payload.mission_id, 'lang-1');
  for (const payload of [
    { date: '2026-11-02' }, { mission_id: 'lang-1' }, { date: '2026-02-30', mission_id: 'lang-1' },
    { date: '2026-11-02', mission_id: 'Lang 1!' }, { date: '2026-11-02', mission_id: 'lang-1', text: 'diary' },
  ]) assert.throws(() => toDiaryrouletteCandidate(envelope(payload)));
  assert.throws(() => toDiaryrouletteCandidate(envelope({ date: '2026-11-02', mission_id: 'lang-1' }, 'diary_entry')));
});

test('diary day is KST, and before 02:00 still counts as the previous day', () => {
  assert.equal(diaryDate(Date.parse('2026-11-02T03:00:00Z')), '2026-11-02'); // 12:00 KST
  assert.equal(diaryDate(Date.parse('2026-11-02T16:59:00Z')), '2026-11-02'); // 01:59 KST on the 3rd
  assert.equal(diaryDate(Date.parse('2026-11-02T17:00:00Z')), '2026-11-03'); // 02:00 KST on the 3rd
  assert.equal(diaryDate(Date.parse('2026-11-01T15:30:00Z')), '2026-11-01'); // 00:30 KST on the 2nd
});

test('no shared mission list: nothing is drawn or stored', async () => {
  const db = new TestD1();
  try {
    const r = await call(db, 'propose_daily_mission', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /has not shared its missions/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 0);
    // The model cannot pass a mission.
    await share(db, 'missions', MISSIONS);
    const forced = await call(db, 'propose_daily_mission', { mission_id: 'lang-1' });
    assert.equal(forced.isError, true);
  } finally { db.close(); }
});

test('the draw skips resting missions, keeps one mission per day, and only the card gets a ticket', async () => {
  const db = new TestD1();
  try {
    await share(db, 'missions', MISSIONS);
    await share(db, 'state', [{ id: 'lang-1', label: 'Synthetic mission A', group: 'resting' }, { id: 'view-1', label: 'Synthetic mission B', group: 'resting' }]);
    const first = await call(db, 'propose_daily_mission', {});
    assert.equal(first.structuredContent.mission_id, 'time-1', 'the only mission not resting');
    assert.equal(first.structuredContent.date, '2026-11-02');
    assert.equal(first.structuredContent.card.status, 'pending');
    assert.equal(first.structuredContent.card.approve, 'ok');
    assert.deepEqual(first.structuredContent.card.mission, MISSIONS[2]);
    assert.equal(first.structuredContent.card.refs, undefined, 'the list goes only to card_* results');
    const ticket = first._meta['life-hub/card'].ticket;
    assert.ok(!JSON.stringify(first.content).includes(ticket));
    assert.match(first.content[0].text, /Synthetic mission C/);

    // Asking again the same day: the same candidate and mission, even if the cooldown list changed meanwhile.
    await share(db, 'state', [], 2);
    const again = await call(db, 'propose_daily_mission', {});
    assert.equal(again.structuredContent.candidate_id, first.structuredContent.candidate_id);
    assert.equal(again.structuredContent.mission_id, 'time-1');
    assert.equal(again.structuredContent.duplicate, true);

    const refreshed = await call(db, 'card_refresh', { candidate_id: first.structuredContent.candidate_id, ticket });
    assert.deepEqual(refreshed.structuredContent.card.refs.missions, MISSIONS);
    const approved = await call(db, 'card_approve', { candidate_id: first.structuredContent.candidate_id, ticket, revision: 0 });
    assert.equal(approved.structuredContent.card.status, 'approved');
    assert.equal(approved.structuredContent.card.needs_app_review, false);

    // The next diary day draws anew (all resting → falls back to the whole list; the app re-checks).
    await share(db, 'state', MISSIONS.map((m) => ({ ...m, group: 'resting' })), 3);
    const tomorrow = await call(db, 'propose_daily_mission', {}, { now: NOW + 86_400_000 });
    assert.notEqual(tomorrow.structuredContent.candidate_id, first.structuredContent.candidate_id);
    assert.equal(tomorrow.structuredContent.date, '2026-11-03');
    assert.ok(MISSIONS.some((m) => m.id === tomorrow.structuredContent.mission_id));
  } finally { db.close(); }
});

test('a mission the app already drew today is shown as is, with nothing drawn or stored', async () => {
  const db = new TestD1();
  try {
    await share(db, 'missions', MISSIONS);
    await share(db, 'state', [{ id: 'view-1', label: 'Synthetic mission B', group: 'today:2026-11-02' }]);
    const r = await call(db, 'propose_daily_mission', {});
    assert.equal(r.structuredContent.status, 'drawn');
    assert.equal(r.structuredContent.card.status, 'drawn');
    assert.equal(r.structuredContent.card.candidate_id, null);
    assert.deepEqual(r.structuredContent.card.mission, MISSIONS[1]);
    assert.equal(r._meta?.['life-hub/card'], undefined);
    assert.match(r.content[0].text, /already drawn in the app/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 0);
    // Yesterday's "today" does not count.
    const next = await call(db, 'propose_daily_mission', {}, { now: NOW + 86_400_000 });
    assert.equal(next.structuredContent.card.status, 'pending');
  } finally { db.close(); }
});

test('ChatGPT and Codex can ask too: text result, no card, approval in the app', async () => {
  const db = new TestD1();
  try {
    await share(db, 'missions', MISSIONS);
    for (const source of ['chatgpt', 'codex']) {
      const r = await call(db, 'propose_daily_mission', {}, { source, scopes: ['hub:propose'] });
      assert.equal(r.structuredContent.card, undefined, source);
      assert.equal(r._meta?.['life-hub/card'], undefined, source);
      assert.match(r.content[0].text, /drew today's 일기 룰렛 mission/);
    }
  } finally { db.close(); }
});

test('inbox API: the app reads open missions, sends a receipt, and shares both reference lists', async () => {
  const db = new TestD1();
  const api = async (method, path, body) => {
    const response = await handleInboxRequest(new Request(ORIGIN + path, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }), { db, ownerId: 'demo-owner', now: () => NOW, destination: 'diaryroulette', prefix: '/diaryroulette/v1' });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await api('PUT', '/diaryroulette/v1/refs/missions', { revision: 1, items: MISSIONS })).status, 200);
    assert.equal((await api('PUT', '/diaryroulette/v1/refs/state', { revision: Date.parse('2026-11-02T03:00:00Z'), items: [{ id: 'lang-1', label: 'Synthetic mission A', group: 'resting' }] })).status, 200);
    assert.equal((await api('PUT', '/diaryroulette/v1/refs/diary', { revision: 1, items: [] })).status, 404, 'only declared kinds');
    const proposed = await call(db, 'propose_daily_mission', {});
    const open = await api('GET', '/diaryroulette/v1/candidates?status=open');
    assert.equal(open.body.candidates.length, 1);
    const item = open.body.candidates[0];
    assert.deepEqual(Object.keys(item.candidate.payload).sort(), ['date', 'mission_id']);
    assert.equal(item.candidate.payload.mission_id, proposed.structuredContent.mission_id);
    const receipt = await api('POST', '/diaryroulette/v1/receipts', { key: item.key, entity_type: 'daily_mission', entity_id: '2026-11-02' });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.candidate.status, 'confirmed');
  } finally { db.close(); }
});
