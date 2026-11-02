/**
 * Life Hub → potcast candidate contract v1: `album_listening`.
 *
 * potcast separates intentional listening (digging an artist, listening to an album) from music that
 * merely played. A candidate is one album the user confirmed they listened to on purpose:
 * - `origin: conversation` — the user said so ("오늘 Blond 다 들었어"): `whole_album` or named tracks.
 * - `origin: spotify_history` — derived from the user's Spotify streaming-history file, after the user
 *   confirmed this album in the conversation: per-track listened/skipped with play times.
 * potcast resolves the album on Spotify, shows every track for review, and records nothing until the
 * owner approves. No IPs, user agents, usernames or raw history rows are accepted.
 * - `origin: spotify_sync` (source `spotify`) — collected by the hub every hour from the owner's Spotify
 *   recently-played list, album-context plays only (src/spotify/). Always album ID + per-track IDs and times.
 */
import { isObject, hasOnly, validDate, validTimestamp, requiredText, optionalText, validateHubEnvelope } from '../core/candidates.js';

const SOURCES = new Set(['chatgpt', 'claude', 'codex', 'manual', 'spotify']);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
export const MAX_TRACKS = 80;

function validTrack(t) {
  return isObject(t) && hasOnly(t, ['title', 'spotify_track_id', 'status', 'played_at']) &&
    (t.title !== undefined || t.spotify_track_id !== undefined) && optionalText(t.title, 200) &&
    (t.spotify_track_id === undefined || (typeof t.spotify_track_id === 'string' && SPOTIFY_ID.test(t.spotify_track_id))) &&
    (t.status === 'listened' || t.status === 'skipped') && (t.played_at === undefined || validTimestamp(t.played_at));
}

function validAlbumListening(p) {
  if (!hasOnly(p, ['artist', 'album', 'spotify_album_id', 'origin', 'listened_on', 'whole_album', 'tracks', 'note']) ||
    !requiredText(p.artist, 200) || !requiredText(p.album, 200) || !optionalText(p.note, 500) ||
    (p.spotify_album_id !== undefined && (typeof p.spotify_album_id !== 'string' || !SPOTIFY_ID.test(p.spotify_album_id))) ||
    !['conversation', 'spotify_history', 'spotify_sync'].includes(p.origin) ||
    (p.listened_on !== undefined && !validDate(p.listened_on)) ||
    (p.whole_album !== undefined && p.whole_album !== true))
    return false;
  const hasTracks = p.tracks !== undefined;
  if (hasTracks && (!Array.isArray(p.tracks) || p.tracks.length === 0 || p.tracks.length > MAX_TRACKS || !p.tracks.every(validTrack)))
    return false;
  // Exactly one of: the whole album, or a track list. History always lists tracks.
  if ((p.whole_album === true) === hasTracks) return false;
  if (p.origin === 'spotify_history' && !hasTracks) return false;
  // Hourly collection: always the album ID and, per track, its ID and play time.
  if (p.origin === 'spotify_sync' && (!hasTracks || p.spotify_album_id === undefined || !p.tracks.every((t) => t.spotify_track_id && t.played_at)))
    return false;
  if (hasTracks) {
    const ids = p.tracks.map((t) => t.spotify_track_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) return false;
  }
  return true;
}

export function validatePotcastCandidate(candidate) {
  if (!isObject(candidate) || !hasOnly(candidate, [
    'schema_version', 'source', 'source_ref', 'idempotency_key', 'created_at', 'candidate_type', 'payload',
  ]) || candidate.schema_version !== 1 || !SOURCES.has(candidate.source) || !isObject(candidate.payload))
    throw new Error('Invalid potcast candidate');
  if (candidate.candidate_type !== 'album_listening') throw new Error('Unsupported potcast candidate type');
  if (!validAlbumListening(candidate.payload)) throw new Error('Invalid potcast album_listening candidate');
  // Only the hub's own Spotify collection uses the spotify source, and only for spotify_sync.
  if ((candidate.source === 'spotify') !== (candidate.payload.origin === 'spotify_sync'))
    throw new Error('Invalid potcast album_listening candidate');
  return structuredClone(candidate);
}

export function toPotcastCandidate(untrusted) {
  const hub = validateHubEnvelope(untrusted);
  if (hub.destination !== 'potcast') throw new Error('Wrong destination');
  return validatePotcastCandidate({
    schema_version: 1, source: hub.source, source_ref: hub.source_ref, idempotency_key: hub.idempotency_key,
    created_at: hub.created_at, candidate_type: hub.candidate_type, payload: hub.payload,
  });
}
