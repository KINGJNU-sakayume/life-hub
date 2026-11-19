#!/usr/bin/env node
/**
 * Render the ignored wrangler.jsonc from the committed example for CI deploys.
 * Account-specific values come from environment variables (GitHub Actions secrets / variables),
 * so nothing account-specific is ever committed to this public repository.
 *
 * Usage: D1_DATABASE_ID=<uuid> KV_NAMESPACE_ID=<32 hex> HUB_PUBLIC_ORIGIN=https://... \
 *        [HUB_PALATE_REDIRECT_URI=https://.../food/] node scripts/render-wrangler-config.mjs [example] [output]
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
  {
    env: 'HUB_PALATE_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_PALATE_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or PALATE\'s https app URL such as https://<user>.github.io/food/ (no query or fragment)',
  },
  {
    env: 'HUB_KYEOKYEOI_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_KYEOKYEOI_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or 켜켜이\'s https app URL such as https://<user>.github.io/kyeokyeoi/ (no query or fragment)',
  },
  {
    env: 'HUB_MUSIC_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_MUSIC_REDIRECT_URI', optional: true,
    // Renamed from HUB_POTCAST_REDIRECT_URI (2026-11-19): the old variable is read when this one is empty.
    fallbackEnv: 'HUB_POTCAST_REDIRECT_URI',
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or music\'s Life Hub callback URL such as https://<user>.github.io/music/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_MUSIC_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_MUSIC_LOCAL_REDIRECT_URI', optional: true,
    fallbackEnv: 'HUB_POTCAST_LOCAL_REDIRECT_URI',
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of music run on your computer, such as http://127.0.0.1:5173/lifehub/',
  },
  // Legacy (renamed to HUB_MUSIC_*): still rendered so the old callback keeps its profile during the rollout.
  // Remove once the app no longer connects from the old address.
  {
    env: 'HUB_POTCAST_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_POTCAST_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the music app\'s old (potcast) Life Hub callback URL (legacy; use HUB_MUSIC_REDIRECT_URI)',
  },
  {
    env: 'HUB_POTCAST_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_POTCAST_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the music app\'s old (potcast) local callback (legacy; use HUB_MUSIC_LOCAL_REDIRECT_URI)',
  },
  {
    env: 'HUB_ACHIEVEMENT_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ACHIEVEMENT_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or 업적 라이브러리\'s Life Hub callback URL such as https://<user>.github.io/achievement/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_LETTERBOOKXD_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_LETTERBOOKXD_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or 책장 (letterbookxd)\'s Life Hub callback URL such as https://<user>.github.io/letterbookxd/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_SUB_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_SUB_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or 역 도장깨기 (sub)\'s Life Hub callback URL such as https://<user>.github.io/sub/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_SPOTIFY_CLIENT_ID', placeholder: 'REPLACE_WITH_YOUR_SPOTIFY_CLIENT_ID', optional: true,
    valid: /^[0-9a-f]{32}$/,
    normalize: (v) => v.trim().toLowerCase(),
    hint: 'empty, or the 32-character hex Client ID of your Spotify app',
  },
  {
    env: 'HUB_ANIMAN_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ANIMAN_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or AniMan\'s Life Hub callback URL such as https://<user>.github.io/animan/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_DIARYROULETTE_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_DIARYROULETTE_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or 일기 룰렛 (Diaryroulette)\'s Life Hub callback URL such as https://<user>.github.io/diaryroulette/ (no query or fragment)',
  },
  {
    env: 'HUB_ELOSORTER_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ELOSORTER_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or ELO Sorter\'s Life Hub callback URL such as https://<user>.github.io/elosorter/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_BOARD_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_BOARD_REDIRECT_URI', optional: true,
    valid: /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or Life Board\'s Life Hub callback URL such as https://<user>.github.io/board/lifehub/ (no query or fragment)',
  },
  {
    env: 'HUB_PALATE_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_PALATE_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_KYEOKYEOI_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_KYEOKYEOI_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_ACHIEVEMENT_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ACHIEVEMENT_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_LETTERBOOKXD_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_LETTERBOOKXD_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_SUB_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_SUB_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_ANIMAN_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ANIMAN_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_DIARYROULETTE_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_DIARYROULETTE_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_ELOSORTER_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_ELOSORTER_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
  {
    env: 'HUB_BOARD_LOCAL_REDIRECT_URI', placeholder: 'REPLACE_WITH_YOUR_BOARD_LOCAL_REDIRECT_URI', optional: true,
    valid: /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~\/-]*$/,
    normalize: (v) => v.trim(),
    hint: 'empty, or the Life Hub callback of this app run on your computer, such as http://127.0.0.1:8080/lifehub/',
  },
]);

export function renderWranglerConfig(exampleText, values) {
  let out = exampleText;
  for (const field of FIELDS) {
    // A renamed variable falls back to its old name when it is unset or empty.
    const raw = typeof values[field.env] === 'string' && values[field.env].trim() !== '' ? values[field.env] : values[field.fallbackEnv];
    const value = typeof raw === 'string' ? field.normalize(raw) : '';
    if (!(field.optional && value === '') && !field.valid.test(value)) throw new Error(`${field.env} must be ${field.hint}`);
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
