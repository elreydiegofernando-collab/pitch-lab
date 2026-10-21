# Pitch Lab — Design System

Derived from the `ui-ux-pro-max` and `frontend-design` skill guidance. Every screen follows this file; if a screen needs something not covered here, add it here first.

## 1. Concept: "the vocal booth after hours"

A late-night studio session: warm-black surfaces, glass-free and quiet, with one sharp accent, the amber **tally light** (the "on air / recording" lamp). The **pitch trace is the hero**. Everything else gets out of its way.

- **Mood:** focused, professional, a little cinematic. It should feel like serious gear, not a toy, even though progression is game-like.
- **The one memorable thing:** the live trace drawn over a piano-roll lane grid. In-tune singing makes the target bar "lock" (it fills and its outline goes solid). It's a calm, satisfying, unmistakable signal you can read at arm's length.
- **Not:** purple gradients, glassmorphism, emoji, confetti, mascots, cartoon stars, Inter, Roboto or system fonts.

## 2. Usage context drives everything

- The phone is held **at arm's length or propped on a stand, one-handed, while singing**, often in a dim room. Readouts must be legible at about 70 cm, and primary actions must be reachable with the thumb.
- Users are a choir-trained tenor and high baritone who wants polish, plus a beginner. The UI is the same for both. Difficulty comes from the level the user has reached, never from a mode switch.
- Dark theme is the default. A light theme exists (setting: System / Dark / Light).

## 3. Color tokens (CSS custom properties on `:root`)

### Dark (default)
| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0E0F13` | app background, canvas background |
| `--bg-1` | `#15171D` | surfaces (cards, bars) |
| `--bg-2` | `#1D2029` | raised (sheets, pressed states) |
| `--line` | `#2A2E39` | borders, grid lines |
| `--lane-natural` | `#13151B` | piano-roll lane for natural notes |
| `--lane-accidental` | `#0B0C10` | piano-roll lane for sharps/flats (darker, like black keys) |
| `--text-hi` | `#F2EFE8` | primary text (warm white), free-singing trace core |
| `--text-mid` | `#AEB4BF` | secondary text |
| `--text-lo` | `#858C99` | tertiary text (≥ 4.5:1 on `--bg-0`; never smaller than 13 px) |
| `--tally` | `#FFB224` | THE accent: primary action (Sing), now-line, focus ring, current level |
| `--tally-ink` | `#1A1204` | text/icons on `--tally` |
| `--on` | `#56B4E9` | in tolerance / locked / good (Okabe–Ito sky blue) |
| `--off` | `#E69F00` | outside tolerance (Okabe–Ito orange) |
| `--alert` | `#E8743B` | cracks, errors, missed (vermilion family; always paired with a glyph) |
| `--good` | `#19C39A` | "defined" note in runs (bluish green) |
| `--meh` | `#F0E442` | "smeared" note in runs (Okabe–Ito yellow) |

### Light
`--bg-0 #F5F2EC`, `--bg-1 #FFFFFF`, `--bg-2 #ECE8E0`, `--line #DDD8CF`, `--lane-natural #FBFAF7`, `--lane-accidental #EFEBE3`, `--text-hi #15171C`, `--text-mid #4A505B`, `--text-lo #646B78`, `--tally #B86E00` (text) / `#FFB224` (fills, with `--tally-ink`), `--on #0072B2`, `--off #D55E00`, `--alert #C2410C`, `--good #00866A`, `--meh #8A7A00`.

### Accuracy encoding (color-blind safe, never color alone)
- **In tune vs out of tune:** blue `--on` vs orange `--off` (the Okabe–Ito pair that deuteranopes and protanopes can tell apart). Always paired with **position** (the trace sits inside or outside the band) and **text** (`+18¢`, `−7¢`). Sharp and flat also get **▲/▼ glyphs**, drawn as SVG or canvas paths, never as typed characters.
- **Runs, note by note** (spec: green = defined, yellow = smeared, red = missed): `--good` + filled circle, `--meh` + half-filled circle, `--alert` + ✕ mark. The shape carries the meaning; color reinforces it.
- **Cracks/breaks** on the trace: `--alert` vertical tick plus a small zig-zag glyph and the label "crack".
- **Neutral flags** (e.g. straight tone, which the spec says is *not* an error): `--text-mid` with an info glyph. Never orange or red.

## 4. Typography (self-hosted, works offline)

