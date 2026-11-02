/** D1 persistence. All queries are parameterized and owner-scoped. SQLite triggers append changes atomically. */
import { candidateMeaning } from '../core/candidates.js';
import { toDestinationCandidate } from '../adapters/index.js';
export class StoreFailure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function record(row) {
  return {
    id: row.id, destination: row.destination, source: row.source,
    status: row.status, received_at: row.received_at, reviewed_at: row.reviewed_at,
    confirmed_entity_id: row.confirmed_entity_id ?? null,
    candidate: JSON.parse(row.envelope_json),
    // Card edits/approval (0008). final_payload is the owner's version; candidate keeps the original proposal.
    revision: row.revision ?? 0,
    final_payload: row.final_payload_json ? JSON.parse(row.final_payload_json) : null,
    approved_at: row.approved_at ?? null,
    needs_app_review: row.needs_app_review === 1,
  };
}

/** The envelope the destination should save: the original proposal with the owner's edits, if any. */
export function finalEnvelope(rec) {
  return rec.final_payload ? { ...rec.candidate, payload: rec.final_payload } : rec.candidate;
}
export async function insertCandidate(db, ownerId, candidate, at) {
  const meaning = candidateMeaning(candidate);
  // Validating the exact destination shape here prevents invalid records from entering persistent storage.
  toDestinationCandidate(candidate);
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
  // An app may still reject an approved candidate (its last check); a confirmed record stays.
  await db.prepare(`UPDATE inbox SET status='rejected',reviewed_at=?
    WHERE owner_id=? AND id=? AND status IN ('pending','approved')`).bind(at, ownerId, id).run();
  const row = await db.prepare('SELECT * FROM inbox WHERE owner_id=? AND id=?').bind(ownerId, id).first();
  if (!row) throw new StoreFailure(404, 'Candidate not found');
  if (row.status === 'confirmed') throw new StoreFailure(409, 'Confirmed record cannot be rejected');
  return record(row);
}
/** Single candidate lookup, owner-scoped and optionally restricted to one source (e.g. what an MCP client may see). */
export async function getCandidate(db, ownerId, id, source) {
  const row = source ?
    await db.prepare('SELECT * FROM inbox WHERE owner_id=? AND id=? AND source=?').bind(ownerId, id, source).first() :
    await db.prepare('SELECT * FROM inbox WHERE owner_id=? AND id=?').bind(ownerId, id).first();
  return row ? record(row) : null;
}

/** Look up by the destination-visible key (source + idempotency key), owner-scoped. */
async function rowByKey(db, ownerId, destination, source, key) {
  return db.prepare('SELECT * FROM inbox WHERE owner_id=? AND destination=? AND source=? AND idempotency_key=?')
    .bind(ownerId, destination, source, key).first();
}

/**
 * Record the destination's receipt: the owner approved this candidate there and it was saved as
 * `entityId`. Idempotent for the same entity; any other transition is a conflict.
 */
export async function confirmCandidateByKey(db, ownerId, destination, source, key, entityType, entityId, at) {
  const before = await rowByKey(db, ownerId, destination, source, key);
  if (!before) throw new StoreFailure(404, 'Candidate not found');
  if (JSON.parse(before.envelope_json).candidate_type !== entityType)
    throw new StoreFailure(409, 'Receipt type does not match the candidate');
  await db.prepare(`UPDATE inbox SET status='confirmed',confirmed_entity_id=?,reviewed_at=?
    WHERE id=? AND owner_id=? AND status IN ('pending','approved')`).bind(entityId, at, before.id, ownerId).run();
  const row = await rowByKey(db, ownerId, destination, source, key);
  if (row.status === 'rejected') throw new StoreFailure(409, 'Candidate was rejected');
  if (row.status !== 'confirmed' || row.confirmed_entity_id !== entityId)
    throw new StoreFailure(409, 'Candidate is confirmed as a different record');
  return record(row);
}

