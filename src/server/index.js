/**
 * Worker entry point.
 *
 * One OAuth authorization server, one protected resource per client, plus the P1 API:
 * - /mcp/*                    Claude/Codex/ChatGPT connectors (MCP), scope hub:propose
 * - /<app path>/*             each destination app's inbox API (src/destinations.js), e.g.
 *                             /palate (food:inbox), /kyeokyeoi, /potcast, /achievement; plus <path>/v1/sync
 *                             (P6) and <path>/v1/board (P7, scope <id>:board)
 * - /board/*                  Life Board's read API (docs/P7_BOARD.md), scope board:read
 * - /authorize                owner password + consent page (ours)
 * - /oauth/token, /oauth/register, /.well-known/oauth-authorization-server   the library's
 * - /.well-known/oauth-protected-resource/<path>                               each resource's
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
import { isAllowedMcpCallback, SCOPES, RESOURCE_PATHS, ALL_SCOPES, BOARD_CLIENT } from '../auth/clients.js';
import { DESTINATIONS, redirectUriFor, appUrlFor, boardScope } from '../destinations.js';
import { handleManifestRequest, handleBoardRequest } from '../board/api.js';
import { handleMcpRequest } from '../mcp/protocol.js';
import { handleInboxRequest } from '../inbox/api.js';
import { handleSyncRequest } from '../sync/api.js';
import { handleSpotify } from '../spotify/routes.js';
import { pollSpotify } from '../spotify/sync.js';
import { deleteExpiredTickets } from './store.js';

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const OAUTH_PATHS = new RegExp(`^/(?:mcp|board|${DESTINATIONS.map((d) => d.path.slice(1)).join('|')}|authorize|oauth/|\\.well-known/oauth-)`);
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
    const role = ctx.props?.role;
    if (!['claude', 'codex', 'chatgpt'].includes(role)) return forbidden();
    return guard(env, ctx, role, [SCOPES.HUB_PROPOSE, SCOPES.PROPOSE, SCOPES.KYEOKYEOI_PROPOSE]) ?? handleMcpRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), source: role,
      allowedOrigins: [env.HUB_PUBLIC_ORIGIN, role === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com'],
      // Per-destination tools check these; grants made before a destination existed lack its scope.
      scopes: [...(ctx.auth?.scope ?? [])],
      // Card links open the destination app (only apps configured with a redirect URI).
      appUrls: Object.fromEntries(DESTINATIONS.map((d) => [d.id, appUrlFor(env, d)]).filter(([, u]) => u)),
    });
  },
};

/**
 * One handler per destination app: `<path>/v1/sync*` is the device sync API and needs the app's sync scope
 * (an inbox-only token gets a step-up error); everything else under `<path>/v1` is the inbox API and needs
 * the inbox scope. A sync-only app has no inbox, so its other paths are 404.
 */
function destinationHandler(d) {
  const prefix = d.path + '/v1';
  const syncPrefix = prefix + '/sync';
  const boardPath = prefix + '/board';
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path === boardPath || path.startsWith(boardPath + '/')) {
        // Board tiles (docs/P7_BOARD.md section 5): a grant from before P7 lacks the scope → step-up, the app reconnects.
        return guard(env, ctx, d.role, boardScope(d)) ?? handleManifestRequest(request, {
          db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), app: d.id, path: boardPath,
        });
      }
      if (d.sync && (path === syncPrefix || path.startsWith(syncPrefix + '/'))) {
        return guard(env, ctx, d.role, d.sync.scope) ?? handleSyncRequest(request, {
          db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), destination: d.id, prefix: syncPrefix,
          limits: { maxBytes: d.sync.maxBytes, keep: d.sync.keep },
        });
      }
      if (!d.scope) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: JSON_HEADERS });
      return guard(env, ctx, d.role, d.scope) ?? handleInboxRequest(request, {
        db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), destination: d.id, prefix,
      });
    },
  };
}
/** One handler per destination app, keyed by destination id (the inbox handlers' historical name). */
export const inboxHandlers = Object.freeze(Object.fromEntries(DESTINATIONS.map((d) => [d.id, destinationHandler(d)])));
export const palateHandler = inboxHandlers.food;

/** Life Board (docs/P7_BOARD.md section 6): reads every app's stored manifest and the Hub's own tile. */
const APP_NAMES = Object.freeze(Object.fromEntries(DESTINATIONS.map((d) => [d.id, d.app])));
export const boardHandler = {
  async fetch(request, env, ctx) {
    return guard(env, ctx, 'board', SCOPES.BOARD_READ) ?? handleBoardRequest(request, {
      db: env.DB, ownerId: env.HUB_OWNER_ID, now: () => Date.now(), appNames: APP_NAMES,
    });
  },
};

