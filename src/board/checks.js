/**
 * Hub-side checks for a board manifest (docs/P7_BOARD.md section 5.2).
 *
 * The board validates every tile before drawing it (board repository, js/schema.js), so the Hub checks only
 * what protects storage and identity: the version, that the manifest belongs to the app whose token sent it, a
 * sane `generated_at`, the tile count, tile ids and tones, and that no `data:` string (an inline image) is
 * anywhere in it. Nothing else in a tile is interpreted. Returns a short reason string, or null when it passes;
 * the reason never contains manifest text.
 */
export const BOARD_LIMITS = Object.freeze({ maxBytes: 65536, tiles: 24, futureMs: 5 * 60 * 1000, depth: 12 });
const TONES = new Set(['sleeve', 'hero', 'strip', 'plate', 'map', 'type']);
const TILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True when some string value (or key) anywhere in `value` starts with `data:` (case-insensitive). */
function hasDataUri(value, depth = 0) {
  if (depth > BOARD_LIMITS.depth) return true;   // absurdly deep: refuse rather than walk it
  if (typeof value === 'string') return /^\s*data:/i.test(value);
  if (Array.isArray(value)) return value.some((v) => hasDataUri(v, depth + 1));
  if (isObject(value)) return Object.entries(value).some(([k, v]) => /^\s*data:/i.test(k) || hasDataUri(v, depth + 1));
  return false;
}

/** @returns {{ reason: string|null, generatedAt?: string }} generatedAt is normalized (toISOString). */
export function checkManifest(app, m, nowMs) {
  if (!isObject(m)) return { reason: 'Manifest must be an object' };
  if (m.version !== 1) return { reason: 'Unsupported manifest version' };
  if (m.app !== app) return { reason: 'Manifest app does not match this app' };
  if (typeof m.generated_at !== 'string' || !ISO.test(m.generated_at)) return { reason: 'Invalid generated_at' };
  const at = Date.parse(m.generated_at);
  if (Number.isNaN(at)) return { reason: 'Invalid generated_at' };
  if (at > nowMs + BOARD_LIMITS.futureMs) return { reason: 'generated_at is in the future' };
  if (!Array.isArray(m.tiles) || m.tiles.length > BOARD_LIMITS.tiles) return { reason: `tiles must be an array of at most ${BOARD_LIMITS.tiles}` };
  const ids = new Set();
  for (const t of m.tiles) {
    if (!isObject(t) || typeof t.id !== 'string' || !TILE_ID.test(t.id)) return { reason: 'Invalid tile id' };
    if (ids.has(t.id)) return { reason: 'Duplicate tile id' };
    ids.add(t.id);
    if (!TONES.has(t.tone)) return { reason: 'Invalid tile tone' };
  }
  if (hasDataUri(m)) return { reason: 'Inline data: images are not accepted; send image addresses' };
  return { reason: null, generatedAt: new Date(at).toISOString() };
}
