/**
 * MCP tools exposed to an authorized Claude connection.
 *
 * Every tool only PROPOSES a candidate into the private inbox (status: pending) or reads the status
 * of a candidate this connector proposed. Nothing here can approve, confirm, edit or delete records,
 * and nothing writes to PALATE or 켜켜이 directly.
 */
import { canonical } from '../core/candidates.js';
import { insertCandidate, getCandidate, StoreFailure } from '../server/store.js';
import { KYEOKYEOI_EMOTIONS } from '../adapters/kyeokyeoi.js';

const SOURCE = 'claude';
const pendingNote = (app) => `Saved as a PENDING proposal only. It becomes a real record only after the owner reviews and approves it in ${app}.`;
const NOT_A_RECORD = pendingNote('PALATE');

const mealSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['menu_name'],
  properties: {
    menu_name: { type: 'string', minLength: 1, maxLength: 200, description: 'Dish or menu item exactly as the user named it.' },
    place_name: { type: 'string', minLength: 1, maxLength: 200, description: 'Restaurant or place, only if the user said it.' },
    eaten_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date the meal was actually eaten (YYYY-MM-DD, user\'s local date). Only if the user stated or clearly implied it ("today", "last night"); never guess.' },
    verdict: { type: 'string', enum: ['LIKE', 'NEUTRAL', 'DISLIKE'], description: 'Only if the user expressed how it was.' },
    reorder_intent: { type: 'string', enum: ['YES', 'MAYBE', 'NO'], description: 'Only if the user said whether they would order it again.' },
    note: { type: 'string', minLength: 1, maxLength: 1000, description: 'Short note in the user\'s own words. Do not paste the conversation.' },
  },
};
const wishSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['wish_kind', 'name'],
  properties: {
    wish_kind: { type: 'string', enum: ['visit_place', 'try_menu'], description: 'visit_place for a restaurant/place, try_menu for a dish.' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    source_url: { type: 'string', maxLength: 2048, pattern: '^https://', description: 'Optional https link the user shared.' },
    note: { type: 'string', minLength: 1, maxLength: 1000 },
  },
};

