# Calendar panel vs. date filter — decoupled

`currentView` (`'grid' | 'calendar'` in `state.ts`) controls only whether the
calendar panel is visible. It has **no coupling to the date filter**
(`calDateFrom` / `calDateTo`).

## Controls

**Calendar toggle** (`btn-view-cal`): clicking it calls `switchView()` which
opens or closes the panel. On open, `deriveNavigationPosition()` computes a
sensible `calYear` / `calMonth` from the current filter (≤ 62-day filter →
month view; longer → year view for the midpoint year; no filter → most-recent
year). The filter itself is not modified.

**Clear button** (`btn-clear-dates`): calls `clearCalDateFilter()` which zeroes
`calDateFrom`, `calDateTo`, `calDay`, `calWeek`. The calendar panel stays open
if it was open.

**Navigation** (arrows, year/month selects): change `calYear` / `calMonth` only;
do **not** touch the date filter. The calendar re-renders to show the new
position; the clip grid is also re-rendered (same filter, same results — this
keeps the URL hash in sync with the new navigation position).

**Selection** (clicking a mini-month card, month pill, day, week; breadcrumb
clicks): change both the navigation position **and** the date filter, then
re-render both the calendar and the clip grid.
