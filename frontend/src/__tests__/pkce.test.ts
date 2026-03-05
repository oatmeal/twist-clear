import { describe, it, expect } from 'vitest';
import { randomBase64url, sha256Base64url } from '../lib/pkce';

describe('sha256Base64url', () => {
  // RFC 7636 Appendix B test vector — the canonical PKCE interop check.
  it('matches the RFC 7636 Appendix B test vector', async () => {
    const verifier  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await sha256Base64url(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('output contains only URL-safe base64 characters', async () => {
    const result = await sha256Base64url('test input string');
    expect(result).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('does not contain base64 padding or standard base64 special chars', async () => {
    const result = await sha256Base64url('any string');
    expect(result).not.toContain('=');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('SHA-256 output encodes to exactly 43 URL-safe base64 chars', async () => {
    // SHA-256 → 32 bytes → ceil(32 * 4/3) = 43 chars after stripping padding
    const result = await sha256Base64url('hello world');
    expect(result).toHaveLength(43);
  });

  it('different inputs produce different outputs', async () => {
    const a = await sha256Base64url('input-a');
    const b = await sha256Base64url('input-b');
    expect(a).not.toBe(b);
  });

  it('same input always produces the same output (deterministic)', async () => {
    const input = 'deterministic test';
    const a = await sha256Base64url(input);
    const b = await sha256Base64url(input);
    expect(a).toBe(b);
  });
});

describe('randomBase64url', () => {
  it('returns a non-empty string', () => {
    expect(randomBase64url(16)).not.toBe('');
  });

  it('output contains only URL-safe base64 characters', () => {
    const result = randomBase64url(96);
    expect(result).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('does not contain base64 padding or standard base64 special chars', () => {
    const result = randomBase64url(96);
    expect(result).not.toContain('=');
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('96 bytes produces exactly 128 characters', () => {
    // 96 bytes: 96/3 = 32 full base64 groups → 32 × 4 = 128 chars, no padding
    expect(randomBase64url(96)).toHaveLength(128);
  });

  it('16 bytes produces exactly 22 characters', () => {
    // 16 bytes: 15 bytes → 20 chars + 1 remaining byte → 2 chars (= stripped) = 22 chars
    expect(randomBase64url(16)).toHaveLength(22);
  });

  it('produces different output on successive calls', () => {
    // Statistically certain with 16 bytes (128 bits) of entropy
    const a = randomBase64url(16);
    const b = randomBase64url(16);
    expect(a).not.toBe(b);
  });
});
