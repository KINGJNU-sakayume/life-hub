import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toKyeokyeoiCandidate } from '../src/adapters/kyeokyeoi.js';
import { toDestinationCandidate } from '../src/adapters/index.js';
import { callTool } from '../src/mcp/tools.js';

const hub = (candidate_type, payload, extra = {}) => ({
  hub_version: 1, destination: 'kyeokyeoi', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'c'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type, payload, ...extra,
});
const ctx = (db, scopes = ['food:propose', 'kyeokyeoi:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T02:00:00Z'), scopes });

test('kyeokyeoi adapter accepts the user\'s words and stated dates only', () => {
  const memory = toKyeokyeoiCandidate(hub('memory', { title: '바다 수학여행', memo: '친구들이랑 밤새 얘기함', time_text: '고2 가을',
    place_text: '부산 해운대', emotions: ['설렘', '행복'] }));
  assert.equal(memory.schema_version, 1);
  assert.equal(memory.candidate_type, 'memory');
  assert.ok(toKyeokyeoiCandidate(hub('memory', { title: 'x', year: 2019, month: 8, day: 15 })));
  const concert = toKyeokyeoiCandidate(hub('memory', { title: '더 위켄드 콘서트', time_text: '10월 8일', year: 2026, month: 10, day: 8,
    place_text: '고양종합운동장', region_hint: '경기 고양시 일산서구', song_artist: 'The Weeknd' }));
  assert.equal(concert.payload.region_hint, '경기 고양시 일산서구');
  assert.equal(concert.payload.song_artist, 'The Weeknd');
  assert.ok(toKyeokyeoiCandidate(hub('visit', { place_text: '고양종합운동장', region_hint: '경기 고양시 일산서구', visited_on: '2026-10-08' })));
  assert.ok(toKyeokyeoiCandidate(hub('visit', { place_text: '전주시', visited_on: '2026-10-03' })));
  assert.equal(toDestinationCandidate(hub('visit', { place_text: '전주시' })).payload.place_text, '전주시');

  for (const [type, payload] of [
    ['memory', {}],
    ['memory', { title: 'x'.repeat(81) }],
    ['memory', { title: 'x', month: 3 }],
    ['memory', { title: 'x', year: 2020, day: 3 }],
    ['memory', { title: 'x', year: 2023, month: 2, day: 30 }],
    ['memory', { title: 'x', year: 1800 }],
    ['memory', { title: 'x', emotions: ['기쁨'] }],
    ['memory', { title: 'x', emotions: ['행복', '행복'] }],
    ['memory', { title: 'x', region_code: '11010' }],
    ['memory', { title: 'x', photos: ['data:...'] }],
    ['memory', { title: 'x', region_hint: 'x'.repeat(61) }],
    ['memory', { title: 'x', song_artist: '' }],
    ['visit', { place_text: 'x', song_artist: 'y' }],
    ['visit', { place_text: '' }],
    ['visit', { place_text: '서울', visited_on: '2026-13-01' }],
    ['visit', { place_text: '서울', memory: 'smuggled' }],
    ['meal', { menu_name: 'x' }],
  ]) assert.throws(() => toKyeokyeoiCandidate(hub(type, payload)), undefined, JSON.stringify([type, payload]));
  assert.throws(() => toDestinationCandidate({ ...hub('visit', { place_text: 'x' }), destination: 'diary' }));
});

