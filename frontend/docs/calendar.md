# Date filter: selection, navigation, timeline and calendar

## The model

Two separate pieces of state, never mixed:

- **Selection** — the date filter, `calDateFrom` / `calDateTo` in `state.ts`:
  local `YYYY-MM-DD` dates, `to` exclusive, either end may be `null`. Its
  *kind* (day, Sun–Sat week, month, year, custom, open) is derived from the
  dates by `rangeKind()` in `lib/dateRange.ts`, not stored — so a range typed
  into the date inputs behaves exactly like the same range clicked in the
  calendar. (There used to be `calDay` / `calWeek` state and `day` / `week`
  hash params; both are gone, and old URLs still work via `from` / `to`.)
- **Navigation** — what the calendar panel shows: `calYear` plus `calMonth`
  (`null` = the year view). Serialized as `year` / `month` in the hash only
  while the panel is open.

The rule: **navigating never changes the selection; selecting may move the
view, but only when the new selection is entirely off-screen** (typed into the
inputs, or dragged on the timeline). Clicking a day that's on screen leaves the
view where it is.

In code:

- Every selection change goes through `applyDateSelection(from, to)` in
  `calendar.ts` — date inputs, the clear button, calendar clicks / drags /
  shift-clicks, the "Filter to …" button, and the timeline. It syncs the date
  inputs, moves the view if needed, re-renders the calendar, resets to page 1
  and calls `render()`.
- Every navigation change goes through `navigate()` — it re-renders the
  calendar and calls `render()` only to update the URL hash and the timeline's
  view underline (the page isn't reset; results don't change).

### Why not "the view always follows the selection"?

