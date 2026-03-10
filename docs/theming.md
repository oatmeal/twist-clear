# Theming

The entire UI palette is exposed as CSS custom properties. You can override any
or all of them via `config.toml` (local dev) or `deploy.yml` inputs (CI/GitHub
Pages) without editing any source files.

---

## CSS variables reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `--accent` | `#9147ff` | Interactive highlights: buttons, focus rings, hover borders, view-count badge, streamer links |
| `--cal-accent` | `#22a84a` | Calendar heat-map colour — intentionally separate from `--accent` (see below) |
| `--bg` | `#0e0e0e` | Page background |
| `--surface` | `#1f1f23` | Cards, header, login banner, calendar panel |
| `--surface2` | `#26262c` | Dropdowns, nav buttons, week-number column |
| `--border` | `#3a3a40` | All borders and dividers |
| `--text` | `#efeff1` | Primary text |
| `--muted` | `#adadb8` | Secondary text, labels, placeholders, metadata |

Three additional variables are **derived automatically** via `color-mix()` —
you do not normally need to set them, but you can override them in
`style.css :root` if needed:

| Variable | Derivation | Purpose |
|----------|-----------|---------|
| `--accent-h` | `color-mix(in srgb, --accent, white 15%)` | Hover tint on accent-coloured elements |
| `--cal-text` | `color-mix(in srgb, --cal-accent, black 65%)` | Dark text on the two brightest calendar heat cells |
| `--cal-text-muted` | `color-mix(in srgb, --cal-accent, black 50%)` | Dimmer dark text on heat cell metadata |

`color-mix()` requires **Chrome 111+, Firefox 113+, Safari 16.2+** (all
current browser versions). In older browsers, derived vars fall back to
`inherit`/`initial` — the rest of the UI is unaffected.

---

## Why `--cal-accent` is separate from `--accent`

The calendar heat-map shows *data density* (how many clips exist on a given
day). Using the same colour as interactive UI elements (buttons, links, focus
rings) makes it hard to read the two signals apart — a glance at a dark-green
cell should mean "busy day", not "something to click". Keeping the colours
distinct is the same principle behind GitHub's contribution graph always being
green regardless of GitHub's own UI accent colour.

The default green (`#22a84a`) works well against the dark background and pairs
cleanly with the default purple `--accent`. If you want the heat-map to track
your UI accent exactly, just set `cal_accent_color` to the same value as
`accent_color`.

---

## Setting colours

### Via `config.toml` (local dev)

Add any combination of keys under `[frontend]`. All are optional; omit a key
to keep the built-in default:

```toml
[frontend]
accent_color     = "#e87c2c"
cal_accent_color = "#22a84a"   # keep green, or change to match accent
color_bg         = "#0e0e0e"
# ... any subset works
```

The values are picked up by `vite.config.ts` and baked into the JS bundle when
you run `npm run dev` or `npm run build`.

### Via `deploy.yml` inputs (GitHub Actions)

Pass any colour inputs when calling the reusable workflow:

```yaml
jobs:
  deploy:
    uses: oatmeal/twist-clear/.github/workflows/deploy.yml@master
    with:
      streamers: my_streamer
      accent_color:     "#6441a5"
      cal_accent_color: "#22a84a"
      color_bg:         "#f5f5f5"
      color_surface:    "#ffffff"
      color_surface2:   "#ececec"
      color_border:     "#d1d1d6"
      color_text:       "#111111"
      color_muted:      "#6e6e7a"
    secrets: inherit
```

### Directly as environment variables

```sh
VITE_COLOR_ACCENT=#e87c2c VITE_COLOR_CAL_ACCENT=#d4a017 npm run build
```

### Full mapping

| config.toml | env var | CSS var |
|-------------|---------|---------|
| `accent_color` | `VITE_COLOR_ACCENT` | `--accent` |
| `cal_accent_color` | `VITE_COLOR_CAL_ACCENT` | `--cal-accent` |
| `color_bg` | `VITE_COLOR_BG` | `--bg` |
| `color_surface` | `VITE_COLOR_SURFACE` | `--surface` |
| `color_surface2` | `VITE_COLOR_SURFACE2` | `--surface2` |
| `color_border` | `VITE_COLOR_BORDER` | `--border` |
| `color_text` | `VITE_COLOR_TEXT` | `--text` |
| `color_muted` | `VITE_COLOR_MUTED` | `--muted` |

---

## Choosing colours

### Dark themes

The default palette is a near-black dark theme. When designing a dark variant:

- **`--bg`** — Keep this your darkest value. Near-black (`#0d0d0d`–`#161616`)
  works well. Pure `#000000` is fine but can feel harsh.
- **`--surface` / `--surface2`** — Step up in lightness from `--bg` by a few
  points each. Cards and panels need enough contrast against the background to
  be perceptible, but not so much that they look bright in a dark context.
  Typical range: 5–10% HSL lightness above `--bg`.
- **`--border`** — Usually sits between `--surface2` and `--muted` in
  lightness. Subtle enough not to dominate, visible enough to separate regions.
- **`--text`** — Near-white is standard. `#efeff1` (the default) is slightly
  warmer than pure `#ffffff`, which reduces eye strain.
- **`--muted`** — Secondary labels. Should have ≥ 4.5:1 contrast against
  `--bg` (WCAG AA). The default `#adadb8` on `#0e0e0e` achieves ~7:1.
- **`--accent`** — Aim for **HSL lightness 50–65%**, saturation ≥ 60%. This
  ensures legibility of white text on the accent (buttons, active pagination).
