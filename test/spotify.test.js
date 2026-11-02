import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import { albumPlays, buildSessions, kstDay } from '../src/spotify/sessions.js';
import { sealToken, openToken } from '../src/spotify/crypto.js';
import { linkSpotify, pollSpotify } from '../src/spotify/sync.js';
import { handleSpotify } from '../src/spotify/routes.js';
import { toPotcastCandidate } from '../src/adapters/potcast.js';

// Synthetic data only: invented IDs, titles and times.
const ID = (c) => c.repeat(22);
const ALBUM = ID('A');
const OTHER = ID('B');
const T = (n) => ID(String.fromCharCode(97 + n));
const PASSWORD = 'synthetic-owner-password-' + 's'.repeat(24);
const env = (patch = {}) => ({
  DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: 'https://hub.example', HUB_OWNER_ID: 'demo-owner',
  HUB_OWNER_PASSWORD: PASSWORD, HUB_SPOTIFY_CLIENT_ID: '0123456789abcdef0123456789abcdef',
  HUB_SPOTIFY_TOKEN_KEY: 'synthetic-token-key-' + 'k'.repeat(32), ...patch,
});
const item = (track, album, playedAt, context = { type: 'album', uri: `spotify:album:${album}` }, duration = 200_000) => ({
  played_at: playedAt, context,
  track: { type: 'track', id: track, name: 'Song ' + track.slice(0, 1), duration_ms: duration, artists: [{ name: 'Synthetic Artist' }],
    album: { id: album, name: 'Synthetic Album ' + album.slice(0, 1), total_tracks: 8, artists: [{ name: 'Synthetic Artist' }] } },
});
const at = (min) => new Date(Date.parse('2026-11-01T10:00:00Z') + min * 60_000).toISOString();

test('only plays started from the album itself count', () => {
  const plays = albumPlays([
    item(T(0), ALBUM, at(0)),
    item(T(1), ALBUM, at(4), { type: 'playlist', uri: 'spotify:playlist:' + ID('P') }),
    item(T(2), ALBUM, at(8), null),
    item(T(3), ALBUM, at(12), { type: 'album', uri: 'spotify:album:' + OTHER }),
    item(T(4), ALBUM, at(16), { type: 'artist', uri: 'spotify:artist:' + ID('R') }),
    { played_at: at(20), context: { type: 'album', uri: 'spotify:album:' + ALBUM }, track: { type: 'episode', id: T(5) } },
  ]);
  assert.deepEqual(plays.map((p) => p.track_id), [T(0)]);
  assert.deepEqual(Object.keys(plays[0]).sort(), ['album_id', 'album_name', 'album_tracks', 'artist_name', 'duration_ms', 'played_at', 'track_id', 'track_name']);
});

test('sessions: closed ones become candidates with listened/skipped, open ones wait, clicks are dropped', () => {
  const plays = albumPlays([
    // Album A: 4 tracks; the third ended 40 s after the second → skipped.
    item(T(0), ALBUM, at(0)), item(T(1), ALBUM, at(4)), item(T(2), ALBUM, at(4.67)), item(T(3), ALBUM, at(8)),
    // Album B: only two tracks → just clicked in.
    item(T(4), OTHER, at(20), undefined), item(T(5), OTHER, at(24)),
  ].map((it) => (it.context === undefined ? { ...it, context: { type: 'album', uri: `spotify:album:${OTHER}` } } : it)));
  const now = Date.parse(at(8)) + 3 * 3600_000;
  const { candidates, consumed, keep } = buildSessions(plays, now);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.idempotency_key, `spsync-${ALBUM}-${Date.parse(at(0))}`);
  assert.equal(c.payload.origin, 'spotify_sync');
  assert.equal(c.payload.listened_on, kstDay(Date.parse(at(0))));
  assert.deepEqual(c.payload.tracks.map((t) => t.status), ['listened', 'listened', 'skipped', 'listened']);
  assert.equal(consumed.length, 6);
  assert.equal(keep.length, 0);
  assert.ok(toPotcastCandidate({ hub_version: 1, destination: 'potcast', source: 'spotify', source_ref: 'spotify-sync:x',
    idempotency_key: c.idempotency_key, created_at: at(0), candidate_type: 'album_listening', payload: c.payload }));

  // The same plays one hour later are still an open session: nothing proposed, nothing deleted.
  const open = buildSessions(plays, Date.parse(at(8)) + 3600_000);
  assert.equal(open.candidates.length, 0);
  assert.equal(open.keep.length, 6);

  // A gap longer than an hour starts a new session.
  const split = buildSessions(albumPlays([item(T(0), ALBUM, at(0)), item(T(1), ALBUM, at(4)), item(T(2), ALBUM, at(8)),
    item(T(3), ALBUM, at(200)), item(T(4), ALBUM, at(204)), item(T(5), ALBUM, at(208))]), Date.parse(at(208)) + 3 * 3600_000);
  assert.equal(split.candidates.length, 2);
});

