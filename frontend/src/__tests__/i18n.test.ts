import { describe, it, expect, afterEach } from 'vitest';
import { setLang, t } from '../lib/i18n';

describe('clipCount', () => {
  afterEach(() => setLang('ja'));

  // Expected strings use toLocaleString() themselves so the test doesn't
  // depend on the runner's default locale.
  it('groups thousands in English, matching resultCount', () => {
    setLang('en');
    expect(t().clipCount(28488)).toBe(`${(28488).toLocaleString()} clips`);
    expect(t().clipCount(28488)).toBe(t().resultCount(28488));
  });

  it('groups thousands in Japanese', () => {
    setLang('ja');
    expect(t().clipCount(28488)).toBe(`${(28488).toLocaleString()}本`);
  });

  it('keeps the English singular', () => {
    setLang('en');
    expect(t().clipCount(1)).toBe('1 clip');
    expect(t().clipCount(0)).toBe('0 clips');
  });
});
