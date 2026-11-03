import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toPotcastCandidate } from '../src/adapters/potcast.js';
import { callTool } from '../src/mcp/tools.js';

const ID = (c) => c.repeat(22);
const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'potcast', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'p'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'album_listening', payload, ...extra,
});
const ctx = (db, scopes = ['hub:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes });

test('album_listening accepts a whole album from conversation or per-track results from history', () => {
  assert.ok(toPotcastCandidate(hub({ artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation', whole_album: true, listened_on: '2026-11-02' })));
  const history = toPotcastCandidate(hub({ artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'spotify_history',
    tracks: [{ spotify_track_id: ID('a'), title: 'One', status: 'listened', played_at: '2026-10-01T10:00:00Z' },
      { spotify_track_id: ID('b'), status: 'skipped', played_at: '2026-10-01T10:03:00Z' }] }));
  assert.equal(history.payload.tracks.length, 2);
  for (const payload of [
    { artist: 'x', album: 'y', origin: 'conversation' },
    { artist: 'x', album: 'y', origin: 'conversation', whole_album: true, tracks: [{ title: 'a', status: 'listened' }] },
    { artist: 'x', album: 'y', origin: 'spotify_history', whole_album: true },
    { artist: 'x', album: 'y', origin: 'radio', whole_album: true },
    { artist: 'x', album: 'y', origin: 'conversation', whole_album: false },
    { artist: 'x', album: 'y', origin: 'conversation', tracks: [] },
    { artist: 'x', album: 'y', origin: 'conversation', tracks: [{ status: 'listened' }] },
    { artist: 'x', album: 'y', origin: 'conversation', tracks: [{ title: 'a', status: 'loved' }] },
    { artist: 'x', album: 'y', origin: 'spotify_history', tracks: [{ spotify_track_id: 'short', status: 'listened' }] },
    { artist: 'x', album: 'y', origin: 'spotify_history', tracks: [{ spotify_track_id: ID('a'), status: 'listened' }, { spotify_track_id: ID('a'), status: 'skipped' }] },
    { artist: 'x', album: 'y', origin: 'spotify_history', tracks: [{ title: 'a', status: 'listened', ip_addr: '1.2.3.4' }] },
    { artist: 'x', album: 'y', origin: 'spotify_history', tracks: Array.from({ length: 81 }, (_, i) => ({ title: 't' + i, status: 'listened' })) },
    { artist: 'x', album: 'y', origin: 'conversation', whole_album: true, ms_played: 1 },
  ]) assert.throws(() => toPotcastCandidate(hub(payload)), undefined, JSON.stringify(payload).slice(0, 120));
  assert.throws(() => toPotcastCandidate(hub({ artist: 'x', album: 'y', origin: 'conversation', whole_album: true }, { candidate_type: 'track' })));
});

test('propose_album_listening stores a pending potcast candidate; hub:propose covers it, old grants are asked to reconnect', async () => {
  const db = new TestD1();
  try {
    const args = { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'spotify_history',
      tracks: [{ spotify_track_id: ID('a'), title: 'One', status: 'listened', played_at: '2026-10-01T10:00:00Z' }] };
    const ok = await callTool('propose_album_listening', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'potcast');
    assert.deepEqual(JSON.parse(row.envelope_json).payload, args);
    assert.equal((await callTool('propose_album_listening', args, ctx(db))).structuredContent.duplicate, true);

    const old = await callTool('propose_album_listening', args, ctx(db, ['food:propose', 'kyeokyeoi:propose']));
    assert.equal(old.isError, true);
    assert.match(old.content[0].text, /reconnect/);
    // hub:propose alone also covers the earlier destinations.
    assert.equal((await callTool('propose_food_meal', { menu_name: 'Synthetic soup' }, ctx(db))).isError, undefined);
    assert.equal((await callTool('propose_memory', { title: 'x' }, ctx(db))).isError, undefined);

    for (const bad of [{ ...args, tracks: [{ status: 'listened' }] }, { ...args, whole_album: 'yes' }, { ...args, tracks: 'all' }]) {
      const r = await callTool('propose_album_listening', bad, ctx(db));
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
  } finally { db.close(); }
});

test('migration 0005 opens destinations without losing data or history', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_inbox.sql', '0002_owner_login.sql', '0003_destination_receipts.sql', '0004_multi_destination.sql'])
      db.exec(readFileSync(new URL(f, dir), 'utf8'));
    db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('a','o','kyeokyeoi','claude','key-00000001','m','{}','t')`);
    db.exec(`UPDATE inbox SET status='rejected' WHERE id='a'`);
    assert.throws(() => db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('x','o','potcast','claude','key-00000009','m','{}','t')`), /CHECK/);
    const history = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all().map((r) => ({ ...r }));
    db.exec('BEGIN');
    db.exec(readFileSync(new URL('0005_open_destinations.sql', dir), 'utf8'));
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all().map((r) => ({ ...r })), history);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('b','o','potcast','claude','key-00000002','m','{}','t')`);
    assert.throws(() => db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('c','o','','claude','key-00000003','m','{}','t')`), /CHECK/);
    assert.throws(() => db.exec("DELETE FROM inbox WHERE id='a'"), /FOREIGN KEY/);
  } finally { db.close(); }
});

