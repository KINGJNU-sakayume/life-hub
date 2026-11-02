/**
 * Owner pages for the Spotify link (same look as the consent page):
 *   GET  /spotify             status
 *   POST /spotify/connect     owner password → Spotify authorization (PKCE)
 *   GET  /spotify/callback    Spotify returns here; the code is exchanged once
 *   POST /spotify/poll        owner password → collect now (normally the hourly cron does it)
 *   POST /spotify/disconnect  owner password → forget the authorization and waiting plays
 * Every state-changing request needs the owner password, so no session cookie is involved.
 */
import { escapeHtml, page, verifyOwnerPassword, ownerLoginConfigured } from '../auth/owner-login.js';
import {
  linkSpotify, pollSpotify, spotifyClientId, spotifyConfigured, spotifyRedirectUri, spotifyStatus, unlinkSpotify,
  SpotifyError, SPOTIFY_ACCOUNTS, SPOTIFY_SCOPE,
} from './sync.js';

const STATE_TTL_S = 600;
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음');
const ERROR_TEXT = {
  revoked: 'Spotify 연결이 끊어졌어요(권한 해제 또는 만료). 다시 연결해 주세요.',
  network: '마지막 수집 때 Spotify에 연결하지 못했어요. 다음 수집 때 다시 시도해요.',
  server: '마지막 수집 때 오류가 있었어요. 다음 수집 때 다시 시도해요.',
};

const form = (action, label, primary = false) => `<form method="post" action="${action}">
<label for="pw-${action.replace(/\W/g, '')}">주인 비밀번호</label>
<input id="pw-${action.replace(/\W/g, '')}" type="password" name="password" autocomplete="current-password" required>
<div class="row"><button class="${primary ? 'primary' : ''}" type="submit">${escapeHtml(label)}</button></div></form>`;

async function statusPage(env, notice = '') {
  const status = await spotifyStatus(env);
  const body = `<h1>Spotify 청취 수집</h1>
${notice ? `<p class="warn">${escapeHtml(notice)}</p>` : ''}
<p class="muted">한 시간마다 Spotify의 최근 재생 목록을 확인해서, <strong>앨범에서 직접 재생한</strong> 곡만 앨범 단위로 묶어 potcast에 제안해요. 플레이리스트·라디오·자동 재생은 세지 않아요. 제안은 potcast에서 곡별로 확인하고 승인해야 기록돼요.</p>
${status ? `<p>연결됨 · ${escapeHtml(fmt(status.linked_at))}<br>마지막 수집: ${escapeHtml(fmt(status.last_polled_at))} · 정리 대기 중인 재생 ${Number(status.waiting)}개</p>
${status.last_error ? `<p class="warn">${escapeHtml(ERROR_TEXT[status.last_error] ?? ERROR_TEXT.server)}</p>` : ''}
${form('/spotify/poll', '지금 수집')}${status.last_error === 'revoked' ? form('/spotify/connect', 'Spotify 다시 연결', true) : ''}${form('/spotify/disconnect', '연결 해제')}`
    : form('/spotify/connect', 'Spotify 연결', true)}
<p class="muted">권한: <code>${SPOTIFY_SCOPE}</code> (최근 재생 읽기만)</p>`;
  return page(200, 'Spotify 청취 수집', body, undefined, [SPOTIFY_ACCOUNTS]);
}

async function checkPassword(request, env) {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!/^application\/x-www-form-urlencoded/i.test(ct)) return { ok: false, notice: '잘못된 요청이에요.' };
  const text = await request.text();
  if (text.length > 4096) return { ok: false, notice: '잘못된 요청이에요.' };
  const result = await verifyOwnerPassword(env.DB, env, new URLSearchParams(text).get('password') ?? '');
  if (result.ok) return { ok: true };
  return { ok: false, notice: result.reason === 'locked' ? `시도가 너무 많아요. ${Math.ceil(result.retryAfterSeconds / 60)}분 뒤에 다시 해 주세요.` : '비밀번호가 맞지 않아요.' };
}

export async function handleSpotify(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (!spotifyConfigured(env) || !ownerLoginConfigured(env) || !env.OAUTH_KV)
    return page(503, 'Spotify 수집 꺼짐', '<h1>Spotify 수집이 꺼져 있어요</h1><p class="muted">HUB_SPOTIFY_CLIENT_ID 변수와 HUB_SPOTIFY_TOKEN_KEY 비밀값을 설정한 뒤 배포해 주세요.</p>');

  if (url.pathname === '/spotify' && request.method === 'GET') return statusPage(env);

  if (url.pathname === '/spotify/connect' && request.method === 'POST') {
    const auth = await checkPassword(request, env);
    if (!auth.ok) return statusPage(env, auth.notice);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    await env.OAUTH_KV.put('spotify-auth:' + state, JSON.stringify({ verifier }), { expirationTtl: STATE_TTL_S });
    const q = new URLSearchParams({
      client_id: spotifyClientId(env), response_type: 'code', redirect_uri: spotifyRedirectUri(env), scope: SPOTIFY_SCOPE,
      state, code_challenge_method: 'S256', code_challenge: challenge,
    });
    return new Response(null, { status: 303, headers: { Location: `${SPOTIFY_ACCOUNTS}/authorize?${q}`, 'Cache-Control': 'no-store' } });
  }

  if (url.pathname === '/spotify/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state') ?? '';
    const saved = /^[A-Za-z0-9_-]{16,64}$/.test(state) ? await env.OAUTH_KV.get('spotify-auth:' + state, 'json') : null;
    if (saved) await env.OAUTH_KV.delete('spotify-auth:' + state);
    if (!saved) return statusPage(env, '연결 요청이 만료됐거나 여기서 시작되지 않았어요. 다시 연결해 주세요.');
    if (url.searchParams.has('error')) return statusPage(env, 'Spotify 연결을 취소했어요.');
    const code = url.searchParams.get('code');
    if (!code) return statusPage(env, 'Spotify가 인증 코드를 주지 않았어요.');
    try {
      await linkSpotify(env, code, saved.verifier, fetchFn);
    } catch (error) {
      return statusPage(env, error instanceof SpotifyError ? 'Spotify 연결에 실패했어요. 다시 시도해 주세요.' : '연결 중 오류가 있었어요.');
    }
    return statusPage(env, 'Spotify를 연결했어요. 한 시간 안에 첫 수집을 해요.');
  }

  if (url.pathname === '/spotify/poll' && request.method === 'POST') {
    const auth = await checkPassword(request, env);
    if (!auth.ok) return statusPage(env, auth.notice);
    const r = await pollSpotify(env, fetchFn);
    if (!r) return statusPage(env, 'Spotify가 연결되어 있지 않아요.');
    if (r.error) return statusPage(env, ERROR_TEXT[r.error] ?? ERROR_TEXT.server);
    return statusPage(env, `새 재생 ${r.stored}개를 확인했고, potcast에 앨범 ${r.proposed}개를 제안했어요.`);
  }

  if (url.pathname === '/spotify/disconnect' && request.method === 'POST') {
    const auth = await checkPassword(request, env);
    if (!auth.ok) return statusPage(env, auth.notice);
    await unlinkSpotify(env);
    return statusPage(env, 'Spotify 연결을 해제했어요. 저장해 둔 재생 기록도 지웠어요. Spotify 계정 설정에서 앱 권한도 해제할 수 있어요.');
  }
  return new Response('Not found', { status: 404 });
}