- **`--cal-accent`** — Choose a colour that is visually distinct from `--accent`
  so the heat-map reads as data, not UI. Complementary hues work well (e.g.
  warm accent → cool cal-accent, or vice versa). The default green pairs well
  with most non-green accents. Keep lightness similar to `--accent` so the
  brightest cells don't look washed out.

### Light themes

A complete light theme requires flipping the background/text poles and choosing
a darker accent (light accents lose contrast on white backgrounds):

- **`--bg`** — Off-white (`#f5f5f5`–`#fafafa`) is easier on the eyes than pure
  `#ffffff`.
- **`--surface`** — White or near-white (`#ffffff`–`#f8f8f8`).
- **`--surface2`** — Slightly grey (`#ececec`–`#f0f0f0`).
- **`--border`** — Light grey (`#d1d1d6`–`#e0e0e0`).
- **`--text`** — Near-black (`#111111`–`#222222`).
- **`--muted`** — Medium grey (`#6e6e7a`–`#888888`). Must have ≥ 4.5:1
  contrast against `--bg` (WCAG AA).
- **`--accent`** — Use a **darker** shade than you would for a dark theme; aim
  for HSL lightness 35–55%. White text on the accent (buttons) should still
  pass 4.5:1.
- **`--cal-accent`** — For light themes, also choose a mid-to-dark shade
  (HSL lightness 35–55%) so the brightest heat cell has enough contrast against
  `--bg`. The derived `--cal-text` mixes `--cal-accent` with black, which
  works correctly regardless of theme.

### Quick checklist after setting colours

1. **Active button / pagination** — white text on `--accent`. Readable?
2. **Streamer name links** — `--accent` text on `--bg`. Readable?
3. **Calendar heat level 4 cells** — `--cal-text` (dark, auto-derived) on
   `--cal-accent`. Legible?
4. **Calendar level 1 cells** — the faintest heat colour (`--cal-0`/`--cal-1`)
   visible against `--bg`?
5. **Muted text** — `--muted` on `--bg` ≥ 4.5:1 contrast (WCAG AA)?

---

## Example palettes

### Default — Twitch dark
```toml
# No config needed — these are the built-in defaults.
# accent_color     = "#9147ff"
# cal_accent_color = "#22a84a"
```
Purple UI accent, green calendar heat-map.

### Warm amber + teal heat-map
```toml
[frontend]
accent_color     = "#d4a017"
cal_accent_color = "#14b8a6"
```
Gold-amber interactive elements, teal heat-map. High visual contrast between
the two colour roles. Retro feel on the default dark background.

### Cobalt dark
```toml
[frontend]
accent_color   = "#2d7dd2"
color_bg       = "#0b0d12"
color_surface  = "#141822"
color_surface2 = "#1c2230"
color_border   = "#2a3347"
```
Blue-tinted dark background with a calm blue accent. Keeps the default green
heat-map, which provides good contrast against the blue UI.

### Slate dark (cool neutral)
```toml
[frontend]
accent_color   = "#7c8cf8"
color_bg       = "#0f1117"
color_surface  = "#1a1d27"
color_surface2 = "#222636"
color_border   = "#30364a"
color_muted    = "#9fa6c0"
```
Blue-slate background with a periwinkle accent and default green heat-map.

### Warm dark (sepia-tinted)
```toml
[frontend]
accent_color     = "#e05252"
cal_accent_color = "#d4a017"   # amber heat-map complements the red accent
color_bg         = "#100d0b"
color_surface    = "#1e1916"
color_surface2   = "#26201c"
color_border     = "#3a3028"
color_muted      = "#b0a898"
```
Warm brown-tinted dark surfaces, red accent, amber heat-map.

### Light — classic purple
```toml
[frontend]
accent_color  = "#6441a5"
color_bg      = "#f5f5f5"
color_surface = "#ffffff"
color_surface2 = "#efefef"
color_border  = "#d1d1d6"
color_text    = "#111111"
color_muted   = "#6e6e7a"
```
A proper light theme. Uses a darker purple for white-text contrast on buttons.
The default green `--cal-accent` reads well on light surfaces.

### Light — teal
```toml
[frontend]
accent_color     = "#0d7a6e"
cal_accent_color = "#7c5cbf"   # purple heat-map contrasts the teal accent
color_bg         = "#f7f9f9"
color_surface    = "#ffffff"
color_surface2   = "#edf2f2"
color_border     = "#c8d8d8"
color_text       = "#0d1a1a"
color_muted      = "#527070"
```
Cool teal-tinted light theme with a contrasting purple heat-map.

---

## Editing the CSS directly

If the config channels don't cover your needs (e.g. you want to hard-code a
specific hover colour instead of the auto-derived one), edit `:root` in
`frontend/style.css` and/or `frontend/calendar.css`:

```css
/* style.css :root */
:root {
  --bg:        #0e0e0e;
  --surface:   #1f1f23;
  --surface2:  #26262c;
  --border:    #3a3a40;
  --text:      #efeff1;
  --muted:     #adadb8;
  --accent:    #9147ff;
  /* Override the auto-derived hover tint if needed: */
  /* --accent-h: #bf80ff; */
}

/* calendar.css :root */
:root {
  --cal-accent: #22a84a;
  /* Override the auto-derived contrast text if needed: */
  /* --cal-text:       #0a2010; */
  /* --cal-text-muted: #1a3d20; */
}
```

Any value set via `config.toml` / env var takes precedence at runtime (it is
applied as an inline style on `<html>`, which wins over `:root` in the cascade).
