# Grid vs. list layout (`clipLayout`)

`clipLayout` (`'grid' | 'list'` in `state.ts`) controls whether clips are
rendered as thumbnail cards or a compact table. It is orthogonal to
`currentView` — the calendar panel can be open regardless of layout.

The `⊞` / `☰` buttons in the controls bar's `.view-switcher` toggle this
state. `updateLayoutButtons()` in `app.ts` syncs the `.active` class on both
buttons. `clipLayout` is serialised as `layout=list` in the URL hash (the
`grid` default is omitted to keep URLs short).

## Grid mode

`#clips-grid` (`display: grid`): renders `.clip-card` elements via
`clipCardHtml()`. Clicking a card expands an inline Twitch embed
(`expandCard`/`collapseCard`), which uses `grid-column: 1/-1` to span all
columns.

## List mode

`#clips-grid.is-list` (`display: block`): renders a `<table class="clips-table">`
inside `#clips-grid` via `clipListRowHtml()`. Columns: **Title** (with a compact
`.clip-list-thumb` thumbnail and duration overlay) | Game | Creator | Date |
Views — no separate rank or duration columns. Clicking a row calls `expandRow()`,
which inserts a `<tr class="clip-embed-row">` immediately after the clicked row;
the embed occupies a full-colspan `<td>`. Below the iframe a `.clip-list-nav-row`
holds ← / → buttons that call `navigateRow()` to advance between rows while
preserving scroll position (same technique as grid's `navigateClip()`).
`collapseRow()` removes the entire embed row. The active row and its embed row
are tracked by `_expandedRow` / `_insertedEmbedRow`. The close-btn and Escape
key handlers both dispatch to either `collapseCard` (grid) or `collapseRow`
(list). The prev/next button handler routes to `navigateRow` when `_expandedRow`
is set, else `navigateClip`.

## Render loop

The render loop builds a flat `ClipItem[]` array (resolving the live/DB merge
logic) and then passes it to either the card or table renderer, so the complex
merging math only runs once per layout.
