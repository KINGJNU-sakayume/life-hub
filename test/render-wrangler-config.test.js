import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderWranglerConfig } from '../scripts/render-wrangler-config.mjs';

const example = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
const ID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

test('renders the committed example with a synthetic database ID', () => {
  const out = renderWranglerConfig(example, ID);
  assert.ok(out.includes(`"database_id": "${ID}"`));
  assert.ok(!out.includes('REPLACE_WITH_YOUR_D1_DATABASE_ID'));
  assert.ok(out.includes('"binding": "DB"'));
});

test('rejects missing, malformed or injected database IDs', () => {
  for (const bad of [undefined, '', 'life-hub-private', `${ID}", "x": "y`, `${ID}\n`.repeat(2)])
    assert.throws(() => renderWranglerConfig(example, bad), /D1_DATABASE_ID/);
});

test('refuses an example without exactly one placeholder', () => {
  assert.throws(() => renderWranglerConfig('{}', ID), /placeholder/);
});
