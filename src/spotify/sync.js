/**
 * Spotify link and hourly collection.
 *
 * - The owner links Spotify once (Authorization Code + PKCE with the public client ID in
 *   HUB_SPOTIFY_CLIENT_ID, scope user-read-recently-played only). Only the encrypted refresh token is kept.
 * - The Worker's cron trigger calls pollSpotify every hour: one token refresh and one recently-played
 *   request (the last 50 plays after the stored cursor). No Claude involvement, no tokens spent.
 * - Album-context plays are stored briefly, grouped into sessions (sessions.js), and closed sessions
 *   become pending potcast candidates (source `spotify`). The owner approves each album in potcast.
 */
import { insertCandidate } from '../server/store.js';
import { openToken, sealToken, tokenKeyConfigured } from './crypto.js';
import { albumPlays, buildSessions } from './sessions.js';

export const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
const SPOTIFY_API = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPE = 'user-read-recently-played';
const RETAIN_MS = 3 * 24 * 3600 * 1000;
const CLIENT_ID = /^[0-9a-f]{32}$/;

export const spotifyClientId = (env) => (typeof env.HUB_SPOTIFY_CLIENT_ID === 'string' && CLIENT_ID.test(env.HUB_SPOTIFY_CLIENT_ID) ? env.HUB_SPOTIFY_CLIENT_ID : null);
export const spotifyConfigured = (env) => Boolean(spotifyClientId(env) && tokenKeyConfigured(env) && env.HUB_OWNER_ID && env.DB);
export const spotifyRedirectUri = (env) => env.HUB_PUBLIC_ORIGIN + '/spotify/callback';

export class SpotifyError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }   // revoked | network | server
}

async function tokenRequest(env, fetchFn, params) {
  let res;
  try {
    res = await fetchFn(SPOTIFY_ACCOUNTS + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: spotifyClientId(env), ...params }).toString(),
    });
  } catch {
    throw new SpotifyError('network', 'Spotify token endpoint unreachable');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(body.error === 'invalid_grant' ? 'revoked' : 'server', `Spotify token error ${res.status}`);
  if (typeof body.access_token !== 'string') throw new SpotifyError('server', 'Spotify token response malformed');
  return body;
}

/** Finishes linking: exchanges the code and stores the encrypted refresh token. */
export async function linkSpotify(env, code, verifier, fetchFn = fetch, now = Date.now()) {
  const body = await tokenRequest(env, fetchFn, { grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri(env), code_verifier: verifier });
  if (typeof body.refresh_token !== 'string') throw new SpotifyError('server', 'Spotify did not return a refresh token');
  const scopes = String(body.scope ?? '').split(' ');
  if (!scopes.includes(SPOTIFY_SCOPE)) throw new SpotifyError('server', 'Spotify did not grant the recently-played scope');
  await env.DB.prepare(`INSERT INTO spotify_link (owner_id,refresh_token_enc,linked_at,cursor_ms,last_polled_at,last_error)
    VALUES (?,?,?,NULL,NULL,NULL)
    ON CONFLICT(owner_id) DO UPDATE SET refresh_token_enc=excluded.refresh_token_enc, linked_at=excluded.linked_at, last_error=NULL`)
    .bind(env.HUB_OWNER_ID, await sealToken(env, body.refresh_token), new Date(now).toISOString()).run();
}

export async function unlinkSpotify(env) {
  await env.DB.prepare('DELETE FROM spotify_plays WHERE owner_id=?').bind(env.HUB_OWNER_ID).run();
  await env.DB.prepare('DELETE FROM spotify_link WHERE owner_id=?').bind(env.HUB_OWNER_ID).run();
}

export async function spotifyStatus(env) {
  if (!env.DB || !env.HUB_OWNER_ID) return null;
  const link = await env.DB.prepare('SELECT linked_at,last_polled_at,last_error FROM spotify_link WHERE owner_id=?').bind(env.HUB_OWNER_ID).first();
  const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_plays WHERE owner_id=?').bind(env.HUB_OWNER_ID).first();
  return link ? { ...link, waiting: waiting?.n ?? 0 } : null;
}

