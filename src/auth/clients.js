/**
 * Which OAuth clients may connect, and what each one gets.
 *
 * A profile is chosen ONLY by the exact redirect URI the OAuth library already validated for the
 * client, so a client cannot ask for another profile's scope or resource. Every profile receives
 * exactly its own scopes, for exactly its own resource.
 */
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/[^\s#?]*$/;

export const SCOPES = Object.freeze({ PROPOSE: 'food:propose', INBOX: 'food:inbox' });
export const RESOURCE_PATHS = Object.freeze({ MCP: '/mcp', PALATE: '/palate' });

/** PALATE's redirect URI comes from deploy config; returns null when unset or malformed. */
export function palateRedirectUri(env) {
  const value = env.HUB_PALATE_REDIRECT_URI;
  return typeof value === 'string' && HTTPS_URL.test(value) && value.length <= 300 ? value : null;
}

export function clientProfiles(env) {
  const profiles = [{
    id: 'claude', role: 'claude', redirectUri: CLAUDE_CALLBACK,
    resourcePath: RESOURCE_PATHS.MCP, scopes: [SCOPES.PROPOSE],
    // Older MCP clients may omit `resource`; the authorization server defaults it to /mcp.
    allowMissingResource: true,
    title: 'Claude',
    grants: '음식 기록 후보를 Life Hub 수신함에 <strong>제안</strong>할 수 있어요. 제안은 직접 승인하기 전까지 실제 기록이 되지 않아요.',
  }];
  const palate = palateRedirectUri(env);
  if (palate) profiles.push({
    id: 'palate', role: 'palate', redirectUri: palate,
    resourcePath: RESOURCE_PATHS.PALATE, scopes: [SCOPES.INBOX],
    allowMissingResource: false,
    title: 'PALATE',
    grants: 'Life Hub 수신함의 <strong>음식 후보를 가져오고</strong>, PALATE에서 승인하거나 거절한 결과를 돌려보낼 수 있어요.',
  });
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
