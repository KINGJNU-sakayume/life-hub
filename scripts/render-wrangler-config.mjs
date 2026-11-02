#!/usr/bin/env node
/**
 * Render the ignored wrangler.jsonc from the committed example for CI deploys.
 * Account-specific values come from environment variables (GitHub Actions secrets / variables),
 * so nothing account-specific is ever committed to this public repository.
 *
 * Usage: D1_DATABASE_ID=<uuid> KV_NAMESPACE_ID=<32 hex> HUB_PUBLIC_ORIGIN=https://... \
 *        node scripts/render-wrangler-config.mjs [example] [output]
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const FIELDS = Object.freeze([
  {
    env: 'D1_DATABASE_ID', placeholder: 'REPLACE_WITH_YOUR_D1_DATABASE_ID',
    valid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    normalize: (v) => v.trim().toLowerCase(),
    hint: 'the UUID shown for the D1 database in Cloudflare',
  },
  {
    env: 'KV_NAMESPACE_ID', placeholder: 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID',
    valid: /^[0-9a-f]{32}$/,
    normalize: (v) => v.trim().toLowerCase(),
    hint: 'the 32-character hex ID of the KV namespace in Cloudflare',
  },
  {
    env: 'HUB_PUBLIC_ORIGIN', placeholder: 'REPLACE_WITH_YOUR_PUBLIC_ORIGIN',
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/,
    normalize: (v) => v.trim().toLowerCase().replace(/\/+$/, ''),
    hint: 'the Worker origin such as https://life-hub-api.<subdomain>.workers.dev (no path)',
  },
]);

export function renderWranglerConfig(exampleText, values) {
  let out = exampleText;
  for (const field of FIELDS) {
    const raw = values[field.env];
    const value = typeof raw === 'string' ? field.normalize(raw) : '';
    if (!field.valid.test(value)) throw new Error(`${field.env} must be ${field.hint}`);
    const occurrences = out.split(field.placeholder).length - 1;
    if (occurrences !== 1) throw new Error(`Expected exactly one ${field.placeholder} placeholder, found ${occurrences}`);
    out = out.replace(field.placeholder, value);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [example = 'wrangler.example.jsonc', output = 'wrangler.jsonc'] = process.argv.slice(2);
  try {
    writeFileSync(output, renderWranglerConfig(readFileSync(example, 'utf8'), process.env));
    console.log(`Wrote ${output} (values not printed).`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
