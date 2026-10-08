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
columns. The thumbnail is swapped for `[prev peek][player][next peek]` and
the expanded card becomes a CSS grid (see "Prev/next peeks" below).

## List mode

`#clips-grid.is-list` (`display: block`): renders a `<table class="clips-table">`
inside `#clips-grid` via `clipListRowHtml()`. Columns: **Title** (with a compact
`.clip-list-thumb` thumbnail and duration overlay) | Game | Creator | Date |
Views — no separate rank or duration columns. Clicking a row calls `expandRow()`,
which inserts a `<tr class="clip-embed-row">` immediately after the clicked row;
the embed occupies a full-colspan `<td>` holding a `.clip-stage` with the same
`[prev peek][player][next peek]` trio; the peeks call `navigateRow()` to
advance between rows while preserving scroll position (same technique as
grid's `navigateClip()`).
`collapseRow()` removes the entire embed row. The active row and its embed row
are tracked by `_expandedRow` / `_insertedEmbedRow`. The close-btn and Escape
key handlers both dispatch to either `collapseCard` (grid) or `collapseRow`
(list). The prev/next button handler routes to `navigateRow` when `_expandedRow`
is set, else `navigateClip`.

## Prev/next peeks

`peekButtonHtml()` in `embed.ts` renders each prev/next button as a mini clip
card — direction label, thumbnail with an arrow badge, title — read from the
neighbouring card/row in the DOM (`peekFromEl`), or at a page edge from the
boundary clip that `render()` prefetches (`setPageBoundaryClips`, title +
thumbnail). Buttons keep the `.clip-prev-btn` / `.clip-next-btn` classes the
delegated click handler in `app.ts` routes on. A missing neighbour renders a
disabled button (`visibility: hidden`) so the player stays centred.

Layout is driven by container queries on `#clips-grid` (`container: clips`):

| container width | grid card                   | list `.clip-stage`   | peek shape            |
|-----------------|-----------------------------|----------------------|-----------------------|
| < 520px         | player / info / prev · next | player / prev · next | stacked (thumb above) |
| 520–1099px      | player / info / prev · next | player / prev · next | thumb beside text     |
| ≥ 1100px        | prev · player · next / info | prev · player · next | stacked, in gutters   |

At ≥ 1100px the peeks sit in the gutters a max-854px player leaves empty and
are vertically centred on it, so they're visible whenever the video is. The
gutter columns are `minmax(160px, 1fr)`: below ~1260px the player shrinks
rather than squeezing the peeks.

List view's clicked row and player are separate `<tr>`s, so `expandRow` uses
`scrollSpanIntoView(row, embedRow)` to bring the whole span into view (a
plain `scrollIntoView` on either can leave the player or peeks off-screen).
`←` / `→` (keydown handler in `app.ts`) also navigate while a clip is open,
except when focus is in a form control or inside the cross-origin iframe.

## Filter bar (`filterBar.ts`)

`#sticky-bar` is in normal flow and scrolls away with the page. A sentinel
(`#sticky-bar-sentinel`, directly after it) is watched by an
IntersectionObserver; once it's above the viewport the bar gets `.offscreen`,
which reveals `#filter-tab` — a small tab hanging from the top edge, with a
thin accent rule across the viewport. Clicking the tab adds `.pinned`
(`position: sticky`), sliding the bar back in with the tab hanging below it.

The bar unpins on a second tab click, Escape, a click outside it, or when its
natural position scrolls back into view. Any filter change made from the
pinned bar scrolls to the bar's natural position first (`revealResults`) so
the new result set is seen from the top — which also unpins it.

`updateFilterTab()` (called at the end of `render()` and from
`applyTranslations()`) sets the tab label to a summary of active filters
(search · game · dates), or "Filters" when none. `.has-live` (set by
`updateLiveBanner()`) shows a pulsing dot on the tab while the "new clips"
banner inside the hidden bar has something to show.

## Render loop

The render loop builds a flat `ClipItem[]` array (resolving the live/DB merge
logic) and then passes it to either the card or table renderer, so the complex
merging math only runs once per layout.
