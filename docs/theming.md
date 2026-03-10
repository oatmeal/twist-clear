# Theming

The UI is built on a small set of CSS custom properties (variables) defined in
`frontend/style.css`. Changing **`--accent`** is the only setting most
deployments need — everything else is derived from it automatically.

---

## How it works

All colours in the UI reference CSS custom properties set on `:root`. The
accent colour is used for interactive highlights, focus rings, clip card hover
borders, the calendar heat-map, the view-count badge, and more.

Two derived values update automatically via `color-mix()`:

| Variable | Derived from | Purpose |
|----------|-------------|---------|
| `--accent-h` | `color-mix(in srgb, --accent, white 15%)` | Hover tint on accent-coloured elements |
| `--cal-0` … `--cal-4` | `color-mix(in srgb, --accent N%, --bg)` | Calendar heat-map ramp |
| `--cal-text`, `--cal-text-muted` | `color-mix(in srgb, --accent, black 65%/50%)` | Dark text on bright heat cells |

`color-mix()` requires **Chrome 111+, Firefox 113+, Safari 16.2+** (released
2022–2023). All current browser versions support it.

---

## Setting the accent colour

### Via `config.toml` (local dev)

Add or uncomment in `config.toml`:

```toml
[frontend]
accent_color = "#e87c2c"
```

The value is picked up by `vite.config.ts` and injected as `VITE_COLOR_ACCENT`
when you run `npm run dev` or `npm run build`.

### Via `deploy.yml` input (GitHub Actions)

Pass `accent_color` when calling the reusable workflow:

```yaml
jobs:
  deploy:
    uses: oatmeal/twist-clear/.github/workflows/deploy.yml@master
    with:
      streamers: my_streamer
      accent_color: "#e87c2c"
    secrets: inherit
```

### Directly as an environment variable

```sh
VITE_COLOR_ACCENT="#e87c2c" npm run build
```

---

## Choosing a good colour

The UI uses a **dark background** (`#0e0e0e`). A few rules of thumb:

- **Avoid very dark accents** — a near-black accent will be invisible against
  the dark surface. Aim for colours that stand out clearly on `#1f1f23`.
- **Avoid very light or washed-out accents** — they lose contrast on white text.
- **Pure black or pure white** will break the derived `--cal-text` logic and
  produce unreadable heat-map labels; avoid these extremes.
- **Saturated, mid-brightness colours** work best. In OKLCH terms, aim for
  lightness **L 0.50–0.68** and chroma **C ≥ 0.12**. In HSL terms, lightness
  **45%–65%** with saturation above 60%.

### Quick sanity check

After setting a colour, scan these elements in the browser:

1. **Nav buttons** (active state): white text on `--accent` background. Is it readable?
2. **Calendar heat level 4** cells: text should be dark (derived automatically). Is it legible?
3. **Pagination active button**: white text on `--accent`. Same check.
4. **Login button**: white text on `--accent`.

---

## Example palettes

These all pass the basic contrast checks above on the default dark background.

### Default — Twitch purple
```toml
accent_color = "#9147ff"
```
The stock look. High chroma purple, distinctive.

### Cobalt blue
```toml
accent_color = "#2d7dd2"
```
A calm, professional blue. Works well for archival/informational sites.

### Amber
```toml
accent_color = "#d4a017"
```
Warm gold-amber. Pairs well with dark surfaces; gives a retro feel.

### Coral / salmon
```toml
accent_color = "#e05252"
```
Warm red-orange. High energy. Works best for archives with a lot of action
content.

### Teal
```toml
accent_color = "#14b8a6"
```
Cool, calm. Works well for variety streamers.

### Emerald green
```toml
accent_color = "#22a84a"
```
The original calendar heat-map colour, now available as a full accent.

### Electric lime
```toml
accent_color = "#84cc16"
```
High-energy yellow-green. Very readable on dark backgrounds.

### Rose pink
```toml
accent_color = "#e879a0"
```
Bright pink. Good contrast on dark; vivid and playful.

---

## Changing the full colour palette

If you want to go beyond the accent and retheme the background, surfaces, or
text colours, edit `:root` in `frontend/style.css` directly:

```css
:root {
  --bg:       #0e0e0e;   /* page background */
  --surface:  #1f1f23;   /* card / header background */
  --surface2: #26262c;   /* secondary surfaces (dropdowns, nav buttons) */
  --border:   #3a3a40;   /* borders and dividers */
  --text:     #efeff1;   /* primary text */
  --muted:    #adadb8;   /* secondary text, labels */
  --accent:   #9147ff;   /* interactive accent — change this for the easiest retheme */
  /* --accent-h is derived; you can override it here if you want a specific hover colour */
}
```

For a **light theme**, swap the background and text poles:

```css
:root {
  --bg:       #f5f5f5;
  --surface:  #ffffff;
  --surface2: #ececec;
  --border:   #d1d1d6;
  --text:     #111111;
  --muted:    #6e6e7a;
  --accent:   #6441a5;   /* darker purple works better on light backgrounds */
}
```

Note that `--cal-text` / `--cal-text-muted` are mixed with `black`, which
works for bright heat cells on a dark background. If you switch to a light
theme, you may want to override `--cal-text` to use `white` instead so the
brightest heat cells remain readable.

---

## Browser support note

`color-mix()` (used for `--accent-h` and the calendar heat-map) requires:

| Browser | Minimum version |
|---------|----------------|
| Chrome / Edge | 111 (March 2023) |
| Firefox | 113 (May 2023) |
| Safari | 16.2 (December 2022) |

Older browsers will see the CSS fallback: `--accent-h` is undefined (elements
will inherit the default accent colour instead of the lighter hover tint), and
the heat-map cells will fall back to their fallback background. The rest of the
UI is unaffected.
