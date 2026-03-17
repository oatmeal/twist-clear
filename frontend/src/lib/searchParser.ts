/**
 * Parses a user search query into a valid FTS5 MATCH string or a compound
 * LIKE clause for terms shorter than 3 characters (below the trigram minimum).
 *
 * Supported syntax:
 *   word1 word2            → "word1" "word2"          (implicit AND)
 *   word1 OR word2         → "word1" OR "word2"        (| and ｜ also accepted)
 *   word1 -word2           → "word1" NOT "word2"       (binary NOT)
 *   "exact phrase"         → "exact phrase"
 *   word -"exact phrase"   → "word" NOT "exact phrase"
 *   (word1 OR word2) word3 → ("word1" OR "word2") "word3"
 *   word -(word1 OR word2) → "word" NOT ("word1" OR "word2")
 *
 * The '-' operator is strictly binary: it requires a left-hand operand and
 * binds tightly to exactly one atom on the right (matching FTS5's NOT semantics).
 * This means '-word' alone (no positive term) returns null, and
 * '-(group)' can appear after any positive atom.
 *
 * For the LIKE fallback, negated groups are expanded via De Morgan:
 *   NOT (A OR B)  →  NOT LIKE A  AND  NOT LIKE B
 *   NOT (A AND B) →  NOT LIKE A  OR   NOT LIKE B
 *
 * Japanese IME normalization:
 *   full-width space \u3000 → ASCII space (applied globally)
 *   full-width minus \uff0d → NOT operator alias (only at token start, not inside words)
 */

// ── Token types ──────────────────────────────────────────────────────────────

type Token =
  | { kind: 'term'; value: string }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'open' }
  | { kind: 'close' };

// ── Expression tree (AST) ─────────────────────────────────────────────────────

type Expr =
  | { kind: 'term'; value: string }
  | { kind: 'not';  child: Expr }
  | { kind: 'and';  children: Expr[] }
  | { kind: 'or';   children: Expr[] };

// ── Normalization ─────────────────────────────────────────────────────────────

function normalize(raw: string): string {
  return raw
    .replace(/\u3000/g, ' ')  // full-width space → ASCII space
    .trim();
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // skip whitespace
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;

    // '(' → open
    if (input[i] === '(') {
      tokens.push({ kind: 'open' });
      i++;
      continue;
    }

    // ')' → close
    if (input[i] === ')') {
      tokens.push({ kind: 'close' });
      i++;
      continue;
    }

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

    // NOT prefix: '-' or full-width '－' (\uff0d) not followed by whitespace.
    // Emitted as a binary NOT operator; the atom on the right is the operand.
    // \uff0d is only a NOT alias at token-start; inside a bare word it is left as-is.
    if ((input[i] === '-' || input[i] === '\uff0d') && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }

    // quoted phrase
    if (input[i] === '"') {
      i++; // skip opening quote
      let value = '';
      while (i < input.length && input[i] !== '"') {
        value += input[i++];
      }
      if (i < input.length) i++; // skip closing quote
      if (value) tokens.push({ kind: 'term', value });
      continue;
    }

    // bare word — stop at whitespace, '(', or ')'
    let word = '';
    while (i < input.length && !/[\s()]/.test(input[i]!)) {
      word += input[i++];
    }
    if (word) tokens.push({ kind: 'term', value: word });
  }

  return tokens;
}

// ── Recursive-descent parser ──────────────────────────────────────────────────

interface ParseState {
  tokens: Token[];
  pos: number;
}

/**
 * or_expr = and_expr (OR and_expr)*
 */
function parseOrExpr(s: ParseState): Expr {
  const children: Expr[] = [];

  const first = parseAndExpr(s);
  if (first !== null) children.push(first);

  while (s.pos < s.tokens.length && s.tokens[s.pos]!.kind === 'or') {
    s.pos++; // consume 'or'
    const next = parseAndExpr(s);
    if (next !== null) children.push(next);
  }

  if (children.length === 0) return { kind: 'and', children: [] };
  if (children.length === 1) return children[0]!;
  return { kind: 'or', children };
}

/**
 * and_expr = (atom | NOT atom)+  (stops at OR or close-paren)
 *
 * '-' is a binary NOT operator: it binds tightly to the single atom on its
 * right, consistent with FTS5's own NOT semantics. A leading NOT with no
 * preceding atom is valid in context (the top-level hasPositiveTerm check
 * catches purely-negative queries).
 */
function parseAndExpr(s: ParseState): Expr | null {
  const children: Expr[] = [];

  while (s.pos < s.tokens.length) {
    const tok = s.tokens[s.pos]!;
    if (tok.kind === 'or' || tok.kind === 'close') break;

    if (tok.kind === 'not') {
      s.pos++; // consume 'not'
      // Dangling NOT at end / before OR / before close → skip
      if (
        s.pos >= s.tokens.length ||
        s.tokens[s.pos]!.kind === 'or' ||
        s.tokens[s.pos]!.kind === 'close'
      ) continue;
      const operand = parseAtom(s);
      if (operand !== null) children.push({ kind: 'not', child: operand });
      continue;
    }

    const atom = parseAtom(s);
    if (atom !== null) children.push(atom);
  }

  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: 'and', children };
}

/**
 * atom = TERM | '(' or_expr ')'
 */
