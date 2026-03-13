/**
 * Parses a user search query into a valid FTS5 MATCH string or a compound
 * LIKE clause for terms shorter than 3 characters (below the trigram minimum).
 *
 * Supported syntax:
 *   word1 word2           → "word1" "word2"   (implicit AND)
 *   word1 OR word2        → "word1" OR "word2"
 *   word1 | word2         → "word1" OR "word2"  (full-width ｜ also accepted)
 *   word1 -word2          → "word1" NOT "word2"
 *   "exact phrase"        → "exact phrase"
 *   word -"exact phrase" → "word" NOT "exact phrase"
 *
 * Japanese IME normalization:
 *   full-width space \u3000 → ASCII space (applied globally)
 *   full-width minus \uff0d → negation prefix alias (only at token start, not inside words)
 */

type Token =
  | { kind: 'term'; value: string; negated: boolean }
  | { kind: 'or' };

function normalize(raw: string): string {
  return raw
    .replace(/\u3000/g, ' ')  // full-width space → ASCII space
    .trim();
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // skip whitespace
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;

    // pipe → OR  (ASCII '|' or full-width '｜' \uff5c)
    if (input[i] === '|' || input[i] === '\uff5c') {
      tokens.push({ kind: 'or' });
      i++;
      continue;
    }

    // "OR" keyword (case-insensitive), must be followed by whitespace or end
    if (/^OR(?:\s|$)/i.test(input.slice(i))) {
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }

    // negation prefix: '-' or full-width '－' (\uff0d) not followed by whitespace.
    // \uff0d is only an alias at token-start; inside a bare word it is left as-is.
    let negated = false;
    if ((input[i] === '-' || input[i] === '\uff0d') && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      negated = true;
      i++;
    }

    // quoted phrase
    if (input[i] === '"') {
      i++; // skip opening quote
      let value = '';
      while (i < input.length && input[i] !== '"') {
        value += input[i++];
      }
      if (i < input.length) i++; // skip closing quote
      if (value) tokens.push({ kind: 'term', value, negated });
      continue;
    }

    // bare word
    let word = '';
    while (i < input.length && !/\s/.test(input[i]!)) {
      word += input[i++];
    }
    if (word) tokens.push({ kind: 'term', value: word, negated });
  }

  return tokens;
}

/**
 * Convert a user search string to a safe FTS5 MATCH expression.
 * Returns null when there are no positive terms, or when any term is shorter
 * than 3 characters (FTS5 trigram minimum — caller should fall back to LIKE).
 */
export function parseSearchQuery(raw: string): string | null {
  const normalized = normalize(raw);
  if (!normalized) return null;

  const tokens = tokenize(normalized);
  if (!tokens.length) return null;

  const hasPositive = tokens.some(t => t.kind === 'term' && !t.negated);
  if (!hasPositive) return null;

  // FTS5 trigram requires ≥3 characters per token; bail out for short terms
  const hasShortTerm = tokens.some(t => t.kind === 'term' && t.value.length < 3);
  if (hasShortTerm) return null;

  const parts: string[] = [];
  let prevWasTerm = false;

  for (const token of tokens) {
    if (token.kind === 'or') {
      // only emit OR when preceded by a term (suppresses leading/consecutive ORs)
      if (prevWasTerm) {
        parts.push('OR');
        prevWasTerm = false;
      }
    } else {
      // strip any embedded quotes from the value to keep FTS5 syntax valid
      const safe = token.value.replace(/"/g, '');
      if (!safe) continue;
      const quoted = `"${safe}"`;
      parts.push(token.negated ? `NOT ${quoted}` : quoted);
      prevWasTerm = true;
    }
  }

  // strip trailing OR that was emitted before we saw the next term
  while (parts.length && parts[parts.length - 1] === 'OR') parts.pop();

  if (!parts.length) return null;
  return parts.join(' ');
}

export interface LikeQuery {
  clause: string;
  params: Record<string, string>;
}

/**
 * Convert a user search string to a compound SQL LIKE expression.
 * Used as a fallback when FTS5 is unavailable or terms are too short for
 * the trigram index. Supports the same boolean syntax as parseSearchQuery.
 * Returns null when there are no positive terms.
 */
export function parseLikeSearchQuery(raw: string): LikeQuery | null {
  const normalized = normalize(raw);
  if (!normalized) return null;

  const tokens = tokenize(normalized);
  if (!tokens.length) return null;

  const hasPositive = tokens.some(t => t.kind === 'term' && !t.negated);
  if (!hasPositive) return null;

  // Split into OR-groups separated by 'or' tokens
  const groups: Array<Array<{ value: string; negated: boolean }>> = [[]];
  for (const token of tokens) {
    if (token.kind === 'or') {
      groups.push([]);
    } else {
      groups[groups.length - 1]!.push({ value: token.value, negated: token.negated });
    }
  }

  // Drop groups that have no positive term (e.g. a trailing OR produces an empty group)
  const validGroups = groups.filter(g => g.some(t => !t.negated));
  if (!validGroups.length) return null;

  const params: Record<string, string> = {};
  let idx = 0;

  const groupClauses = validGroups.map(group => {
    const termClauses = group.map(({ value, negated }) => {
      const key = `:s${idx++}`;
      params[key] = `%${value}%`;
      return negated ? `c.title NOT LIKE ${key}` : `c.title LIKE ${key}`;
    });
    if (termClauses.length === 1) return termClauses[0]!;
    return `(${termClauses.join(' AND ')})`;
  });

  const clause = groupClauses.length === 1
    ? groupClauses[0]!
    : `(${groupClauses.join(' OR ')})`;

  return { clause, params };
}