/* ---------- Cards stage 7: the potcast album card and review_listening ---------- */

test('review_listening shows one pending album as a card (Spotify-collected first), and the owner edits tracks there', async () => {
  const { insertCandidate } = await import('../src/server/store.js');
  const { needsAppReview } = await import('../src/mcp/tools.js');
  const ALBUM = 'A'.repeat(22);
  const sync = (key, at) => ({
    hub_version: 1, destination: 'potcast', source: 'spotify', source_ref: 'spotify-sync:2026-11-01', idempotency_key: key, created_at: at, candidate_type: 'album_listening',
    payload: { artist: 'Synthetic Artist', album: 'Imaginary Album', spotify_album_id: ALBUM, origin: 'spotify_sync', listened_on: '2026-11-01',
      tracks: [{ spotify_track_id: 'a'.repeat(22), title: 'First Song', status: 'listened', played_at: at }, { spotify_track_id: 'b'.repeat(22), title: 'Second Song', status: 'skipped', played_at: at }] },
  });
  const db = new TestD1();
  const claude = { ...ctx(db, ['hub:propose', 'hub:approve']), source: 'claude', appUrls: {} };
  try {
    const empty = await callTool('review_listening', {}, claude);
    assert.equal(empty.structuredContent.status, 'empty');
    assert.equal(empty._meta, undefined);

    await callTool('propose_album_listening', { artist: 'Synthetic Band', album: 'Talked About', origin: 'conversation', whole_album: true }, claude);
    const older = await insertCandidate(db, 'demo-owner', sync('spsync-' + ALBUM + '-1', '2026-11-01T01:00:00.000Z'), '2026-11-01T03:00:00.000Z');
    await insertCandidate(db, 'demo-owner', sync('spsync-' + ALBUM + '-2', '2026-11-01T05:00:00.000Z'), '2026-11-01T07:00:00.000Z');

    const r = await callTool('review_listening', {}, claude);
    assert.equal(r.structuredContent.candidate_id, older.id, 'Spotify-collected and oldest first');
    assert.equal(r.structuredContent.remaining, 2);
    assert.equal(r.structuredContent.card.label, '앨범 감상');
    assert.match(r.content[0].text, /Imaginary Album.*1 listened, 1 skipped/);
    const ticket = r._meta['life-hub/card'].ticket;
    assert.ok(!JSON.stringify(r.content).includes(ticket) && !JSON.stringify(r.structuredContent).includes(ticket));

    // The owner marks the skipped track as listened in the card, then approves.
    const payload = structuredClone(r.structuredContent.card.payload);
    payload.tracks[1].status = 'listened';
    const edited = await callTool('card_edit', { candidate_id: older.id, ticket, revision: 0, payload }, claude);
    assert.deepEqual(edited.structuredContent.card.payload.tracks.map((t) => t.status), ['listened', 'listened']);
    // An edit that breaks the contract (a spotify_sync track without its ID) changes nothing.
    const broken = structuredClone(payload); delete broken.tracks[0].spotify_track_id;
    const refused = await callTool('card_edit', { candidate_id: older.id, ticket, revision: 1, payload: broken }, claude);
    assert.equal(refused.isError, true);
    const approved = await callTool('card_approve', { candidate_id: older.id, ticket, revision: 1 }, claude);
    assert.equal(approved.structuredContent.card.status, 'approved');
    assert.equal(approved.structuredContent.card.needs_app_review, false);

    // The next call shows the next album; a named one can be shown directly.
    const next = await callTool('review_listening', {}, claude);
    assert.notEqual(next.structuredContent.candidate_id, older.id);
    assert.equal(next.structuredContent.remaining, 1);
    assert.equal((await callTool('review_listening', { candidate_id: older.id }, claude)).isError, true, 'decided albums are not shown');

    // ChatGPT gets the text, no card.
    const gpt = await callTool('review_listening', {}, { ...ctx(db), source: 'chatgpt' });
    assert.equal(gpt.structuredContent.card, undefined);
    assert.equal(gpt._meta, undefined);
  } finally { db.close(); }
  assert.equal(needsAppReview('potcast', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', whole_album: true }), true, 'nothing to find the album with');
  assert.equal(needsAppReview('potcast', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', tracks: [{ spotify_track_id: 'a'.repeat(22), status: 'listened' }] }), false);
  assert.equal(needsAppReview('potcast', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', whole_album: true, spotify_album_id: 'A'.repeat(22) }), false);
});
