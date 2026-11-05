/** 0011 (P7 B5): the inbox gets the `board` source; every proposal, event and card ticket survives. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../migrations/', import.meta.url);
const sql = (name) => readFileSync(new URL(name, dir), 'utf8');

test('0011 keeps proposals, events, tickets, indexes and triggers; adds source board', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const prior = readdirSync(dir).filter((f) => /^00(0\d|10)_.*\.sql$/.test(f)).sort();
    db.exec('PRAGMA foreign_keys = ON;' + prior.map(sql).join('\n'));
    const insert = db.prepare(`INSERT INTO inbox (id, owner_id, destination, source, idempotency_key, meaning, envelope_json, status, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
    insert.run(a, 'demo-owner', 'sub', 'claude', 'synthetic-0011-01', 'm1', '{}', 'pending', '2026-11-05T00:00:00Z');
    insert.run(b, 'demo-owner', 'food', 'codex', 'synthetic-0011-02', 'm2', '{}', 'pending', '2026-11-05T01:00:00Z');
    db.prepare(`UPDATE inbox SET final_payload_json='{}', revision=1, edited_at=? WHERE id=?`).run('2026-11-05T02:00:00Z', a);
    db.prepare(`UPDATE inbox SET status='approved', approved_at=?, needs_app_review=1 WHERE id=?`).run('2026-11-05T03:00:00Z', a);
    db.prepare(`INSERT INTO card_tickets (ticket_hash,owner_id,candidate_id,created_at,expires_at) VALUES (?,?,?,?,?)`).run('a'.repeat(64), 'demo-owner', a, 'c', 'e');
    assert.throws(() => insert.run(crypto.randomUUID(), 'demo-owner', 'sub', 'board', 'synthetic-0011-03', 'm3', '{}', 'pending', 'now'), /CHECK constraint/, 'board is refused before 0011');
    const rows = db.prepare('SELECT * FROM inbox ORDER BY id').all();
    const events = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all();
    const tickets = db.prepare('SELECT * FROM card_tickets').all();

    db.exec(sql('0011_board_source.sql'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM inbox ORDER BY id').all(), rows);
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all(), events);
    assert.deepEqual(db.prepare('SELECT * FROM card_tickets').all(), tickets, 'card tickets are not cascaded away');

    insert.run('33333333-3333-4333-8333-333333333333', 'demo-owner', 'sub', 'board', 'synthetic-0011-03', 'm3', '{}', 'pending', '2026-11-05T04:00:00Z');
    const last = db.prepare('SELECT seq, change_type, candidate_id FROM inbox_changes ORDER BY seq DESC LIMIT 1').get();
    assert.equal(last.seq, events.at(-1).seq + 1, 'the event cursor continues');
    assert.equal(last.change_type, 'created');
    assert.throws(() => insert.run(crypto.randomUUID(), 'demo-owner', 'sub', 'tablet', 'synthetic-0011-04', 'm4', '{}', 'pending', 'now'), /CHECK constraint/);
    assert.throws(() => db.prepare(`INSERT INTO card_tickets (ticket_hash,owner_id,candidate_id,created_at,expires_at) VALUES (?,?,?,?,?)`)
      .run('b'.repeat(64), 'demo-owner', '44444444-4444-4444-8444-444444444444', 'c', 'e'), /FOREIGN KEY/, 'tickets still reference the inbox');
    db.prepare('DELETE FROM card_tickets').run();
    assert.throws(() => db.prepare('DELETE FROM inbox WHERE id=?').run(a), /FOREIGN KEY/, 'events still RESTRICT deleting a proposal');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const n of ['card_tickets_expiry', 'inbox_changes_owner_seq', 'inbox_edit_event', 'inbox_insert_event', 'inbox_owner_status_time', 'inbox_status_event']) assert.ok(names.includes(n), n);
  } finally { db.close(); }
});
