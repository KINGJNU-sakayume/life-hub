import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { toMusicCandidate } from '../src/adapters/music.js';
import { callTool } from '../src/mcp/tools.js';

const ID = (c) => c.repeat(22);
const hub = (payload, extra = {}) => ({
  hub_version: 1, destination: 'music', source: 'claude', source_ref: 'claude-mcp:2026-11-02',
  idempotency_key: 'mcp-' + 'p'.repeat(40), created_at: '2026-11-02T01:00:00.000Z', candidate_type: 'album_listening', payload, ...extra,
});
const ctx = (db, scopes = ['hub:propose']) => ({ db, ownerId: 'demo-owner', now: () => Date.parse('2026-11-02T03:00:00Z'), scopes });

test('album_listening accepts a whole album from conversation or per-track results from history', () => {
  assert.ok(toMusicCandidate(hub({ artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation', whole_album: true, listened_on: '2026-11-02' })));
  const history = toMusicCandidate(hub({ artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'spotify_history',
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
  ]) assert.throws(() => toMusicCandidate(hub(payload)), undefined, JSON.stringify(payload).slice(0, 120));
  assert.throws(() => toMusicCandidate(hub({ artist: 'x', album: 'y', origin: 'conversation', whole_album: true }, { candidate_type: 'track' })));
});

test('propose_album_listening proposes only listened tracks: a skipped one is left out, nothing listened is refused', async () => {
  const db = new TestD1();
  try {
    const mixed = { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation',
      tracks: [{ spotify_track_id: ID('a'), title: 'One', status: 'listened' }, { spotify_track_id: ID('b'), title: 'Two', status: 'skipped' }] };
    const ok = await callTool('propose_album_listening', mixed, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    const row = await db.prepare('SELECT envelope_json FROM inbox').bind().first();
    assert.deepEqual(JSON.parse(row.envelope_json).payload.tracks, [{ spotify_track_id: ID('a'), title: 'One', status: 'listened' }]);
    const none = await callTool('propose_album_listening', { ...mixed, album: 'Other', tracks: [{ title: 'Two', status: 'skipped' }] }, ctx(db));
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /listened/);
  } finally { db.close(); }
});

test('propose_album_listening stores a pending music candidate; hub:propose covers it, old grants are asked to reconnect', async () => {
  const db = new TestD1();
  try {
    const args = { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'spotify_history',
      tracks: [{ spotify_track_id: ID('a'), title: 'One', status: 'listened', played_at: '2026-10-01T10:00:00Z' }] };
    const ok = await callTool('propose_album_listening', args, ctx(db));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    const row = await db.prepare('SELECT destination, envelope_json FROM inbox').bind().first();
    assert.equal(row.destination, 'music');
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
      VALUES ('x','o','music','claude','key-00000009','m','{}','t')`), /CHECK/);
    const history = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all().map((r) => ({ ...r }));
    db.exec('BEGIN');
    db.exec(readFileSync(new URL('0005_open_destinations.sql', dir), 'utf8'));
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all().map((r) => ({ ...r })), history);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('b','o','music','claude','key-00000002','m','{}','t')`);
    assert.throws(() => db.exec(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,received_at)
      VALUES ('c','o','','claude','key-00000003','m','{}','t')`), /CHECK/);
    assert.throws(() => db.exec("DELETE FROM inbox WHERE id='a'"), /FOREIGN KEY/);
  } finally { db.close(); }
});

/* ---------- Cards stage 7: the music album card and review_listening ---------- */

test('review_listening shows one pending album as a card (Spotify-collected first), and the owner edits tracks there', async () => {
  const { insertCandidate } = await import('../src/server/store.js');
  const { needsAppReview } = await import('../src/mcp/tools.js');
  const ALBUM = 'A'.repeat(22);
  const sync = (key, at) => ({
    hub_version: 1, destination: 'music', source: 'spotify', source_ref: 'spotify-sync:2026-11-01', idempotency_key: key, created_at: at, candidate_type: 'album_listening',
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
    assert.match(r.content[0].text, /Imaginary Album.*1 track\(s\) listened/);
    const ticket = r._meta['life-hub/card'].ticket;
    assert.ok(!JSON.stringify(r.content).includes(ticket) && !JSON.stringify(r.structuredContent).includes(ticket));

    // This stored proposal still carries a legacy "skipped" track; it stays readable and the owner can turn it into a listened one.
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
  assert.equal(needsAppReview('music', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', whole_album: true }), true, 'nothing to find the album with');
  assert.equal(needsAppReview('music', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', tracks: [{ spotify_track_id: 'a'.repeat(22), status: 'listened' }] }), false);
  assert.equal(needsAppReview('music', 'album_listening', { artist: 'x', album: 'y', origin: 'conversation', whole_album: true, spotify_album_id: 'A'.repeat(22) }), false);
});

/* ---------- Rename potcast → music (2026-11-19): aliases kept during the rollout, removable later ---------- */

test('the music handler accepts the old potcast role and scopes, and nothing broader', async () => {
  const { inboxHandlers } = await import('../src/server/index.js');
  const db = new TestD1();
  const env = { DB: db, HUB_OWNER_ID: 'demo-owner' };
  const owner = 'demo-owner';
  const req = (path, method = 'GET') => new Request('https://hub.example' + path, { method });
  const ctxWith = (role, scope) => ({ props: { ownerId: owner, role }, auth: { token: 't', audience: 'https://hub.example/music', scope } });
  const status = async (path, role, scope, method) => (await inboxHandlers.music.fetch(req(path, method), env, ctxWith(role, scope))).status;
  try {
    for (const path of ['/music/v1/candidates', '/potcast/v1/candidates']) {
      assert.equal(await status(path, 'music', ['music:inbox']), 200, path);
      assert.equal(await status(path, 'potcast', ['potcast:inbox']), 200, path + ' old grant');
      assert.equal(await status(path, 'music', ['potcast:inbox']), 200, path + ' old scope, new role');
      assert.equal(await status(path, 'palate', ['music:inbox']), 403, path + ' another app');
      assert.equal(await status(path, 'claude', ['hub:propose', 'potcast:inbox']), 403, path + ' an MCP client');
      assert.equal(await status(path, 'music', ['food:inbox']), 403, path + ' wrong scope');
    }
    // Board tiles need the board scope in either spelling; the inbox scope alone is a step-up.
    for (const path of ['/music/v1/board', '/potcast/v1/board']) {
      assert.equal(await status(path, 'potcast', ['potcast:inbox']), 403, path);
      assert.equal(await status(path, 'potcast', ['potcast:inbox', 'potcast:board']), 404, path + ' (no manifest yet)');
      assert.equal(await status(path, 'music', ['music:inbox', 'music:board']), 404, path + ' (no manifest yet)');
    }
    const { ALL_SCOPES } = await import('../src/auth/clients.js');
    for (const s of ['music:inbox', 'music:board', 'potcast:inbox', 'potcast:board']) assert.ok(ALL_SCOPES.includes(s), s);
  } finally { db.close(); }
});

test('rows stored as potcast (before migration 0012) are read as music and de-duplicate new proposals', async () => {
  const { insertCandidate, listDestinationCandidates, findCandidateByKey } = await import('../src/server/store.js');
  const { candidateMeaning } = await import('../src/core/candidates.js');
  const db = new TestD1();
  try {
    const legacy = hub({ artist: 'Synthetic Artist', album: 'Old Album', origin: 'conversation', whole_album: true }, { destination: 'potcast' });
    db.prepare(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`).bind('11111111-1111-4111-8111-111111111111', 'demo-owner', 'potcast', 'claude',
      legacy.idempotency_key, candidateMeaning(legacy), JSON.stringify(legacy), '2026-11-02T01:00:00Z').run();
    const [row] = await listDestinationCandidates(db, 'demo-owner', 'music', 'pending', 10);
    assert.equal(row.destination, 'music');
    assert.equal(row.candidate.destination, 'music');
    assert.ok(toMusicCandidate(row.candidate));
    assert.ok(await findCandidateByKey(db, 'demo-owner', 'music', 'claude', legacy.idempotency_key));
    // The same proposal sent again (new or old spelling) is the stored record, not a second one.
    for (const destination of ['music', 'potcast']) {
      const again = await insertCandidate(db, 'demo-owner', { ...legacy, destination }, '2026-11-02T02:00:00Z');
      assert.equal(again.duplicate, true, destination);
      assert.equal(again.id, '11111111-1111-4111-8111-111111111111');
    }
    // A different payload under the same key is still a conflict.
    await assert.rejects(insertCandidate(db, 'demo-owner', { ...legacy, payload: { ...legacy.payload, album: 'Else' } }, '2026-11-02T02:00:00Z'), /Conflicting/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 1);
    // New proposals are stored as music.
    await insertCandidate(db, 'demo-owner', hub({ artist: 'x', album: 'New', origin: 'conversation', whole_album: true }, { idempotency_key: 'mcp-' + 'n'.repeat(40) }), '2026-11-02T03:00:00Z');
    assert.deepEqual((await db.prepare('SELECT destination FROM inbox ORDER BY received_at').bind().all()).results.map((r) => r.destination), ['potcast', 'music']);
  } finally { db.close(); }
});

test('album proposal keys keep hashing the old name, so a retry across the rename is the same proposal', async () => {
  const db = new TestD1();
  try {
    const args = { artist: 'Synthetic Artist', album: 'Synthetic Album', origin: 'conversation', whole_album: true };
    const r = await callTool('propose_album_listening', args, { ...ctx(db), source: 'claude' });
    const { canonical } = await import('../src/core/candidates.js');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['claude', 'potcast', 'album_listening', canonical(args)])));
    const expected = 'mcp-' + [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
    const row = await db.prepare('SELECT destination, idempotency_key FROM inbox').bind().first();
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual([row.destination, row.idempotency_key], ['music', expected]);
  } finally { db.close(); }
});

test('the album card is music now; its old URI still reads the same card', async () => {
  const { cardFor, CARD_RESOURCES, readCardResource } = await import('../src/mcp/cards/index.js');
  assert.equal(cardFor('music').uri, 'ui://life-hub/card-music.html');
  assert.equal(cardFor('potcast'), cardFor('music'));
  assert.ok(!CARD_RESOURCES.some((c) => c.uri.includes('potcast')), 'only the new URI is listed');
  assert.equal(readCardResource('ui://life-hub/card-potcast.html').text, readCardResource('ui://life-hub/card-music.html').text);
});

test('migration 0012 moves potcast rows, meaning, envelopes and board manifests to music without losing history', async () => {
  const { readdirSync } = await import('node:fs');
  const { candidateMeaning } = await import('../src/core/candidates.js');
  const dir = new URL('../migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  try {
    const prior = readdirSync(dir).filter((f) => /^00(0\d|1[01])_.*\.sql$/.test(f)).sort();
    db.exec('PRAGMA foreign_keys = ON;' + prior.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n'));
    const insert = db.prepare(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`);
    const a = hub({ artist: 'Synthetic Artist', album: 'A', origin: 'conversation', whole_album: true }, { destination: 'potcast', idempotency_key: 'mcp-' + 'a'.repeat(40) });
    const b = hub({ artist: 'Synthetic Artist', album: 'B', origin: 'conversation', whole_album: true }, { destination: 'potcast', idempotency_key: 'mcp-' + 'b'.repeat(40) });
    const dup = { ...b, destination: 'music' };
    insert.run('a', 'demo-owner', 'potcast', 'claude', a.idempotency_key, candidateMeaning(a), JSON.stringify(a), '2026-11-01T00:00:00Z');
    insert.run('b', 'demo-owner', 'potcast', 'claude', b.idempotency_key, candidateMeaning(b), JSON.stringify(b), '2026-11-01T01:00:00Z');
    // Already stored under music too (same key): the potcast row is left as it is, nothing is lost.
    insert.run('c', 'demo-owner', 'music', 'claude', dup.idempotency_key, candidateMeaning(dup), JSON.stringify(dup), '2026-11-01T02:00:00Z');
    db.prepare("UPDATE inbox SET status='confirmed', reviewed_at='2026-11-02T00:00:00Z', confirmed_entity_id='x' WHERE id='a'").run();
    db.prepare(`INSERT INTO board_manifests (owner_id,app,generated_at,received_at,body_json,size_bytes,sha256) VALUES (?,?,?,?,?,?,?)`)
      .run('demo-owner', 'potcast', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00Z', '{"app":"potcast"}', 17, 'f'.repeat(64));
    const events = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all();

    db.exec(readFileSync(new URL('0012_music_rename.sql', dir), 'utf8'));
    const rows = Object.fromEntries(db.prepare('SELECT * FROM inbox').all().map((r) => [r.id, r]));
    assert.equal(rows.a.destination, 'music');
    assert.equal(rows.a.meaning, candidateMeaning({ ...a, destination: 'music' }));
    assert.equal(JSON.parse(rows.a.envelope_json).destination, 'music');
    assert.deepEqual(JSON.parse(rows.a.envelope_json), { ...a, destination: 'music' });
    assert.deepEqual([rows.a.status, rows.a.confirmed_entity_id], ['confirmed', 'x']);
    assert.equal(rows.b.destination, 'potcast', 'a key already stored as music is left alone');
    assert.equal(rows.c.destination, 'music');
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all(), events, 'no new events');
    assert.deepEqual(db.prepare('SELECT app FROM board_manifests').all().map((r) => r.app), ['music']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('the Hub inbox tile counts pending rows stored as potcast under music', async () => {
  const { handleBoardRequest } = await import('../src/board/api.js');
  const { candidateMeaning } = await import('../src/core/candidates.js');
  const db = new TestD1();
  try {
    const legacy = hub({ artist: 'x', album: 'Old', origin: 'conversation', whole_album: true }, { destination: 'potcast', idempotency_key: 'mcp-' + 'o'.repeat(40) });
    db.prepare(`INSERT INTO inbox (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at)
      VALUES ('l','demo-owner','potcast','claude',?,?,?,'pending','2026-11-02T01:00:00Z')`).bind(legacy.idempotency_key, candidateMeaning(legacy), JSON.stringify(legacy)).run();
    await callTool('propose_album_listening', { artist: 'x', album: 'New', origin: 'conversation', whole_album: true }, { ...ctx(db), source: 'claude' });
    const res = await handleBoardRequest(new Request('https://hub.example/board/v1/tiles'), { db, ownerId: 'demo-owner', now: () => Date.now(), appNames: { music: 'music' } });
    const hubTile = (await res.json()).manifests.find((m) => m.app === 'hub').tiles[0];
    assert.equal(hubTile.data.value, 2);
    assert.deepEqual(hubTile.detail.rows, [{ title: 'music', value: '2건' }]);
  } finally { db.close(); }
});
