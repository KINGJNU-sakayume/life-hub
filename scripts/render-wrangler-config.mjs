#!/usr/bin/env node
/**
 * Render the ignored wrangler.jsonc from the committed example for CI deploys.
 * The D1 database ID comes from an environment variable (a GitHub Actions secret),
 * so no account-specific value is ever committed to this public repository.
 *
 * Usage: D1_DATABASE_ID=<uuid> node scripts/render-wrangler-config.mjs [example] [output]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function renderWranglerConfig(exampleText, databaseId) {
  if (typeof databaseId !== 'string' || !UUID.test(databaseId.trim()))
    throw new Error('D1_DATABASE_ID must be the UUID shown for the D1 database in Cloudflare');
  const occurrences = exampleText.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) throw new Error(`Expected exactly one ${PLACEHOLDER} placeholder, found ${occurrences}`);
  return exampleText.replace(PLACEHOLDER, databaseId.trim().toLowerCase());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [example = 'wrangler.example.jsonc', output = 'wrangler.jsonc'] = process.argv.slice(2);
  try {
    writeFileSync(output, renderWranglerConfig(readFileSync(example, 'utf8'), process.env.D1_DATABASE_ID));
    console.log(`Wrote ${output} (database ID not printed).`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
