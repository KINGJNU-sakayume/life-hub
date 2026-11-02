import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const migrationDir = new URL('../migrations/', import.meta.url);
const sql = (name) => readFileSync(new URL(name, migrationDir), 'utf8');

test('0008 keeps every proposal, receipt and event; adds approved, edits and card tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const prior = readdirSync(migrationDir).filter((f) => /^000[1-7]_.*\.sql$/.test(f)).sort();
    db.exec('PRAGMA foreign_keys = ON;' + prior.map(sql).join('\n'));
    const insert = db.prepare(`INSERT INTO inbox
      (id, owner_id, destination, source, idempotency_key, meaning, envelope_json, status, received_at, confirmed_entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const envelope = JSON.stringify({ hub_version: 1, destination: 'food', source: 'claude', source_ref: 'claude-mcp:2026-11-01',
      idempotency_key: 'synthetic-0008-01', created_at: '2026-11-01T00:00:00Z', candidate_type: 'wish',
      payload: { wish_kind: 'try_menu', name: 'Fictional soup' } });
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    insert.run(a, 'demo-owner', 'food', 'claude', 'synthetic-0008-01', 'm1', envelope, 'pending', '2026-11-01T00:00:00Z', null);
    insert.run(b, 'demo-owner', 'potcast', 'spotify', 'synthetic-0008-02', 'm2', '{}', 'pending', '2026-11-01T01:00:00Z', null);
    db.prepare('UPDATE inbox SET status=?, reviewed_at=?, confirmed_entity_id=? WHERE id=?').run('confirmed', '2026-11-02T00:00:00Z', 'receipt-1', a);
    const before = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all();
    const rowsBefore = db.prepare('SELECT * FROM inbox ORDER BY id').all();

    db.exec(sql('0008_card_approval.sql'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const rowsAfter = db.prepare('SELECT * FROM inbox ORDER BY id').all();
    for (const [i, row] of rowsBefore.entries()) {
      for (const [k, v] of Object.entries(row)) assert.equal(rowsAfter[i][k], v, k);
      assert.equal(rowsAfter[i].revision, 0);
      assert.equal(rowsAfter[i].needs_app_review, 0);
      assert.equal(rowsAfter[i].final_payload_json, null);
    }
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all(), before);

    // New state and events keep the same cursor sequence.
    db.prepare(`UPDATE inbox SET final_payload_json='{}', revision=revision+1, edited_at=? WHERE id=?`).run('2026-11-02T02:00:00Z', b);
    db.prepare(`UPDATE inbox SET status='approved', approved_at=? WHERE id=?`).run('2026-11-02T03:00:00Z', b);
    const events = db.prepare('SELECT seq, change_type, status, changed_at FROM inbox_changes WHERE seq>? ORDER BY seq').all(before.at(-1).seq);
    assert.deepEqual(events.map((e) => [e.change_type, e.status, e.changed_at]), [
      ['edited', 'pending', '2026-11-02T02:00:00Z'], ['status', 'approved', '2026-11-02T03:00:00Z']]);
    assert.equal(events[0].seq, before.at(-1).seq + 1);
    assert.throws(() => db.prepare(`UPDATE inbox SET status='saved' WHERE id=?`).run(b), /CHECK constraint/);

    // Tickets belong to an existing candidate; reference lists are bounded.
    assert.throws(() => db.prepare(`INSERT INTO card_tickets (ticket_hash,owner_id,candidate_id,created_at,expires_at) VALUES (?,?,?,?,?)`)
      .run('a'.repeat(64), 'demo-owner', '33333333-3333-4333-8333-333333333333', 'x', 'y'), /FOREIGN KEY/);
    assert.throws(() => db.prepare(`INSERT INTO destination_refs VALUES (?,?,?,?,?,?)`)
      .run('demo-owner', 'kyeokyeoi', 'regions', 1, 'x'.repeat(40000), 'now'), /CHECK constraint/);
  } finally { db.close(); }
});
