/**
 * MCP tools exposed to an authorized Claude, Codex or ChatGPT connection.
 *
 * Every tool only PROPOSES a candidate into the private inbox (status: pending) or reads the status
 * of a candidate this connector proposed. Nothing here can approve, confirm, edit or delete records,
 * and nothing writes to PALATE or 켜켜이 directly.
 */
import { canonical } from '../core/candidates.js';
import { insertCandidate, getCandidate, StoreFailure } from '../server/store.js';
import { KYEOKYEOI_EMOTIONS } from '../adapters/kyeokyeoi.js';
import { destinationById, ADAPTER_ERROR } from '../destinations.js';
import { READING_PREVIEW_URI } from './reading-widget.js';
import { CARD_PREVIEW_URI } from './cards/widget.js';
import { toDestinationCandidate } from '../adapters/index.js';

function sourceFor(context) {
  // This is injected by the authenticated MCP handler, never from tool arguments.
  const source = context.source ?? 'claude'; // Legacy direct unit-test contexts.
  if (!['claude', 'codex', 'chatgpt'].includes(source)) throw new Error('Invalid MCP source');
  return source;
}
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
const ACHIEVEMENT_CATEGORIES = '피트니스(러닝·걷기·등산·사이클링·수영·벤치 프레스·스쿼트·데드리프트·푸시업·턱걸이·플랭크·요가·필라테스) 건강(수면·금주·금연) 영양(요리·수분 섭취·식단 관리) 학습(독서·강의·공부·영어·일본어·중국어·스페인어) 마음 챙김(명상·일기·감사 일기·디지털 디톡스) 여행(국내·해외·캠핑) 문화생활(영화·공연·전시) 창작(글쓰기·음악·그림·사진) 커리어(업무·자격증·네트워킹) 재정(투자·저축·가계부) 기술(코딩·알고리즘) 사회활동(봉사활동·기부·헌혈) 관계(가족·친구) 생활(청소·정리·반려동물), and for milestones and one-off experiences 인생 챕터 / 경험치 / 사건사고 subcategories';
const activitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'date'],
  properties: {
    category: { type: 'string', minLength: 1, maxLength: 60, description: 'The most specific category name for the activity, as the app names it. Defaults: ' + ACHIEVEMENT_CATEGORIES + '. Use a name the user gave for their own category when they did. The owner confirms the category.' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day the activity happened (YYYY-MM-DD); today when the user is reporting it as just done. ' + DATE_RULE },
    value: { type: 'number', minimum: 0, maximum: 1000000000, description: 'Amount, only when the user gave one (5 for "5km", 30 for "30분", 2 for "2권").' },
    unit: { type: 'string', minLength: 1, maxLength: 20, description: 'Unit of value as the user said it or its usual short form: km, m, 분, 시간, 회, 세트, 쪽, 권, 원, 만원, L, ml, 잔, 걸음, kg, 개, 명, 곡. Requires value; the app converts units.' },
    tags: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 30 }, description: 'One-word Korean keywords for notable details the user mentioned, no "#": places (남산, 한라산, 한강자전거길), kinds (콘서트, 뮤지컬, 자유형, 베이킹), occasions (대회, PB, 완주, 새벽, 입사, 승진, 무지출). Achievements look for such tags.' },
    memo: { type: 'string', minLength: 1, maxLength: 500, description: 'Short note in the user\'s words. Do not paste the conversation.' },
  },
};
const readingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'state'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Book title as published in Korean when it has a Korean edition (e.g. "데미안", "죄와 벌"), without volume numbers.' },
    author: { type: 'string', minLength: 1, maxLength: 100, description: 'Author as usually written in Korean (e.g. "헤르만 헤세"), when the user said it or the title alone is ambiguous.' },
    publisher: { type: 'string', minLength: 1, maxLength: 100, description: 'Publisher / translation edition, only if the user said it (e.g. "민음사").' },
    volume: { type: 'integer', minimum: 1, maximum: 200, description: 'Volume number for multi-volume books (상/중/하 → 1/2/3), only if the user said it.' },
    state: { type: 'string', enum: ['reading', 'completed'], description: 'completed: the user finished it. reading: they are reading it (with current_page when they said where they are).' },
    current_page: { type: 'integer', minimum: 1, maximum: 20000, description: 'Page reached, reading only.' },
    rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Stars 1–5, completed only, only if the user rated it or said clearly how much they liked it.' },
    liked: { type: 'boolean', description: 'true only when the user calls it a book of their life (인생책), completed only.' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day it was finished, or of the reading update (YYYY-MM-DD). ' + DATE_RULE },
    note: { type: 'string', minLength: 1, maxLength: 500, description: 'Short note in the user\'s words, shown to the owner while reviewing.' },
  },
};
const stationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['station', 'date'],
  properties: {
    station: { type: 'string', minLength: 1, maxLength: 40, description: 'Subway station name as the user said it, e.g. "망원", "홍대입구역".' },
    line: { type: 'string', minLength: 1, maxLength: 20, description: 'Line, only if the user said it or the name is shared by different stations (e.g. "2호선", "경의중앙선", "신분당선").' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day of the visit (YYYY-MM-DD). ' + DATE_RULE },
    note: { type: 'string', minLength: 1, maxLength: 300, description: 'Short note in the user\'s words.' },
  },
};
const mediaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'kind'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 100, description: 'Series title as the user said it or its usual Korean title (e.g. "주술회전", "최애의 아이").' },
    kind: { type: 'string', enum: ['episode', 'volume'], description: 'episode: anime episodes watched. volume: manga/book volumes read.' },
    season: { type: 'integer', minimum: 1, maximum: 30, description: 'Episodes only: the season the user counted in ("2기 5화" → season 2, up_to 5). Omit when they counted from the start.' },
    up_to: { type: 'integer', minimum: 1, maximum: 5000, description: 'The user finished everything up to and including this episode/volume ("12화까지 봤어"). Use this OR numbers.' },
    numbers: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 5000 }, description: 'Only these episodes/volumes ("3화랑 5화만 봤어"). Use this OR up_to.' },
    note: { type: 'string', minLength: 1, maxLength: 300, description: 'Short note in the user\'s words.' },
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
    name: 'preview_reading_record',
    title: 'Review reading update before proposing',
    description: 'Read-only preview for reading progress or completion. Call before proposing when a ChatGPT or Claude user reports reading; render an editable card, then let the user submit the pending candidate. Without UI, ask for confirmation before propose_reading_record.',
    inputSchema: readingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: READING_PREVIEW_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'preview_food_meal',
    title: 'Review meal before proposing',
    description: 'Read-only editable PALATE meal preview. Use when the owner says they actually ate something; do not submit without user action. Text-only: request confirmation before propose_food_meal.',
    inputSchema: mealSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CARD_PREVIEW_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'preview_food_wish',
    title: 'Review food wish before proposing',
    description: 'Read-only editable PALATE wish preview for a place/dish the owner wants to try. Text-only: confirm before propose_food_wish.',
    inputSchema: wishSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CARD_PREVIEW_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'preview_memory',
    title: 'Review memory before proposing',
    description: 'Read-only editable 켜켜이 memory preview. Keep original time/place words; do not turn a memory into a region visit. Text-only: confirm before propose_memory.',
    inputSchema: memorySchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CARD_PREVIEW_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'preview_region_visit',
    title: 'Review region visit before proposing',
    description: 'Read-only editable 켜켜이 visit preview; only for a visit the owner stated. Region hints are suggestions, not validated region codes. Text-only: confirm before propose_region_visit.',
    inputSchema: visitSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CARD_PREVIEW_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'get_proposal_status',
    title: 'Check a proposal',
    description: 'Look up the review status (pending, rejected, confirmed) of any proposal previously made through this connector (any app), by the candidate_id a propose tool returned.',
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
    name: 'propose_activity_record',
    title: 'Propose an activity record for 업적 라이브러리',
    description: 'Propose ONE activity the user actually did, for their 업적 라이브러리 (a personal tracker that turns records — workouts, reading, study, saving, meditation, culture, chores, milestones — into achievements). Use only when the user says they did it, never for plans or wishes. One proposal per activity and day; several activities mean several proposals. It may accompany a proposal to another app for the same event (a concert: a 켜켜이 memory and a 공연 record; a book: a 독서 record). Fill category, the resolved date, value+unit when an amount was given, and tags for notable details. ' + pendingNote('업적 라이브러리') + ' Identical proposals are de-duplicated.',
    inputSchema: activitySchema,
    annotations: WRITE,
  },
  {
    name: 'propose_reading_record',
    title: 'Propose a reading record for 책장',
    description: 'Propose ONE book the user said they finished or are reading, for their 책장 reading log (it tracks per-volume reading state, pages, 1–5 stars and 인생책). Use only for books the user actually read or is reading, never for wishlists or recommendations. 책장 finds the book in its own catalogue; give the Korean edition title and author when you know them, and publisher/volume only if the user said them. A finished book may also deserve a 독서 record for 업적 라이브러리 if the user tracks that. ' + pendingNote('책장') + ' Identical proposals are de-duplicated.',
    inputSchema: readingSchema,
    annotations: WRITE,
  },
  {
    name: 'propose_station_visit',
    title: 'Propose a station stamp for 역 도장깨기',
    description: 'Propose ONE Seoul-area subway station the user actually got off at or visited, for their 역 도장깨기 stamp book (one stamp per station; a random draw alone never counts). Use only when the user says they went to or got off at a station, never for plans, passing through, or where they live or work unless they say they visited. One proposal per station. A visit to a neighbourhood may also deserve a 켜켜이 region visit. ' + pendingNote('역 도장깨기') + ' The owner confirms the station and adds a photo sticker in the app.',
    inputSchema: stationSchema,
    annotations: WRITE,
  },
  {
    name: 'propose_media_progress',
    title: 'Propose anime/manga progress for AniMan',
    description: 'Propose ONE progress update the user stated for an anime they watch or a manga they read, for AniMan (it maps episodes and volumes onto the original chapters). Use only when the user says they watched/read it, never for plans. Give up_to for "N화/권까지" (earlier ones count as done) or numbers for specific ones; add season only when they counted within a season. AniMan matches the series in its own catalogue. ' + pendingNote('AniMan') + ' Identical proposals are de-duplicated.',
    inputSchema: mediaSchema,
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
const acceptedScopes = (destination) => ['hub:propose', ...(destinationById(destination)?.legacyProposeScope ? [destinationById(destination).legacyProposeScope] : [])];
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
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolInputError(`${key} must be a number.`);
      out[key] = value;
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be true or false.`);
      if (value) out[key] = true;
    } else if (type === 'array' && schema.properties[key].items?.type === 'object') {
      if (!Array.isArray(value) || value.length > (schema.properties[key].maxItems ?? 100)) throw new ToolInputError(`${key} must be a list of at most ${schema.properties[key].maxItems} items.`);
      out[key] = value.map((item) => pick(item, schema.properties[key].items));
    } else if (type === 'array' && schema.properties[key].items?.type === 'integer') {
      if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v))) throw new ToolInputError(`${key} must be a list of integers.`);
      if (value.length) out[key] = [...value];
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

async function idempotencyKey(destination, candidateType, payload, source) {
  // Food keeps its original formula so earlier proposals still de-duplicate.
  const parts = destination === 'food' ? [source, candidateType, canonical(payload)] : [source, destination, candidateType, canonical(payload)];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return 'mcp-' + [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const appName = (destination) => destinationById(destination)?.app ?? destination;

async function propose(context, destination, candidateType, payload) {
  if (!acceptedScopes(destination).some((s) => (context.scopes ?? []).includes(s)))
    throw new ToolInputError(`This Life Hub connection was authorized before ${appName(destination)} was added. Ask the user to reconnect the Life Hub MCP server in their client, then try again.`);
  const source = sourceFor(context);
  const createdAt = new Date(context.now()).toISOString();
  const envelope = {
    hub_version: 1, destination, source,
    source_ref: source + '-mcp:' + createdAt.slice(0, 10),
    idempotency_key: await idempotencyKey(destination, candidateType, payload, source),
    created_at: createdAt, candidate_type: candidateType, payload,
  };
  let result;
  try {
    result = await insertCandidate(context.db, context.ownerId, envelope, createdAt);
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    // Adapter validation failures carry no user data; report them as fixable input errors.
    if (ADAPTER_ERROR.test(String(error?.message)))
      throw new ToolInputError(`The proposal did not pass ${appName(destination)} validation. Check field formats and limits (dates as YYYY-MM-DD, a month needs a year, a day needs a month, https links, emotions from the list).`);
    throw error;
  }
  const structured = { candidate_id: result.id, status: result.status, duplicate: result.duplicate };
  const text = result.duplicate ?
    `An identical proposal is already in the inbox (candidate_id ${result.id}, status ${result.status}). Nothing new was added. If this is a different occasion, include a date or a distinguishing note.` :
    `Proposal saved for review (candidate_id ${result.id}, status pending). ${pendingNote(appName(destination))}`;
  return { text, structured };
}

/** Returns { content, structuredContent, isError? }, or null for an unknown tool. Throws only for server faults. */
export async function callTool(name, args, context) {
  try {
    const previews = {
      preview_reading_record: { variant: 'reading', destination: 'letterbookxd', type: 'reading_record', schema: readingSchema },
      preview_food_meal: { variant: 'meal', destination: 'food', type: 'meal', schema: mealSchema },
      preview_food_wish: { variant: 'wish', destination: 'food', type: 'wish', schema: wishSchema },
      preview_memory: { variant: 'memory', destination: 'kyeokyeoi', type: 'memory', schema: memorySchema },
      preview_region_visit: { variant: 'visit', destination: 'kyeokyeoi', type: 'visit', schema: visitSchema },
    };
    const preview = previews[name];
    if (preview) {
      if (!['claude', 'chatgpt'].includes(sourceFor(context))) return null;
      const draft = pick(args, preview.schema);
      const payload = preview.variant === 'meal' ? {
        menu_name: draft.menu_name,
        ...(draft.place_name !== undefined ? { place_name: draft.place_name } : {}),
        ...(draft.verdict !== undefined ? { verdict: draft.verdict } : {}),
        ...(draft.reorder_intent !== undefined ? { reorder_intent: draft.reorder_intent } : {}),
        ...(draft.note !== undefined ? { note: draft.note } : {}),
        ...(draft.eaten_on !== undefined ? { eaten_at: draft.eaten_on } : {}),
      } : draft;
      // Reuse the destination's real validation. A preview is NEVER inserted.
      try {
        toDestinationCandidate({
          hub_version: 1, destination: preview.destination, source: sourceFor(context),
          source_ref: 'preview:' + new Date(context.now()).toISOString().slice(0, 10),
          idempotency_key: 'synthetic-preview-0001',
          created_at: new Date(context.now()).toISOString(),
          candidate_type: preview.type, payload,
        });
      } catch {
        throw new ToolInputError('Please check the record fields, date and field limits before previewing.');
      }
      return {
        content: [{ type: 'text', text: 'Editable ' + preview.destination + ' proposal preview, NOT saved: ' + JSON.stringify(draft) +
          '. Show the card. If no interactive card appears, ask the owner to confirm the details before proposing via the regular tool.' }],
        structuredContent: { variant: preview.variant, draft, destination: preview.destination, status: 'preview' },
      };
    }
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
    } else if (name === 'propose_activity_record') {
      outcome = await propose(context, 'achievement', 'activity_record', pick(args, activitySchema));
    } else if (name === 'propose_reading_record') {
      outcome = await propose(context, 'letterbookxd', 'reading_record', pick(args, readingSchema));
    } else if (name === 'propose_station_visit') {
      outcome = await propose(context, 'sub', 'station_visit', pick(args, stationSchema));
    } else if (name === 'propose_media_progress') {
      outcome = await propose(context, 'animan', 'media_progress', pick(args, mediaSchema));
    } else if (name === 'propose_memory') {
      outcome = await propose(context, 'kyeokyeoi', 'memory', pick(args, memorySchema));
    } else if (name === 'propose_region_visit') {
      outcome = await propose(context, 'kyeokyeoi', 'visit', pick(args, visitSchema));
    } else if (name === 'get_proposal_status' || name === 'get_food_candidate_status') {
      // The old name is still answered for clients that cached the previous tool list.
      const { candidate_id: id } = pick(args, statusSchema);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new ToolInputError('candidate_id must be the id returned by a propose tool.');
      const found = await getCandidate(context.db, context.ownerId, id, sourceFor(context));
      if (!found) throw new ToolInputError('No proposal with that candidate_id was made through this connector.');
      const structured = { candidate_id: found.id, destination: found.destination, status: found.status, received_at: found.received_at, reviewed_at: found.reviewed_at ?? null };
      outcome = { text: `Candidate ${found.id} (${appName(found.destination)}) is ${found.status}.`, structured };
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
