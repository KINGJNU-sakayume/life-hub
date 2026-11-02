/**
 * P2 owner sign-in for the OAuth authorization endpoint.
 *
 * Life Hub has exactly one owner. Connecting a client (Claude, PALATE) requires that owner to type
 * a dedicated password (HUB_OWNER_PASSWORD, a Worker secret) on this page. The OAuth library
 * validates the client, redirect URI and PKCE; this module adds the owner check, a throttle, the
 * client profile allowlist (src/auth/clients.js), and a consent page that never echoes unescaped
 * client metadata.
 */
import { profileFor, clientProfiles, isAllowedMcpCallback } from './clients.js';
export const PASSWORD_MIN_LENGTH = 20;
export const MAX_ATTEMPTS_PER_WINDOW = 10;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const OWNER_ID = /^[a-zA-Z0-9_-]{6,128}$/;
const BUCKET = 'owner';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function ownerLoginConfigured(env) {
  return OWNER_ID.test(env.HUB_OWNER_ID ?? '') &&
    typeof env.HUB_OWNER_PASSWORD === 'string' && env.HUB_OWNER_PASSWORD.length >= PASSWORD_MIN_LENGTH &&
    Boolean(env.DB && typeof env.DB.prepare === 'function');
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
function constantTimeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Count the attempt BEFORE comparing, atomically, so parallel guesses cannot exceed the limit.
 * Returns { ok: true } | { ok: false, reason: 'locked' | 'wrong', retryAfterSeconds? }.
 */
export async function verifyOwnerPassword(db, env, supplied, nowMs = Date.now()) {
  const windowStart = nowMs - ATTEMPT_WINDOW_MS;
  const row = await db.prepare(`INSERT INTO login_failures (bucket,failures,window_started_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET
      failures = CASE WHEN window_started_at <= ? THEN 1 ELSE failures + 1 END,
      window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END
    RETURNING failures, window_started_at`).bind(BUCKET, nowMs, windowStart, windowStart).first();
  if (!row) throw new Error('Login throttle unavailable');
  if (row.failures > MAX_ATTEMPTS_PER_WINDOW) {
    const retryAfterSeconds = Math.max(1, Math.ceil((row.window_started_at + ATTEMPT_WINDOW_MS - nowMs) / 1000));
    return { ok: false, reason: 'locked', retryAfterSeconds };
  }
  const given = typeof supplied === 'string' && supplied.length <= 1024 ? supplied : '';
  const match = constantTimeEqual(await sha256(given), await sha256(env.HUB_OWNER_PASSWORD));
  if (!match) return { ok: false, reason: 'wrong' };
  await db.prepare('DELETE FROM login_failures WHERE bucket=?').bind(BUCKET).run();
  return { ok: true };
}

/** A same-origin path back to the authorization request, or null. Never an absolute URL. */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/authorize?')) return null;
  if (/[\s\\]/.test(value) || value.includes('//')) return null;
  return value;
}

/**
 * Browsers apply `form-action` to the redirect that follows a form POST, so the consent page must
 * allow the origin of the client it sends the code to (claude.ai, PALATE's GitHub Pages, ...).
 * Every other page allows only same-origin forms.
 */
const csp = (formOrigins = []) => "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action " + ["'self'", ...formOrigins].join(' ');

function page(status, title, body, extraHeaders, formOrigins = []) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', csp(formOrigins));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f6f3;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#dedcd6;--accent:#2f5d50;--warn:#9a3b1a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a3a19b;--card:#21211f;--line:#383733;--accent:#7cc0a8;--warn:#f0a07c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.92rem}
.warn{color:var(--warn)}code{font-size:.9em}
label{display:block;margin:18px 0 6px;font-weight:600}
input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:16px}
.row{display:flex;gap:10px;margin-top:18px}button,a.btn{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);font-size:16px;text-align:center;text-decoration:none;color:var(--fg);background:transparent}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}
</style><main><div class="card">${body}</div></main></html>`;
  return new Response(html, { status, headers });
}

function messagePage(status, title, message, returnTo, headers) {
  const retry = returnTo ? `<div class="row"><a class="btn" href="${escapeHtml(returnTo)}">다시 시도</a></div>` : '';
  return page(status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${retry}`, headers);
}