test('the refresh token is sealed with its own key', async () => {
  const e = env();
  try {
    const sealed = await sealToken(e, 'refresh-synthetic');
    assert.ok(!sealed.includes('refresh-synthetic'));
    assert.equal(await openToken(e, sealed), 'refresh-synthetic');
    await assert.rejects(openToken({ HUB_SPOTIFY_TOKEN_KEY: 'another-synthetic-key-' + 'x'.repeat(32) }, sealed));
  } finally { e.DB.close(); }
});

function spotifyFake(items, { revoke = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/token')) {
      const body = new URLSearchParams(init.body);
      if (revoke && body.get('grant_type') === 'refresh_token') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return Response.json({ access_token: 'access-synthetic', token_type: 'Bearer', expires_in: 3600, scope: 'user-read-recently-played',
        refresh_token: body.get('grant_type') === 'refresh_token' ? 'refresh-rotated' : 'refresh-synthetic' });
    }
    if (String(url).includes('/me/player/recently-played')) return Response.json({ items, cursors: {} });
    return new Response('unexpected', { status: 500 });
  };
  return { calls, fetchFn };
}

test('hourly poll: album sessions become pending potcast candidates, plays are deleted, the cursor moves', async () => {
  const e = env();
  try {
    const items = [item(T(0), ALBUM, at(0)), item(T(1), ALBUM, at(4)), item(T(2), ALBUM, at(8)), item(T(6), OTHER, at(9), { type: 'playlist', uri: 'spotify:playlist:x' })];
    const { calls, fetchFn } = spotifyFake(items);
    await linkSpotify(e, 'code-synthetic', 'verifier-synthetic', fetchFn, Date.parse(at(-10)));
    const stored = await e.DB.prepare('SELECT refresh_token_enc FROM spotify_link').bind().first();
    assert.ok(!stored.refresh_token_enc.includes('refresh-synthetic'));

    // An hour after the last play the session is still open.
    let r = await pollSpotify(e, fetchFn, Date.parse(at(68)));
    assert.deepEqual(r, { proposed: 0, stored: 3, closedPlays: 0 });
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 0);
    const recent = calls.filter((c) => c.url.includes('recently-played'));
    assert.ok(!recent[0].url.includes('after='));
    assert.equal(recent[0].init.headers.Authorization, 'Bearer access-synthetic');

    // Later: closed → one candidate; the stored plays are gone; the next request asks only for newer plays.
    r = await pollSpotify(e, fetchFn, Date.parse(at(8)) + 3 * 3600_000);
    assert.equal(r.proposed, 1);
    const row = await e.DB.prepare('SELECT destination, source, status, envelope_json FROM inbox').bind().first();
    assert.deepEqual([row.destination, row.source, row.status], ['potcast', 'spotify', 'pending']);
    assert.equal(JSON.parse(row.envelope_json).payload.tracks.length, 3);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM spotify_plays').bind().first()).n, 0);
    assert.match(calls.filter((c) => c.url.includes('recently-played')).at(-1).url, new RegExp(`after=${Date.parse(at(9))}`));
    // Spotify rotated the refresh token; the new one is stored (sealed).
    const link = await e.DB.prepare('SELECT refresh_token_enc FROM spotify_link').bind().first();
    const { openToken: open } = await import('../src/spotify/crypto.js');
    assert.equal(await open(e, link.refresh_token_enc), 'refresh-rotated');

    // Polling again changes nothing (same plays come back only through the cursor, none here).
    r = await pollSpotify(e, spotifyFake([]).fetchFn, Date.parse(at(8)) + 4 * 3600_000);
    assert.equal(r.proposed, 0);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM inbox').bind().first()).n, 1);
  } finally { e.DB.close(); }
});

