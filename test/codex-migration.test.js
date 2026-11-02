import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const migrationDir = new URL('../migrations/', import.meta.url);
function sql(name) { return readFileSync(new URL(name, migrationDir), 'utf8'); }

test('0006 preserves existing proposals, confirmed receipts and event cursor; admits Codex', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const prior = readdirSync(migrationDir).filter((f) => /^000[1-5]_.*\.sql$/.test(f)).sort();
    db.exec('PRAGMA foreign_keys = ON;' + prior.map(sql).join('\n'));
    const insert = db.prepare(`INSERT INTO inbox
      (id, owner_id, destination, source, idempotency_key, meaning, envelope_json, status, received_at, confirmed_entity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const original = {
      hub_version: 1, destination: 'food', source: 'claude', source_ref: 'claude-mcp:2026-11-01',
      idempotency_key: 'existing-synthetic-01', created_at: '2026-11-01T00:00:00Z',
      candidate_type: 'wish', payload: { wish_kind: 'try_menu', name: 'Fictional soup' },
    };
    const id = '11111111-1111-4111-8111-111111111111';
    insert.run(id, 'demo-owner', 'food', 'claude', original.idempotency_key, 'original-meaning',
      JSON.stringify(original), 'pending', '2026-11-01T00:00:00Z', null);
    db.prepare('UPDATE inbox SET status=?, reviewed_at=?, confirmed_entity_id=? WHERE id=?')
      .run('confirmed', '2026-11-02T00:00:00Z', 'synthetic-receipt-1', id);
    const before = db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all();
    assert.equal(before.length, 2);

    db.exec(sql('0006_codex_source.sql'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const preserved = db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
    assert.equal(preserved.source, 'claude');
    assert.equal(preserved.status, 'confirmed');
    assert.equal(preserved.confirmed_entity_id, 'synthetic-receipt-1');
    assert.equal(preserved.meaning, 'original-meaning');
    assert.equal(preserved.envelope_json, JSON.stringify(original));
    assert.deepEqual(db.prepare('SELECT * FROM inbox_changes ORDER BY seq').all(), before);

    insert.run('22222222-2222-4222-8222-222222222222', 'demo-owner', 'food', 'codex',
      original.idempotency_key, 'codex-meaning', '{}', 'pending', '2026-11-02T01:00:00Z', null);
    const events = db.prepare('SELECT seq, candidate_id FROM inbox_changes ORDER BY seq').all();
    assert.equal(events.length, 3);
    assert.equal(events[2].seq, before[1].seq + 1);
    assert.equal(events[2].candidate_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => insert.run('33333333-3333-4333-8333-333333333333', 'demo-owner', 'food', 'unknown',
      'different-synthetic-key', 'x', '{}', 'pending', '2026-11-02T01:00:00Z', null), /CHECK constraint/);
  } finally { db.close(); }
});
