/**
 * OAuth cryptographic helpers — pure functions with no side effects.
 *
 * Exported separately from auth.ts so they can be unit-tested in Node without
 * DOM or localStorage dependencies. Both functions use the Web Crypto API
 * (available globally in Node 18+ and all modern browsers).
 *
 * randomBase64url is used for the OAuth state nonce.
 * sha256Base64url implements the RFC 7636 S256 code_challenge format (retained
 * for completeness and in case PKCE support is added in future).
 */

/** Generate a URL-safe base64 string from `byteCount` random bytes. */
export function randomBase64url(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * SHA-256 hash of `plain` (UTF-8 encoded), returned as a URL-safe base64
 * string with no padding — the PKCE code_challenge format (S256 method).
 */
export async function sha256Base64url(plain: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
