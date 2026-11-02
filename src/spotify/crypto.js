/**
 * The Spotify refresh token at rest: AES-GCM with a key derived (SHA-256) from the HUB_SPOTIFY_TOKEN_KEY
 * secret, which is separate from the owner password and every OAuth secret. Stored as base64url(iv || ciphertext).
 */
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const tokenKeyConfigured = (env) => typeof env.HUB_SPOTIFY_TOKEN_KEY === 'string' && env.HUB_SPOTIFY_TOKEN_KEY.length >= 32;

async function key(env) {
  if (!tokenKeyConfigured(env)) throw new Error('HUB_SPOTIFY_TOKEN_KEY is not configured');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.HUB_SPOTIFY_TOKEN_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(token)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function openToken(env, sealed) {
  const bytes = unb64(sealed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(env), bytes.slice(12));
  return new TextDecoder().decode(pt);
}
