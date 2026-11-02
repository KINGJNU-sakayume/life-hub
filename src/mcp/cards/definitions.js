/**
 * Card specification registry (design-time only, no runtime permissions).
 *
 * This is the single source for visual/component contracts across future MCP Apps.
 * Existing MCP tools and destination adapters remain unchanged until their own
 * implementation phases; a card type being declared here NEVER enables a write.
 */
export const CARD_STYLE = Object.freeze({
  version: 1,
  density: 'comfortable',
  width: { compact: 360, standard: 520, expanded: 640 },
  radius: { shell: 14, field: 8, button: 8 },
  spacing: { base: 4, card: 16, section: 12 },
  typography: { title: 17, label: 12, body: 14, caption: 12 },
  palette: Object.freeze({
    light: Object.freeze({ surface: '#FFFFFF', text: '#252525', muted: '#727272', line: '#E4E4E4', accent: '#315F54' }),
    dark: Object.freeze({ surface: '#1E1E1E', text: '#F0F0F0', muted: '#A8A8A8', line: '#424242', accent: '#8CC7B3' }),
  }),
});

export const CARD_COMPONENTS = Object.freeze([
  'card-shell', 'card-heading', 'field-row', 'text-field', 'numeric-field',
  'date-field', 'select-field', 'choice-chips', 'rating-field', 'progress-meter',
  'catalog-picker', 'region-picker', 'track-checklist', 'timeline-preview',
  'media-progress', 'status-strip', 'action-footer', 'resolution-notice',
]);

/**
 * phase:
 *  existing  — destination has a proposal tool today. This is NOT a claim that a card works.
 *  planned   — requires a new, separately reviewed contract or destination.
 * dependencies: what must be resolved before the card may auto-apply.
 */
const definitions = [
  ['food', 'meal', '식사', 'meal', 'existing', ['meal-menu', 'restaurant', 'verdict'], ['meal-identity']],
  ['food', 'wish', '먹어보기', 'wish', 'existing', ['wish-kind', 'place-or-dish'], []],
  ['kyeokyeoi', 'memory', '추억', 'memory', 'existing', ['memory-title', 'time', 'place', 'emotion'], []],
  ['kyeokyeoi', 'visit', '지역 방문', 'region', 'existing', ['place', 'region-picker', 'visit-date'], ['region-code']],
  ['achievement', 'activity_record', '활동 기록', 'activity', 'existing', ['category', 'value', 'tags', 'date'], ['category-id']],
  ['achievement', 'achievement_definition', '업적 만들기', 'achievement-rule', 'planned', ['title', 'rule-kind', 'threshold', 'tags'], ['rule-validation']],
  ['animan', 'media_progress', '시청·독서 진행', 'media-progress', 'existing', ['title', 'kind', 'episode-or-volume'], ['media-identity']],
  ['animan', 'media_add', '작품 추가', 'catalog', 'planned', ['catalog-picker', 'media-type'], ['catalog-entry']],
  ['letterbookxd', 'reading_record', '독서 기록', 'reading', 'existing', ['title', 'page-or-finished', 'date', 'edition-picker'], ['edition-id']],
  ['letterbookxd', 'catalog_add', '책 추가', 'catalog', 'planned', ['catalog-picker', 'edition', 'author'], ['catalog-entry']],
  ['potcast', 'album_listening', '앨범 감상', 'track-checklist', 'existing', ['artist', 'album', 'track-checklist'], ['album-match', 'track-match']],
  ['sub', 'station_visit', '역 방문', 'station', 'existing', ['line', 'station', 'visit-date', 'sticker'], ['station-code']],
  ['sub', 'station_draw', '역 뽑기', 'station-draw', 'planned', ['line', 'random-station'], ['current-station-list']],
  ['diaryroulette', 'today_mission', '오늘의 미션', 'roulette', 'planned', ['slot', 'mission', 'deep-link'], ['mission-list', 'cooldown', 'daily-claim']],
].map(([destination, candidateType, title, variant, phase, fields, dependencies]) =>
  Object.freeze({
    id: destination + '.' + candidateType,
    destination, candidateType, title, variant, phase,
    fields: Object.freeze(fields), dependencies: Object.freeze(dependencies),
  }));

export const CARD_DEFINITIONS = Object.freeze(definitions);

/** Read-only metadata lookup; these definitions do not authorize or commit anything. */
export function cardDefinitionFor(destination, candidateType) {
  return CARD_DEFINITIONS.find((c) => c.destination === destination && c.candidateType === candidateType) ?? null;
}

/** Only a dependency-free, unambiguous match may ever qualify for unattended destination sync. */
export function canAutoApply({ dependenciesResolved = [], ownerApproved = false, autoApplyEnabled = false, ambiguous = false, sourceVersionCurrent = false } = {}, definition) {
  if (!definition || definition.phase !== 'existing' || !ownerApproved || !autoApplyEnabled ||
      ambiguous || !sourceVersionCurrent) return false;
  return definition.dependencies.every((d) => dependenciesResolved.includes(d));
}
