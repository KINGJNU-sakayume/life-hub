/**
 * From Spotify "recently played" items to potcast album-listening candidates. Pure functions.
 *
 * Intentional listening only: a play counts when it was started from the album itself (its playback
 * context is that album). Playlists, radio, artist pages, search results and autoplay are ignored, so a
 * song that merely came up somewhere never becomes a proposal.
 *
 * Sessions: plays of one album that follow each other with gaps of at most SESSION_GAP_MS. A session is
 * only turned into a candidate once it is CLOSED (its last play is older than CLOSE_AFTER_MS), so a
 * listening session is never split across two hourly polls. Sessions with fewer than MIN_TRACKS
 * distinct tracks (or the whole album when it is shorter) are discarded as "just clicked in".
 *
 * Track status: Spotify reports when each play happened (`played_at`, the end of playback) but not how
 * long it lasted. The time since the previous play ended approximates it: a track counts as listened
 * when that time is at least min(90% of its length, 2 minutes); otherwise skipped. The first play of a
 * session has no previous play and counts as listened (Spotify only lists plays of 30 s or more).
 * The owner reviews every track in potcast before anything is recorded.
 */
export const SESSION_GAP_MS = 60 * 60 * 1000;
export const CLOSE_AFTER_MS = 2 * 60 * 60 * 1000;
export const MIN_TRACKS = 3;
export const MAX_TRACKS = 80;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

const clip = (s, max) => String(s ?? '').trim().slice(0, max);

/** Album-context plays from a recently-played response (only the fields potcast needs). */
export function albumPlays(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const track = item?.track;
    const album = track?.album;
    const context = item?.context;
    if (!track || !album || track.type !== 'track' || !SPOTIFY_ID.test(track.id ?? '') || !SPOTIFY_ID.test(album.id ?? '')) continue;
    if (context?.type !== 'album' || context.uri !== `spotify:album:${album.id}`) continue;
    const playedMs = Date.parse(item.played_at);
    if (!Number.isFinite(playedMs)) continue;
    out.push({
      played_at: new Date(playedMs).toISOString(),
      track_id: track.id,
      track_name: clip(track.name, 200) || '?',
      album_id: album.id,
      album_name: clip(album.name, 200) || '?',
      artist_name: clip(album.artists?.[0]?.name ?? track.artists?.[0]?.name, 200) || '?',
      duration_ms: Number.isFinite(track.duration_ms) ? Math.max(0, Math.round(track.duration_ms)) : 0,
      album_tracks: Number.isInteger(album.total_tracks) ? album.total_tracks : null,
    });
  }
  return out;
}

/** Korean calendar day of an instant. */
export const kstDay = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Groups stored plays into sessions. Returns { candidates, consumed, keep }: payloads for closed
 * sessions worth proposing, plays to delete (closed sessions, proposed or discarded), plays to keep.
 */
export function buildSessions(plays, nowMs) {
  const byAlbum = new Map();
  for (const p of [...plays].sort((a, b) => a.played_at.localeCompare(b.played_at))) {
    const list = byAlbum.get(p.album_id) ?? [];
    list.push(p);
    byAlbum.set(p.album_id, list);
  }
  const candidates = [];
  const consumed = [];
  const keep = [];
  for (const list of byAlbum.values()) {
    let session = [];
    const flush = (closed) => {
      if (!session.length) return;
      if (!closed) { keep.push(...session); session = []; return; }
      consumed.push(...session);
      const candidate = toCandidate(session);
      if (candidate) candidates.push(candidate);
      session = [];
    };
    for (const p of list) {
      const last = session[session.length - 1];
      if (last && Date.parse(p.played_at) - Date.parse(last.played_at) > SESSION_GAP_MS) flush(true);
      session.push(p);
    }
    const tail = session[session.length - 1];
    flush(tail ? nowMs - Date.parse(tail.played_at) > CLOSE_AFTER_MS : false);
  }
  return { candidates, consumed, keep };
}

function toCandidate(session) {
  const first = session[0];
  const distinct = new Set(session.map((p) => p.track_id));
  const albumTracks = first.album_tracks ?? MIN_TRACKS;
  if (distinct.size < Math.min(MIN_TRACKS, Math.max(1, albumTracks))) return null;
  // Latest play per track; a listened play beats a skipped one.
  const tracks = new Map();
  session.forEach((p, i) => {
    const prev = session[i - 1];
    const gap = prev ? Date.parse(p.played_at) - Date.parse(prev.played_at) : Infinity;
    const status = gap >= Math.min(p.duration_ms * 0.9, 120_000) ? 'listened' : 'skipped';
    const listened = status === 'listened' || tracks.get(p.track_id)?.status === 'listened';
    tracks.set(p.track_id, { title: p.track_name, spotify_track_id: p.track_id, status: listened ? 'listened' : 'skipped', played_at: p.played_at });
  });
  const startMs = Date.parse(first.played_at);
  return {
    idempotency_key: `spsync-${first.album_id}-${startMs}`,
    payload: {
      artist: first.artist_name,
      album: first.album_name,
      spotify_album_id: first.album_id,
      origin: 'spotify_sync',
      listened_on: kstDay(startMs),
      tracks: [...tracks.values()].slice(0, MAX_TRACKS),
    },
  };
}
