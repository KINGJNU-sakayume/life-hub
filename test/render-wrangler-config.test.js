import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderWranglerConfig } from '../scripts/render-wrangler-config.mjs';

const example = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const good = {
  D1_DATABASE_ID: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
  KV_NAMESPACE_ID: '0123456789abcdef0123456789ABCDEF',
  HUB_PUBLIC_ORIGIN: 'https://life-hub-api.example-subdomain.workers.dev/',
};

test('renders the committed example with synthetic values', () => {
  const out = renderWranglerConfig(example, good);
  assert.ok(out.includes(`"database_id": "${good.D1_DATABASE_ID}"`));
  assert.ok(out.includes('"id": "0123456789abcdef0123456789abcdef"'));
  assert.ok(out.includes('"HUB_PUBLIC_ORIGIN": "https://life-hub-api.example-subdomain.workers.dev"'));
  assert.ok(!out.includes('REPLACE_WITH_YOUR'));
  assert.ok(out.includes('"binding": "OAUTH_KV"') && out.includes('global_fetch_strictly_public'));
});

test('PALATE redirect URI is optional but validated when present', () => {
  assert.ok(renderWranglerConfig(example, good).includes('"HUB_PALATE_REDIRECT_URI": ""'));
  assert.ok(renderWranglerConfig(example, good).includes('"HUB_KYEOKYEOI_REDIRECT_URI": ""'));
  assert.ok(renderWranglerConfig(example, { ...good, HUB_KYEOKYEOI_REDIRECT_URI: 'https://someone.github.io/kyeokyeoi/' })
    .includes('"HUB_KYEOKYEOI_REDIRECT_URI": "https://someone.github.io/kyeokyeoi/"'));
  assert.throws(() => renderWranglerConfig(example, { ...good, HUB_KYEOKYEOI_REDIRECT_URI: 'http://x.io/' }), /HUB_KYEOKYEOI_REDIRECT_URI/);
  const out = renderWranglerConfig(example, { ...good, HUB_PALATE_REDIRECT_URI: 'https://someone.github.io/food/' });
  assert.ok(out.includes('"HUB_PALATE_REDIRECT_URI": "https://someone.github.io/food/"'));
  for (const bad of ['http://someone.github.io/food/', 'https://someone.github.io/food/#/x', 'https://x.io/a?b=1', 'https://x.io/"}'])
    assert.throws(() => renderWranglerConfig(example, { ...good, HUB_PALATE_REDIRECT_URI: bad }), /HUB_PALATE_REDIRECT_URI/, bad);
});

test('rejects missing, malformed or injected values', () => {
  const bad = [
    { D1_DATABASE_ID: undefined }, { D1_DATABASE_ID: 'life-hub-private' },
    { D1_DATABASE_ID: `${good.D1_DATABASE_ID}", "x": "y` },
    { KV_NAMESPACE_ID: '' }, { KV_NAMESPACE_ID: 'g'.repeat(32) },
    { HUB_PUBLIC_ORIGIN: 'http://life-hub-api.example.workers.dev' },
    { HUB_PUBLIC_ORIGIN: 'https://life-hub-api.example.workers.dev/mcp' },
    { HUB_PUBLIC_ORIGIN: 'https://evil.example"}, "x": {"' },
  ];
  for (const patch of bad)
    assert.throws(() => renderWranglerConfig(example, { ...good, ...patch }), /must be/, JSON.stringify(patch));
});

test('refuses an example without exactly one placeholder each', () => {
  assert.throws(() => renderWranglerConfig('{}', good), /placeholder/);
});