function parseAtom(s: ParseState): Expr | null {
  const tok = s.tokens[s.pos]!;

  if (tok.kind === 'open') {
    s.pos++; // consume '('
    const inner = parseOrExpr(s);
    if (s.pos < s.tokens.length && s.tokens[s.pos]!.kind === 'close') {
      s.pos++; // consume ')'
    }
    // skip empty groups
    if (inner.kind === 'and' && inner.children.length === 0) return null;
    return inner;
  }

  if (tok.kind === 'term') {
    s.pos++;
    return tok;
  }

  // 'not', 'or', 'close' — shouldn't reach here in normal flow; advance to prevent
  // infinite loop
  s.pos++;
  return null;
}

// ── AST helpers ───────────────────────────────────────────────────────────────

function hasPositiveTerm(expr: Expr): boolean {
  if (expr.kind === 'term') return true;
  if (expr.kind === 'not')  return false;
  return expr.children.some(hasPositiveTerm);
}

/** Returns true if any term in the expression has fewer than 3 characters. */
function hasShortTerm(expr: Expr): boolean {
  if (expr.kind === 'term') return expr.value.length < 3;
  if (expr.kind === 'not')  return hasShortTerm(expr.child);
  return expr.children.some(hasShortTerm);
}

// ── FTS5 emitter ──────────────────────────────────────────────────────────────

/**
 * Emit an FTS5 MATCH sub-expression.
 * @param wrapOr - When true, wrap OR expressions in parentheses. Pass true
 *   when emitting a child of an AND node (needed because FTS5 AND has higher
 *   precedence than OR; without parens "A OR B C" reads as "A OR (B AND C)").
 */
function emitFts5Expr(expr: Expr, wrapOr: boolean = false): string | null {
  switch (expr.kind) {
    case 'term': {
      // strip any embedded quotes from the value to keep FTS5 syntax valid
      const safe = expr.value.replace(/"/g, '');
      if (!safe) return null;
      return `"${safe}"`;
    }
    case 'not': {
      const inner = emitFts5Expr(expr.child, false);
      if (!inner) return null;
      // Wrap compound (multi-child) inner expressions so NOT binds correctly
      const compound = (expr.child.kind === 'and' || expr.child.kind === 'or')
        && expr.child.children.length > 1;
      return compound ? `NOT (${inner})` : `NOT ${inner}`;
    }
    case 'or': {
      const parts = expr.children
        .map(c => emitFts5Expr(c, false))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      const joined = parts.join(' OR ');
      return wrapOr ? `(${joined})` : joined;
    }
    case 'and': {
      // Children of AND: pass wrapOr=true so any OR child gets wrapped
      const parts = expr.children
        .map(c => emitFts5Expr(c, true))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      return parts.join(' ');
    }
  }
}

// ── LIKE emitter ──────────────────────────────────────────────────────────────

function emitLikeExpr(
  expr: Expr,
  params: Record<string, string>,
  idx: { n: number },
): string | null {
  switch (expr.kind) {
    case 'term': {
      const key = `:s${idx.n++}`;
      params[key] = `%${expr.value}%`;
      return `c.title LIKE ${key}`;
    }
    case 'not': {
      return emitLikeNegated(expr.child, params, idx);
    }
    case 'or': {
      const parts = expr.children
        .map(c => emitLikeExpr(c, params, idx))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join(' OR ')})`;
    }
    case 'and': {
      const parts = expr.children
        .map(c => emitLikeExpr(c, params, idx))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join(' AND ')})`;
    }
  }
}

/**
 * Emit a negated LIKE expression by applying De Morgan's laws:
 *   NOT term          →  c.title NOT LIKE :sN
 *   NOT (A OR B)      →  NOT LIKE A  AND  NOT LIKE B
 *   NOT (A AND B)     →  NOT LIKE A  OR   NOT LIKE B
 *   NOT (NOT X)       →  (double-negation cancelled) emit X normally
 */
function emitLikeNegated(
  expr: Expr,
  params: Record<string, string>,
  idx: { n: number },
): string | null {
  switch (expr.kind) {
    case 'term': {
      const key = `:s${idx.n++}`;
      params[key] = `%${expr.value}%`;
      return `c.title NOT LIKE ${key}`;
    }
    case 'not': {
      // NOT NOT X = X
      return emitLikeExpr(expr.child, params, idx);
    }
    case 'or': {
      // NOT (A OR B) = NOT A AND NOT B
      const parts = expr.children
        .map(c => emitLikeNegated(c, params, idx))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join(' AND ')})`;
    }
    case 'and': {
      // NOT (A AND B) = NOT A OR NOT B
      const parts = expr.children
        .map(c => emitLikeNegated(c, params, idx))
        .filter((p): p is string => p !== null);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      return `(${parts.join(' OR ')})`;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

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

  const s: ParseState = { tokens, pos: 0 };
  const expr = parseOrExpr(s);

  if (!hasPositiveTerm(expr)) return null;

  // FTS5 trigram requires ≥3 characters per token; bail out for short terms
  if (hasShortTerm(expr)) return null;

  return emitFts5Expr(expr);
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

  const s: ParseState = { tokens, pos: 0 };
  const expr = parseOrExpr(s);

  if (!hasPositiveTerm(expr)) return null;

  const params: Record<string, string> = {};
  const idx = { n: 0 };
  const clause = emitLikeExpr(expr, params, idx);

  if (!clause) return null;
  return { clause, params };
}