/** Owner rejected the candidate at the destination. Idempotent; a confirmed candidate cannot be rejected. */
export async function rejectCandidateByKey(db, ownerId, destination, source, key, at) {
  const before = await rowByKey(db, ownerId, destination, source, key);
  if (!before) throw new StoreFailure(404, 'Candidate not found');
  return rejectCandidate(db, ownerId, before.id, at);
}

/** One destination's candidates, newest first. `status` is one status, a list of statuses, or null for all. */
export async function listDestinationCandidates(db, ownerId, destination, status, limit) {
  const statuses = status === null ? [] : Array.isArray(status) ? status : [status];
  const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return (await db.prepare(`SELECT * FROM inbox WHERE owner_id=? AND destination=?${filter} ORDER BY received_at DESC,id DESC LIMIT ?`)
    .bind(ownerId, destination, ...statuses, limit).all()).results.map(record);
}

/* ---------- Claude card approval (0008) ---------- */

const TICKET_DAYS = 7;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const toBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * A single-use ticket for one candidate's card. Only its SHA-256 is stored; the ticket itself goes to the
 * card UI (tool result _meta), never into model-visible content.
 */
export async function issueCardTicket(db, ownerId, candidateId, now) {
  const ticket = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const created = new Date(now);
  const expires = new Date(now + TICKET_DAYS * 86400000);
  await db.prepare(`INSERT INTO card_tickets (ticket_hash,owner_id,candidate_id,created_at,expires_at) VALUES (?,?,?,?,?)`)
    .bind(await sha256(ticket), ownerId, candidateId, created.toISOString(), expires.toISOString()).run();
  return { ticket, expires_at: expires.toISOString() };
}

/** The ticket row for this owner + candidate, or a 403. Expired tickets never match. */
async function ticketFor(db, ownerId, candidateId, ticket, at) {
  if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) throw new StoreFailure(403, 'Card ticket is invalid or expired');
  const row = await db.prepare(`SELECT * FROM card_tickets WHERE ticket_hash=? AND owner_id=? AND candidate_id=? AND expires_at>?`)
    .bind(await sha256(ticket), ownerId, candidateId, at).first();
  if (!row) throw new StoreFailure(403, 'Card ticket is invalid or expired');
  return row;
}

async function useTicket(db, row, purpose, at) {
  const result = await db.prepare(`UPDATE card_tickets SET used_at=?,used_for=? WHERE ticket_hash=? AND used_at IS NULL`)
    .bind(at, purpose, row.ticket_hash).run();
  return result.meta.changes === 1;
}

async function ownRecord(db, ownerId, id) {
  const row = await db.prepare('SELECT * FROM inbox WHERE owner_id=? AND id=?').bind(ownerId, id).first();
  if (!row) throw new StoreFailure(404, 'Candidate not found');
  return record(row);
}

/** Validates an edited payload with the destination's own adapter; returns its canonical JSON. */
function checkedPayload(rec, payload) {
  toDestinationCandidate({ ...rec.candidate, payload });
  return JSON.stringify(payload);
}

/** Read a card's candidate with its ticket (no state change). */
export async function readCardCandidate(db, ownerId, id, ticket, at) {
  await ticketFor(db, ownerId, id, ticket, at);
  return ownRecord(db, ownerId, id);
}

/** Save the owner's edit of a pending candidate. `revision` must be current (optimistic lock). */
export async function editCardCandidate(db, ownerId, id, ticket, revision, payload, at) {
  const t = await ticketFor(db, ownerId, id, ticket, at);
  if (t.used_at) throw new StoreFailure(409, 'This card was already used');
  const rec = await ownRecord(db, ownerId, id);
  if (rec.status !== 'pending') throw new StoreFailure(409, 'Candidate is no longer pending');
  const json = checkedPayload(rec, payload);
  const result = await db.prepare(`UPDATE inbox SET final_payload_json=?,revision=revision+1,edited_at=?
    WHERE owner_id=? AND id=? AND status='pending' AND revision=?`).bind(json, at, ownerId, id, revision).run();
  if (result.meta.changes !== 1) throw new StoreFailure(409, 'Candidate changed elsewhere; reload the card');
  return ownRecord(db, ownerId, id);
}

