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
`clipCardHtml()`. Clicking a card opens the Twitch player Google Images
style (`expandCard`/`collapseCard`): the card stays in place, marked
`.playing` (accent outline, play icon left showing, `aria-current`), and a
full-width `.clip-panel` holding a `.clip-stage` — `[prev peek][player][next
peek]`, the same as list view's — opens in the grid row below the card's
row, with a notch (`::before`, at `--notch-x`) pointing up at the card. So
no card is ever orphaned, and stepping to a neighbour in the same row just
swaps the panel's contents with no layout shift. Clicking the playing card
again closes the panel.

`placePanel()` positions the panel with an explicit `grid-row` (from the
pure `panelSlot(idx, cols, count)`; the column count is read from the grid's
computed `grid-template-columns`) rather than relying on DOM order. A
`ResizeObserver` on the grid re-runs it when the width changes, so a column
count change moves the panel by restyling it alone: re-inserting it would
reload the iframe and restart the clip. When the panel is (re)filled it's
detached first and inserted after its row's last card, so the new iframe
loads once and the DOM order follows the layout. `expandCard` reads all the
layout it needs (column count, card offset) *before* detaching. Anything that
forces a layout while the panel is out (`getComputedStyle`, `offsetTop`, …)
lays out a page one panel shorter, and near the bottom of the page the
browser clamps the scroll position up to fit.

Scrolling: `navigateClip` keeps the panel at the same screen position (when a
step crosses into another row the panel hops over a row of cards, and the
page scrolls by the same amount; at the very bottom of the page there's no
room to follow a hop downwards, so the panel just moves down a row).
The correction compares the panel's on-screen position before and after
(`viewportTop`), not its page offset. Browser scroll anchoring may scroll in
between: at the bottom of the page Chrome anchors on a card below the panel
and scrolls up a panel height as the panel hops past it. A page-offset delta
misses that scroll and stacks on top of it, while the on-screen delta undoes
it. (Turning anchoring off with `overflow-anchor: none` would also fix it,
but anchoring is what stops the grid shifting when the live-clips banner
appears above it while a clip is open.) Clicking a card below an open panel first
undoes the jump the panel's move causes, then scrolls card + panel into view
with `scrollSpanIntoView(card, panel, 'bottom')`, which, if both don't fit,
keeps the whole panel visible and shows the card's bottom edge (its title)
above it.

On a one-column grid the playing card also gets `.single-col`, which hides
its thumbnail (the player directly below would repeat it), leaving the
title and meta as a header above the player, the way list view's clicked row
sits above its embed row.

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

Grid panel and list embed row share the `.clip-stage` layout:

| container width | `.clip-stage`        | peek shape            |
|-----------------|----------------------|-----------------------|
| < 520px         | player / prev · next | stacked (thumb above) |
| 520–1099px      | player / prev · next | thumb beside text     |
| ≥ 1100px        | prev · player · next | stacked, in gutters   |

At ≥ 1100px the peeks sit in the gutters a max-854px player leaves empty and
are vertically centred on it, so they're visible whenever the video is. The
gutter columns are `minmax(160px, 1fr)`: below ~1260px the player shrinks
rather than squeezing the peeks.

In both layouts the clicked clip and its player are separate elements, so
`expandRow` uses `scrollSpanIntoView(row, embedRow)` (and `expandCard` its
`'bottom'` variant, above) to bring the whole span into view: a plain
`scrollIntoView` on either can leave the player or peeks off-screen.
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
