/**
 * Worker entry point.
 *
 * One OAuth authorization server, two protected resources, plus the P1 API:
 * - /mcp/*                    Claude custom connector (MCP), scope food:propose, role claude
 * - /palate/*                 PALATE inbox API, scope food:inbox, role palate
 * - /authorize                owner password + consent page (ours)
 * - /oauth/token, /oauth/register, /.well-known/oauth-authorization-server   the library's
 * - /.well-known/oauth-protected-resource/{mcp,palate}                       each resource's
 * - /health, /v1/*            P1 server-to-server API with static role tokens (unchanged)
 *
 * The servers need the public origin to name the issuer and resources, so they are built lazily
 * from HUB_PUBLIC_ORIGIN. Without it (or without OAUTH_KV) the OAuth routes fail closed with 503
 * and the P1 API keeps working.
 */
import {
  OAuthAuthorizationServer, OAuthResourceServer, AuthorizationError, CimdFetchError, insufficientScope,
} from '@cloudflare/workers-oauth-provider';
import { handleRequest } from './worker.js';
import { handleAuthorize } from '../auth/owner-login.js';
import { CLAUDE_CALLBACK, SCOPES, RESOURCE_PATHS, palateRedirectUri } from '../auth/clients.js';
import { handleMcpRequest } from '../mcp/protocol.js';
import { handlePalateRequest } from '../palate/api.js';

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const OAUTH_PATHS = /^\/(?:mcp|palate|authorize|oauth\/|\.well-known\/oauth-)/;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const notConfigured = () => new Response(JSON.stringify({ error: 'OAuth is not configured' }), { status: 503, headers: JSON_HEADERS });
const forbidden = () => new Response(JSON.stringify({ error: 'Token is not valid for this Life Hub' }), { status: 403, headers: JSON_HEADERS });

/** Shared checks: the token's owner must be the current owner, its role and scope must match. */
function guard(env, ctx, role, scope) {
  const props = ctx.props ?? {};
  // A token minted for a different owner (e.g. before HUB_OWNER_ID was rotated) is not valid here.
  if (props.role !== role || !env.HUB_OWNER_ID || props.ownerId !== env.HUB_OWNER_ID) return forbidden();
  if (!ctx.auth?.scope?.includes(scope)) return insufficientScope(ctx.auth, [scope]);
  if (!env.DB || typeof env.DB.prepare !== 'function') return notConfigured();
  return null;
}

export const mcpHandler = {
  async fetch(request, env, ctx) {
    return guard(env, ctx, 'claude', SCOPES.PROPOSE) ?? handleMcpRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(),
      allowedOrigins: [env.HUB_PUBLIC_ORIGIN, 'https://claude.ai'],
    });
  },
};

export const palateHandler = {
  async fetch(request, env, ctx) {
    return guard(env, ctx, 'palate', SCOPES.INBOX) ?? handlePalateRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(),
    });
  },
};

export function createServers(origin) {
  const mcpResource = origin + RESOURCE_PATHS.MCP;
  const palateResource = origin + RESOURCE_PATHS.PALATE;
  const authorizationServer = new OAuthAuthorizationServer({
    issuer: origin,
    resources: [mcpResource, palateResource],
    // Older MCP clients may omit `resource`; they mean the MCP endpoint.
    defaultResource: mcpResource,
    authorizeEndpoint: origin + '/authorize',
    tokenEndpoint: origin + '/oauth/token',
    clientRegistrationEndpoint: origin + '/oauth/register',
    // CIMD (Claude may use it; PALATE does) needs the global_fetch_strictly_public flag. DCR is the fallback.
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPES.PROPOSE, SCOPES.INBOX],
    // DCR is only for Claude; PALATE identifies itself with its CIMD document.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      if (!uris.includes(CLAUDE_CALLBACK))
        return { code: 'invalid_redirect_uri', description: 'Only the Claude app may register', status: 400 };
    },
    onError: ({ status, code }) => { if (status >= 500) console.warn('oauth error', status, code); },
  });
  const validateToken = (env) => (resource, token) => authorizationServer.validateToken(resource, token, env);
  const mcp = new OAuthResourceServer({
    resourceMetadata: { resource: mcpResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.PROPOSE], validateToken, handler: mcpHandler,
  });
  const palate = new OAuthResourceServer({
    resourceMetadata: { resource: palateResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.INBOX], validateToken, handler: palateHandler,
  });
  return { authorizationServer, mcp, palate };
}

const under = (path, base) => path === base || path.startsWith(base + '/');
const servers = new Map();

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // Exact origin, no trailing slash: the deploy renderer validates it, and it must match the connector URL.
    const origin = typeof env.HUB_PUBLIC_ORIGIN === 'string' ? env.HUB_PUBLIC_ORIGIN : '';
    if (!ORIGIN.test(origin) || !env.OAUTH_KV) return OAUTH_PATHS.test(path) ? notConfigured() : handleRequest(request, env);

    let s = servers.get(origin);
    if (!s) { s = createServers(origin); servers.set(origin, s); }

    if (under(path, RESOURCE_PATHS.MCP) || under(path, '/.well-known/oauth-protected-resource' + RESOURCE_PATHS.MCP))
      return s.mcp.fetch(request, env, ctx);
    if (under(path, RESOURCE_PATHS.PALATE) || under(path, '/.well-known/oauth-protected-resource' + RESOURCE_PATHS.PALATE)) {
      if (!palateRedirectUri(env)) return notConfigured();
      return s.palate.fetch(request, env, ctx);
    }
    if (path === '/authorize')
      return handleAuthorize(request, env, s.authorizationServer.getOAuthApi(env), { AuthorizationError, CimdFetchError });
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/'))
      return s.authorizationServer.fetch(request, env, ctx);
    return handleRequest(request, env);
  },
};