/**
 * The owner approved the candidate in the card: pending → approved (not confirmed; the app saves it).
 * Exactly once per candidate: a repeat with the ticket that approved it returns the same record.
 */
export async function approveCardCandidate(db, ownerId, id, ticket, revision, { appReview = false } = {}, at) {
  const t = await ticketFor(db, ownerId, id, ticket, at);
  const rec = await ownRecord(db, ownerId, id);
  if (t.used_at) {
    if (t.used_for === 'approve' && rec.status !== 'pending') return rec;
    throw new StoreFailure(409, 'This card was already used');
  }
  if (rec.status !== 'pending') throw new StoreFailure(409, `Candidate is already ${rec.status}`);
  const result = await db.prepare(`UPDATE inbox SET status='approved',approved_at=?,needs_app_review=?
    WHERE owner_id=? AND id=? AND status='pending' AND revision=?`).bind(at, appReview ? 1 : 0, ownerId, id, revision).run();
  if (result.meta.changes !== 1) throw new StoreFailure(409, 'Candidate changed elsewhere; reload the card');
  await useTicket(db, t, 'approve', at);
  return ownRecord(db, ownerId, id);
}

/** The owner rejected the pending candidate in the card. Repeats with the same ticket are idempotent. */
export async function rejectCardCandidate(db, ownerId, id, ticket, at) {
  const t = await ticketFor(db, ownerId, id, ticket, at);
  const rec = await ownRecord(db, ownerId, id);
  if (t.used_at) {
    if (t.used_for === 'reject' && rec.status === 'rejected') return rec;
    throw new StoreFailure(409, 'This card was already used');
  }
  if (rec.status !== 'pending') throw new StoreFailure(409, `Candidate is already ${rec.status}`);
  const result = await db.prepare(`UPDATE inbox SET status='rejected',reviewed_at=? WHERE owner_id=? AND id=? AND status='pending'`)
    .bind(at, ownerId, id).run();
  if (result.meta.changes !== 1) throw new StoreFailure(409, 'Candidate changed elsewhere; reload the card');
  await useTicket(db, t, 'reject', at);
  return ownRecord(db, ownerId, id);
}

/** Housekeeping for the hourly cron: drop expired tickets. */
export async function deleteExpiredTickets(db, at) {
  return (await db.prepare('DELETE FROM card_tickets WHERE expires_at<=?').bind(at).run()).meta.changes;
}

/* ---------- Destination reference lists (0008) ---------- */

/**
 * Store an app's reference list (e.g. its region list) for card pickers. Only a higher revision replaces
 * the stored one; re-sending the same revision with the same body is a no-op, anything else is a conflict.
 */
export async function putDestinationRefs(db, ownerId, destination, kind, revision, body, at) {
  const json = JSON.stringify(body);
  await db.prepare(`INSERT INTO destination_refs (owner_id,destination,kind,revision,body_json,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(owner_id,destination,kind) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at
    WHERE excluded.revision > destination_refs.revision`).bind(ownerId, destination, kind, revision, json, at).run();
  const row = await db.prepare('SELECT * FROM destination_refs WHERE owner_id=? AND destination=? AND kind=?')
    .bind(ownerId, destination, kind).first();
  if (row.revision !== revision || row.body_json !== json) throw new StoreFailure(409, 'A newer reference list is already stored');
  return { kind, revision: row.revision, updated_at: row.updated_at };
}

/** Every reference list one destination published, keyed by kind. */
export async function getDestinationRefs(db, ownerId, destination) {
  const rows = (await db.prepare('SELECT kind,revision,body_json,updated_at FROM destination_refs WHERE owner_id=? AND destination=?')
    .bind(ownerId, destination).all()).results;
  return Object.fromEntries(rows.map((r) => [r.kind, { revision: r.revision, updated_at: r.updated_at, items: JSON.parse(r.body_json) }]));
}
