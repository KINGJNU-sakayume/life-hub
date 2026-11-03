/**
 * Every destination app in one place. Adding an app means: an adapter (src/adapters/<id>.js), an entry
 * here, its id in core/candidates.js, its MCP tool(s), and an optional redirect variable in the deploy
 * config (scripts/render-wrangler-config.mjs, wrangler.example.jsonc, .github/workflows/deploy.yml).
 *
 * For each entry the hub serves an OAuth protected resource at `path` (scope `scope`, token role
 * `role`), a client profile chosen by the exact redirect URI in `redirectVar`, and the inbox API at
 * `<path>/v1`. Without the redirect variable the app's profile and API are off.
 * Optional: `card` (a Claude conversation card; `approve` only once the app syncs approved candidates) and
 * `refKinds` (reference lists the app may upload for card pickers).
 *
 * Optional `sync` (docs/P6_SYNC.md): the app may keep one JSON document on this Hub, served at
 * `<path>/v1/sync`. `scope` is its own OAuth scope; `maxBytes` (default 1 MiB) and `keep` (default 10 versions)
 * override the limits in src/sync/api.js. An app with an inbox (`scope`) gets the sync scope as an opt-in
 * checkbox on the consent page; a SYNC-ONLY app (no `scope`, `types` or `adapter`, e.g. elosorter) has no
 * inbox, candidates or card, and its sync scope is required. Sync-only ids must never be added to the
 * candidate destinations in src/core/candidates.js.
 */
import { toFoodCandidate } from './adapters/food.js';
import { toKyeokyeoiCandidate } from './adapters/kyeokyeoi.js';
import { toPotcastCandidate } from './adapters/potcast.js';
import { toAchievementCandidate } from './adapters/achievement.js';
import { toLetterbookxdCandidate } from './adapters/letterbookxd.js';
import { toSubCandidate } from './adapters/sub.js';
import { toAnimanCandidate } from './adapters/animan.js';
import { toDiaryrouletteCandidate } from './adapters/diaryroulette.js';