const DATE_RULE = 'Resolve the date the user gave into year/month/day: if they say a month and day without a year (\"10월 8일\"), use the current year, or last year if that date is still ahead; resolve relative dates (\"어제\", \"지난주 토요일\", \"작년 크리스마스\") from today. Never derive a year from an age or school year (켜켜이 does that itself). Tell the user which year you assumed.';
const REGION_RULE = 'Your resolution of the place to a Korean 시군구 (city/county/district) as "<시·도 short> <시군구>", e.g. 고양종합운동장 → "경기 고양시 일산서구", 해운대 → "부산 해운대구". For a well-known venue or landmark, use its actual district (look it up if unsure). Omit if you cannot tell. The owner confirms it before saving.';
const memorySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80, description: 'Short title for the memory, in the user\'s words.' },
    memo: { type: 'string', minLength: 1, maxLength: 2000, description: 'The memory as the user told it. Do not paste the whole conversation.' },
    time_text: { type: 'string', minLength: 1, maxLength: 100, description: 'When it happened, exactly as the user said it (e.g. "고2 여름", "10월 8일"). Keep this even when you also fill year/month/day.' },
    year: { type: 'integer', minimum: 1900, maximum: 2100, description: 'Year of the memory. ' + DATE_RULE },
    month: { type: 'integer', minimum: 1, maximum: 12, description: 'Month, when the user gave one (requires year).' },
    day: { type: 'integer', minimum: 1, maximum: 31, description: 'Day, when the user gave one (requires year and month).' },
    place_text: { type: 'string', minLength: 1, maxLength: 100, description: 'Where it happened, as the user said it (e.g. "고양종합운동장").' },
    region_hint: { type: 'string', minLength: 1, maxLength: 60, description: REGION_RULE },
    emotions: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', enum: [...KYEOKYEOI_EMOTIONS] }, description: 'Only feelings the user expressed, from this fixed list.' },
    song_artist: { type: 'string', minLength: 1, maxLength: 100, description: 'Artist tied to the memory, e.g. the performer of a concert the user saw ("더 위켄드 콘서트" → "The Weeknd"), or a song they mention. Use the artist\'s usual name.' },
    song_title: { type: 'string', minLength: 1, maxLength: 100, description: 'Song title, only if the user named a specific song.' },
  },
};
const visitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['place_text'],
  properties: {
    place_text: { type: 'string', minLength: 1, maxLength: 100, description: 'Where the user said they went, in their words.' },
    region_hint: { type: 'string', minLength: 1, maxLength: 60, description: REGION_RULE },
    visited_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Visit date (YYYY-MM-DD) when the user gave one. ' + DATE_RULE },
    note: { type: 'string', minLength: 1, maxLength: 500, description: 'Optional short note in the user\'s words.' },
  },
};
const trackSchema = {
  type: 'object', additionalProperties: false, required: ['status'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    spotify_track_id: { type: 'string', pattern: '^[A-Za-z0-9]{22}$', description: 'From spotify_track_uri "spotify:track:<id>".' },
    status: { type: 'string', enum: ['listened', 'skipped'] },
    played_at: { type: 'string', description: 'ISO 8601 time of the play (the history file\'s "ts").' },
  },
};
const albumSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artist', 'album', 'origin'],
  properties: {
    artist: { type: 'string', minLength: 1, maxLength: 200, description: 'Album artist as Spotify names them.' },
    album: { type: 'string', minLength: 1, maxLength: 200 },
    spotify_album_id: { type: 'string', pattern: '^[A-Za-z0-9]{22}$', description: 'Only if you actually know it; potcast can find the album itself.' },
    origin: { type: 'string', enum: ['conversation', 'spotify_history'], description: 'conversation: the user told you. spotify_history: from their Spotify streaming-history file, after they confirmed this album.' },
    listened_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day of listening (YYYY-MM-DD). ' + DATE_RULE },
    whole_album: { type: 'boolean', description: 'true when the user said they listened to the whole album (conversation only). Do not send tracks then.' },
    tracks: { type: 'array', minItems: 1, maxItems: 80, items: trackSchema, description: 'Per-track result, one entry per track (latest play). Required for spotify_history.' },
    note: { type: 'string', minLength: 1, maxLength: 500 },
  },
};
const statusSchema = {
  type: 'object', additionalProperties: false, required: ['candidate_id'],
  properties: { candidate_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } },
};
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Deterministic order, as MCP recommends for client-side caching. */
export const TOOLS = Object.freeze([
  {
    name: 'get_proposal_status',
    title: 'Check a proposal',
    description: 'Look up the review status (pending, rejected, confirmed) of any proposal previously made through this connector (food, memory or visit), by the candidate_id a propose tool returned.',
    inputSchema: statusSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'propose_food_meal',
    title: 'Propose a meal for PALATE',
    description: 'Propose a meal the user has ACTUALLY eaten, for later review in their PALATE food log. Use only when the user explicitly says they ate it. Do NOT use for plans, wishes, hypotheticals, recipes, or meals they did not eat. Fill only fields the user stated. ' + NOT_A_RECORD + ' Identical proposals are de-duplicated.',
    inputSchema: mealSchema,
    annotations: WRITE,
  },
  {
    name: 'propose_food_wish',
    title: 'Propose a food wish for PALATE',
    description: 'Propose a place the user wants to visit or a dish they want to try, for later review in their PALATE wishlist. Use only when the user says they want to go or try it. ' + NOT_A_RECORD + ' Identical proposals are de-duplicated.',
    inputSchema: wishSchema,
    annotations: WRITE,
  },
  {
    name: 'propose_album_listening',
    title: 'Propose an album listening for potcast',
    description: 'Propose ONE album the user listened to on purpose (digging an artist, or sitting down to listen to an album), for review in potcast. ' +
      'Music that merely played in the background, on a playlist, radio or autoplay does not count. ' +
      'origin=conversation: the user told you ("오늘 Blond 다 들었어") — use whole_album, or tracks with their status. ' +
      'origin=spotify_history: the user gave you their Spotify Extended Streaming History (JSON). Analyse it with code, never by reading rows: use only ts, ms_played, spotify_track_uri, master_metadata_track_name, master_metadata_album_album_name, master_metadata_album_artist_name, reason_start, reason_end, shuffle, skipped, and ignore everything else (IP addresses, user agents, usernames). ' +
      'Treat as intentional only album sessions: several different tracks of the same album played close together with shuffle off. ' +
      'A track is listened when reason_end is "trackdone", or it was not skipped and ms_played ≥ 120000; otherwise skipped. Keep one entry per track (latest play). ' +
      'Before proposing from history, list the candidate albums to the user in small batches (artist, album, date range, listened/total) and propose ONLY the albums they confirm. ' +
      pendingNote('potcast') + ' Identical proposals are de-duplicated.',
    inputSchema: albumSchema,
    annotations: WRITE,
  },
  {
    name: 'propose_memory',
    title: 'Propose a memory for 켜켜이',
    description: 'Propose a personal memory for the user\'s 켜켜이 archive (places and times they lived through). Use when the user shares a memory and wants it kept, or asks you to record it; if that is unclear, ask first. Fill the form the way the user would: a short title, the memo, time_text and place_text in their words, plus your resolution of the date (year/month/day) and of the place (region_hint), and the artist/song when music is involved. Emotions only if expressed. A memory does NOT record a visit to its place. ' + pendingNote('켜켜이') + ' Identical proposals are de-duplicated.',
    inputSchema: memorySchema,
    annotations: WRITE,
  },
  {
    name: 'propose_region_visit',
    title: 'Propose a region visit for 켜켜이',
    description: 'Propose that the user has actually been to a region (city, county or district) for their 켜켜이 visit map. Use ONLY when the user explicitly says they went, visited, travelled to or stayed there. Never for plans or wishes, never because a place appears in a memory, and never inferred from where they live or work. ' + pendingNote('켜켜이') + ' The owner picks the exact region when approving.',
    inputSchema: visitSchema,
    annotations: WRITE,
  },
]);

