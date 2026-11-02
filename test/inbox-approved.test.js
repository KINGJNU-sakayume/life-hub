/**
 * Destination inbox API for card-approved candidates and reference lists. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { handleInboxRequest } from '../src/inbox/api.js';
import {
  insertCandidate, issueCardTicket, editCardCandidate, approveCardCandidate, getDestinationRefs,
} from '../src/server/store.js';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const AT = new Date(NOW).toISOString();
const env = (db, destination = 'food') => ({ db, ownerId: 'demo-owner', now: () => NOW, destination, prefix: { food: '/palate/v1', kyeokyeoi: '/kyeokyeoi/v1' }[destination] });
async function api(db, method, path, body, destination = 'food') {
  const response = await handleInboxRequest(new Request('https://hub.example' + path, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env(db, destination));
  return { status: response.status, body: await response.json() };
}
function meal(key, source = 'claude', menu = 'Synthetic udon') {
  return { hub_version: 1, destination: 'food', source, source_ref: source + '-mcp:2026-11-02', idempotency_key: key,
    created_at: AT, candidate_type: 'meal', payload: { menu_name: menu } };
}

test('open lists pending and approved; approved carries the owner\'s final version', async () => {
  const db = new TestD1();
  try {
    const a = await insertCandidate(db, 'demo-owner', meal('synthetic-key-0001'), AT);
    const b = await insertCandidate(db, 'demo-owner', meal('synthetic-key-0002', 'claude', 'Synthetic soba'), AT);
    const { ticket } = await issueCardTicket(db, 'demo-owner', a.id, NOW);
    await editCardCandidate(db, 'demo-owner', a.id, ticket, 0, { menu_name: 'Synthetic udon, large', verdict: 'LIKE' }, AT);
    await approveCardCandidate(db, 'demo-owner', a.id, ticket, 1, {}, AT);

    const pending = await api(db, 'GET', '/palate/v1/candidates');
    assert.deepEqual(pending.body.candidates.map((c) => c.hub_id), [b.id], 'default stays pending-only for older app versions');
    const approved = await api(db, 'GET', '/palate/v1/candidates?status=approved');
    assert.equal(approved.body.candidates.length, 1);
    const [c] = approved.body.candidates;
    assert.equal(c.status, 'approved');
    assert.equal(c.revision, 1);
    assert.equal(c.needs_app_review, false);
    assert.equal(c.approved_at, AT);
    assert.equal(c.candidate.payload.menu_name, 'Synthetic udon', 'original proposal kept');
    assert.deepEqual(c.final_candidate.payload, { menu_name: 'Synthetic udon, large', verdict: 'LIKE' });
    assert.equal(c.final_candidate.idempotency_key, 'synthetic-key-0001');
    const open = await api(db, 'GET', '/palate/v1/candidates?status=open');
    assert.equal(open.body.candidates.length, 2);
    assert.equal((await api(db, 'GET', '/palate/v1/candidates?status=nope')).status, 400);

    // The app saves it and sends the usual receipt: approved → confirmed.
    const receipt = await api(db, 'POST', '/palate/v1/receipts', { key: c.key, entity_type: 'meal', entity_id: 'meal-syn-1' });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.candidate.status, 'confirmed');
    assert.equal((await api(db, 'POST', '/palate/v1/receipts', { key: c.key, entity_type: 'meal', entity_id: 'meal-syn-1' })).status, 200);
  } finally { db.close(); }
});

test('the app may still reject an approved candidate on its last check', async () => {
  const db = new TestD1();
  try {
    const a = await insertCandidate(db, 'demo-owner', meal('synthetic-key-0003'), AT);
    const { ticket } = await issueCardTicket(db, 'demo-owner', a.id, NOW);
    await approveCardCandidate(db, 'demo-owner', a.id, ticket, 0, { appReview: true }, AT);
    const [c] = (await api(db, 'GET', '/palate/v1/candidates?status=approved')).body.candidates;
    assert.equal(c.needs_app_review, true);
    assert.equal(c.final_candidate, null);
    const rejected = await api(db, 'POST', '/palate/v1/rejections', { key: c.key });
    assert.equal(rejected.body.candidate.status, 'rejected');
    assert.equal((await api(db, 'POST', '/palate/v1/receipts', { key: c.key, entity_type: 'meal', entity_id: 'x1' })).status, 409);
  } finally { db.close(); }
});

test('Codex proposals can be confirmed by the destination app', async () => {
  const db = new TestD1();
  try {
    await insertCandidate(db, 'demo-owner', meal('synthetic-key-0004', 'codex'), AT);
    const r = await api(db, 'POST', '/palate/v1/receipts', { key: 'codex:synthetic-key-0004', entity_type: 'meal', entity_id: 'meal-syn-4' });
    assert.equal(r.status, 200);
    assert.equal(r.body.candidate.status, 'confirmed');
  } finally { db.close(); }
});

test('reference lists: allowed kinds only, bounded, newer revisions win', async () => {
  const db = new TestD1();
  try {
    const regions = { revision: 3, items: [{ id: 'KR-42-150', label: '강원 강릉시', group: '강원' }, { id: 'KR-26-350', label: '부산 해운대구' }] };
    const put = await api(db, 'PUT', '/kyeokyeoi/v1/refs/regions', regions, 'kyeokyeoi');
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { kind: 'regions', revision: 3, updated_at: AT });
    assert.equal((await api(db, 'PUT', '/kyeokyeoi/v1/refs/regions', regions, 'kyeokyeoi')).status, 200, 'same revision and body is a no-op');
    const older = await api(db, 'PUT', '/kyeokyeoi/v1/refs/regions', { revision: 2, items: [] }, 'kyeokyeoi');
    assert.equal(older.status, 409);
    const stored = await getDestinationRefs(db, 'demo-owner', 'kyeokyeoi');
    assert.deepEqual(stored.regions.items, regions.items);

    // Unknown kinds, other destinations' kinds and bad items are refused.
    assert.equal((await api(db, 'PUT', '/kyeokyeoi/v1/refs/diary', regions, 'kyeokyeoi')).status, 404);
    assert.equal((await api(db, 'PUT', '/palate/v1/refs/regions', regions)).status, 404);
    for (const items of [[{ id: 'x', label: 'y', memo: 'z' }], [{ id: 'bad id', label: 'y' }], [{ id: 'a', label: 'y' }, { id: 'a', label: 'z' }],
      Array.from({ length: 501 }, (_, i) => ({ id: 'r' + i, label: 'r' }))]) {
      const r = await api(db, 'PUT', '/kyeokyeoi/v1/refs/regions', { revision: 9, items }, 'kyeokyeoi');
      assert.ok([400].includes(r.status), JSON.stringify(items).slice(0, 60));
    }
    assert.equal((await getDestinationRefs(db, 'demo-owner', 'kyeokyeoi')).regions.revision, 3);
  } finally { db.close(); }
});