- **Display / readouts:** `Big Shoulders Display Variable` (`@fontsource-variable/big-shoulders-display`). Condensed, tall, stage-marquee feel, very legible at distance. Use it for note names, scores, level and world titles, and big numbers.
- **UI / body:** `Instrument Sans Variable` (`@fontsource-variable/instrument-sans`). Use it for all body text, labels and controls.
- **Numbers that change live** (cents, Hz, dB, timers): `font-variant-numeric: tabular-nums` inside fixed-width boxes, right-aligned, so readouts never jitter.
- Import only the latin subset (and latin-ext if it's tiny). Do not add other fonts.

| Style | Font | Size / line-height | Weight | Use |
|---|---|---|---|---|
| `readout-xl` | Big Shoulders | 72 / 0.9 | 700 | live note name ("F♯4") |
| `readout-l` | Big Shoulders | 44 / 1.0 | 700 | scores, cents readout |
| `display-l` | Big Shoulders | 36 / 1.05 | 700 | screen and world titles |
| `display-m` | Big Shoulders | 26 / 1.1 | 600 | level names, card titles |
| `body` | Instrument Sans | 17 / 1.5 | 400 | default text (iOS body size; never < 16 px on mobile) |
| `body-s` | Instrument Sans | 15 / 1.45 | 400 | secondary text |
| `label` | Instrument Sans | 13 / 1.2 | 600, uppercase, letter-spacing 0.08em | section labels, units |
| `data` | Instrument Sans | 17 / 1.2 | 600, tabular-nums | live numbers |

Line length for prose: 65 characters max. Sharps and flats display as the real glyphs ♯ ♭ in text (set via the `notation` setting).

## 5. Space, shape, layers

- Spacing scale: 4, 8, 12, 16, 24, 32, 48. Page side padding is 16 px, plus `env(safe-area-inset-*)`.
- Radius: 10 for controls, 16 for cards and sheets, 999 for pills.
- Elevation: no drop shadows on dark. Use `--bg-1`/`--bg-2` steps and 1 px `--line` borders. Light theme may use one soft shadow (`0 1px 2px rgb(0 0 0 / .06)`).
- z-index scale: canvas 0, app bar 10, bottom bar 20, sheet 30, toast 40, modal 50.

## 6. Touch & interaction (CRITICAL)

- Touch targets are **at least 48×48 px**; the primary **Sing** button is **64 px** tall. There's 8 px minimum between targets.
- **Thumb zone:** primary actions live in the **bottom action bar** (`Listen` secondary on the left, `Sing`/`Stop` primary amber in the centre and widest, `More` on the right). Readouts sit at the top, the canvas fills the middle.
- Icons come from `lucide-preact` at 24 px, stroke 2. An icon is never the only label on a primary action: the bottom bar shows a text label under each icon, and icon-only buttons get an `aria-label`.
- `touch-action: manipulation` on controls (no double-tap zoom). `-webkit-tap-highlight-color: transparent`, replaced by our own pressed state (`--bg-2` plus scale 0.98 via transform).
- `cursor: pointer` on everything clickable (Windows). Visible focus ring: 2 px `--tally` outline with 2 px offset (`:focus-visible`).
- Disable a button while its async action runs and show inline progress. Never fire twice.
- Desktop keyboard: `Space` = Sing/Stop, `L` = Listen, `Esc` = back.
- Errors appear next to the cause, in plain language with the fix. Example: "Microphone blocked. In Settings › Safari › Microphone choose Allow, then tap Try again."

## 7. Layout

- **Mobile portrait (primary):** app bar (52 px + safe-area-top; back button, title, and a status pill for mic state and route icon) → readout cluster → **canvas (flex: 1)** → bottom action bar (about 88 px + safe-area-bottom).
- **Wide (≥ 900 px, Windows Chrome):** max-width 1180 px, centred. The canvas takes the left about 70%, with a right panel for readouts and controls. The bottom bar becomes the right panel's footer.
- No horizontal scroll at 375 px. Test at 375, 390, 430, 768, 1024 and 1440 px.
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover`. Pinch-zoom stays allowed (accessibility); controls use `touch-action: manipulation`.
- Reserve space for async content (no layout jumps when diagnostics or scores arrive).

## 8. The live pitch canvas (hero) — visual spec

- **Lanes:** one horizontal lane per semitone. Natural notes use `--lane-natural`, accidentals the darker `--lane-accidental`, so it reads like a piano keyboard turned sideways. A thin `--line` separates octaves (B|C). The left gutter shows note names (`C3`, `D3`…) in `label` style, with C notes emphasised. The grid lives on a **static layer** and is redrawn only when the range or size changes.
- **Now line:** a 1.5 px `--tally` vertical line at **72% of the width**. Past is on the left, upcoming targets on the right (default 4.5 s past, 1.75 s future).
- **Target bars:** rounded rectangles whose **height is the tolerance band** (±tolerance cents), with a 1 px centre line. Idle state is `--text-hi` at 8% fill with a 1 px `--line` outline. **Locked** (singer inside the band) is `--on` at 30% fill with a solid 1.5 px `--on` outline. Glides draw as a sloped band.
- **Trace:** a 3 px round-cap core with an 8 px under-stroke at 14% alpha for glow. **Never use `shadowBlur`.** Free singing draws the trace in `--text-hi`. With a target, it's `--on` inside tolerance and `--off` outside (batched into same-colour runs, one path per run). Unvoiced frames leave a gap.
- **Vibrato zone** (vibrato meter): a band of ±extent around the target, `--on` at 10% with dashed edges.
- **Markers:** cracks are an `--alert` tick plus a zig-zag glyph. Onsets get a small `--text-mid` dot.
- **Readout cluster above the canvas:** note name (`readout-xl`), the cents gauge (a horizontal ±50¢ scale with the tolerance band shaded and a needle, plus `+12¢` text and a ▲/▼ glyph), and Hz and dB in `data` style.

## 9. Motion

- Micro-interactions take 150–220 ms, `cubic-bezier(.2,.8,.2,1)`. Animate **only `transform` and `opacity`**.
- Screen change: fade plus 8 px rise, 200 ms.
- **The one celebratory moment** is passing a level. The score ring counts up (600 ms), the three tally lights light in sequence (120 ms stagger), and the next level node "powers on" (amber glow fade-in). No confetti.
- `prefers-reduced-motion: reduce` (or the in-app setting) makes every one of these instant. The canvas keeps scrolling (it's functional, not decoration), but glow pulses are disabled.
- Loading uses skeleton blocks in `--bg-1`, not spinners, except inside buttons.

## 10. Game / progression patterns (Phase 3+)

Progression is **linear and earned, like a video game**. There's no picking "beginner/advanced" and no jumping around.

- **World map:** a vertical **setlist path**. Worlds stack as sections (Foundations, Vibrato, Inflections, Runs & Riffs, Dynamics, Song Stage). Levels are nodes along a single line that connects them.
- **Level node:** a 56 px circle with a ring showing the best score. **Three tally lights** (small amber dots) show mastery tiers (pass, solid, studio). That's on-brand; no cartoon stars.
- **Locked:** dim (`--text-lo`), a lock glyph, and an explicit requirement ("Pass *Sustain II* to unlock"). **Current:** amber ring with a slow 2 s breathing glow (disabled under reduced motion). **Passed:** a solid ring.
- Each world has a quiet hue accent used only on its header rule and node rings. Foundations `--tally`, Vibrato `#56B4E9`, Inflections `#19C39A`, Runs `#F0E442`, Dynamics `#E69F00`, Song Stage `#F2EFE8`.
- **Level screen:** goal in one sentence → **Listen** (demo) → **Sing** → take report. Pass thresholds are shown before singing ("Pass: 70% in tune, settle < 150 ms").
- **Take report:** a big score in a ring (`readout-l`), pass/fail as text plus a glyph, 2–4 metric tiles (label, value, target), the trace replayed with markers, and **one** coaching tip. Buttons: Retry (primary) and Next (when unlocked).

## 11. Voice & copy

Coach-like, specific, brief. Use numbers over adjectives, and no exclamation spam. For example, write "Landed 12¢ flat. Aim a hair higher on the onset," not "Great job!!!" Neutral facts stay neutral: "Straight tone — no vibrato detected" is information, not criticism.

## 12. Pre-delivery checklist (every UI change)

- [ ] Contrast ≥ 4.5:1 for text (both themes); graphics ≥ 3:1
- [ ] Color is never the only cue (position, glyph or text always accompanies it)
- [ ] Targets ≥ 48 px; primary 64 px; thumb-zone placement
- [ ] Focus-visible rings; keyboard works on desktop
- [ ] No emoji icons; lucide only; aria-labels on icon-only buttons
- [ ] Reduced motion respected
- [ ] No horizontal scroll at 375 px; safe areas respected (notch and home indicator)
- [ ] Live numbers are tabular and fixed-width (no jitter)
- [ ] Animations use transform/opacity only