/** hub:propose covers every destination; per-destination scopes come from older grants. */
const ACCEPTED_SCOPES = Object.freeze({
  food: ['hub:propose', 'food:propose'],
  kyeokyeoi: ['hub:propose', 'kyeokyeoi:propose'],
  potcast: ['hub:propose'],
});
export class ToolInputError extends Error {}

/** Strict argument parsing against a tool schema: unknown fields, wrong types and blanks are input errors. */
function pick(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('Arguments must be an object.');
  const allowed = Object.keys(schema.properties);
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ToolInputError(`Unknown field(s): ${unknown.join(', ')}.`);
  for (const key of schema.required) if (args[key] === undefined) throw new ToolInputError(`Missing required field: ${key}.`);
  const out = {};
  for (const key of allowed) {
    const value = args[key];
    if (value === undefined) continue;
    const type = schema.properties[key].type;
    if (type === 'integer') {
      if (!Number.isInteger(value)) throw new ToolInputError(`${key} must be an integer.`);
      out[key] = value;
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false.`);
      if (value) out[key] = true;
    } else if (type === 'array' && schema.properties[key].items?.type === 'object') {
      if (!Array.isArray(value) || value.length > (schema.properties[key].maxItems ?? 100)) throw new ToolInputError(`${key} must be a list of at most ${schema.properties[key].maxItems} items.`);
      out[key] = value.map((item) => pick(item, schema.properties[key].items));
    } else if (type === 'array') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ToolInputError(`${key} must be a list of strings.`);
      if (value.length) out[key] = value.map((v) => v.trim());
    } else {
      if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string.`);
      if (!value.trim()) throw new ToolInputError(`${key} must not be empty.`);
      out[key] = value.trim();
    }
  }
  return out;
}

