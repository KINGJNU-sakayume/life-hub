import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import {
  verifyOwnerPassword, safeReturnTo, ownerLoginConfigured,
  MAX_ATTEMPTS_PER_WINDOW, ATTEMPT_WINDOW_MS,
} from '../src/auth/owner-login.js';

const PASSWORD = 'synthetic-owner-password-' + 'x'.repeat(24);
const env = (db) => ({ DB: db, HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD });

test('owner login requires an owner id, a long password and a database', () => {
  const db = new TestD1();
  try {
    assert.equal(ownerLoginConfigured(env(db)), true);
    assert.equal(ownerLoginConfigured({ ...env(db), HUB_OWNER_PASSWORD: 'short' }), false);
    assert.equal(ownerLoginConfigured({ ...env(db), HUB_OWNER_ID: 'a b' }), false);
    assert.equal(ownerLoginConfigured({ ...env(db), DB: undefined }), false);
  } finally { db.close(); }
});

test('correct password succeeds and resets the counter', async () => {
  const db = new TestD1();
  try {
    assert.equal((await verifyOwnerPassword(db, env(db), 'nope', 1000)).reason, 'wrong');
    assert.deepEqual(await verifyOwnerPassword(db, env(db), PASSWORD, 2000), { ok: true });
    const row = await db.prepare('SELECT * FROM login_failures').bind().first();
    assert.equal(row, null);
  } finally { db.close(); }
});

test('attempts are counted before comparing; the correct password is refused while locked', async () => {
  const db = new TestD1();
  try {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++)
      assert.equal((await verifyOwnerPassword(db, env(db), 'guess' + i, t0 + i)).reason, 'wrong');
    const locked = await verifyOwnerPassword(db, env(db), PASSWORD, t0 + 100);
    assert.equal(locked.reason, 'locked');
    assert.ok(locked.retryAfterSeconds > 0 && locked.retryAfterSeconds <= ATTEMPT_WINDOW_MS / 1000);
    // After the window passes, the owner can sign in again.
    assert.deepEqual(await verifyOwnerPassword(db, env(db), PASSWORD, t0 + ATTEMPT_WINDOW_MS + 1), { ok: true });
  } finally { db.close(); }
});

test('oversized or non-string passwords are treated as wrong without throwing', async () => {
  const db = new TestD1();
  try {
    assert.equal((await verifyOwnerPassword(db, env(db), PASSWORD + 'x'.repeat(2000))).reason, 'wrong');
    assert.equal((await verifyOwnerPassword(db, env(db), undefined)).reason, 'wrong');
  } finally { db.close(); }
});

test('return_to only allows same-origin /authorize paths', () => {
  assert.equal(safeReturnTo('/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi'), '/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi');
  for (const bad of ['https://evil.example/authorize?x', '//evil.example/authorize?', '/authorize', '/authorize?a=//b',
    '/authorize?a=b\\c', '/other?x', '/authorize?x y', 'javascript:alert(1)', 42, undefined])
    assert.equal(safeReturnTo(bad), null, String(bad));
});

test('authorize POST rejects non-form bodies before touching OAuth state', async () => {
  const { handleAuthorize } = await import('../src/auth/owner-login.js');
  const db = new TestD1();
  try {
    const oauth = new Proxy({}, { get: () => () => { throw new Error('OAuth helpers must not be called'); } });
    const request = new Request('https://hub.example/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const response = await handleAuthorize(request, env(db), oauth, { AuthorizationError: class {}, CimdFetchError: class {} });
    assert.equal(response.status, 415);
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  } finally { db.close(); }
});