function consentPage(details, profile, handle, returnTo, headers) {
  const name = escapeHtml(details.clientName || '이름 없는 앱');
  const origin = details.clientDomain ?
    `<p class="muted">게시자: <strong>${escapeHtml(details.clientDomain)}</strong></p>` :
    '<p class="muted">스스로 등록한 앱이라 이름은 검증되지 않았어요.</p>';
  const body = `<h1>${name}에 Life Hub 연결</h1>
${origin}
<p>허용하면 이 앱이 ${profile.grants}</p>
<p class="muted">권한: <code>${profile.scopes.map(escapeHtml).join(', ')}</code><br>
인증 결과가 전달되는 곳: <strong>${escapeHtml(details.redirectHost)}</strong></p>
${details.redirectIsLoopback ? '<p class="warn">이 컴퓨터의 앱으로 권한이 전달돼요. 방금 직접 연결을 시작한 경우에만 계속하세요.</p>' : ''}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<label for="pw">Life Hub 소유자 비밀번호</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required>
<div class="row"><button type="submit" name="decision" value="deny">거절</button>
<button class="primary" type="submit" name="decision" value="approve">허용</button></div>
</form>`;
  return page(200, `${details.clientName || 'App'} 연결`, body, headers, [new URL(profile.redirectUri).origin]);
}

function notAllowed(env) {
  const names = [...clientProfiles(env).map((p) => p.title), 'Codex (loopback)'].join(', ');
  return messagePage(403, '허용되지 않은 앱', `이 Life Hub는 ${names} 연결만 허용해요.`);
}

/**
 * GET/POST /authorize. `oauth` is env.OAUTH_PROVIDER; `errors` carries the library's error classes
 * so this module stays importable without the Workers runtime.
 */
export async function handleAuthorize(request, env, oauth, errors) {
  const { AuthorizationError, CimdFetchError } = errors;
  if (!ownerLoginConfigured(env))
    return messagePage(503, '설정이 필요해요', 'Life Hub 소유자 로그인이 아직 설정되지 않았어요.');
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const profile = profileFor(env, authRequest);
      if (!profile) return notAllowed(env);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const url = new URL(request.url);
      return consentPage(details, profile, consent.handle, safeReturnTo(url.pathname + url.search) ?? '', consent.headers);
    }
    if (request.method !== 'POST') return messagePage(405, '지원하지 않는 요청', 'GET 또는 POST만 사용할 수 있어요.', null, { Allow: 'GET, POST' });

    if (!/^application\/x-www-form-urlencoded(\s*;|\s*$)/i.test(request.headers.get('Content-Type') ?? ''))
      return messagePage(415, '지원하지 않는 요청', '로그인 양식으로만 제출할 수 있어요.');
    let form;
    try { form = await request.formData(); } catch {
      return messagePage(400, '지원하지 않는 요청', '로그인 양식을 읽을 수 없어요.');
    }
    const handle = String(form.get('handle') ?? '');
    const returnTo = safeReturnTo(String(form.get('return_to') ?? ''));
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const check = await verifyOwnerPassword(env.DB, env, String(form.get('password') ?? ''));
    if (check.reason === 'locked')
      return messagePage(429, '잠시 후 다시 시도하세요', '비밀번호 시도가 너무 많아요. 15분 뒤에 다시 연결해 주세요.', null,
        { 'Retry-After': String(check.retryAfterSeconds) });
    if (!check.ok)
      return messagePage(401, '비밀번호가 맞지 않아요', '비밀번호를 확인한 뒤 다시 시도해 주세요.', returnTo);

    // The stored request (not the form) decides the profile, its scopes and its resource.
    const approved = await oauth.approveConsent(request, handle, { scope: [] });
    const profile = profileFor(env, approved.request);
    if (!profile) return notAllowed(env);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: env.HUB_OWNER_ID,
      metadata: { connector: profile.id },
      scope: [...profile.scopes],
      props: { ownerId: env.HUB_OWNER_ID, role: profile.role },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo && request.method === 'GET') {
      // Only parseAuthRequest() attaches redirectTo, after validating the client and exact redirect URI.
      const target = new URL(error.redirectTo);
      if (clientProfiles(env).some((p) => p.redirectUri === target.origin + target.pathname) ||
          isAllowedMcpCallback(target.origin + target.pathname))
        return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return messagePage(400, '연결을 완료할 수 없어요', '요청이 만료됐거나 올바르지 않아요. 연결을 처음부터 다시 시작해 주세요.');
    throw error;
  }
}
