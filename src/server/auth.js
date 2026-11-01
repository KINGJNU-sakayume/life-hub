/** P1 server-to-server identity gate. Never embed these secrets in GitHub Pages or chat messages. */
const NAMES = [
  ['owner', 'HUB_OWNER_TOKEN'],
  ['chatgpt', 'HUB_CHATGPT_TOKEN'],
  ['claude', 'HUB_CLAUDE_TOKEN'],
  ['food_reader', 'HUB_FOOD_READER_TOKEN'],
];
export class AuthFailure extends Error {
  constructor(code, message) { super(message); this.status = code; }
}
const bytes = (v) => new TextEncoder().encode(v);
async function digest(v) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(v))); }
function equal(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}
/** Tokens are opaque 32+ character secrets, not OAuth tokens. */
export async function authenticate(request, env) {
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(env.HUB_OWNER_ID ?? '') ||
      typeof env.HUB_OWNER_TOKEN !== 'string' || env.HUB_OWNER_TOKEN.length < 32)
    throw new AuthFailure(503, 'Authentication is not configured');
  const supplied = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('Authorization') ?? '');
  if (!supplied) throw new AuthFailure(401, 'Authorization required');
  const presented = await digest(supplied[1]);
  let match = null;
  let matches = 0;
  for (const [role, name] of NAMES) {
    const secret = env[name];
    if (typeof secret !== 'string' || secret.length < 32) continue;
    const candidate = await digest(secret);
    if (equal(presented, candidate)) { match = role; matches++; }
  }
  // Reject accidental duplicate secrets rather than accidentally elevating privileges.
  if (matches !== 1) throw new AuthFailure(401, 'Invalid credentials');
  return { ownerId: env.HUB_OWNER_ID, role: match };
}
export function requireRole(actor, allowed) {
  if (!allowed.includes(actor.role)) throw new AuthFailure(403, 'Insufficient scope');
}
export function assertSource(actor, source) {
  if (!((actor.role === 'owner' && source === 'manual') ||
        (actor.role === 'chatgpt' && source === 'chatgpt') ||
        (actor.role === 'claude' && source === 'claude')))
    throw new AuthFailure(403, 'Source is not permitted for this credential');
}