test('a revoked authorization stops polling until relinked; unconfigured means off', async () => {
  const e = env();
  try {
    await linkSpotify(e, 'code', 'verifier', spotifyFake([]).fetchFn);
    assert.deepEqual(await pollSpotify(e, spotifyFake([], { revoke: true }).fetchFn), { error: 'revoked' });
    assert.equal(await pollSpotify(e, spotifyFake([]).fetchFn), null);
    assert.equal(await pollSpotify(env({ HUB_SPOTIFY_TOKEN_KEY: '' }), spotifyFake([]).fetchFn), null);
  } finally { e.DB.close(); }
});

test('owner pages: password gate, PKCE redirect with state, callback links once', async () => {
  const e = env();
  try {
    const post = (path, password) => new Request('https://hub.example' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
    const home = await handleSpotify(new Request('https://hub.example/spotify'), e);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/accounts\.spotify\.com/);
    assert.match(await home.text(), /Spotify 연결/);

    assert.match(await (await handleSpotify(post('/spotify/connect', 'wrong-password'), e)).text(), /비밀번호가 맞지 않아요/);
    const go = await handleSpotify(post('/spotify/connect', PASSWORD), e);
    assert.equal(go.status, 303);
    const to = new URL(go.headers.get('Location'));
    assert.equal(to.origin + to.pathname, 'https://accounts.spotify.com/authorize');
    assert.deepEqual([to.searchParams.get('scope'), to.searchParams.get('code_challenge_method'), to.searchParams.get('redirect_uri')],
      ['user-read-recently-played', 'S256', 'https://hub.example/spotify/callback']);
    const state = to.searchParams.get('state');

    const { calls, fetchFn } = spotifyFake([]);
    const forged = await handleSpotify(new Request('https://hub.example/spotify/callback?code=c&state=' + 'x'.repeat(22)), e, fetchFn);
    assert.match(await forged.text(), /만료됐거나/);
    const done = await handleSpotify(new Request(`https://hub.example/spotify/callback?code=c&state=${state}`), e, fetchFn);
    assert.match(await done.text(), /연결했어요/);
    assert.equal(new URLSearchParams(calls[0].init.body).get('code_verifier').length, 43);
    // The state works once.
    assert.match(await (await handleSpotify(new Request(`https://hub.example/spotify/callback?code=c&state=${state}`), e, fetchFn)).text(), /만료됐거나/);

    assert.match(await (await handleSpotify(post('/spotify/disconnect', PASSWORD), e)).text(), /연결을 해제했어요/);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM spotify_link').bind().first()).n, 0);
    assert.equal((await handleSpotify(new Request('https://hub.example/spotify'), env({ HUB_SPOTIFY_CLIENT_ID: '' }))).status, 503);
  } finally { e.DB.close(); }
});

test('the spotify source is only for the hub\'s own collection', () => {
  const base = { hub_version: 1, destination: 'potcast', source_ref: 'x:y', idempotency_key: 'spsync-' + 'a'.repeat(30), created_at: at(0), candidate_type: 'album_listening' };
  const sync = { artist: 'x', album: 'y', origin: 'spotify_sync', spotify_album_id: ALBUM, tracks: [{ spotify_track_id: T(0), status: 'listened', played_at: at(0) }] };
  assert.ok(toPotcastCandidate({ ...base, source: 'spotify', payload: sync }));
  assert.throws(() => toPotcastCandidate({ ...base, source: 'claude', payload: sync }));
  assert.throws(() => toPotcastCandidate({ ...base, source: 'spotify', payload: { artist: 'x', album: 'y', origin: 'conversation', whole_album: true } }));
  assert.throws(() => toPotcastCandidate({ ...base, source: 'spotify', payload: { ...sync, spotify_album_id: undefined } }));
  assert.throws(() => toPotcastCandidate({ ...base, source: 'spotify', payload: { ...sync, tracks: [{ title: 'a', status: 'listened' }] } }));
});
