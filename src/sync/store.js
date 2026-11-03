/**
 * D1 access for device sync (docs/P6_SYNC.md). Every query is scoped by owner and destination.
 * Document text is only ever read back to the owner; nothing here logs it or puts it in an error.
 */
const META = 'version, sha256, size_bytes, device, written_at';

/** Meta (no document text) of the newest version, or null. */
export async function currentSyncMeta(db, ownerId, destination) {
  return db.prepare(`SELECT ${META} FROM sync_docs WHERE owner_id=? AND destination=? ORDER BY version DESC LIMIT 1`)
    .bind(ownerId, destination).first();
}

/** The newest version with its document text, or null. */
export async function readCurrentSyncDoc(db, ownerId, destination) {
  return db.prepare(`SELECT ${META}, body_json FROM sync_docs WHERE owner_id=? AND destination=? ORDER BY version DESC LIMIT 1`)
    .bind(ownerId, destination).first();
}

export async function readSyncVersion(db, ownerId, destination, version) {
  return db.prepare(`SELECT ${META}, body_json FROM sync_docs WHERE owner_id=? AND destination=? AND version=?`)
    .bind(ownerId, destination, version).first();
}

export async function listSyncVersions(db, ownerId, destination, limit) {
  return (await db.prepare(`SELECT ${META} FROM sync_docs WHERE owner_id=? AND destination=? ORDER BY version DESC LIMIT ?`)
    .bind(ownerId, destination, limit).all()).results;
}

/**
 * Write version `base + 1` only if `base` is still the newest version (0 = no document yet).
 * Returns { ok: true, meta } or { ok: false, current } where `current` is the newest meta (or null).
 * The conditional INSERT is one statement; a unique-key collision from a racing writer counts as stale.
 */
export async function writeSyncDoc(db, ownerId, destination, base, doc, at, keep) {
  let changes = 0;
  try {
    changes = (await db.prepare(`INSERT INTO sync_docs (owner_id,destination,version,body_json,size_bytes,sha256,device,written_at)
      SELECT ?, ?, ? + 1, ?, ?, ?, ?, ?
      WHERE COALESCE((SELECT MAX(version) FROM sync_docs WHERE owner_id=? AND destination=?), 0) = ?`)
      .bind(ownerId, destination, base, doc.body, doc.size, doc.sha256, doc.device, at, ownerId, destination, base).run()).meta.changes;
  } catch (error) {
    if (!/UNIQUE constraint failed/i.test(String(error?.message))) throw error;
  }
  if (changes !== 1) return { ok: false, current: await currentSyncMeta(db, ownerId, destination) };
  // Drop versions older than the newest `keep`. Best effort: the next write prunes again.
  try {
    await db.prepare('DELETE FROM sync_docs WHERE owner_id=? AND destination=? AND version<=?')
      .bind(ownerId, destination, base + 1 - keep).run();
  } catch { /* nothing to do */ }
  return { ok: true, meta: { version: base + 1, sha256: doc.sha256, size_bytes: doc.size, device: doc.device, written_at: at } };
}

/**
 * Remove every version this owner/destination has, if `base` is the newest one.
 * Returns { status: 'none' } | { status: 'stale', current } | { status: 'deleted' }.
 * Only versions up to the one the client saw are removed, so a write that lands meanwhile survives.
 */
export async function deleteSyncDocs(db, ownerId, destination, base) {
  const current = await currentSyncMeta(db, ownerId, destination);
  if (!current) return { status: 'none' };
  if (current.version !== base) return { status: 'stale', current };
  await db.prepare('DELETE FROM sync_docs WHERE owner_id=? AND destination=? AND version<=?')
    .bind(ownerId, destination, current.version).run();
  return { status: 'deleted' };
}