async function idempotencyKey(destination, candidateType, payload) {
  // Food keeps its original formula so earlier proposals still de-duplicate.
  const parts = destination === 'food' ? [SOURCE, candidateType, canonical(payload)] : [SOURCE, destination, candidateType, canonical(payload)];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return 'mcp-' + [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const APP = Object.freeze({ food: 'PALATE', kyeokyeoi: '켜켜이', potcast: 'potcast' });

async function propose(context, destination, candidateType, payload) {
  if (!ACCEPTED_SCOPES[destination].some((s) => (context.scopes ?? []).includes(s)))
    throw new ToolInputError(`This Life Hub connection was authorized before ${APP[destination]} was added. Ask the user to reconnect the Life Hub connector in Claude's settings, then try again.`);
  const createdAt = new Date(context.now()).toISOString();
  const envelope = {
    hub_version: 1, destination, source: SOURCE,
    source_ref: 'claude-mcp:' + createdAt.slice(0, 10),
    idempotency_key: await idempotencyKey(destination, candidateType, payload),
    created_at: createdAt, candidate_type: candidateType, payload,
  };
  let result;
  try {
    result = await insertCandidate(context.db, context.ownerId, envelope, createdAt);
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    // Adapter validation failures carry no user data; report them as fixable input errors.
    if (/Invalid (Life Hub|PALATE|kyeokyeoi|potcast)|Unsupported (PALATE|kyeokyeoi|potcast)/.test(String(error?.message)))
      throw new ToolInputError(`The proposal did not pass ${APP[destination]} validation. Check field formats and limits (dates as YYYY-MM-DD, a month needs a year, a day needs a month, https links, emotions from the list).`);
    throw error;
  }
  const structured = { candidate_id: result.id, status: result.status, duplicate: result.duplicate };
  const text = result.duplicate ?
    `An identical proposal is already in the inbox (candidate_id ${result.id}, status ${result.status}). Nothing new was added. If this is a different occasion, include a date or a distinguishing note.` :
    `Proposal saved for review (candidate_id ${result.id}, status pending). ${pendingNote(APP[destination])}`;
  return { text, structured };
}

/** Returns { content, structuredContent, isError? }, or null for an unknown tool. Throws only for server faults. */
export async function callTool(name, args, context) {
  try {
    let outcome;
    if (name === 'propose_food_meal') {
      const p = pick(args, mealSchema);
      const payload = { menu_name: p.menu_name };
      for (const key of ['place_name', 'verdict', 'reorder_intent', 'note']) if (p[key] !== undefined) payload[key] = p[key];
      if (p.eaten_on !== undefined) payload.eaten_at = p.eaten_on;
      outcome = await propose(context, 'food', 'meal', payload);
    } else if (name === 'propose_food_wish') {
      outcome = await propose(context, 'food', 'wish', pick(args, wishSchema));
    } else if (name === 'propose_album_listening') {
      outcome = await propose(context, 'potcast', 'album_listening', pick(args, albumSchema));
    } else if (name === 'propose_memory') {
      outcome = await propose(context, 'kyeokyeoi', 'memory', pick(args, memorySchema));
    } else if (name === 'propose_region_visit') {
      outcome = await propose(context, 'kyeokyeoi', 'visit', pick(args, visitSchema));
    } else if (name === 'get_proposal_status' || name === 'get_food_candidate_status') {
      // The old name is still answered for clients that cached the previous tool list.
      const { candidate_id: id } = pick(args, statusSchema);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new ToolInputError('candidate_id must be the id returned by a propose tool.');
      const found = await getCandidate(context.db, context.ownerId, id, SOURCE);
      if (!found) throw new ToolInputError('No proposal with that candidate_id was made through this connector.');
      const structured = { candidate_id: found.id, destination: found.destination, status: found.status, received_at: found.received_at, reviewed_at: found.reviewed_at ?? null };
      outcome = { text: `Candidate ${found.id} (${APP[found.destination] ?? found.destination}) is ${found.status}.`, structured };
    } else {
      return null;
    }
    return { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured };
  } catch (error) {
    if (error instanceof ToolInputError || (error instanceof StoreFailure && error.status === 409)) {
      const text = error instanceof StoreFailure ? 'A conflicting proposal already uses this key.' : error.message;
      return { content: [{ type: 'text', text }], isError: true };
    }
    throw error;
  }
}
