# Live clips (`twitch.ts`, `lib/liveFilter.ts`)

## Fetching

`twitch.ts` fetches clips from the Helix API newer than the DB's most recent
clip (`_dbCutoffDate` in `app.ts`). It auto-paginates (100 clips per page) and
resolves game names in a second batch request.

## Filtering and merge

Live clips are stored in `state.liveClips` and filtered client-side by
`filterLiveClips(opts)` from `lib/liveFilter.ts` — a pure function that takes
`LiveFilterOpts` (clips array, cutoff date, date range, game filter, search query).

When `sortBy === 'date_desc'`, `render()` merges live clips directly into the
main grid rather than showing the separate collapsible panel. Live clips are
always newer than any archived clip, so they fill the first page(s); the
pagination math computes `liveOnPage`/`dbOnPage`/`dbOffset` for each page.
For other sort orders the separate `renderLiveSection()` panel is shown instead,
because true interleaving would require loading all DB clips into memory.

## Calendar integration

After `fetchLiveClips()` completes, `updateLiveClipBounds()` in `calendar.ts`
is called to extend `calMaxDate` (and the year-select options) if live clips are
newer than the DB cutoff. The calendar heat-map counts also include live clips:
`liveDayCountsForYear/Month` aggregate `state.liveClips` in-memory and merge
into the DB query results in `renderYearView`, `renderYearStrip`, and
`renderMonthGrid`.

## Game filter interaction

The calendar heat-map **respects the active game filter** — `queryYearDays`,
`queryMonthDays`, `queryYearMonthTotals` and the live clip count helpers all
apply `AND game_id = ?` when `state.gameFilter` is set. The game filter change
handler and the search debounce both call `renderCalendar()` when the calendar
is open so the heat-map re-renders immediately. **Title search is intentionally
not reflected** in calendar counts (no efficient aggregate index); when a search
is active, a `#cal-search-notice` element is shown inside the calendar panel.

The game filter is **never auto-cleared** when the user clicks a calendar period
where the selected game has no clips. Instead, `updateGameFilter` adds a (0)
option to the dropdown so the selection remains coherent, doing a PK lookup on
the `games` table if the name isn't in the `_gameName` cache yet.
