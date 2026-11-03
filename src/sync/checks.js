/**
 * Minimal shape checks for sync documents (docs/P6_SYNC.md, section 5).
 *
 * The Hub stores each app's document as opaque JSON and never interprets it, so these checks only keep
 * the wrong app's file, or a broken one, from replacing a good document. They live here and not in the
 * destination adapters on purpose: adapters validate candidates, this is a separate contract.
 * Unknown extra fields are allowed because the app owns its format. A destination without an entry
 * fails closed.
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const CHECKS = Object.freeze({
  animan: (d) => d.app === 'animan' && d.version === 2 && isObject(d.progress),
  letterbookxd: (d) => d.app === 'letterbookxd' && d.version === 2 && Array.isArray(d.logs) &&
    (d.tombstones === undefined || Array.isArray(d.tombstones)),
  elosorter: (d) => d.version === 2 && Array.isArray(d.tracks),
});

/** True when `doc` has the shape this destination's sync document must have. */
export function checkSyncDocument(destination, doc) {
  const check = Object.hasOwn(CHECKS, destination) ? CHECKS[destination] : null;
  return Boolean(check && isObject(doc) && check(doc));
}

export const syncCheckedDestinations = () => Object.keys(CHECKS);
