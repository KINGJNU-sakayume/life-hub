/**
 * D1 access for board manifests (docs/P7_BOARD.md section 5.4). Every query is scoped by owner.
 * Manifest text is only read back to the owner's board or the app; nothing here logs it.
 */
const META = 'app, generated_at, received_at, size_bytes, sha256';

export async function readManifestMeta(db, ownerId, app) {
  return db.prepare(`SELECT ${META} FROM board_manifests WHERE owner_id=? AND app=?`).bind(ownerId, app).first();
}

export async function readManifest(db, ownerId, app) {
  return db.prepare(`SELECT ${META}, body_json FROM board_manifests WHERE owner_id=? AND app=?`).bind(ownerId, app).first();
}

export async function listManifests(db, ownerId) {
  return (await db.prepare(`SELECT ${META}, body_json FROM board_manifests WHERE owner_id=? ORDER BY app`).bind(ownerId).all()).results;
}

/**
 * Store the manifest if it is newer than the stored one. One conditional upsert, so two racing uploads cannot
 * leave the older one last. Returns { status: 'stored' | 'unchanged' | 'ignored', current }.
 */
export async function writeManifest(db, ownerId, app, m, receivedAt) {
  const current = await readManifestMeta(db, ownerId, app);
  if (current && current.sha256 === m.sha256) return { status: 'unchanged', current };
  if (current && current.generated_at >= m.generatedAt) return { status: 'ignored', current };
  const { changes } = (await db.prepare(`INSERT INTO board_manifests (owner_id, app, generated_at, received_at, body_json, size_bytes, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, app) DO UPDATE SET generated_at=excluded.generated_at, received_at=excluded.received_at,
      body_json=excluded.body_json, size_bytes=excluded.size_bytes, sha256=excluded.sha256
    WHERE excluded.generated_at > board_manifests.generated_at`)
    .bind(ownerId, app, m.generatedAt, receivedAt, m.body, m.size, m.sha256).run()).meta;
  if (changes !== 1) return { status: 'ignored', current: await readManifestMeta(db, ownerId, app) };
  return { status: 'stored', current: { app, generated_at: m.generatedAt, received_at: receivedAt, size_bytes: m.size, sha256: m.sha256 } };
}

export async function deleteManifest(db, ownerId, app) {
  return (await db.prepare('DELETE FROM board_manifests WHERE owner_id=? AND app=?').bind(ownerId, app).run()).meta.changes;
}

/** Pending candidates per destination (counts only), for the Hub's own `inbox` tile. */
export async function pendingCounts(db, ownerId) {
  return (await db.prepare(`SELECT destination, COUNT(*) AS n FROM inbox WHERE owner_id=? AND status='pending' GROUP BY destination ORDER BY destination`)
    .bind(ownerId).all()).results;
}