export function createServers(origin) {
  const mcpResource = origin + RESOURCE_PATHS.MCP;
  const authorizationServer = new OAuthAuthorizationServer({
    issuer: origin,
    resources: [mcpResource, origin + RESOURCE_PATHS.BOARD, ...DESTINATIONS.map((d) => origin + d.path)],
    // Older MCP clients may omit `resource`; they mean the MCP endpoint.
    defaultResource: mcpResource,
    authorizeEndpoint: origin + '/authorize',
    tokenEndpoint: origin + '/oauth/token',
    clientRegistrationEndpoint: origin + '/oauth/register',
    // CIMD (Claude may use it; the destination apps do) needs the global_fetch_strictly_public flag. DCR is the fallback.
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...ALL_SCOPES],
    // Grant lifetime: no practical expiry (docs/P6_SYNC.md section 7, "Grant lifetime"). The key must be present:
    // omitting it keeps the library's 30-day absolute default. The idle lifetime restarts at every refresh, which
    // also lifts grants issued under the old 30-day default on their next refresh. Revoking a grant and rotating
    // HUB_OWNER_ID still end access. Access tokens keep the library default (3,600 s).
    refreshTokenTTL: undefined,
    refreshTokenIdleTTL: 315360000, // 10 years, in seconds
    // DCR registrations never expire either (same section, "Client registration"); omitting the key keeps the
    // library's 90-day default. Records written under that default keep their stored KV expiry.
    clientRegistrationTTL: undefined,
    // DCR accepts one approved callback per client. Never permit mixed MCP client callbacks.
    // Destination apps use their own CIMD documents, not DCR.
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      if (uris.length !== 1 || !isAllowedMcpCallback(uris[0]))
        return { code: 'invalid_redirect_uri', description: 'Only approved Claude, Codex or ChatGPT callbacks may register', status: 400 };
    },
    onError: ({ status, code }) => { if (status >= 500) console.warn('oauth error', status, code); },
  });
  const validateToken = (env) => (resource, token) => authorizationServer.validateToken(resource, token, env);
  const mcp = new OAuthResourceServer({
    resourceMetadata: { resource: mcpResource, authorization_servers: [origin] },
    requiredScopes: [SCOPES.HUB_PROPOSE], validateToken, handler: mcpHandler,
  });
  const inboxes = new Map(DESTINATIONS.map((d) => [d.id, new OAuthResourceServer({
    resourceMetadata: { resource: origin + d.path, authorization_servers: [origin] },
    // The resource's base scope: the inbox scope, or the sync scope for a sync-only app. Sync routes of an app
    // with an inbox check their own scope again in destinationHandler.
    requiredScopes: [d.scope ?? d.sync.scope], validateToken, handler: inboxHandlers[d.id],
  })]));
  const board = new OAuthResourceServer({
    resourceMetadata: { resource: origin + RESOURCE_PATHS.BOARD, authorization_servers: [origin] },
    requiredScopes: [SCOPES.BOARD_READ], validateToken, handler: boardHandler,
  });
  return { authorizationServer, mcp, inboxes, board };
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
    if (under(path, RESOURCE_PATHS.BOARD) || under(path, '/.well-known/oauth-protected-resource' + RESOURCE_PATHS.BOARD)) {
      if (!redirectUriFor(env, BOARD_CLIENT)) return notConfigured();
      return s.board.fetch(request, env, ctx);
    }
    for (const d of DESTINATIONS) {
      if (under(path, d.path) || under(path, '/.well-known/oauth-protected-resource' + d.path)) {
        if (!redirectUriFor(env, d)) return notConfigured();
        return s.inboxes.get(d.id).fetch(request, env, ctx);
      }
    }
    if (path === '/spotify' || path.startsWith('/spotify/')) return handleSpotify(request, env);
    if (path === '/authorize')
      return handleAuthorize(request, env, s.authorizationServer.getOAuthApi(env), { AuthorizationError, CimdFetchError });
    if (path.startsWith('/oauth/') || path.startsWith('/.well-known/'))
      return s.authorizationServer.fetch(request, env, ctx);
    return handleRequest(request, env);
  },
  /** Cron trigger (wrangler `triggers.crons`): hourly Spotify collection for potcast. Off unless configured. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(pollSpotify(env).catch((error) => console.warn('spotify poll failed', error?.message)));
    // Card tickets expire after 7 days; drop them so D1 stays small.
    if (env.DB) ctx.waitUntil(deleteExpiredTickets(env.DB, new Date().toISOString()).catch(() => {}));
  },
};