export const DESTINATIONS = Object.freeze([
  {
    id: 'food', app: 'PALATE', role: 'palate', path: '/palate', scope: 'food:inbox', legacyProposeScope: 'food:propose',
    redirectVar: 'HUB_PALATE_REDIRECT_URI', types: ['meal', 'wish'], adapter: toFoodCandidate, label: 'PALATE',
    // Conversation card (src/mcp/cards). PALATE saves `approved` candidates since its stage-2 release.
    card: { approve: true },
    grants: 'Life Hub 수신함의 <strong>음식 후보를 가져오고</strong>, PALATE에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'kyeokyeoi', app: '켜켜이', role: 'kyeokyeoi', path: '/kyeokyeoi', scope: 'kyeokyeoi:inbox', legacyProposeScope: 'kyeokyeoi:propose',
    redirectVar: 'HUB_KYEOKYEOI_REDIRECT_URI', types: ['memory', 'visit'], adapter: toKyeokyeoiCandidate, label: 'kyeokyeoi',
    // Conversation card; 켜켜이 saves `approved` candidates since its stage-2 release.
    card: { approve: true },
    // Reference lists the app may publish for card pickers (PUT /kyeokyeoi/v1/refs/<kind>).
    refKinds: ['regions'],
    grants: 'Life Hub 수신함의 <strong>추억·방문 후보를 가져오고</strong>, 켜켜이에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'potcast', app: 'potcast', role: 'potcast', path: '/potcast', scope: 'potcast:inbox',
    redirectVar: 'HUB_POTCAST_REDIRECT_URI', types: ['album_listening'], adapter: toPotcastCandidate, label: 'potcast',
    // Album card (track by track); the app records `approved` albums since its stage-7 release.
    card: { approve: true },
    grants: 'Life Hub 수신함의 <strong>앨범 감상 후보를 가져오고</strong>, potcast에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'achievement', app: '업적 라이브러리', role: 'achievement', path: '/achievement', scope: 'achievement:inbox',
    redirectVar: 'HUB_ACHIEVEMENT_REDIRECT_URI', types: ['activity_record', 'achievement_definition'], adapter: toAchievementCandidate, label: 'achievement',
    // Record/achievement card; the app saves `approved` items since its stage-4 release.
    card: { approve: true },
    // The owner's category tree (ids, names, top-level group) for the card's category picker.
    refKinds: ['categories'],
    grants: 'Life Hub 수신함의 <strong>활동 기록·새 업적 후보를 가져오고</strong>, 카테고리 이름 목록을 공유하고, 업적 라이브러리에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'letterbookxd', app: '책장', role: 'letterbookxd', path: '/letterbookxd', scope: 'letterbookxd:inbox',
    redirectVar: 'HUB_LETTERBOOKXD_REDIRECT_URI', types: ['reading_record'], adapter: toLetterbookxdCandidate, label: 'letterbookxd',
    // Reading card; the app records `approved` books since its stage-6 release.
    card: { approve: true },
    // The app's catalogue: works (id, title, author) and editions (id, publisher, "workId/volume").
    refKinds: ['works', 'editions'],
    // Reading logs sync as one document (the catalogue override stays on the device).
    sync: { scope: 'letterbookxd:sync' },
    grants: 'Life Hub 수신함의 <strong>독서 기록 후보를 가져오고</strong>, 책 목록(제목·지은이·판본)을 공유하고, 책장에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'sub', app: '역 도장깨기', role: 'sub', path: '/sub', scope: 'sub:inbox',
    redirectVar: 'HUB_SUB_REDIRECT_URI', types: ['station_visit', 'station_draw'], adapter: toSubCandidate, label: 'sub',
    // Station card (draw + stamp); the app saves `approved` items since its stage-5 release.
    card: { approve: true },
    // lines (name, colour), stations (the public line-station list) and pool (what can be drawn now, which
    // reflects "unvisited only"). The card gets lines and stations, never the pool.
    refKinds: ['lines', 'stations', 'pool'], cardRefKinds: ['lines', 'stations'],
    refLimits: { stations: { items: 800, bytes: 49152 }, pool: { items: 800, bytes: 49152 } },
    grants: 'Life Hub 수신함의 <strong>역 방문·역 뽑기 후보를 가져오고</strong>, 노선·역 목록과 지금 뽑을 수 있는 역(아직 안 간 역 설정 반영)을 공유하고, 역 도장깨기에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'animan', app: 'AniMan', role: 'animan', path: '/animan', scope: 'animan:inbox',
    redirectVar: 'HUB_ANIMAN_REDIRECT_URI', types: ['media_progress'], adapter: toAnimanCandidate, label: 'animan',
    // Progress card; the app marks `approved` progress since its stage-6 release.
    card: { approve: true },
    // Watch progress syncs as one document.
    sync: { scope: 'animan:sync' },
    // The app's catalogue: series id, title and accent colour, for the card's title list.
    refKinds: ['series'],
    grants: 'Life Hub 수신함의 <strong>애니·만화 진행 후보를 가져오고</strong>, 작품 목록(제목)을 공유하고, AniMan에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  },
  {
    id: 'diaryroulette', app: '일기 룰렛', role: 'diaryroulette', path: '/diaryroulette', scope: 'diaryroulette:inbox',
    redirectVar: 'HUB_DIARYROULETTE_REDIRECT_URI', types: ['daily_mission'], adapter: toDiaryrouletteCandidate, label: 'diaryroulette',
    // Roulette card; the app saves `approved` missions after its own day/cooldown checks.
    card: { approve: true },
    // The mission list and today's state (resting missions, a mission already drawn today) the app shares.
    refKinds: ['missions', 'state'],
    grants: 'Life Hub 수신함의 <strong>오늘의 미션 후보를 가져오고</strong>, 미션 목록과 오늘 상태(쉬는 미션·오늘 뽑은 미션)를 공유하고, 일기 룰렛에서 정한 결과를 돌려보낼 수 있어요. 일기 내용은 보내지 않아요.',
  },
  {
    // Sync-only: no inbox, candidates or card. The session lives on this Hub's private database.
    id: 'elosorter', app: 'ELO Sorter', role: 'elosorter', path: '/elosorter',
    redirectVar: 'HUB_ELOSORTER_REDIRECT_URI', label: 'elosorter',
    sync: { scope: 'elosorter:sync' },
    grants: 'ELO Sorter의 세션(곡·분류·비교 기록)을 이 Life Hub의 비공개 저장소에 <strong>보관하고 다른 기기에서 불러올 수</strong> 있어요. 내용은 공개 저장소에 올라가지 않아요.',
  },
]);

const BY_ID = new Map(DESTINATIONS.map((d) => [d.id, d]));
export const destinationById = (id) => BY_ID.get(id) ?? null;

const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[^\s#?]*$/;
/** A destination app's redirect URI comes from deploy config; null when unset or malformed. */
export function redirectUriFor(env, destination) {
  const value = env[destination.redirectVar];
  return typeof value === 'string' && HTTPS_URL.test(value) && value.length <= 300 ? value : null;
}

/** The app's public start page for card links: the redirect URI's origin + first path segment. */
export function appUrlFor(env, destination) {
  const redirect = redirectUriFor(env, destination);
  if (!redirect) return null;
  const url = new URL(redirect);
  const first = url.pathname.split('/').filter(Boolean)[0];
  return url.origin + '/' + (first ? first + '/' : '');
}

/** Adapter validation failures (no user data in the message): reported as fixable input errors. */
export const ADAPTER_ERROR = new RegExp(`^(?:Invalid Life Hub|(?:Invalid|Unsupported) (?:${DESTINATIONS.map((d) => d.label).join('|')}) )`);
