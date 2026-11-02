/**
 * Worker entry point.
 *
 * One OAuth authorization server, two protected resources, plus the P1 API:
 * - /mcp/*                    Claude custom connector (MCP), scope food:propose, role claude
 * - /palate/*                 PALATE inbox API, scope food:inbox, role palate
 * - /kyeokyeoi/*              켜켜이 inbox API, scope kyeokyeoi:inbox, role kyeokyeoi
 * - /potcast/*                potcast inbox API, scope potcast:inbox, role potcast
 * - /authorize                owner password + consent page (ours)
 * - /oauth/token, /oauth/register, /.well-known/oauth-authorization-server   the library's
 * - /.well-known/oauth-protected-resource/{mcp,palate,kyeokyeoi}             each resource's
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
import { CLAUDE_CALLBACK, SCOPES, RESOURCE_PATHS, palateRedirectUri, kyeokyeoiRedirectUri, potcastRedirectUri } from '../auth/clients.js';
import { handleMcpRequest } from '../mcp/protocol.js';
import { handleInboxRequest } from '../inbox/api.js';

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const OAUTH_PATHS = /^\/(?:mcp|palate|kyeokyeoi|potcast|authorize|oauth\/|\.well-known\/oauth-)/;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const notConfigured = () => new Response(JSON.stringify({ error: 'OAuth is not configured' }), { status: 503, headers: JSON_HEADERS });
const forbidden = () => new Response(JSON.stringify({ error: 'Token is not valid for this Life Hub' }), { status: 403, headers: JSON_HEADERS });

/**
 * Shared checks: the token's owner must be the current owner, its role must match, and it must carry
 * one of the accepted scopes (the first is the one asked for on step-up).
 */
function guard(env, ctx, role, scopes) {
  const props = ctx.props ?? {};
  // A token minted for a different owner (e.g. before HUB_OWNER_ID was rotated) is not valid here.
  if (props.role !== role || !env.HUB_OWNER_ID || props.ownerId !== env.HUB_OWNER_ID) return forbidden();
  const accepted = Array.isArray(scopes) ? scopes : [scopes];
  if (!accepted.some((s) => ctx.auth?.scope?.includes(s))) return insufficientScope(ctx.auth, [accepted[0]]);
  if (!env.DB || typeof env.DB.prepare !== 'function') return notConfigured();
  return null;
}

export const mcpHandler = {
  async fetch(request, env, ctx) {
    // Grants from before hub:propose carry the per-destination scopes; tools check the specific one.
    return guard(env, ctx, 'claude', [SCOPES.HUB_PROPOSE, SCOPES.PROPOSE, SCOPES.KYEOKYEOI_PROPOSE]) ?? handleMcpRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(),
      allowedOrigins: [env.HUB_PUBLIC_ORIGIN, 'https://claude.ai'],
      // Per-destination tools check these; grants made before a destination existed lack its scope.
      scopes: [...(ctx.auth?.scope ?? [])],
    });
  },
};

function inboxHandler(role, scope, destination, prefix) {
  return {
    async fetch(request, env, ctx) {
      return guard(env, ctx, role, scope) ?? handleInboxRequest(request, {
        db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), destination, prefix,
      });
    },
  };
}
export const palateHandler = inboxHandler('palate', SCOPES.INBOX, 'food', RESOURCE_PATHS.PALATE + '/v1');
export const kyeokyeoiHandler = inboxHandler('kyeokyeoi', SCOPES.KYEOKYEOI_INBOX, 'kyeokyeoi', RESOURCE_PATHS.KYEOKYEOI + '/v1');
export const potcastHandler = inboxHandler('potcast', SCOPES.POTCAST_INBOX, 'potcast', RESOURCE_PATHS.POTCAST + '/v1');

export function createServers(origin) {
  const mcpResource = origin + RESOURCE_PATHS.MCP;
  const palateResource = origin + RESOURCE_PATHS.PALATE;
  const kyeokyeoiResource = origin + RESOURCE_PATHS.KYEOKYEOI;
  const potcastResource = origin + RESOURCE_PATHS.POTCAST;
  const authorizationServer = new OAuthAuthorizationServer({
    issuer: origin,
    resources: [mcpResource, palateResource, kyeokyeoiResource, potcastResource],
    // Older MCP clients may omit `resource`; they mean the MCP endpoint.
    defaultResource: mcpResource,
    authorizeEndpoint: origin + '/authorize',
    tokenEndpoint: origin + '/oauth/token',
    clientRegistrationEndpoint: origin + '/oauth/register',
    // CIMD (Claude may use it; PALATE and 켜켜이 do) needs the global_fetch_strictly_public flag. DCR is the fallback.
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPES.HUB_PROPOSE, SCOPES.INBOX, SCOPES.KYEOKYEOI_INBOX, SCOPES.POTCAST_INBOX, SCOPES.PROPOSE, SCOPES.KYEOKYEOI_PROPOSE],
    // DCR is only for Claude; the destination apps identify themselves with their CIMD documents.
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
    requiredScopes: [SCOPES.HUB_PROPOSE], validateToken, handler: mcpHandler,
  });
  const palate = new OAuthResourceServer({
    resourceMetadata: { resource: palateResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.INBOX], validateToken, handler: palateHandler,
  });
  const kyeokyeoi = new OAuthResourceServer({
    resourceMetadata: { resource: kyeokyeoiResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.KYEOKYEOI_INBOX], validateToken, handler: kyeokyeoiHandler,
  });
  const potcast = new OAuthResourceServer({
    resourceMetadata: { resource: potcastResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.POTCAST_INBOX], validateToken, handler: potcastHandler,
  });
  return { authorizationServer, mcp, palate, kyeokyeoi, potcast };
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
    if (under(path, RESOURCE_PATHS.KYEOKYEOI) || under(path, '/.well-known/oauth-protected-resource' + RESOURCE_PATHS.KYEOKYEOI)) {
      if (!kyeokyeoiRedirectUri(env)) return notConfigured();
      return s.kyeokyeoi.fetch(request, env, ctx);
    }
    if (under(path, RESOURCE_PATHS.POTCAST) || under(path, '/.well-known/oauth-protected-resource' + RESOURCE_PATHS.POTCAST)) {
      if (!potcastRedirectUri(env)) return notConfigured();
      return s.potcast.fetch(request, env, ctx);
    }
    if (path === '/authorize')
      return handleAuthorize(request, env, s.authorizationServer.getOAuthApi(env), { AuthorizationError, CimdFetchError });
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/'))
      return s.authorizationServer.fetch(request, env, ctx);
    return handleRequest(request, env);
  },
};