The October 2026 UX review (see `docs/future-work.md`) found that navigation
and selection controls looked identical, so the view and the filter drifted
apart ("2024 › July" in the breadcrumb while the grid showed June's clips).
Coupling them — every click selects, one ‹ › steps the selection — was
considered and rejected: browsing would then destroy selections, and a typed
custom range is the most expensive one to recreate. Instead we kept the
date-picker rule above and made the selection always visible outside the
calendar, in the timeline.

## Timeline overview (`timeline.ts`, `lib/timeline.ts`)

The last row of the filter bar (`#timeline`): an SVG histogram of the whole
archive, `calMinDate`…`calMaxDate`.

- **Bars**: one per week (Sunday-aligned), or per month when week bars would be
  narrower than `MIN_WEEK_PX` (phones, tablets). Square-root height scale. Bars
  use `--cal-accent`; with a selection, bars outside it are dimmed and the band
  behind them is tinted `--accent`. Year ticks and labels below; a sliver of a
  year at either end gets `'26` or no label.
- **Filters**: the bars follow the game and search filters but never the date
  filter (the band shows that). With a game or search filter, faint grey "ghost"
  bars show the unfiltered totals on the same scale.
- **Data**: one per-local-day `GROUP BY` over the whole archive
  (`queryDayCounts`), rebinned in JS on resize; re-queried only when the
  search / game filter, timezone, archive bounds or live-clip count change.
  Live clips are merged in through `filterLiveClips()`.
  - FTS searches add `INDEXED BY clips_created_at` (`byDayHint()`): SQLite's
    default plan looks up every matching row to read `created_at` (≈1,850 4 KB
    pages for a common term such as りりまる); scanning the index and probing
    the match list costs ≈210 pages whatever the term — about the same as no
    filter. With a game filter the default plan (`clips_game_created`) is
    cheaper (≈90), so the hint is skipped. See "Query plans" in
    `docs/search.md`.
  - LIKE fallback searches (terms under 3 characters) scan the table, but the
    result-count query already does that same scan, so the pages are cached.
- **Calendar-view underline** (`rect.tl-view`): the year or month the calendar
  panel shows, while it's open.

### Interactions

| Gesture | Mouse | Touch |
|---|---|---|
| Click / tap (no drag), anywhere incl. the band | Open the calendar (if closed) and move it to that date at its current zoom level — `showDateInCalendar()`; filter unchanged | same |
| Drag empty space | New selection, ends snapped outward to whole bars (`rangeFromDrag`) | ignored, so a stray swipe can't replace a selection |
| Drag a handle | Resize, snapped to bar boundaries, never collapsing (`resizeRange`) | same (16 px hit zone) |
| Drag the band | Slide by whole units of its own kind — days, weeks, calendar months, years, or its own length for custom ranges (`dragShift` → `shiftRange`) | same |
| Keyboard | Band is a slider: ← → shift by one unit. Handles are sliders: ← → move that end a day, Shift = a week. Clicking the band / a handle focuses it (focus is set explicitly because `preventDefault()` on `pointerdown` cancels the browser's focus-on-press) | — |

Narrow bands (under `NARROW_BAND_PX`, e.g. one month on a phone) are drawn as
one solid marker without handles, and their hit zones change so both the band
(move) and the edges (resize, extending outward only) stay reachable.

Edits commit on release; while dragging, the band and tooltip preview the new
range and its clip count. Commits and calendar moves dispatch a bubbling
`change` event from `#timeline` so `filterBar.ts` treats them like any other
filter change (it reveals the results when the bar is pinned).

## Calendar panel (`calendar.ts`)

**Toggle** (`#btn-view-cal`): `switchView()` opens or closes the panel. On open,
`deriveNavigationPosition()` picks a starting view from the filter (no filter →
latest year; ≤ 62 days → month view of its start; longer → year view of its
midpoint). Opening from a timeline click skips that and goes to the clicked
date instead.

**Header**: `‹ title ›` steps the view (a year or a month at a time, disabled at
the archive bounds). The **Year | Month** toggle zooms; switching to Month picks
the selection's month if it's in the viewed year, else the last month viewed,
else the latest month with data (`monthForYear`). **"Filter to <period>"**
(`#cal-select-view`) selects exactly the year or month on screen; once that is
the filter it reads "✓ Filtered to …" and is disabled. All of these except the
last are navigation only.

**Heat-map and preview strip** follow the game and search filters, like the
timeline: `queryDays()` counts clips per day over the viewed year or month
(the date filter is shown, not applied), and the game preview strip under the
calendar breaks down the hovered period, or by default the selection, by game.
Both go through `buildWhere()`, so FTS searches get the same index plans.
During a search, the default breakdown is computed here (`defaultPeriod()`)
rather than taken from app.ts, whose per-game counts ignore the search.

**Year view**: all twelve mini-months; months without clips (that match the
filters) are dimmed and inert. Clicking anywhere on a card zooms into that month (navigation; the title
is the keyboard-focusable button for the same thing). Hovering a card previews
the month in the game strip.

**Month view**: click a day to select it; click a week number (ISO numbering,
Sunday-start rows) to select that Sun–Sat week.

**Ranges** (mouse/trackpad, both views): drag across days to select a range —
in the year view a drag can span months; Shift-click extends the selection to
the clicked day, moving whichever end is on that side, including across months
after paging with ‹ ›. On touch, a drag scrolls the page, so a drag across
days isn't available.

**Selection handles** (month view, mouse and touch): a closed selection has a
knob (`.sel-handle`) at the top-left of its first day and the bottom-right of
its last, on whichever ends are in the month on screen. Dragging one is a
drag-select anchored at the other end (which may be in another month), so it
moves that end, and past the other end it swaps roles. This is how phones
make ranges in the calendar: tap a day, then drag a knob, the way text
selection works. Only the knob has `touch-action: none`, so a swipe anywhere
else still scrolls. Its finger target (36 px) overlaps the neighbouring days;
a tap there selects that day, while a tap on the knob's own day does nothing,
so grabbing a knob without dragging keeps the range. Keyboard users have the
timeline's handles instead (the knobs are `aria-hidden`).

All of this is one delegated `pointerdown` handler on `#cal-month-grid` /
`#cal-year-view` (cells carry `data-date`; cards `data-month`; knobs
`data-anchor`, the fixed end). A hint line under the calendar (`#cal-hint`,
hidden on `(hover: none)` devices) explains the mouse gestures.

**Clear** (`#btn-clear-dates`): `applyDateSelection(null, null)`.

## Open questions

The experiment's year/month flow (toggle + "Filter to …" + card zoom) is still
being evaluated — see "Timeline & calendar follow-ups" in
`docs/future-work.md`.
