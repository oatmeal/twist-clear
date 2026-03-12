/**
 * Implicit grant OAuth flow for Twitch — no backend required.
 *
 * Twitch does not support PKCE for public clients; the authorization code
 * flow always requires client_secret. The implicit grant (response_type=token)
 * is the correct flow for browser-only apps: the access token is returned
 * directly in the URL fragment, with no token exchange step.
 *
 * Trade-offs vs. authorization code + PKCE:
 *   - No refresh token (user re-authenticates when the token expires, ~60 days)
 *   - Token arrives in the URL hash (stripped immediately on callback)
 */

import * as state from './state';
import { randomBase64url } from './lib/pkce';

const CLIENT_ID: string = (import.meta.env as Record<string, string>)['VITE_TWITCH_CLIENT_ID'] ?? '';

/** True when a Twitch app Client ID has been configured at build time. */
export const hasClientId: boolean = CLIENT_ID.length > 0;

// Redirect URI is dynamic so the same build works on localhost and any
// deployed origin (GitHub Pages, custom domain, etc.).
// Trailing slash is stripped so the URI registered in the Twitch app does not
// need one — Twitch does exact string matching and most users register without
// a trailing slash (e.g. "http://localhost:5173", not "http://localhost:5173/").
function redirectUri(): string {
  return (window.location.origin + window.location.pathname).replace(/\/$/, '');
}

// ── Storage keys ──────────────────────────────────────────────────────────

const LS = {
  accessToken: 'tc_access_token',
  expiresAt:   'tc_expires_at',
  username:    'tc_username',
} as const;

const SS = {
  oauthState:  'tc_oauth_state',
  preAuthHash: 'tc_pre_auth_hash',
} as const;

// ── Public API ────────────────────────────────────────────────────────────

/** Redirect the browser to Twitch's OAuth consent screen. */
export function initiateLogin(): void {
  const oauthState = randomBase64url(16);
  sessionStorage.setItem(SS.oauthState, oauthState);

  // Preserve the current filter state so it can be restored after the redirect
  // overwrites the URL hash with the OAuth response fragment.
  if (window.location.hash) {
    sessionStorage.setItem(SS.preAuthHash, window.location.hash);
  } else {
    sessionStorage.removeItem(SS.preAuthHash);
  }

  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri(),
    response_type: 'token',
    scope:         '',
    state:         oauthState,
  });
  // window.location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
  window.location.replace(`https://id.twitch.tv/oauth2/authorize?${params}`);
}

/**
 * Call on every page load. Detects an OAuth redirect (URL hash contains
 * access_token=…), stores the token, and cleans the hash. Returns true if
 * this page load was an OAuth callback (whether or not the token was accepted).
 */
export async function handleOAuthCallback(): Promise<boolean> {
  // Implicit grant returns params in the URL hash, not the query string.
  const hash = window.location.hash.slice(1); // strip leading '#'
  if (!hash) return false;

  const hashParams  = new URLSearchParams(hash);
  const accessToken = hashParams.get('access_token');
  if (!accessToken) return false;

  const returnedState = hashParams.get('state');
  const expiresIn     = hashParams.get('expires_in');

  // Strip the token hash and restore any pre-login filter state so the app's
  // hash-state parser (applyStateHash) picks up the user's previous filters.
  const savedHash = sessionStorage.getItem(SS.preAuthHash) ?? '';
  sessionStorage.removeItem(SS.preAuthHash);
  history.replaceState(null, '', window.location.pathname + window.location.search + savedHash);

  const expectedState = sessionStorage.getItem(SS.oauthState);
  sessionStorage.removeItem(SS.oauthState);

  if (returnedState !== expectedState) {
    console.warn('[auth] OAuth callback: state mismatch', {
      returned: returnedState,
      expected: expectedState,
    });
    return true;
  }

  console.debug('[auth] Token received via implicit grant');

  // Twitch implicit grant tokens last ~60 days; expires_in is in seconds.
  _storeTokens(accessToken, expiresIn ? Number(expiresIn) : 60 * 24 * 3600);

  const username = await _fetchUsername(accessToken);
  if (username) {
    localStorage.setItem(LS.username, username);
    state.setTwitchUsername(username);
  }

  return true;
}

/**
 * Returns a valid access token.
 * Returns null when not logged in or when the token has expired (no refresh
 * is possible with implicit grant — the user must log in again).
 */
export async function getValidToken(): Promise<string | null> {
  const accessToken = localStorage.getItem(LS.accessToken);
  const expiresAt   = Number(localStorage.getItem(LS.expiresAt) ?? 0);

  if (!accessToken) return null;

  // Still valid (with 5-min buffer).
  if (Date.now() < expiresAt - 5 * 60 * 1000) return accessToken;

  // Token expired; no refresh possible — clear and require re-login.
  _clearTokens();
  return null;
}

/** Clear all stored tokens and auth state. */
export function logout(): void {
  _clearTokens();
  state.setLiveClips([]);
  state.setTwitchUsername(null);
}

/** True when an access token exists in localStorage (may still be expired). */
export function isLoggedIn(): boolean {
  return localStorage.getItem(LS.accessToken) !== null;
}

/** Stored display name from the last successful login. */
export function getUsername(): string | null {
  return localStorage.getItem(LS.username);
}

// ── Internals ─────────────────────────────────────────────────────────────

function _storeTokens(accessToken: string, expiresIn: number): void {
  localStorage.setItem(LS.accessToken, accessToken);
  localStorage.setItem(LS.expiresAt,   String(Date.now() + expiresIn * 1000));
}

function _clearTokens(): void {
  localStorage.removeItem(LS.accessToken);
  localStorage.removeItem(LS.expiresAt);
  localStorage.removeItem(LS.username);
}

async function _fetchUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Client-Id':     CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ display_name: string }> };
    return data.data[0]?.display_name ?? null;
  } catch {
    return null;
  }
}
