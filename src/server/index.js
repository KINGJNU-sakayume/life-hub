/**
 * Worker entry point (P2).
 *
 * - /mcp                      MCP endpoint, OAuth-protected (Claude custom connector)
 * - /authorize                owner password + consent page (ours)
 * - /oauth/token, /oauth/register, /.well-known/*   served by @cloudflare/workers-oauth-provider
 * - /health, /v1/*            unchanged P1 server-to-server API with static role tokens
 *
 * The OAuth provider needs the public origin to name its resource, so it is built lazily from
 * HUB_PUBLIC_ORIGIN (a deploy-time variable). Without it, OAuth and MCP routes fail closed and
 * the P1 API keeps working.
 */
import { OAuthProvider, AuthorizationError, CimdFetchError, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { handleRequest } from './worker.js';
import { handleAuthorize, GRANTED_SCOPES } from '../auth/owner-login.js';
import { handleMcpRequest } from '../mcp/protocol.js';

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const OAUTH_PATHS = /^\/(?:mcp|authorize|oauth\/|\.well-known\/oauth-)/;

const notConfigured = () => new Response(JSON.stringify({ error: 'OAuth is not configured' }), {
  status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export const mcpApiHandler = {
  async fetch(request, env, ctx) {
    const props = ctx.props ?? {};
    // A token minted for a different owner (e.g. before HUB_OWNER_ID was rotated) is not valid here.
    if (props.role !== 'claude' || !env.HUB_OWNER_ID || props.ownerId !== env.HUB_OWNER_ID)
      return new Response(JSON.stringify({ error: 'Token is not valid for this Life Hub' }), {
        status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    if (!GRANTED_SCOPES.every((scope) => ctx.auth?.scope?.includes(scope)))
      return insufficientScope(ctx.auth, [...GRANTED_SCOPES]);
    if (!env.DB || typeof env.DB.prepare !== 'function') return notConfigured();
    return handleMcpRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(),
      allowedOrigins: [env.HUB_PUBLIC_ORIGIN, 'https://claude.ai'],
    });
  },
};

export const defaultHandler = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/authorize')
      return handleAuthorize(request, env, env.OAUTH_PROVIDER, { AuthorizationError, CimdFetchError });
    return handleRequest(request, env);
  },
};

export function createProvider(origin) {
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: mcpApiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // Claude prefers CIMD when advertised (needs the global_fetch_strictly_public flag) and falls back to DCR.
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...GRANTED_SCOPES],
    requiredScopes: [...GRANTED_SCOPES],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    // DCR: refuse clients that cannot use the hosted Claude callback; /authorize enforces the exact URI.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      if (!uris.includes('https://claude.ai/api/mcp/auth_callback'))
        return { code: 'invalid_redirect_uri', description: 'Only the Claude app may register', status: 400 };
    },
    onError: ({ status, code }) => { if (status >= 500) console.warn('oauth error', status, code); },
  });
}

const providers = new Map();
export default {
  async fetch(request, env, ctx) {
    // Exact origin, no trailing slash: the deploy renderer validates it, and it must match the connector URL.
    const origin = typeof env.HUB_PUBLIC_ORIGIN === 'string' ? env.HUB_PUBLIC_ORIGIN : '';
    if (!ORIGIN.test(origin) || !env.OAUTH_KV) {
      return OAUTH_PATHS.test(new URL(request.url).pathname) ? notConfigured() : handleRequest(request, env);
    }
    let provider = providers.get(origin);
    if (!provider) { provider = createProvider(origin); providers.set(origin, provider); }
    return provider.fetch(request, env, ctx);
  },
};