test('propose_memory and propose_region_visit store pending kyeokyeoi candidates', async () => {
  const db = new TestD1();
  try {
    const memory = await callTool('propose_memory', { title: '첫 자취방', memo: '창문이 작았지만 좋았다', time_text: '스무 살 봄',
      place_text: '서울 관악구', emotions: ['설렘'] }, ctx(db));
    assert.equal(memory.isError, undefined, JSON.stringify(memory));
    assert.match(memory.content[0].text, /켜켜이/);
    const concert = await callTool('propose_memory', { title: '더 위켄드 콘서트', time_text: '10월 8일', year: 2026, month: 10, day: 8,
      place_text: '고양종합운동장', region_hint: '경기 고양시 일산서구', song_artist: 'The Weeknd' }, ctx(db));
    assert.equal(concert.isError, undefined, JSON.stringify(concert));
    const stored = JSON.parse((await db.prepare('SELECT envelope_json FROM inbox WHERE id=?').bind(concert.structuredContent.candidate_id).first()).envelope_json);
    assert.deepEqual(stored.payload, { title: '더 위켄드 콘서트', time_text: '10월 8일', year: 2026, month: 10, day: 8,
      place_text: '고양종합운동장', region_hint: '경기 고양시 일산서구', song_artist: 'The Weeknd' });
    const visit = await callTool('propose_region_visit', { place_text: '강릉', visited_on: '2026-10-12' }, ctx(db));
    assert.equal(visit.structuredContent.status, 'pending');

    const rows = (await db.prepare('SELECT destination, source, envelope_json FROM inbox ORDER BY received_at').bind().all()).results;
    assert.deepEqual(rows.map((r) => r.destination), ['kyeokyeoi', 'kyeokyeoi', 'kyeokyeoi']);
    assert.deepEqual(rows.map((r) => JSON.parse(r.envelope_json).candidate_type).sort(), ['memory', 'memory', 'visit']);
    // A memory with a place does not create a visit.
    assert.equal(rows.filter((r) => JSON.parse(r.envelope_json).candidate_type === 'visit').length, 1);

    const again = await callTool('propose_region_visit', { visited_on: '2026-10-12', place_text: ' 강릉 ' }, ctx(db));
    assert.equal(again.structuredContent.duplicate, true);
    const status = await callTool('get_proposal_status', { candidate_id: memory.structuredContent.candidate_id }, ctx(db));
    assert.equal(status.structuredContent.destination, 'kyeokyeoi');
    // The previous tool name keeps working for clients with a cached tool list.
    const legacy = await callTool('get_food_candidate_status', { candidate_id: visit.structuredContent.candidate_id }, ctx(db));
    assert.equal(legacy.structuredContent.status, 'pending');
  } finally { db.close(); }
});

test('invalid memory/visit input is a fixable tool error and nothing is stored', async () => {
  const db = new TestD1();
  try {
    for (const [name, args] of [
      ['propose_memory', { title: 'x', month: 4 }],
      ['propose_memory', { title: 'x', year: '2020' }],
      ['propose_memory', { title: 'x', emotions: '행복' }],
      ['propose_memory', { title: 'x', emotions: ['분노'] }],
      ['propose_memory', { title: 'x', region_code: '11' }],
      ['propose_region_visit', { place_text: '서울', visited_on: 'yesterday' }],
      ['propose_region_visit', {}],
    ]) {
      const result = await callTool(name, args, ctx(db));
      assert.equal(result.isError, true, JSON.stringify([name, args]));
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 0);
  } finally { db.close(); }
});

test('a connection authorized before 켜켜이 existed is asked to reconnect, food still works', async () => {
  const db = new TestD1();
  try {
    const old = ctx(db, ['food:propose']);
    const memory = await callTool('propose_memory', { title: 'x' }, old);
    assert.equal(memory.isError, true);
    assert.match(memory.content[0].text, /reconnect/);
    const meal = await callTool('propose_food_meal', { menu_name: 'Synthetic soup' }, old);
    assert.equal(meal.isError, undefined);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE destination='kyeokyeoi'").bind().first()).n, 0);
  } finally { db.close(); }
});

test('migration 0004 keeps existing candidates and history, then accepts kyeokyeoi', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_inbox.sql', '0002_owner_login.sql', '0003_destination_receipts.sql']) db.exec(readFileSync(new URL(f, dir), 'utf8'));
    db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('a','o','food','claude','key-00000001','m','{}','2026-11-02T00:00:00Z')`);
    db.exec(`UPDATE inbox SET status='confirmed', confirmed_entity_id='e1', reviewed_at='2026-11-02T01:00:00Z' WHERE id='a'`);
    assert.throws(() => db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('x','o','kyeokyeoi','claude','key-00000009','m','{}','t')`), /CHECK/);
    const history = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all();

    db.exec('BEGIN');
    db.exec(readFileSync(new URL('0004_multi_destination.sql', dir), 'utf8'));
    db.exec('COMMIT');

    assert.deepEqual({ ...db.prepare('SELECT status, confirmed_entity_id FROM inbox WHERE id=?').get('a') }, { status: 'confirmed', confirmed_entity_id: 'e1' });
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all().map((r) => ({ ...r })), history.map((r) => ({ ...r })));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('b','o','kyeokyeoi','claude','key-00000002','m','{}','t')`);
    const seqs = db.prepare("SELECT seq FROM inbox_changes WHERE candidate_id='b'").all().map((r) => r.seq);
    assert.ok(seqs[0] > Math.max(...history.map((r) => r.seq)), 'sequence numbers keep increasing');
    assert.throws(() => db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('c','o','diary','claude','key-00000003','m','{}','t')`), /CHECK/);
    assert.throws(() => db.exec("DELETE FROM inbox WHERE id='a'"), /FOREIGN KEY/);
  } finally { db.close(); }
});
