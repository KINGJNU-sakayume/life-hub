/**
 * MCP tools exposed to an authorized Claude, Codex or ChatGPT connection.
 *
 * Model-visible tools only PROPOSE a candidate into the private inbox (status: pending) or read the
 * status of a candidate this connector proposed. Nothing writes to a destination app directly.
 *
 * The card_* tools are the one exception and are NOT for the model: MCP Apps app-only tools
 * (`_meta.ui.visibility: ["app"]`), listed only for a Claude grant that carries hub:approve, and each call
 * needs the single-use ticket the server put in the proposal result's `_meta` (which hosts hand to the
 * card UI, not to the model). They let the owner edit, approve or reject from the Claude card.
 */
import { canonical } from '../core/candidates.js';
import {
  insertCandidate, getCandidate, listDestinationCandidates, StoreFailure, finalEnvelope, issueCardTicket, readCardCandidate, getDestinationRefs, findCandidateByKey,
  editCardCandidate, approveCardCandidate, rejectCardCandidate,
} from '../server/store.js';
import { cardFor } from './cards/index.js';
import { KYEOKYEOI_EMOTIONS } from '../adapters/kyeokyeoi.js';
import { diaryDate, MISSION_ID } from '../adapters/diaryroulette.js';
import { destinationById, ADAPTER_ERROR } from '../destinations.js';
import { READING_PREVIEW_URI } from './reading-widget.js';

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
const definitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'tier', 'condition_type'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 40, description: 'Short, fun achievement name in Korean (e.g. "한강 100km", "새벽 러너").' },
    description: { type: 'string', minLength: 1, maxLength: 200, description: 'One sentence saying what to do, as the app phrases it (e.g. "러닝 기록을 모두 더해 100km를 달려 보세요.").' },
    category: { type: 'string', minLength: 1, maxLength: 60, description: 'Category whose records count (subcategories included), as the app names it. Defaults: ' + ACHIEVEMENT_CATEGORIES + '. Omit only for an achievement over every record. The owner confirms it.' },
    tier: { type: 'string', enum: ['bronze', 'silver', 'gold', 'platinum', 'diamond'], description: 'Difficulty: bronze 처음 해 보는 일, silver 조금씩 쌓이는 습관, gold 꾸준함이 필요한 목표, platinum 몇 달은 걸리는 큰 목표, diamond 손에 꼽을 만한 기록.' },
    condition_type: { type: 'string', enum: ['count', 'total', 'streak', 'tag', 'tag_count'], description: 'count: target records. total: record values add up to target in unit. streak: target consecutive days. tag: one record tagged tag. tag_count: target records tagged tag.' },
    target: { type: 'number', minimum: 0, maximum: 1000000000, description: 'Goal number: a whole number for count/streak/tag_count, any positive amount for total. Not for tag.' },
    unit: { type: 'string', minLength: 1, maxLength: 20, description: 'Unit of a total goal only (km, 분, 시간, 권, 원, 만원, L, 걸음, kg, 회 …).' },
    tag: { type: 'string', minLength: 1, maxLength: 30, description: 'One-word keyword without "#", for tag/tag_count (e.g. 남산, 대회, 새벽).' },
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
const reviewSchema = {
  type: 'object', additionalProperties: false, required: [],
  properties: { candidate_id: { type: 'string', pattern: '^[0-9a-f-]{36}$', description: 'A specific album returned by an earlier review_listening call; omit for the next one.' } },
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
    description: 'PREVIEW ONLY, no data is saved. When a ChatGPT user reports reading progress or finishing a book, call this first to display an editable reading-record card for letterbookxd. They can correct title, state, pages and notes, then explicitly submit the PENDING proposal from the card. If no card displays, present the draft in text and ask for confirmation before calling propose_reading_record.',
    inputSchema: readingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: READING_PREVIEW_URI } },
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
    name: 'propose_achievement',
    title: 'Propose a custom achievement for 업적 라이브러리',
    description: 'Propose ONE new custom achievement (a goal) when the user asks to create, add or set one in 업적 라이브러리 ("러닝 누적 100km 업적 만들어줘", "30일 연속 독서 업적 추가해줘"). Never for an activity they did (use propose_activity_record) and never unasked. Pick the tier by difficulty and the simplest fitting condition. Its progress counts the owner\'s existing records too. ' + pendingNote('업적 라이브러리') + ' Identical proposals are de-duplicated.',
    inputSchema: definitionSchema,
    annotations: WRITE,
  },
  {
    name: 'review_listening',
    title: 'Review listened albums for potcast',
    description: 'Show ONE album listening waiting for review in potcast (albums Life Hub collected from Spotify every hour, or ones proposed earlier), when the user asks to check or review the albums they listened to. The owner checks each track (listened / skipped) and approves in the card or in potcast. Call again to show the next album. Never approve, reject or change tracks on the owner\'s behalf.',
    inputSchema: reviewSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    name: 'propose_station_draw',
    title: 'Draw a station for 역 도장깨기',
    description: 'Draw a random station for the user\'s 역 도장깨기 when they ask for a station draw, a random station to visit, or where to go next. Takes no input: Life Hub draws a line, then a station, from what the app says can be drawn now (the lines switched on, the area, and unvisited stations if the owner chose that). Never pick or suggest a station yourself. Approved (「여기 갈래요」), it becomes the app\'s current destination; it never stamps a visit. Asking again draws again.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
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
  {
    name: 'propose_daily_mission',
    title: 'Spin today\'s 일기 룰렛 mission',
    description: 'Spin the user\'s 일기 룰렛 (diary roulette) for today\'s writing mission, when they ask for a diary mission, the roulette, or what to write today. Takes no input: Life Hub draws from the missions the app says are available today (the app keeps a 7-day cooldown and one mission per day; asking again the same day returns the same mission). Never pick, suggest or re-roll a mission yourself. If the app already drew today\'s mission, the result shows that one. The owner confirms with 「일기 쓰기」 in the card or in the app; the diary itself is written only in the app.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: WRITE,
  },
]);

