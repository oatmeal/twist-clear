import { describe, it, expect } from 'vitest';
import { escHtml, fmtDuration, fmtViews, fmtDate } from '../lib/format';

describe('escHtml', () => {
  it('escapes ampersands', () => expect(escHtml('a & b')).toBe('a &amp; b'));
  it('escapes angle brackets', () => expect(escHtml('<script>')).toBe('&lt;script&gt;'));
  it('escapes double quotes', () => expect(escHtml('"hello"')).toBe('&quot;hello&quot;'));
  it('handles null', () => expect(escHtml(null)).toBe(''));
  it('handles undefined', () => expect(escHtml(undefined)).toBe(''));
  it('handles numbers', () => expect(escHtml(42)).toBe('42'));
  it('passes safe strings through unchanged', () => expect(escHtml('hello world')).toBe('hello world'));
});

describe('fmtDuration', () => {
  it('formats whole minutes', () => expect(fmtDuration(60)).toBe('1:00'));
  it('formats minutes and seconds', () => expect(fmtDuration(90)).toBe('1:30'));
  it('pads single-digit seconds', () => expect(fmtDuration(61)).toBe('1:01'));
  it('handles zero', () => expect(fmtDuration(0)).toBe('0:00'));
  it('handles sub-minute', () => expect(fmtDuration(45)).toBe('0:45'));
  it('rounds fractional seconds', () => expect(fmtDuration(90.6)).toBe('1:31'));
});

describe('fmtViews', () => {
  it('formats millions with one decimal', () => expect(fmtViews(1_500_000)).toBe('1.5M'));
  it('formats thousands with one decimal', () => expect(fmtViews(2_500)).toBe('2.5K'));
  it('formats exactly 1M', () => expect(fmtViews(1_000_000)).toBe('1.0M'));
  it('formats exactly 1K', () => expect(fmtViews(1_000)).toBe('1.0K'));
  it('formats small numbers as-is', () => expect(fmtViews(42)).toBe('42'));
  it('formats 999 as-is', () => expect(fmtViews(999)).toBe('999'));

  describe('ja locale', () => {
    it('formats 億 (100M+)', () => expect(fmtViews(150_000_000, 'ja')).toBe('1.5億'));
    it('formats exactly 1億', () => expect(fmtViews(100_000_000, 'ja')).toBe('1.0億'));
    it('formats 万 (10K+)', () => expect(fmtViews(25_000, 'ja')).toBe('2.5万'));
    it('formats exactly 1万', () => expect(fmtViews(10_000, 'ja')).toBe('1.0万'));
    it('formats small numbers as-is', () => expect(fmtViews(9_999, 'ja')).toBe('9,999'));
    it('formats sub-10K as-is', () => expect(fmtViews(42, 'ja')).toBe('42'));
  });
});

describe('fmtDate', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = fmtDate('2024-03-15T12:00:00Z');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});