/**
 * One collection round. Returns { proposed, discarded, stored } or null when not linked/configured.
 * Errors are recorded on the link row (and a revoked authorization stops further polls).
 */
export async function pollSpotify(env, fetchFn = fetch, now = Date.now()) {
  if (!spotifyConfigured(env)) return null;
  const owner = env.HUB_OWNER_ID;
  const link = await env.DB.prepare('SELECT * FROM spotify_link WHERE owner_id=?').bind(owner).first();
  if (!link || link.last_error === 'revoked') return null;
  const at = new Date(now).toISOString();
  const fail = async (error) => {
    await env.DB.prepare('UPDATE spotify_link SET last_polled_at=?, last_error=? WHERE owner_id=?').bind(at, error, owner).run();
  };
  try {
    const tokens = await tokenRequest(env, fetchFn, { grant_type: 'refresh_token', refresh_token: await openToken(env, link.refresh_token_enc) });
    // Spotify may rotate the refresh token.
    if (typeof tokens.refresh_token === 'string')
      await env.DB.prepare('UPDATE spotify_link SET refresh_token_enc=? WHERE owner_id=?').bind(await sealToken(env, tokens.refresh_token), owner).run();

    const q = new URLSearchParams({ limit: '50' });
    if (Number.isInteger(link.cursor_ms)) q.set('after', String(link.cursor_ms));
    let res;
    try {
      res = await fetchFn(`${SPOTIFY_API}/me/player/recently-played?${q}`, { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    } catch {
      throw new SpotifyError('network', 'Spotify API unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new SpotifyError('revoked', `Spotify API ${res.status}`);
    if (!res.ok) throw new SpotifyError('server', `Spotify API ${res.status}`);
    const body = await res.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items : [];

    const plays = albumPlays(items);
    for (const p of plays) {
      await env.DB.prepare(`INSERT INTO spotify_plays (owner_id,played_at,track_id,track_name,album_id,album_name,artist_name,duration_ms,album_tracks)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(owner, p.played_at, p.track_id, p.track_name, p.album_id, p.album_name, p.artist_name, p.duration_ms, p.album_tracks).run();
    }
    // Newest play seen becomes the cursor (also for non-album plays, so they are not fetched again).
    const newest = items.reduce((m, it) => Math.max(m, Date.parse(it?.played_at) || 0), Number.isInteger(link.cursor_ms) ? link.cursor_ms : 0);

    const stored = (await env.DB.prepare('SELECT * FROM spotify_plays WHERE owner_id=? ORDER BY played_at').bind(owner).all()).results;
    const { candidates, consumed } = buildSessions(stored, now);
    for (const c of candidates) {
      // A rebuilt session (e.g. after an interrupted round) has the same key and content: a duplicate, not an error.
      await insertCandidate(env.DB, owner, {
        hub_version: 1, destination: 'potcast', source: 'spotify', source_ref: 'spotify-sync:' + c.payload.listened_on,
        idempotency_key: c.idempotency_key, created_at: at, candidate_type: 'album_listening', payload: c.payload,
      }, at);
    }
    for (const p of consumed)
      await env.DB.prepare('DELETE FROM spotify_plays WHERE owner_id=? AND played_at=? AND track_id=?').bind(owner, p.played_at, p.track_id).run();
    await env.DB.prepare('DELETE FROM spotify_plays WHERE owner_id=? AND played_at<?').bind(owner, new Date(now - RETAIN_MS).toISOString()).run();
    await env.DB.prepare('UPDATE spotify_link SET cursor_ms=?, last_polled_at=?, last_error=NULL WHERE owner_id=?')
      .bind(newest || null, at, owner).run();
    return { proposed: candidates.length, stored: plays.length, closedPlays: consumed.length };
  } catch (error) {
    await fail(error instanceof SpotifyError ? error.kind : 'server');
    if (!(error instanceof SpotifyError)) throw error;
    return { error: error.kind };
  }
}
