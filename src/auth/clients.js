/**
 * Which OAuth clients may connect, and what each one gets.
 *
 * A profile is chosen ONLY by the exact redirect URI the OAuth library already validated for the
 * client, so a client cannot ask for another profile's scope or resource. Every profile receives
 * exactly its own scopes, for exactly its own resource.
 */
import { DESTINATIONS, redirectUriFor } from '../destinations.js';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export const SCOPES = Object.freeze({
  /** One scope for every Claude proposal tool, so adding a destination never needs a reconnect. */
  HUB_PROPOSE: 'hub:propose',
  // Per-destination proposal scopes from earlier grants; still honored.
  PROPOSE: 'food:propose', KYEOKYEOI_PROPOSE: 'kyeokyeoi:propose',
  INBOX: 'food:inbox', KYEOKYEOI_INBOX: 'kyeokyeoi:inbox', POTCAST_INBOX: 'potcast:inbox',
});
export const RESOURCE_PATHS = Object.freeze({ MCP: '/mcp', PALATE: '/palate', KYEOKYEOI: '/kyeokyeoi', POTCAST: '/potcast' });

/** Every scope the authorization server knows: Claude's, the legacy proposal scopes, each app's inbox. */
export const ALL_SCOPES = Object.freeze([
  SCOPES.HUB_PROPOSE, ...DESTINATIONS.map((d) => d.scope), ...DESTINATIONS.filter((d) => d.legacyProposeScope).map((d) => d.legacyProposeScope),
]);

export function clientProfiles(env) {
  const profiles = [{
    id: 'claude', role: 'claude', redirectUri: CLAUDE_CALLBACK,
    resourcePath: RESOURCE_PATHS.MCP, scopes: [SCOPES.HUB_PROPOSE],
    // Older MCP clients may omit `resource`; the authorization server defaults it to /mcp.
    allowMissingResource: true,
    title: 'Claude',
    grants: '음식·추억·방문·음악 감상·활동·독서·역 방문 기록 후보를 Life Hub 수신함에 <strong>제안</strong>할 수 있어요. 제안은 각 앱에서 직접 승인하기 전까지 실제 기록이 되지 않아요.',
  }];
  for (const d of DESTINATIONS) {
    const redirectUri = redirectUriFor(env, d);
    if (redirectUri) profiles.push({
      id: d.role, role: d.role, redirectUri, resourcePath: d.path, scopes: [d.scope],
      allowMissingResource: false, title: d.app, grants: d.grants,
    });
  }
  return profiles;
}

/** The profile for an authorization request, or null if the request must be refused. */
export function profileFor(env, authRequest) {
  const profile = clientProfiles(env).find((p) => p.redirectUri === authRequest.redirectUri);
  if (!profile) return null;
  const expected = env.HUB_PUBLIC_ORIGIN + profile.resourcePath;
  if (authRequest.resource === undefined ? !profile.allowMissingResource : authRequest.resource !== expected) return null;
  return profile;
}
