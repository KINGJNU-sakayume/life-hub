import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../src/server/worker.js';
import { insertCandidate, listCandidates } from '../src/server/store.js';
const SCHEMA = readFileSync(new URL('../migrations/0001_inbox.sql', import.meta.url), 'utf8');
const OWNER_TOKEN = 'owner_' + 'A'.repeat(48);
const CHATGPT_TOKEN = 'chatgpt_' + 'B'.repeat(48);
const CLAUDE_TOKEN = 'claude_' + 'C'.repeat(48);
const READER_TOKEN = 'reader_' + 'D'.repeat(48);
class TestD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON;' + SCHEMA); }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    return { bind(...args) {
      return {
        run: async () => ({ meta: { changes: statement.run(...args).changes } }),
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
      };
    } };
  }
  close() { this.sqlite.close(); }
}
const envFor = (db) => ({
  DB: db, HUB_OWNER_ID: 'demo-owner',
  HUB_OWNER_TOKEN: OWNER_TOKEN, HUB_CHATGPT_TOKEN: CHATGPT_TOKEN,
  HUB_CLAUDE_TOKEN: CLAUDE_TOKEN, HUB_FOOD_READER_TOKEN: READER_TOKEN,
});
const meal = (overrides = {}) => ({
  hub_version: 1, destination: 'food', source: 'chatgpt',
  source_ref: 'synthetic:test-message-01', idempotency_key: 'test-meal-00001',
  created_at: '2026-11-01T10:00:00+09:00', candidate_type: 'meal',
  payload: { menu_name: 'Example noodles', place_name: 'Fictional cafe' },
  ...overrides,
});
const wish = (overrides = {}) => ({
  hub_version: 1, destination: 'food', source: 'manual',
  source_ref: 'manual:test-01', idempotency_key: 'test-wish-00001',
  created_at: '2026-11-01T10:00:00+09:00', candidate_type: 'wish',
  payload: { wish_kind: 'try_menu', name: 'Imaginary pasta' },
  ...overrides,
});
function makeReq(method, path, token, body, headers = {}) {
  return new Request('https://unit.example' + path, {
    method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
async function call(db, method, path, token, body, envPatch = {}) {
  const response = await handleRequest(makeReq(method, path, token, body), { ...envFor(db), ...envPatch });
  return { status: response.status, result: await response.json(), headers: response.headers };
}
test('health is non-sensitive and endpoints fail closed without auth', async () => {
  const db = new TestD1();
  try {
    assert.equal((await call(db, 'GET', '/health')).status, 200);
    assert.equal((await call(db, 'GET', '/v1/candidates')).status, 401);
    assert.equal((await call(db, 'GET', '/v1/candidates', 'X'.repeat(64))).status, 401);
    assert.equal((await call(db, 'GET', '/v1/candidates', OWNER_TOKEN, undefined, { HUB_OWNER_TOKEN: undefined })).status, 503);
  } finally { db.close(); }
});
test('producer cannot impersonate provider or owner', async () => {
  const db = new TestD1();
  try {
    assert.equal((await call(db, 'POST', '/v1/candidates', CHATGPT_TOKEN, meal())).status, 201);
    assert.equal((await call(db, 'POST', '/v1/candidates', CLAUDE_TOKEN, meal({ idempotency_key:'different-key-0002' }))).status, 403);
    assert.equal((await call(db, 'POST', '/v1/candidates', OWNER_TOKEN, meal({ idempotency_key:'different-key-0003' }))).status, 403);
    assert.equal((await call(db, 'POST', '/v1/candidates', OWNER_TOKEN, wish())).status, 201);
    assert.equal((await call(db, 'POST', '/v1/candidates', READER_TOKEN, wish({idempotency_key:'another-wish-00004'}))).status, 403);
  } finally { db.close(); }
});
test('unique key is durable and conflicting replay rejected without overwriting', async () => {
  const db = new TestD1();
  try {
    const created = await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal());
    assert.equal(created.status,201); assert.equal(created.result.duplicate,false);
    const replay = await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal({source_ref:'synthetic:different-ref',created_at:'2026-11-01T10:00:03+09:00'}));
    assert.equal(replay.status,200); assert.equal(replay.result.duplicate,true);
    assert.equal(replay.result.id,created.result.id);
    assert.equal((await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal({payload:{menu_name:'Other noodles'}}))).status,409);
    const list = await call(db,'GET','/v1/candidates',OWNER_TOKEN);
    assert.equal(list.result.candidates.length,1);
    assert.equal(list.result.candidates[0].candidate.payload.menu_name,'Example noodles');
  } finally { db.close(); }
});
test('only owner may reject; rejection is idempotent and change cursor is monotonic', async () => {
  const db = new TestD1();
  try {
    const inserted = await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal());
    const id=inserted.result.id;
    assert.equal((await call(db,'POST',`/v1/candidates/${id}/reject`,CHATGPT_TOKEN)).status,403);
    assert.equal((await call(db,'POST',`/v1/candidates/${id}/reject`,OWNER_TOKEN)).status,200);
    assert.equal((await call(db,'POST',`/v1/candidates/${id}/reject`,OWNER_TOKEN)).status,200);
    const changes=await call(db,'GET','/v1/changes?cursor=0&limit=1',READER_TOKEN);
    assert.equal(changes.result.changes.length,1);
    assert.equal(changes.result.changes[0].event_status,'pending');
    const more=await call(db,'GET',`/v1/changes?cursor=${changes.result.next_cursor}`,READER_TOKEN);
    assert.equal(more.result.changes.length,1);
    assert.equal(more.result.changes[0].event_status,'rejected');
    const final=await call(db,'GET',`/v1/changes?cursor=${more.result.next_cursor}`,OWNER_TOKEN);
    assert.equal(final.result.changes.length,0);
    assert.equal((await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal())).result.status,'rejected');
  } finally { db.close(); }
});
test('read scopes and invalid input are enforced', async () => {
  const db = new TestD1();
  try {
    assert.equal((await call(db,'GET','/v1/candidates',READER_TOKEN)).status,403);
    assert.equal((await call(db,'GET','/v1/changes',CHATGPT_TOKEN)).status,403);
    assert.equal((await call(db,'GET','/v1/changes?cursor=-1',OWNER_TOKEN)).status,400);
    assert.equal((await call(db,'GET','/v1/candidates?limit=999',OWNER_TOKEN)).status,400);
    assert.equal((await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,{...meal(),raw_conversation:'secret'})).status,400);
    assert.equal((await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal({payload:{menu_name:'X',raw_message:'not allowed'}}))).status,400);
    const tooLong = meal({payload:{menu_name:'x'.repeat(17*1024)}});
    assert.equal((await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,tooLong)).status,413);
  } finally { db.close(); }
});
test('D1 owner scoping, injection text and trigger journal hold', async () => {
  const db=new TestD1();
  try {
    const untrusted=meal({ payload:{menu_name:"'); DROP TABLE inbox; --"} });
    await insertCandidate(db,'another-owner',untrusted,'2026-11-01T01:01:00Z');
    await call(db,'POST','/v1/candidates',CHATGPT_TOKEN,meal());
    assert.equal((await listCandidates(db,'demo-owner',null,10)).length,1);
    assert.equal((await listCandidates(db,'another-owner',null,10)).length,1);
    assert.equal((await call(db,'GET','/v1/changes',OWNER_TOKEN)).result.changes.length,1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM inbox').get().n,2);
  } finally { db.close(); }
});
test('no cross-origin browser access headers and no unverified confirmation endpoint', async () => {
  const db=new TestD1();
  try {
    const v=await call(db,'GET','/v1/candidates',OWNER_TOKEN);
    assert.equal(v.headers.get('Access-Control-Allow-Origin'),null);
    assert.equal(v.headers.get('Cache-Control'),'no-store');
    assert.equal((await call(db,'POST','/v1/candidates/12345678-1234-1234-1234-123456789abc/confirm',OWNER_TOKEN)).status,404);
  } finally { db.close(); }
});
