import { describe, it, expect } from 'vitest';
import { parseSearchQuery, parseLikeSearchQuery } from '../lib/searchParser';

describe('parseSearchQuery — null cases', () => {
  it('returns null for empty string', () => {
    expect(parseSearchQuery('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseSearchQuery('   ')).toBeNull();
  });

  it('returns null for full-width space only', () => {
    expect(parseSearchQuery('\u3000')).toBeNull();
  });

  it('returns null for pure negation (no positive terms)', () => {
    expect(parseSearchQuery('-boss')).toBeNull();
  });

  it('returns null for multiple negations and no positive term', () => {
    expect(parseSearchQuery('-boss -clip')).toBeNull();
  });

  it('returns null for lone OR keyword', () => {
    expect(parseSearchQuery('OR')).toBeNull();
  });

  it('returns null for lone pipe', () => {
    expect(parseSearchQuery('|')).toBeNull();
  });
});

describe('parseSearchQuery — single terms', () => {
  it('wraps a bare term in quotes', () => {
    expect(parseSearchQuery('pog')).toBe('"pog"');
  });

  it('wraps a multi-char term in quotes', () => {
    expect(parseSearchQuery('mario')).toBe('"mario"');
  });

  it('handles a quoted phrase input as-is (content preserved)', () => {
    expect(parseSearchQuery('"pog moment"')).toBe('"pog moment"');
  });
});

describe('parseSearchQuery — implicit AND', () => {
  it('joins two bare terms with a space (implicit AND)', () => {
    expect(parseSearchQuery('pog hype')).toBe('"pog" "hype"');
  });

  it('joins three bare terms', () => {
    expect(parseSearchQuery('mario zelda link')).toBe('"mario" "zelda" "link"');
  });

  it('handles mixed bare term + quoted phrase', () => {
    expect(parseSearchQuery('mario "final boss"')).toBe('"mario" "final boss"');
  });
});

describe('parseSearchQuery — OR operator', () => {
  it('handles OR keyword between terms', () => {
    expect(parseSearchQuery('pog OR hype')).toBe('"pog" OR "hype"');
  });

  it('handles OR case-insensitively', () => {
    expect(parseSearchQuery('pog or hype')).toBe('"pog" OR "hype"');
  });

  it('handles pipe as OR alias', () => {
    expect(parseSearchQuery('pog | hype')).toBe('"pog" OR "hype"');
  });

  it('handles full-width pipe \uff5c as OR alias', () => {
    expect(parseSearchQuery('mario \uff5c zelda')).toBe('"mario" OR "zelda"');
  });

  it('strips a leading OR', () => {
    expect(parseSearchQuery('OR mario')).toBe('"mario"');
  });

  it('strips a trailing OR', () => {
    expect(parseSearchQuery('mario OR')).toBe('"mario"');
  });

  it('collapses consecutive ORs', () => {
    expect(parseSearchQuery('mario OR OR zelda')).toBe('"mario" OR "zelda"');
  });
});

describe('parseSearchQuery — negation', () => {
  it('emits NOT for a negated term when a positive term is also present', () => {
    expect(parseSearchQuery('mario -boss')).toBe('"mario" NOT "boss"');
  });

  it('handles negated quoted phrase', () => {
    expect(parseSearchQuery('mario -"final boss"')).toBe('"mario" NOT "final boss"');
  });

  it('handles negation combined with OR', () => {
    expect(parseSearchQuery('mario OR zelda -boss')).toBe('"mario" OR "zelda" NOT "boss"');
  });
});

describe('parseSearchQuery — Japanese IME normalization', () => {
  it('normalizes full-width space \\u3000 to a term separator', () => {
    expect(parseSearchQuery('mario\u3000zelda')).toBe('"mario" "zelda"');
  });

  it('treats full-width minus \\uff0d as negation prefix when at token start', () => {
    // full-width space separates tokens; \uff0d at start of second token → NOT
    expect(parseSearchQuery('mario\u3000\uff0dboss')).toBe('"mario" NOT "boss"');
  });

  it('preserves full-width minus \\uff0d inside a bare word (not treated as negation)', () => {
    // \uff0d in the middle of a word is left as-is, so the search finds the
    // literal full-width character — important for titles like "マリオ－ゼルダ"
    expect(parseSearchQuery('mario\uff0dzelda')).toBe('"mario\uff0dzelda"');
  });

  it('treats Japanese text as a normal term', () => {
    expect(parseSearchQuery('マリオ')).toBe('"マリオ"');
  });

  it('handles Japanese terms with full-width space separator', () => {
    expect(parseSearchQuery('マリオ\u3000ゼルダ')).toBe('"マリオ" "ゼルダ"');
  });
});

describe('parseSearchQuery — short-term fallback (FTS5 trigram minimum)', () => {
  it('returns null for a single 1-char term', () => {
    expect(parseSearchQuery('猫')).toBeNull();
  });

  it('returns null for a single 2-char term', () => {
    expect(parseSearchQuery('ab')).toBeNull();
  });

  it('returns null for OR of two short terms', () => {
    expect(parseSearchQuery('猫 OR 犬')).toBeNull();
  });

  it('returns null when any term is short, even if others are long', () => {
    expect(parseSearchQuery('mario OR 犬')).toBeNull();
  });

  it('does not return null for a 3-char term', () => {
    expect(parseSearchQuery('abc')).toBe('"abc"');
  });
});

describe('parseLikeSearchQuery — null cases', () => {
  it('returns null for empty string', () => {
    expect(parseLikeSearchQuery('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseLikeSearchQuery('   ')).toBeNull();
  });

  it('returns null for pure negation', () => {
    expect(parseLikeSearchQuery('-boss')).toBeNull();
  });
});

describe('parseLikeSearchQuery — single terms', () => {
  it('single short term', () => {
    const result = parseLikeSearchQuery('猫');
    expect(result).not.toBeNull();
    expect(result!.clause).toBe('c.title LIKE :s0');
    expect(result!.params).toEqual({ ':s0': '%猫%' });
  });

  it('single long term', () => {
    const result = parseLikeSearchQuery('mario');
    expect(result!.clause).toBe('c.title LIKE :s0');
    expect(result!.params).toEqual({ ':s0': '%mario%' });
  });
});

describe('parseLikeSearchQuery — implicit AND', () => {
  it('two short terms joined with AND', () => {
    const result = parseLikeSearchQuery('猫 犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 AND c.title LIKE :s1)');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%犬%' });
  });

  it('mixed short and long terms (AND)', () => {
    const result = parseLikeSearchQuery('猫 mario');
    expect(result!.clause).toBe('(c.title LIKE :s0 AND c.title LIKE :s1)');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%mario%' });
  });
});

describe('parseLikeSearchQuery — OR operator', () => {
  it('two short terms joined with OR', () => {
    const result = parseLikeSearchQuery('猫 OR 犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 OR c.title LIKE :s1)');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%犬%' });
  });

  it('pipe alias for OR', () => {
    const result = parseLikeSearchQuery('猫 | 犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 OR c.title LIKE :s1)');
  });

  it('full-width pipe \uff5c alias for OR', () => {
    const result = parseLikeSearchQuery('猫 \uff5c 犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 OR c.title LIKE :s1)');
  });

  it('strips leading OR', () => {
    const result = parseLikeSearchQuery('OR 猫');
    expect(result!.clause).toBe('c.title LIKE :s0');
  });

  it('strips trailing OR', () => {
    const result = parseLikeSearchQuery('猫 OR');
    expect(result!.clause).toBe('c.title LIKE :s0');
  });
});

describe('parseLikeSearchQuery — negation', () => {
  it('positive term AND negated term', () => {
    const result = parseLikeSearchQuery('猫 -犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 AND c.title NOT LIKE :s1)');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%犬%' });
  });

  it('OR with negated term in second group', () => {
    const result = parseLikeSearchQuery('猫 OR 犬 -鳥');
    // groups: [猫], [犬, -鳥]
    expect(result!.clause).toBe('(c.title LIKE :s0 OR (c.title LIKE :s1 AND c.title NOT LIKE :s2))');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%犬%', ':s2': '%鳥%' });
  });
});

describe('parseLikeSearchQuery — Japanese IME normalization', () => {
  it('normalizes full-width space', () => {
    const result = parseLikeSearchQuery('猫\u3000犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 AND c.title LIKE :s1)');
    expect(result!.params).toEqual({ ':s0': '%猫%', ':s1': '%犬%' });
  });

  it('treats full-width minus at token-start as negation', () => {
    const result = parseLikeSearchQuery('猫\u3000\uff0d犬');
    expect(result!.clause).toBe('(c.title LIKE :s0 AND c.title NOT LIKE :s1)');
  });
});

describe('parseSearchQuery — edge cases', () => {
  it('strips embedded double-quotes from a bare word', () => {
    expect(parseSearchQuery('foo"bar')).toBe('"foobar"');
  });

  it('handles hyphen followed by whitespace: returns null (1-char term below FTS5 minimum)', () => {
    // "- boss" → '-' is not followed by non-whitespace, so negated=false and '-' is
    // read as a 1-char bare word. The short-term check (value.length < 3) causes null
    // to be returned; the caller falls back to parseLikeSearchQuery / simple LIKE.
    expect(parseSearchQuery('- boss')).toBeNull();
  });

  it('returns null if all terms have empty values after quote stripping', () => {
    // A term consisting only of double-quotes gets stripped to empty and skipped
    expect(parseSearchQuery('"""')).toBeNull();
  });
});