/* ---------- Card-only tools (MCP Apps visibility ["app"]) ---------- */
const HUB_APPROVE = 'hub:approve';
const APP_ONLY = Object.freeze({ ui: Object.freeze({ visibility: Object.freeze(['app']) }) });
const cardRef = {
  candidate_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
  ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
};
const revision = { type: 'integer', minimum: 0 };
const CARD_NOTE = 'Card UI only; never call this yourself.';
export const CARD_TOOLS = Object.freeze([
  { name: 'card_refresh', title: 'Card: reload', description: CARD_NOTE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['candidate_id', 'ticket'], properties: { ...cardRef } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: APP_ONLY },
  { name: 'card_edit', title: 'Card: save the owner\'s edit', description: CARD_NOTE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['candidate_id', 'ticket', 'revision', 'payload'],
      properties: { ...cardRef, revision, payload: { type: 'object' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: APP_ONLY },
  { name: 'card_approve', title: 'Card: owner approves', description: CARD_NOTE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['candidate_id', 'ticket', 'revision'],
      properties: { ...cardRef, revision, app_review: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: APP_ONLY },
  { name: 'card_reject', title: 'Card: owner rejects', description: CARD_NOTE,
    inputSchema: { type: 'object', additionalProperties: false, required: ['candidate_id', 'ticket'], properties: { ...cardRef } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: APP_ONLY },
]);
const CARD_TOOL_NAMES = new Set(CARD_TOOLS.map((t) => t.name));
const PROPOSE_DESTINATION = Object.freeze({
  propose_food_meal: 'food', propose_food_wish: 'food', propose_album_listening: 'potcast', review_listening: 'potcast', propose_activity_record: 'achievement', propose_achievement: 'achievement',
  propose_reading_record: 'letterbookxd', propose_station_visit: 'sub', propose_station_draw: 'sub', propose_media_progress: 'animan',
  propose_memory: 'kyeokyeoi', propose_region_visit: 'kyeokyeoi', propose_daily_mission: 'diaryroulette',
});
/** Cards are a Claude feature for now; the card may approve only with an explicit hub:approve grant. */
const isClaude = (context) => (context.source ?? 'claude') === 'claude';
export const canUseCards = (context) => isClaude(context) && (context.scopes ?? []).includes(HUB_APPROVE);

/** The tool list this connection sees. */
export function toolsFor(context) {
  const source = context.source ?? 'claude';
  let tools = source === 'chatgpt' ? [...TOOLS] : TOOLS.filter((t) => t.name !== 'preview_reading_record');
  if (source !== 'claude') return tools;
  tools = tools.map((t) => {
    const card = cardFor(PROPOSE_DESTINATION[t.name]);
    // `ui/resourceUri` is the older flat key some hosts still read; `ui.resourceUri` is the current one.
    return card ? { ...t, _meta: { ui: { resourceUri: card.uri }, 'ui/resourceUri': card.uri } } : t;
  });
  return canUseCards(context) ? [...tools, ...CARD_TOOLS] : tools;
}

/**
 * What the card renders. Never contains the ticket. `refs` (the app's reference lists for pickers, e.g.
 * 켜켜이's 시군구) is passed only for card_* results, which the host gives to the card and not to the model.
 */
function cardView(rec, context, refs, extra) {
  const destination = destinationById(rec.destination);
  const card = cardFor(rec.destination);
  return {
    v: 1, candidate_id: rec.id, destination: rec.destination, app: destination.app,
    app_url: context.appUrls?.[rec.destination] ?? null,
    type: rec.candidate.candidate_type, label: card.labels[rec.candidate.candidate_type] ?? destination.app,
    status: rec.status, revision: rec.revision, payload: finalEnvelope(rec).payload, needs_app_review: rec.needs_app_review,
    approve: !canUseCards(context) ? 'scope' : destination.card?.approve ? 'ok' : 'app',
    ...(refs ? { refs } : {}),
    ...(extra ?? {}),
  };
}

/**
 * Reference list items by kind for the card (`cardRefKinds`, else every declared kind). A station draw card
 * only needs the drawn line's stations.
 */
async function cardRefs(context, rec) {
  const d = destinationById(rec.destination);
  const kinds = d?.cardRefKinds ?? d?.refKinds ?? [];
  if (!kinds.length) return undefined;
  const stored = await getDestinationRefs(context.db, context.ownerId, rec.destination);
  const refs = Object.fromEntries(kinds.map((k) => [k, stored[k]?.items ?? []]));
  if (rec.candidate.candidate_type === 'station_draw' && refs.stations) {
    const line = finalEnvelope(rec).payload.line;
    refs.stations = refs.stations.filter((s) => s.group === line);
  }
  return refs;
}

/** AniMan titles, as its findSeries: NFKC, lower case, letters and digits; "제목 (원제)" also matches each part. */
const normTitle = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const titleParts = (t) => [t, t.replace(/\s*[([].*?[)\]]\s*/g, ' '), ...[...t.matchAll(/[([](.*?)[)\]]/g)].map((m) => m[1])].map(normTitle).filter(Boolean);
/** Series a proposed title means exactly (the app saves without asking only when there is one). */
export function seriesMatches(title, series) {
  const wanted = normTitle(title);
  return wanted ? (series ?? []).filter((s) => titleParts(s.label).includes(wanted)) : [];
}

/**
 * Whether 책장 can record a proposed book as is, like its findWorks/publishersOf/volumesOf: the title (and the
 * author when given) means exactly one work, and that work has one publisher (or the named one) and one volume
 * (or the named one) there.
 */
export function bookMatch(payload, refs) {
  const title = normTitle(payload.title ?? '');
  const author = payload.author ? normTitle(payload.author) : '';
  const works = title ? (refs?.works ?? []).filter((w) => {
    const g = normTitle(w.group ?? '');
    return normTitle(w.label) === title && (!author || (g && (g.includes(author) || author.includes(g))));
  }) : [];
  if (works.length !== 1) return false;
  const editions = (refs?.editions ?? []).filter((e) => String(e.group).startsWith(works[0].id + '/'));
  const one = (list, want) => (list.length === 1 ? list : want === undefined ? [] : list.filter((x) => x === want));
  const publishers = one([...new Set(editions.map((e) => normTitle(e.label)))], payload.publisher ? normTitle(payload.publisher) : undefined);
  if (publishers.length !== 1) return false;
  const volumes = editions.filter((e) => normTitle(e.label) === publishers[0]).map((e) => Number(String(e.group).split('/')[1]));
  return one(volumes, payload.volume).length === 1;
}

/** 역 도장깨기 names: '망원역' and '망원' are the same; '신촌(경의중앙)' only matches itself. */
const bareStation = (name) => String(name).normalize('NFKC').replace(/\s+/g, '').replace(/\(.*\)$/, '').replace(/역$/, '');
/** Distinct stations a proposed name could mean (like the app's findStations, without the line hint). */
export function stationMatches(name, stations) {
  const exact = /\(.*\)$/.test(name) ? [name] : null;
  const wanted = bareStation(name);
  return [...new Set((stations ?? []).map((s) => s.label).filter((l) => (exact ? exact.includes(l) : bareStation(l) === wanted)))];
}

/**
 * Whether the app must still ask the owner, whatever the card sent: approval in the card never saves
 * something the app cannot save as-is. PALATE needs a meal's date, verdict and reorder intent; 켜켜이
 * needs a 시군구 that is exactly one of the labels it shared (a visit always, a memory when it has a place).
 */
export function needsAppReview(destination, type, payload, refs) {
  if (destination === 'food' && type === 'meal') return !payload.eaten_at || !payload.verdict || !payload.reorder_intent;
  if (destination === 'achievement') {
    // The record (or achievement) must land in exactly one of the owner's categories; an achievement may have none.
    const hits = (refs?.categories ?? []).filter((c) => c.label === payload.category).length;
    return type === 'achievement_definition' && payload.category === undefined ? false : hits !== 1;
  }
  // potcast finds the album on Spotify by its ID or a track ID; without either it must ask.
  if (destination === 'potcast') return !payload.spotify_album_id && !(payload.tracks ?? []).some((t) => t.spotify_track_id);
  if (destination === 'animan') return seriesMatches(payload.title, refs?.series).length !== 1;
  if (destination === 'letterbookxd') return !bookMatch(payload, refs);
  if (destination === 'sub' && type === 'station_visit') return stationMatches(payload.station, refs?.stations).length !== 1;
  if (destination === 'kyeokyeoi') {
    const labels = new Set((refs?.regions ?? []).map((r) => r.label));
    const exact = typeof payload.region_hint === 'string' && labels.has(payload.region_hint);
    if (type === 'visit') return !exact;
    if (type === 'memory') return payload.region_hint ? !exact : Boolean(payload.place_text);
  }
  return false;
}

function cardPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 8192 ||
      Object.values(value).some((v) => typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && !Array.isArray(v)))
    throw new ToolInputError('payload must be a small object of field values.');
  return value;
}

async function callCardTool(name, args, context) {
  if (!canUseCards(context)) return null;
  const at = new Date(context.now()).toISOString();
  const schema = CARD_TOOLS.find((t) => t.name === name).inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('Arguments must be an object.');
  const unknown = Object.keys(args).filter((k) => !(k in schema.properties));
  if (unknown.length) throw new ToolInputError(`Unknown field(s): ${unknown.join(', ')}.`);
  for (const key of schema.required) if (args[key] === undefined) throw new ToolInputError(`Missing required field: ${key}.`);
  if (!/^[0-9a-f-]{36}$/.test(args.candidate_id)) throw new ToolInputError('Invalid candidate_id.');
  if ('revision' in schema.properties && (!Number.isInteger(args.revision) || args.revision < 0)) throw new ToolInputError('Invalid revision.');
  const card = async (rec, text) => ({ content: [{ type: 'text', text }], structuredContent: { card: cardView(rec, context, await cardRefs(context, rec)) } });
  const { db, ownerId } = context;
  try {
    if (name === 'card_refresh') {
      const rec = await readCardCandidate(db, ownerId, args.candidate_id, args.ticket, at);
      if (!cardFor(rec.destination)) throw new StoreFailure(404, 'No card for this candidate');
      return card(rec, `Candidate is ${rec.status}.`);
    }
    if (name === 'card_edit') {
      const rec = await editCardCandidate(db, ownerId, args.candidate_id, args.ticket, args.revision, cardPayload(args.payload), at);
      return card(rec, 'The owner edited the proposal in the card. It is still pending.');
    }
    if (name === 'card_approve') {
      if (args.app_review !== undefined && typeof args.app_review !== 'boolean') throw new ToolInputError('app_review must be true or false.');
      const current = await readCardCandidate(db, ownerId, args.candidate_id, args.ticket, at);
      if (!destinationById(current.destination)?.card?.approve)
        throw new ToolInputError(`${appName(current.destination)} does not accept card approval yet; review it in the app.`);
      const forced = needsAppReview(current.destination, current.candidate.candidate_type, finalEnvelope(current).payload, await cardRefs(context, current));
      const rec = await approveCardCandidate(db, ownerId, args.candidate_id, args.ticket, args.revision, { appReview: args.app_review === true || forced }, at);
      return card(rec, `The owner approved it in the card. ${appName(rec.destination)} saves it the next time it syncs; it is not saved yet.`);
    }
    const rec = await rejectCardCandidate(db, ownerId, args.candidate_id, args.ticket, at);
    return card(rec, 'The owner rejected the proposal in the card.');
  } catch (error) {
    if (error instanceof StoreFailure && [403, 404, 409].includes(error.status)) {
      const code = error.status === 403 ? 'expired' : error.status === 409 ? 'conflict' : 'missing';
      return { content: [{ type: 'text', text: error.message }], structuredContent: { error: code }, isError: true };
    }
    if (ADAPTER_ERROR.test(String(error?.message)))
      throw new ToolInputError('The edit did not pass the destination\'s validation. Check the field formats.');
    throw error;
  }
}

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
  // Food keeps its original formula so earlier proposals still de-duplicate. A daily mission is one per diary
  // day whatever was drawn, so asking again the same day returns the same mission (the app's own rule).
  if (destination === 'diaryroulette') payload = { date: payload.date };
  const parts = destination === 'food' ? [source, candidateType, canonical(payload)] : [source, destination, candidateType, canonical(payload)];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return 'mcp-' + [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const appName = (destination) => destinationById(destination)?.app ?? destination;

async function propose(context, destination, candidateType, payload, extra) {
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
  let text = result.duplicate ?
    `An identical proposal is already in the inbox (candidate_id ${result.id}, status ${result.status}). Nothing new was added. If this is a different occasion, include a date or a distinguishing note.` :
    `Proposal saved for review (candidate_id ${result.id}, status pending). ${pendingNote(appName(destination))}`;
  return withCard(context, result, text, structured, extra);
}

/**
 * Adds the Life Hub card for a candidate (Claude only): its view in structuredContent and, with hub:approve
 * and while pending, a single-use ticket in the result _meta — never in content or structuredContent.
 */
async function withCard(context, rec, text, structured, extra) {
  let meta;
  if (isClaude(context) && cardFor(rec.destination)) {
    structured.card = cardView(rec, context, undefined, extra?.(rec));
    if (canUseCards(context) && rec.status === 'pending')
      meta = { 'life-hub/card': { ticket: (await issueCardTicket(context.db, context.ownerId, rec.id, context.now())).ticket } };
    text += ' The owner may review it in the Life Hub card; never approve or reject on their behalf.';
  }
  return { text, structured, meta };
}

/**
 * potcast: show one pending album (Spotify-collected first, oldest first) as a card, so albums the hourly
 * collection found can be reviewed in a conversation. Reads only; the card's ticket is the one write.
 */
async function reviewListening(context, args) {
  const { candidate_id: wanted } = pick(args ?? {}, reviewSchema);
  if (wanted !== undefined && !/^[0-9a-f-]{36}$/.test(wanted)) throw new ToolInputError('candidate_id must be one returned by review_listening.');
  const pending = (await listDestinationCandidates(context.db, context.ownerId, 'potcast', 'pending', 100))
    .sort((a, b) => Number(b.source === 'spotify') - Number(a.source === 'spotify') || (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
  if (!pending.length) return { text: 'No album listening is waiting for review in potcast.', structured: { status: 'empty', remaining: 0 } };
  const rec = wanted ? pending.find((r) => r.id === wanted) : pending[0];
  if (!rec) throw new ToolInputError('That album is not waiting for review (it may be decided already).');
  const p = finalEnvelope(rec).payload;
  const listened = p.whole_album ? 'the whole album' : `${p.tracks.filter((t) => t.status === 'listened').length} listened, ${p.tracks.filter((t) => t.status === 'skipped').length} skipped`;
  const remaining = pending.length - 1;
  const from = rec.source === 'spotify' ? 'collected from Spotify' : 'proposed in a conversation';
  const text = `"${p.album}" by ${p.artist}${p.listened_on ? ` (${p.listened_on})` : ''}, ${from}: ${listened}. ` +
    (remaining ? `${remaining} more album(s) are waiting; call review_listening again to show the next. ` : 'No other album is waiting. ') +
    'Do not change track statuses yourself.';
  return withCard(context, rec, text, { candidate_id: rec.id, status: rec.status, remaining });
}

/** Uniform random index without modulo bias. */
function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

/**
 * 일기 룰렛: Life Hub draws today's mission only from what the app shared (its mission list minus missions
 * resting in its 7-day cooldown). A mission the app already drew today is shown as is; nothing is drawn then.
 * The app re-checks everything before saving, so this never decides the day's mission on its own.
 */
async function proposeDailyMission(context) {
  const destination = 'diaryroulette';
  if (!acceptedScopes(destination).some((s) => (context.scopes ?? []).includes(s)))
    throw new ToolInputError(`This Life Hub connection was authorized before ${appName(destination)} was added. Ask the user to reconnect the Life Hub MCP server in their client, then try again.`);
  const refs = await getDestinationRefs(context.db, context.ownerId, destination);
  const missions = (refs.missions?.items ?? []).filter((m) => MISSION_ID.test(m.id));
  if (!missions.length)
    throw new ToolInputError(`${appName(destination)} has not shared its missions with Life Hub yet. Ask the user to connect 일기 룰렛 to Life Hub (in the app) and open it once, then try again.`);
  const date = diaryDate(context.now());
  const state = refs.state?.items ?? [];
  const byId = new Map(missions.map((m) => [m.id, m]));
  const today = state.find((s) => s.group === 'today:' + date && byId.has(s.id));
  const describe = (m) => `"${m.label}"${m.group ? ` (${m.group})` : ''}`;
  if (today) {
    const mission = byId.get(today.id);
    const structured = { status: 'drawn', date, mission_id: mission.id };
    if (isClaude(context))
      structured.card = {
        v: 1, candidate_id: null, destination, app: appName(destination), app_url: context.appUrls?.[destination] ?? null,
        type: 'daily_mission', label: '오늘의 미션', status: 'drawn', revision: 0, payload: { date, mission_id: mission.id },
        needs_app_review: false, approve: 'app', mission,
      };
    return { text: `Today's 일기 룰렛 mission was already drawn in the app: ${describe(mission)}. Nothing new was drawn. The user writes it in the app.`, structured };
  }
  // Asked again the same day: keep the mission already drawn through Life Hub (no re-roll).
  const key = await idempotencyKey(destination, 'daily_mission', { date }, sourceFor(context));
  const earlier = await findCandidateByKey(context.db, context.ownerId, destination, sourceFor(context), key);
  let missionId = earlier?.candidate?.payload?.mission_id;
  if (!missionId) {
    const resting = new Set(state.filter((s) => s.group === 'resting').map((s) => s.id));
    const pool = missions.filter((m) => !resting.has(m.id));
    const from = pool.length ? pool : missions;
    missionId = from[randomIndex(from.length)].id;
  }
  const outcome = await propose(context, destination, 'daily_mission', { date, mission_id: missionId },
    (rec) => ({ mission: byId.get(rec.candidate.payload.mission_id) ?? { id: missionId, label: missionId } }));
  const mission = byId.get(missionId) ?? { id: missionId, label: missionId };
  outcome.structured.mission_id = mission.id;
  outcome.structured.date = date;
  outcome.text = (outcome.structured.duplicate ? `Today's mission was already drawn through Life Hub: ${describe(mission)}. ` : `Life Hub drew today's 일기 룰렛 mission: ${describe(mission)}. `) +
    (outcome.structured.status === 'pending' ? 'It becomes today\'s mission once the owner confirms (「일기 쓰기」 in the card, or in the app); the app checks its cooldown again. ' : `Its status is ${outcome.structured.status}. `) +
    'Do not pick or re-roll a mission yourself.' + (outcome.text.includes('Life Hub card') ? ' The owner may confirm it in the Life Hub card; never confirm or reject on their behalf.' : '');
  return outcome;
}

/**
 * 역 도장깨기: like the app's draw, a line first, then a station on it, only from the pool the app shared
 * (it already reflects lines, area and "unvisited only"). The app checks again before using it.
 */
async function proposeStationDraw(context) {
  const destination = 'sub';
  if (!acceptedScopes(destination).some((s) => (context.scopes ?? []).includes(s)))
    throw new ToolInputError(`This Life Hub connection was authorized before ${appName(destination)} was added. Ask the user to reconnect the Life Hub MCP server in their client, then try again.`);
  const refs = await getDestinationRefs(context.db, context.ownerId, destination);
  const pool = (refs.pool?.items ?? []).filter((s) => s.group && s.label);
  if (!pool.length)
    throw new ToolInputError(`${appName(destination)} has not shared which stations can be drawn (or none are left). Ask the user to connect 역 도장깨기 to Life Hub and open it once, or check its draw settings.`);
  const lines = [...new Set(pool.map((s) => s.group))];
  const line = lines[randomIndex(lines.length)];
  const onLine = pool.filter((s) => s.group === line);
  const station = onLine[randomIndex(onLine.length)].label;
  const date = new Date(context.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const outcome = await propose(context, destination, 'station_draw', { date, line, station });
  const shown = station.replace(/\(.*\)$/, '');
  outcome.structured.line = line;
  outcome.structured.station = station;
  outcome.text = `Life Hub drew ${shown}역 on ${line}. ` + (outcome.structured.status === 'pending'
    ? 'It becomes the current destination in 역 도장깨기 once the owner confirms (「여기 갈래요」 in the card, or in the app). Do not draw or suggest another station yourself.'
    : `Its status is ${outcome.structured.status}.`) + (outcome.text.includes('Life Hub card') ? ' Never confirm or reject on the owner\'s behalf.' : '');
  return outcome;
}

/** Returns { content, structuredContent, isError? }, or null for an unknown tool. Throws only for server faults. */
export async function callTool(name, args, context) {
  try {
    if (CARD_TOOL_NAMES.has(name)) return await callCardTool(name, args, context);
    if (name === 'preview_reading_record') {
      // Preview never touches D1, and is only exposed to ChatGPT, not Claude/Codex.
      if (sourceFor(context) !== 'chatgpt') return null;
      const draft = pick(args, readingSchema);
      if (draft.state === 'completed' && draft.current_page !== undefined ||
          draft.state === 'reading' && (draft.rating !== undefined || draft.liked !== undefined))
        throw new ToolInputError('Reading updates use current_page; completed books use rating/liked.');
      return {
        content: [{ type: 'text', text: 'Reading draft prepared for letterbookxd: ' + JSON.stringify(draft) + '. Nothing has been saved. Review and submit the card; when unavailable, ask the user to confirm before proposing.' }],
        structuredContent: { draft, destination: 'letterbookxd', status: 'preview' },
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
    } else if (name === 'review_listening') {
      outcome = await reviewListening(context, args);
    } else if (name === 'propose_achievement') {
      outcome = await propose(context, 'achievement', 'achievement_definition', pick(args, definitionSchema));
    } else if (name === 'propose_reading_record') {
      outcome = await propose(context, 'letterbookxd', 'reading_record', pick(args, readingSchema));
    } else if (name === 'propose_station_draw') {
      pick(args ?? {}, { required: [], properties: {} });
      outcome = await proposeStationDraw(context);
    } else if (name === 'propose_station_visit') {
      outcome = await propose(context, 'sub', 'station_visit', pick(args, stationSchema));
    } else if (name === 'propose_media_progress') {
      outcome = await propose(context, 'animan', 'media_progress', pick(args, mediaSchema));
    } else if (name === 'propose_memory') {
      outcome = await propose(context, 'kyeokyeoi', 'memory', pick(args, memorySchema));
    } else if (name === 'propose_region_visit') {
      outcome = await propose(context, 'kyeokyeoi', 'visit', pick(args, visitSchema));
    } else if (name === 'propose_daily_mission') {
      pick(args ?? {}, { required: [], properties: {} });
      outcome = await proposeDailyMission(context);
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
    return { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured, ...(outcome.meta ? { _meta: outcome.meta } : {}) };
  } catch (error) {
    if (error instanceof ToolInputError || (error instanceof StoreFailure && error.status === 409)) {
      const text = error instanceof StoreFailure ? 'A conflicting proposal already uses this key.' : error.message;
      return { content: [{ type: 'text', text }], isError: true };
    }
    throw error;
  }
}
