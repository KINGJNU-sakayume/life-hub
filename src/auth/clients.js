/**
 * Which OAuth clients may connect, and what each one gets.
 *
 * A profile is chosen ONLY by the exact redirect URI the OAuth library already validated for the
 * client, so a client cannot ask for another profile's scope or resource. Every profile receives
 * exactly its own scopes, for exactly its own resource.
 */
import { DESTINATIONS, redirectUriFor, boardScope, BOARD_READ_SCOPE } from '../destinations.js';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
/** ChatGPT uses this stable callback when OAuth issuer identification is supported. */
export const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
/** Legacy/no-issuer client registrations may use a unique, bounded callback suffix. */
export function isChatgptCallback(uri) {
  return uri === CHATGPT_CALLBACK ||
    (typeof uri === 'string' && /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{8,128}$/.test(uri));
}

/**
 * Codex CLI/IDE OAuth uses an RFC 8252 loopback callback. The port changes at each login;
 * without issuer identification its callback has a server-specific suffix.
 * Only the numeric IPv4 loopback host and Codex callback paths are permitted.
 */
export function isCodexCallback(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/callback(?:\/[A-Za-z0-9_-]{8,80})?$/.test(url.pathname) &&
      (!url.port || (Number(url.port) >= 1 && Number(url.port) <= 65535)) &&
      url.href === value;
  } catch { return false; }
}

export const isAllowedMcpCallback = (uri) => uri === CLAUDE_CALLBACK || isCodexCallback(uri) || isChatgptCallback(uri);

export const SCOPES = Object.freeze({
  /** One scope for every conversational proposal tool, so new destinations need no reconnect. */
  HUB_PROPOSE: 'hub:propose',
  /** Owner approval from a Claude conversation card (app-only tools + single-use ticket). Opt-in at consent. */
  HUB_APPROVE: 'hub:approve',
  // Per-destination proposal scopes from earlier grants; still honored.
  PROPOSE: 'food:propose', KYEOKYEOI_PROPOSE: 'kyeokyeoi:propose',
  INBOX: 'food:inbox', KYEOKYEOI_INBOX: 'kyeokyeoi:inbox', POTCAST_INBOX: 'potcast:inbox',
  /** Life Board reads every app's board tiles (docs/P7_BOARD.md section 6). */
  BOARD_READ: BOARD_READ_SCOPE,
  /** Life Board's roulette sends a station draw to 역 도장깨기 as a proposal (P7_BOARD.md section 8). */
  BOARD_PROPOSE: 'board:propose',
});
export const RESOURCE_PATHS = Object.freeze({ MCP: '/mcp', PALATE: '/palate', KYEOKYEOI: '/kyeokyeoi', POTCAST: '/potcast', BOARD: '/board' });

/** Every scope the authorization server knows: MCP proposals, legacy scopes, destination inboxes and sync. */
export const ALL_SCOPES = Object.freeze([
  SCOPES.HUB_PROPOSE, SCOPES.HUB_APPROVE, ...DESTINATIONS.map((d) => d.scope).filter(Boolean),
  ...DESTINATIONS.filter((d) => d.sync).map((d) => d.sync.scope),
  ...DESTINATIONS.filter((d) => d.legacyProposeScope).map((d) => d.legacyProposeScope),
  ...DESTINATIONS.map(boardScope).filter(Boolean), SCOPES.BOARD_READ, SCOPES.BOARD_PROPOSE,
]);

/** Shown under the grant text on the consent page of an app that syncs (P6_SYNC.md section 7). */
const SYNC_NOTE = '이 앱의 기록을 Life Hub의 비공개 저장소에 보관하고 다른 기기에서 불러올 수 있어요. 내용은 공개 저장소에 올라가지 않아요.';
/** Life Board's consent page (P7_BOARD.md sections 6–7). */
const BOARD_CLIENT_NOTE = '보드 배치(어떤 타일을 어디에 어떤 크기로)와 승인한 Claude 메모를 Life Hub의 비공개 저장소에 보관해 다른 기기에서도 같게 보여요.';
/** Shown on every app's consent page (P7_BOARD.md section 5): the board-tile upload scope comes with the app. */
const BOARD_NOTE = 'Life Board에 보여줄 이 앱의 최근 흐름(타일 목록)을 올릴 수 있어요. 목록은 Life Hub에 앱마다 최신 하나만 보관돼요.';

