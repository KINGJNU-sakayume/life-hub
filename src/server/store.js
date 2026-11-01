/** D1 persistence. All queries are parameterized and owner-scoped. SQLite triggers append changes atomically. */
import { candidateMeaning } from '../core/candidates.js';
import { toFoodCandidate } from '../adapters/food.js';
export class StoreFailure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function record(row) {
  return {
    id: row.id, destination: row.destination, source: row.source,
    status: row.status, received_at: row.received_at, reviewed_at: row.reviewed_at,
    candidate: JSON.parse(row.envelope_json),
  };
}
export async function insertCandidate(db, ownerId, candidate, at) {
  const meaning = candidateMeaning(candidate);
  // Validating the exact destination shape here prevents invalid records from entering persistent storage.
  toFoodCandidate(candidate);
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO inbox
    (id,owner_id,destination,source,idempotency_key,meaning,envelope_json,status,received_at)
    VALUES (?,?,?,?,?,?,?,'pending',?)
    ON CONFLICT(owner_id,destination,source,idempotency_key) DO NOTHING`)
    .bind(id, ownerId, candidate.destination, candidate.source,
      candidate.idempotency_key, meaning, JSON.stringify(candidate), at).run();
  const row = await db.prepare(`SELECT * FROM inbox WHERE owner_id=? AND destination=? AND source=? AND idempotency_key=?`)
    .bind(ownerId, candidate.destination, candidate.source, candidate.idempotency_key).first();
  if (!row) throw new Error('Inbox read after insert failed');
  if (row.meaning !== meaning) throw new StoreFailure(409, 'Conflicting idempotency key');
  return { ...record(row), duplicate: result.meta.changes === 0 };
}
export async function listCandidates(db, ownerId, status, limit) {
  const query = status ?
    'SELECT * FROM inbox WHERE owner_id=? AND status=? ORDER BY received_at DESC,id DESC LIMIT ?' :
    'SELECT * FROM inbox WHERE owner_id=? ORDER BY received_at DESC,id DESC LIMIT ?';
  const params = status ? [ownerId, status, limit] : [ownerId, limit];
  const rows = (await db.prepare(query).bind(...params).all()).results;
  return rows.map(record);
}
export async function readChanges(db, ownerId, cursor, limit) {
  const rows = (await db.prepare(`SELECT ch.seq,ch.change_type,ch.changed_at,
    ch.status AS event_status,i.id,i.destination,i.source,i.status,i.received_at,i.reviewed_at,i.envelope_json
    FROM inbox_changes ch JOIN inbox i ON i.id=ch.candidate_id AND i.owner_id=ch.owner_id
    WHERE ch.owner_id=? AND ch.seq>? ORDER BY ch.seq ASC LIMIT ?`)
    .bind(ownerId, cursor, limit).all()).results;
  return {
    changes: rows.map(row => ({
      sequence: row.seq, event: row.change_type, event_status: row.event_status,
      changed_at: row.changed_at, record: record(row),
    })),
    next_cursor: rows.length ? rows[rows.length - 1].seq : cursor,
  };
}
export async function rejectCandidate(db, ownerId, id, at) {
  await db.prepare(`UPDATE inbox SET status='rejected',reviewed_at=?
    WHERE owner_id=? AND id=? AND status='pending'`).bind(at, ownerId, id).run();
  const row = await db.prepare('SELECT * FROM inbox WHERE owner_id=? AND id=?').bind(ownerId, id).first();
  if (!row) throw new StoreFailure(404, 'Candidate not found');
  if (row.status === 'confirmed') throw new StoreFailure(409, 'Confirmed record cannot be rejected');
  return record(row);
}
