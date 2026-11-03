/**
 * Card registry: which destination has a conversation card, its ui:// resource, and the label per type.
 * A destination's `card.approve` flag (src/destinations.js) decides whether the card may approve; it is
 * switched on only once that app syncs `approved` candidates.
 */
import { FOOD_CARD_URI, FOOD_CARD_HTML } from './food.js';
import { KYEOKYEOI_CARD_URI, KYEOKYEOI_CARD_HTML } from './kyeokyeoi.js';
import { DIARYROULETTE_CARD_URI, DIARYROULETTE_CARD_HTML } from './diaryroulette.js';
import { ACHIEVEMENT_CARD_URI, ACHIEVEMENT_CARD_HTML } from './achievement.js';
import { SUB_CARD_URI, SUB_CARD_HTML } from './sub.js';
import { ANIMAN_CARD_URI, ANIMAN_CARD_HTML } from './animan.js';
import { CARD_MIME, CARD_RESOURCE_META } from './shell.js';

const CARDS = Object.freeze({
  food: { uri: FOOD_CARD_URI, html: FOOD_CARD_HTML, name: 'life-hub-card-food', title: 'PALATE 기록 카드', labels: { meal: '식사 기록', wish: '먹어보기' } },
  kyeokyeoi: { uri: KYEOKYEOI_CARD_URI, html: KYEOKYEOI_CARD_HTML, name: 'life-hub-card-kyeokyeoi', title: '켜켜이 기록 카드', labels: { memory: '추억', visit: '방문' } },
  diaryroulette: { uri: DIARYROULETTE_CARD_URI, html: DIARYROULETTE_CARD_HTML, name: 'life-hub-card-diaryroulette', title: '일기 룰렛 카드', labels: { daily_mission: '오늘의 미션' } },
  achievement: { uri: ACHIEVEMENT_CARD_URI, html: ACHIEVEMENT_CARD_HTML, name: 'life-hub-card-achievement', title: '업적 라이브러리 카드', labels: { activity_record: '활동 기록', achievement_definition: '새 업적' } },
  sub: { uri: SUB_CARD_URI, html: SUB_CARD_HTML, name: 'life-hub-card-sub', title: '역 도장깨기 카드', labels: { station_visit: '역 방문', station_draw: '역 뽑기' } },
  animan: { uri: ANIMAN_CARD_URI, html: ANIMAN_CARD_HTML, name: 'life-hub-card-animan', title: 'AniMan 진행 카드', labels: { media_progress: '진행 기록' } },
});

export const cardFor = (destination) => CARDS[destination] ?? null;
export const CARD_RESOURCES = Object.freeze(Object.values(CARDS).map((c) => ({ uri: c.uri, name: c.name, title: c.title, mimeType: CARD_MIME })));
export function readCardResource(uri) {
  const card = Object.values(CARDS).find((c) => c.uri === uri);
  return card ? { uri, mimeType: CARD_MIME, text: card.html, _meta: CARD_RESOURCE_META } : null;
}