/**
 * The OAuth profile of one destination app. An app with an inbox and sync gets both scopes as required scopes
 * (since 2026-11-04; sync was an opt-in checkbox before, and those grants are left as they are); an app with an
 * inbox only gets its inbox scope; a sync-only app (no inbox) gets the sync scope as its one required scope.
 */
function destinationProfile(d, redirectUri) {
  const profile = {
    id: d.role, role: d.role, redirectUri, resourcePath: d.path,
    scopes: d.boardClient ? [SCOPES.BOARD_READ, d.sync.scope, d.scope, SCOPES.BOARD_PROPOSE] : [d.scope, d.sync?.scope, boardScope(d)].filter(Boolean),
    allowMissingResource: false, title: d.app, grants: d.grants,
    notes: d.boardClient ? [BOARD_CLIENT_NOTE] : [d.scope && d.sync ? SYNC_NOTE : null, BOARD_NOTE].filter(Boolean),
  };
  return profile;
}

export function clientProfiles(env) {
  const profiles = [{
    id: 'claude', role: 'claude', redirectUri: CLAUDE_CALLBACK,
    resourcePath: RESOURCE_PATHS.MCP, scopes: [SCOPES.HUB_PROPOSE],
    // Granted only when the owner ticks it on the consent page (with the password). Claude only.
    optionalScopes: [{
      scope: SCOPES.HUB_APPROVE,
      label: 'Claude 대화 카드에서 승인도 허용',
      detail: '카드의 「승인」·「거절」 버튼으로만 쓸 수 있고, Claude가 스스로 승인할 수는 없어요. 승인한 기록은 다음에 앱을 열 때 저장돼요.',
    }],
    // Older MCP clients may omit `resource`; the authorization server defaults it to /mcp.
    allowMissingResource: true,
    title: 'Claude',
    grants: '음식·추억·방문·음악 감상·활동·독서·역 방문·애니 진행 기록과 보드 메모 후보를 Life Hub 수신함에 <strong>제안</strong>할 수 있어요. 제안은 각 앱에서 직접 승인하기 전까지 실제 기록이 되지 않아요.',
  }];
  for (const d of DESTINATIONS) {
    const redirectUri = redirectUriFor(env, d);
    if (redirectUri) profiles.push(destinationProfile(d, redirectUri));
  }
  return profiles;
}

/** The profile for an authorization request, or null if the request must be refused. */
export function profileFor(env, authRequest) {
  const profile = clientProfiles(env).find((p) => p.redirectUri === authRequest.redirectUri) ??
    (isChatgptCallback(authRequest.redirectUri) ? {
      id: 'chatgpt', role: 'chatgpt', redirectUri: authRequest.redirectUri,
      resourcePath: RESOURCE_PATHS.MCP, scopes: [SCOPES.HUB_PROPOSE],
      allowMissingResource: true, title: 'ChatGPT',
      grants: '독서·음식·추억·활동 등 개인 기록의 <strong>후보</strong>를 Life Hub에 제안할 수 있어요. 각 사이트에서 승인하기 전까지 실제 기록은 변경되지 않아요.',
    } : null) ??
    (isCodexCallback(authRequest.redirectUri) ? {
      id: 'codex', role: 'codex', redirectUri: authRequest.redirectUri,
      resourcePath: RESOURCE_PATHS.MCP, scopes: [SCOPES.HUB_PROPOSE],
      allowMissingResource: true, title: 'Codex',
      grants: '개인 기록 후보를 Life Hub 수신함에 <strong>제안</strong>할 수 있어요. 각 앱에서 직접 승인하기 전까지 실제 기록은 바뀌지 않아요.',
    } : null);
  if (!profile) return null;
  const expected = env.HUB_PUBLIC_ORIGIN + profile.resourcePath;
  if (authRequest.resource === undefined ? !profile.allowMissingResource : authRequest.resource !== expected) return null;
  return profile;
}
