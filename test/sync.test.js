/**
 * Device sync (docs/P6_SYNC.md): the /sync API on its own (conditional writes, limits, isolation, pruning,
 * no document text in errors or logs), the registry rules for sync-only apps, and the OAuth scopes end to end
 * through the real OAuth library. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1, TestKV } from '../scripts/node-test/d1.mjs';
import { handleSyncRequest } from '../src/sync/api.js';
import { checkSyncDocument, syncCheckedDestinations } from '../src/sync/checks.js';
import { DESTINATIONS } from '../src/destinations.js';
import { validateHubEnvelope } from '../src/core/candidates.js';
import { toDestinationCandidate } from '../src/adapters/index.js';

// CIMD is only enabled with this compatibility flag; the Workers runtime exposes it on `Cloudflare`.
globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
const APPS = {
  animan: { page: 'https://owner.github.io/animan/lifehub/', name: 'AniMan' },
  elosorter: { page: 'https://owner.github.io/elosorter/lifehub/', name: 'ELO Sorter' },
};
const clientIdOf = (app) => APPS[app].page.replace(/lifehub\/$/, 'lifehub-client.json');
const CLIENT_DOCS = Object.fromEntries(Object.keys(APPS).map((app) => [clientIdOf(app), {
  client_id: clientIdOf(app), client_name: APPS[app].name, client_uri: APPS[app].page, redirect_uris: [APPS[app].page],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  token_endpoint_auth_method: 'none', application_type: 'web',
}]));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (CLIENT_DOCS[url]) return new Response(JSON.stringify(CLIENT_DOCS[url]), { headers: { 'Content-Type': 'application/json' } });
  return realFetch(input, init);
};
const { default: worker } = await import('../src/server/index.js');

const SENTINEL = 'SYNTHETIC-SECRET-SENTINEL-4721';
const animanDoc = (extra = {}) => ({
  app: 'animan', version: 2, exportedAt: '2026-11-03T00:00:00.000Z',
  progress: { 'series-1': { 'ep-1': { done: true, at: '2026-11-03T00:00:00.000Z' } } }, ...extra,
});
const sha256Hex = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

// ── the API on its own ───────────────────────────────────────────────────────

const make = (patch = {}) => ({
  db: new TestD1(), ownerId: 'demo-owner', now: () => Date.parse('2026-11-03T12:00:00Z'),
  destination: 'animan', prefix: '/animan/v1/sync', ...patch,
});
function send(context, method, suffix = '', { headers = {}, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return handleSyncRequest(new Request('https://hub.example' + context.prefix + suffix, {
    method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: payload,
  }), context);
}
const create = (context, doc = animanDoc()) => send(context, 'PUT', '', { headers: { 'If-None-Match': '*' }, body: doc });
const replace = (context, version, doc = animanDoc(), extra = {}) =>
  send(context, 'PUT', '', { headers: { 'If-Match': `"${version}"`, ...extra }, body: doc });

test('create, read, replace: versions go up by one and the document round-trips', async () => {
  const context = make();
  try {
    assert.equal((await send(context, 'GET')).status, 404);
    assert.equal((await send(context, 'GET', '/meta')).status, 404);
    const text = JSON.stringify(animanDoc());
    const first = await create(context);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    const meta = await first.json();
    assert.equal(meta.version, 1);
    assert.equal(meta.sha256, await sha256Hex(text));
    assert.equal(meta.written_at, '2026-11-03T12:00:00.000Z');

    const read = await (await send(context, 'GET')).json();
    assert.deepEqual(read.doc, animanDoc());
    assert.equal(read.version, 1);
    assert.equal(read.size_bytes, new TextEncoder().encode(text).length);
    const onlyMeta = await (await send(context, 'GET', '/meta')).json();
    assert.equal('doc' in onlyMeta, false);

    const next = animanDoc({ exportedAt: '2026-11-04T00:00:00.000Z' });
    assert.equal((await (await replace(context, 1, next)).json()).version, 2);
    assert.deepEqual((await (await send(context, 'GET')).json()).doc, next);
  } finally { context.db.close(); }
});

test('writes need a precondition and a stale one is refused with the current meta only', async () => {
  const context = make();
  try {
    await create(context);
    assert.equal((await send(context, 'PUT', '', { body: animanDoc() })).status, 428);
    assert.equal((await send(context, 'PUT', '', { headers: { 'If-Match': '"1"', 'If-None-Match': '*' }, body: animanDoc() })).status, 400);
    for (const bad of ['*', '"0"', '0', '"01"', 'abc', '"1', 'W/"1"', '"1","2"'])
      assert.equal((await send(context, 'PUT', '', { headers: { 'If-Match': bad }, body: animanDoc() })).status, 400, bad);
    assert.equal((await send(context, 'PUT', '', { headers: { 'If-None-Match': '"1"' }, body: animanDoc() })).status, 400);

    // First-write form on an existing document, and an old or future base version.
    for (const headers of [{ 'If-None-Match': '*' }, { 'If-Match': '"7"' }]) {
      const refused = await send(context, 'PUT', '', { headers, body: animanDoc({ note: SENTINEL }) });
      assert.equal(refused.status, 412);
      const body = await refused.json();
      assert.equal(body.current.version, 1);
      assert.equal(JSON.stringify(body).includes(SENTINEL), false);
      assert.equal('doc' in body.current, false);
    }
    assert.equal((await (await send(context, 'GET', '/meta')).json()).version, 1);
  } finally { context.db.close(); }
});

test('two writers from the same base: exactly one wins', async () => {
  const context = make();
  try {
    await create(context);
    const [a, b] = await Promise.all([
      replace(context, 1, animanDoc({ writer: 'a' }), { 'X-Device-Label': 'phone' }),
      replace(context, 1, animanDoc({ writer: 'b' }), { 'X-Device-Label': 'laptop' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 412]);
    const current = await (await send(context, 'GET')).json();
    assert.equal(current.version, 2);
    assert.equal(current.doc.writer, a.status === 200 ? 'a' : 'b');
  } finally { context.db.close(); }
});

test('a replayed write that already committed is refused, and the stored hash lets the client see it was its own', async () => {
  const context = make();
  try {
    await create(context);
    const doc = animanDoc({ edit: 'once' });
    const text = JSON.stringify(doc);
    assert.equal((await replace(context, 1, doc)).status, 200);
    const replay = await replace(context, 1, doc);
    assert.equal(replay.status, 412);
    assert.equal((await replay.json()).current.sha256, await sha256Hex(text));
  } finally { context.db.close(); }
});

test('size is a UTF-8 byte limit and the exact boundary is accepted', async () => {
  const text = JSON.stringify(animanDoc());
  const bytes = new TextEncoder().encode(text).length;
  let context = make({ limits: { maxBytes: bytes } });
  try { assert.equal((await create(context)).status, 200); } finally { context.db.close(); }
  context = make({ limits: { maxBytes: bytes - 1 } });
  try { assert.equal((await create(context)).status, 413); } finally { context.db.close(); }

  // Under the character count, over the byte count (Hangul is 3 bytes per character).
  const hangul = animanDoc({ pad: '가'.repeat(2000) });
  assert.ok(JSON.stringify(hangul).length < 4000 && new TextEncoder().encode(JSON.stringify(hangul)).length > 4000);
  context = make({ limits: { maxBytes: 4000 } });
  try { assert.equal((await create(context, hangul)).status, 413); } finally { context.db.close(); }

  // The default limit is 1 MiB.
  context = make();
  try {
    assert.equal((await create(context, animanDoc({ pad: 'a'.repeat(1048576) }))).status, 413);
    assert.equal((await send(context, 'GET')).status, 404);
  } finally { context.db.close(); }
});

test('invalid documents are 400, wrong content type is 415, and nothing of the document is echoed', async () => {
  const context = make();
  try {
    const put = (init) => send(context, 'PUT', '', { headers: { 'If-None-Match': '*' }, ...init });
    for (const raw of ['{not json ' + SENTINEL, '[1,2]', '"text"', 'null']) {
      const response = await put({ raw });
      assert.equal(response.status, 400, raw);
      assert.equal((await response.text()).includes(SENTINEL), false);
    }
    for (const doc of [{ ...animanDoc(), app: 'letterbookxd', note: SENTINEL }, { ...animanDoc(), version: 1 }, { ...animanDoc(), progress: [] },
      { app: 'animan', version: 2 }]) {
      const response = await put({ body: doc });
      assert.equal(response.status, 400, JSON.stringify(doc));
      assert.equal((await response.text()).includes(SENTINEL), false);
    }
    const wrongType = await handleSyncRequest(new Request('https://hub.example/animan/v1/sync', {
      method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*' }, body: JSON.stringify(animanDoc()),
    }), context);
    assert.equal(wrongType.status, 415);
    const badUtf8 = await handleSyncRequest(new Request('https://hub.example/animan/v1/sync', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: new Uint8Array([0x7b, 0xff, 0x7d]),
    }), context);
    assert.equal(badUtf8.status, 400);
    assert.equal((await send(context, 'GET')).status, 404);
  } finally { context.db.close(); }
});

test('no document text reaches the console, even when the database fails', async () => {
  const logged = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) { originals[name] = console[name]; console[name] = (...args) => logged.push(args.join(' ')); }
  const context = make();
  try {
    await create(context, animanDoc({ note: SENTINEL }));
    await replace(context, 9, animanDoc({ note: SENTINEL }));
    await send(context, 'PUT', '', { headers: { 'If-None-Match': '*' }, raw: '{bad ' + SENTINEL });
    context.db = { prepare() { throw new Error('boom ' + SENTINEL); } };
    const failed = await replace(context, 1, animanDoc({ note: SENTINEL }));
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes(SENTINEL), false);
  } finally {
    for (const name of Object.keys(originals)) console[name] = originals[name];
  }
  assert.equal(logged.some((line) => line.includes(SENTINEL)), false);
});

test('only the newest `keep` versions stay; a restore is a new version; old ones are readable', async () => {
  const context = make({ limits: { keep: 3 } });
  try {
    await create(context, animanDoc({ n: 1 }));
    for (const n of [2, 3, 4, 5]) assert.equal((await replace(context, n - 1, animanDoc({ n }))).status, 200);
    const listed = await (await send(context, 'GET', '/versions')).json();
    assert.deepEqual(listed.versions.map((v) => v.version), [5, 4, 3]);
    assert.equal((await send(context, 'GET', '/versions/2')).status, 404);
    assert.equal((await (await send(context, 'GET', '/versions/3')).json()).doc.n, 3);
    assert.equal((await send(context, 'GET', '/versions/0')).status, 404);

    const old = (await (await send(context, 'GET', '/versions/3')).json()).doc;
    const restored = await (await replace(context, 5, old)).json();
    assert.equal(restored.version, 6);
    assert.equal((await (await send(context, 'GET')).json()).doc.n, 3);
    assert.deepEqual((await (await send(context, 'GET', '/versions')).json()).versions.map((v) => v.version), [6, 5, 4]);
  } finally { context.db.close(); }
});

test('documents are isolated by owner and by destination', async () => {
  const db = new TestD1();
  try {
    const mine = make({ db });
    await create(mine, animanDoc({ note: SENTINEL }));
    const other = make({ db, ownerId: 'other-owner' });
    assert.equal((await send(other, 'GET')).status, 404);
    assert.equal((await send(other, 'GET', '/versions/1')).status, 404);
    assert.equal((await send(other, 'GET', '/versions')).status, 200);
    assert.deepEqual((await (await send(other, 'GET', '/versions')).json()).versions, []);
    const book = make({ db, destination: 'letterbookxd', prefix: '/letterbookxd/v1/sync' });
    assert.equal((await send(book, 'GET')).status, 404);
    assert.equal((await send(book, 'DELETE', '', { headers: { 'If-Match': '"1"' } })).status, 404);
    // Another owner's write never disturbs mine.
    assert.equal((await create(other, animanDoc({ note: 'theirs' }))).status, 200);
    assert.equal((await (await send(mine, 'GET')).json()).doc.note, SENTINEL);
    // The same document is not accepted for the wrong app.
    assert.equal((await create(book, animanDoc())).status, 400);
  } finally { db.close(); }
});

test('delete needs the current version and removes only what the client saw', async () => {
  const context = make();
  try {
    assert.equal((await send(context, 'DELETE', '', { headers: { 'If-Match': '"1"' } })).status, 404);
    await create(context);
    await replace(context, 1);
    assert.equal((await send(context, 'DELETE')).status, 428);
    assert.equal((await send(context, 'DELETE', '', { headers: { 'If-None-Match': '*' } })).status, 400);
    assert.equal((await send(context, 'DELETE', '', { headers: { 'If-Match': '"1"' } })).status, 412);
    assert.equal((await send(context, 'DELETE', '', { headers: { 'If-Match': '"2"' } })).status, 204);
    assert.equal((await send(context, 'GET')).status, 404);
    assert.deepEqual((await (await send(context, 'GET', '/versions')).json()).versions, []);
    // After a delete the first-write form works again.
    assert.equal((await (await create(context)).json()).version, 1);
  } finally { context.db.close(); }
});

test('the device label is display-only, printable ASCII up to 40 characters', async () => {
  const context = make();
  try {
    await create(context);
    assert.equal((await replace(context, 1, animanDoc(), { 'X-Device-Label': 'iPhone (Safari)' })).status, 200);
    assert.equal((await (await send(context, 'GET', '/meta')).json()).device, 'iPhone (Safari)');
    for (const bad of ['', ' ', 'x'.repeat(41), 'a\u0001b', 'tab\there']) {
      const response = await send(context, 'PUT', '', { headers: { 'If-Match': '"2"', 'X-Device-Label': bad }, body: animanDoc() });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    assert.equal((await (await send(context, 'GET', '/meta')).json()).version, 2);
  } finally { context.db.close(); }
});

test('unknown paths are 404 and wrong methods are 405 with Allow', async () => {
  const context = make();
  try {
    for (const suffix of ['/', '/nope', '/versions/', '/versions/x', '/meta/1']) assert.equal((await send(context, 'GET', suffix)).status, 404, suffix);
    const post = await send(context, 'POST', '', { body: animanDoc() });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET, PUT, DELETE');
    assert.equal((await send(context, 'PUT', '/meta')).status, 405);
    assert.equal((await send(context, 'DELETE', '/versions')).status, 405);
  } finally { context.db.close(); }
});

// ── registry rules ───────────────────────────────────────────────────────────

test('registry: every app has an inbox or sync, every sync app has a shape check, sync-only apps are never candidates', () => {
  for (const d of DESTINATIONS) {
    assert.ok(d.scope || d.sync, d.id);
    if (d.sync) {
      assert.equal(d.sync.scope, d.id + ':sync');
      assert.ok(syncCheckedDestinations().includes(d.id), `${d.id} needs a check in src/sync/checks.js`);
    }
    if (!d.scope) {
      assert.equal(d.adapter, undefined);
      assert.equal(d.types, undefined);
      assert.equal(d.card, undefined);
      assert.throws(() => validateHubEnvelope({ hub_version: 1, destination: d.id, source: 'manual', source_ref: 'manual:t',
        idempotency_key: 'sync-only-0001', created_at: '2026-11-03T00:00:00Z', candidate_type: 'x', payload: {} }));
      assert.throws(() => toDestinationCandidate({ destination: d.id }));
    }
  }
  assert.deepEqual(DESTINATIONS.filter((d) => !d.scope).map((d) => d.id), ['elosorter']);
  assert.deepEqual(syncCheckedDestinations().sort(), DESTINATIONS.filter((d) => d.sync).map((d) => d.id).sort());
  assert.equal(checkSyncDocument('food', { version: 2, tracks: [] }), false, 'a destination without a check fails closed');
  assert.equal(checkSyncDocument('elosorter', { version: 2, tracks: [] }), true);
  assert.equal(checkSyncDocument('elosorter', { version: 1, tracks: [] }), false);
  assert.equal(checkSyncDocument('letterbookxd', { app: 'letterbookxd', version: 2, logs: [], tombstones: [] }), true);
  assert.equal(checkSyncDocument('letterbookxd', { app: 'letterbookxd', version: 2, logs: [], tombstones: {} }), false);
});

// ── OAuth scopes end to end ──────────────────────────────────────────────────

const ORIGIN = 'https://hub.example';
const PAGES_ORIGIN = 'https://owner.github.io';
const PASSWORD = 'synthetic-owner-password-' + 'q'.repeat(24);
const makeEnv = (patch = {}) => ({
  DB: new TestD1(), OAUTH_KV: new TestKV(), HUB_PUBLIC_ORIGIN: ORIGIN,
  HUB_ANIMAN_REDIRECT_URI: APPS.animan.page, HUB_ELOSORTER_REDIRECT_URI: APPS.elosorter.page,
  HUB_LETTERBOOKXD_REDIRECT_URI: 'https://owner.github.io/letterbookxd/lifehub/',
  HUB_OWNER_ID: 'demo-owner', HUB_OWNER_PASSWORD: PASSWORD, ...patch,
});
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} });
const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env, ctx());
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** Connect `app` through the real consent page, ticking the given optional scopes. Returns the token response. */
async function connect(env, app, { ticked = [], scope }) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ response_type: 'code', client_id: clientIdOf(app), redirect_uri: APPS[app].page,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope, resource: ORIGIN + '/' + app });
  const pageResponse = await call(env, '/authorize?' + query);
  const html = await pageResponse.text();
  assert.equal(pageResponse.status, 200, html);
  const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
  const cookie = pageResponse.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({ handle, decision: 'approve', password: PASSWORD });
  for (const value of ticked) form.append('optional_scope', value);
  const approved = await call(env, '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: form });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('Location'));
  const tokenResponse = await call(env, '/oauth/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES_ORIGIN },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: APPS[app].page,
      client_id: clientIdOf(app), code_verifier: verifier, resource: ORIGIN + '/' + app }) });
  const token = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(token));
  return { html, token };
}
const api = (env, token, method, path, { headers = {}, body } = {}) => call(env, path, {
  method, headers: { Authorization: 'Bearer ' + token, Origin: PAGES_ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const scopesOf = (token) => token.scope.split(' ').sort();

test('an app with an inbox gets inbox and sync together, with no checkbox and no forged extras', async () => {
  const env = makeEnv();
  try {
    const plain = await connect(env, 'animan', { scope: 'animan:inbox' });
    assert.doesNotMatch(plain.html, /name="optional_scope" value="animan:sync"/);
    assert.doesNotMatch(plain.html, /name="optional_scope"/);
    assert.match(plain.html, /animan:inbox, animan:sync/, 'both scopes are listed on the consent page');
    assert.match(plain.html, /<p>이 앱의 기록을 Life Hub의 비공개 저장소에 보관하고 다른 기기에서 불러올 수 있어요\. 내용은 공개 저장소에 올라가지 않아요\.<\/p>/);
    assert.deepEqual(scopesOf(plain.token), ['animan:board', 'animan:inbox', 'animan:sync'], 'the profile, not the request, decides the grant');
    assert.equal((await api(env, plain.token.access_token, 'GET', '/animan/v1/candidates')).status, 200, 'the inbox works');

    // A grant from before 2026-11-04 holds the inbox scope only; an inbox-only access token (downscoped on refresh)
    // stands in for it: the inbox keeps working, sync answers 403 insufficient_scope so the app asks to reconnect.
    const narrowed = await call(env, '/oauth/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: PAGES_ORIGIN },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: plain.token.refresh_token,
        client_id: clientIdOf('animan'), scope: 'animan:inbox', resource: ORIGIN + '/animan' }) });
    const legacy = await narrowed.json();
    assert.equal(narrowed.status, 200, JSON.stringify(legacy));
    assert.deepEqual(scopesOf(legacy), ['animan:inbox']);
    const t = legacy.access_token;
    assert.equal((await api(env, t, 'GET', '/animan/v1/candidates')).status, 200, 'the inbox keeps working');
    const refused = await api(env, t, 'PUT', '/animan/v1/sync', { headers: { 'If-None-Match': '*' }, body: animanDoc() });
    assert.equal(refused.status, 403);
    assert.match(refused.headers.get('WWW-Authenticate') ?? '', /insufficient_scope/);
    assert.equal((await api(env, t, 'GET', '/animan/v1/sync')).status, 403);
    assert.equal((await api(env, t, 'GET', '/animan/v1/sync/versions')).status, 403);

    const forged = await connect(env, 'animan', { scope: 'animan:inbox animan:sync',
      ticked: ['letterbookxd:sync', 'elosorter:sync', 'letterbookxd:inbox', 'hub:approve'] });
    assert.deepEqual(scopesOf(forged.token), ['animan:board', 'animan:inbox', 'animan:sync'], "another app's scope in the form is never granted");

    const withSync = forged;
    const s = withSync.token.access_token;
    const preflight = await call(env, '/animan/v1/sync', { method: 'OPTIONS', headers: { Origin: PAGES_ORIGIN,
      'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, content-type, if-match, if-none-match, x-device-label' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), PAGES_ORIGIN);

    const written = await api(env, s, 'PUT', '/animan/v1/sync', { headers: { 'If-None-Match': '*', 'X-Device-Label': 'test browser' }, body: animanDoc() });
    assert.equal(written.status, 200);
    assert.equal(written.headers.get('Access-Control-Allow-Origin'), PAGES_ORIGIN);
    assert.equal((await written.json()).version, 1);
    assert.deepEqual((await (await api(env, s, 'GET', '/animan/v1/sync')).json()).doc, animanDoc());
  } finally { env.DB.close(); }
});

test('a sync-only app (ELO Sorter) has the sync scope as its one required scope and no inbox', async () => {
  const env = makeEnv();
  try {
    const { html, token } = await connect(env, 'elosorter', { scope: 'elosorter:sync' });
    assert.match(html, /ELO Sorter/);
    assert.match(html, /elosorter:sync/);
    assert.doesNotMatch(html, /name="optional_scope"/);
    assert.deepEqual(scopesOf(token), ['elosorter:board', 'elosorter:sync']);
    const t = token.access_token;
    const session = { version: 2, ownerId: 'spotify-user', tracks: [{ id: 't1' }], matches: [], compCount: 0 };
    assert.equal((await api(env, t, 'PUT', '/elosorter/v1/sync', { headers: { 'If-None-Match': '*' }, body: session })).status, 200);
    assert.deepEqual((await (await api(env, t, 'GET', '/elosorter/v1/sync')).json()).doc, session);
    for (const path of ['/elosorter/v1/candidates', '/elosorter/v1/receipts', '/elosorter/v1/refs/x'])
      assert.equal((await api(env, t, 'GET', path)).status, 404, path);
    const prm = await (await call(env, '/.well-known/oauth-protected-resource/elosorter')).json();
    assert.equal(prm.resource, ORIGIN + '/elosorter');
  } finally { env.DB.close(); }
});

test('a token reaches only its own app, and rotating the owner id invalidates it', async () => {
  const env = makeEnv();
  try {
    const { token } = await connect(env, 'animan', { scope: 'animan:inbox animan:sync' });
    const t = token.access_token;
    assert.equal((await api(env, t, 'PUT', '/animan/v1/sync', { headers: { 'If-None-Match': '*' }, body: animanDoc() })).status, 200);
    const foreign = await api(env, t, 'GET', '/letterbookxd/v1/sync');
    assert.ok([401, 403].includes(foreign.status), String(foreign.status));
    const other = await api(env, t, 'GET', '/elosorter/v1/sync');
    assert.ok([401, 403].includes(other.status), String(other.status));
    const rotated = await call({ ...env, HUB_OWNER_ID: 'rotated-owner' }, '/animan/v1/sync', { headers: { Authorization: 'Bearer ' + t } });
    assert.equal(rotated.status, 403);
    assert.equal((await call(env, '/animan/v1/sync')).status, 401, 'no token, no access');
  } finally { env.DB.close(); }
});

test('without its redirect URI an app has no profile and no sync endpoint', async () => {
  const env = makeEnv({ HUB_ELOSORTER_REDIRECT_URI: '' });
  try {
    assert.equal((await call(env, '/elosorter/v1/sync')).status, 503);
    const query = new URLSearchParams({ response_type: 'code', client_id: clientIdOf('elosorter'), redirect_uri: APPS.elosorter.page,
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', scope: 'elosorter:sync', resource: ORIGIN + '/elosorter' });
    assert.notEqual((await call(env, '/authorize?' + query)).status, 200);
  } finally { env.DB.close(); }
});
