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
- **Take report:** a big score in a ring (`readout-l`), pass/fail as text plus a glyph, 2–4 metric tiles (label, value, target), the trace replayed with markers, and **one** coaching tip. Buttons: after a pass, Next (primary) and Retry; after a miss, Retry (primary) and Back to level (§13.5).

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

## 13. Wave 2 screens (Phases 3–7)

From the `ui-ux-pro-max` rules (accessibility and touch first, then performance, layout, type and colour, motion, charts) and the `frontend-design` stance: one deliberate concept, executed with restraint. **The concept for every Wave 2 screen is the setlist**: a singer's night laid out like a set list taped to a monitor. Numbered entries in Big Shoulders, one cable-like line joining them, the amber tally light marking where you are. Each screen has at most ONE memorable thing (named below), and everything else stays quiet.

### 13.0 Rules for every Wave 2 screen
- **App bar:** a back button when `canGoBack`, the title, and a trailing slot. Hub screens (Home, Map) show the **profile chip** in the slot: the singer's initials in a 32 px `--bg-2` circle inside a 48 px target, which opens Profiles. Screens that use the mic (Sing, Live, Vibrato meter, Song player) show the mic status pill instead.
- **Locked items** (SPEC §11.1) use `<Locked hint=… />`: dimmed, a lucide `Lock` glyph and the one requirement line. They are static text, never a button, and have no pressed state. Screen readers hear "Locked." before the line. A locked item is never hidden, and never shows a tap that "does nothing".
- **The thumb zone:** the screen's primary action sits in the bottom action bar. Only one amber button is visible at a time.
- **Async content:** skeleton blocks in `--bg-1` sized to the final content, so nothing jumps when a score, a list or a chart arrives. Buttons doing async work disable and show inline progress, and never fire twice.
- **Errors:** next to the cause, in plain words, with the fix and a retry. Delete flows report the real result: a rejected delete says it failed and keeps the item.
- **Numbers:** tabular-nums in fixed-width boxes. Scores read "86%", cents "+12¢", tempo "96 bpm", durations "1:05".
- **Charts:** inline SVG, no chart library. Every chart has a "Show as table" toggle (the accessible alternative), axis labels in `label` style, and is never colour-only.
- **Copy:** §11. Coach-like and specific. A miss is "Not yet", never red alarm copy.

### 13.1 Home (the hub)
- **Purpose:** one tap to keep going.
- **Top: the Continue card.**
  - A 4 px left rule in the current world's hue.
  - The label `NEXT UP · 04`, the level title (`display-l`), and the goal sentence (`body-s`, max 65 ch).
  - The level's tally lights, and a full-width 64 px amber **Continue** button that opens the Level screen.
  - When every level is passed: "Every level passed" and a Dashboard link.
- **Momentum chip:** the number and a 7-day mini bar row. Shown only once the dashboard is unlocked.
- **Training destinations:** World map, Daily workout, Song Stage, Vibrato meter, Live pitch, Progress dashboard, as `ListRow`s. A locked one shows `<Locked compact>` with its line in place of the chevron.
- **Utilities:** Setup & calibration, Settings, Profiles, Data & backup, Diagnostics, About & voice care.
- **First run, per profile:**
  1. The **voice-care sheet**: warm up, hydrate, never sing through pain or hoarseness, rest, don't strain for range, plus "This is not medical advice." and a "Got it" button that sets `voiceCareSeen`.
  2. Then the existing headphone/Setup prompt.
- **Memorable thing:** the Continue card reads like the next number on the set list.

### 13.2 World map (the setlist path)
- **Layout:** one vertical scroll.
- **World section headers:** the world number and title in `display-l` ("02 VIBRATO"), its summary (`body-s`), and a 2 px rule in the world hue.
- **Audition row:** an open world with an audition that can be taken gets the row "Placement audition · Sing N short tests to skip ahead".
  - When the audition can't be taken yet, the row is `<Locked>` with `auditionRequirementHint`.
  - When nothing is left to unlock, the row is hidden.
- **Level nodes:** levels sit on one continuous 2 px line (the cable) down the left third, in `--line`, or in the world hue up to the current level.
  - Each node is a 56 px `ScoreRing` (best score) with the level number in the centre (Big Shoulders 20).
  - To its right: the title (`display-m` 22) and a status line (`body-s`).
    - **Passed:** "Best 86% · Solid" plus `TallyLights`.
    - **Current:** "Up next" in `--tally`.
    - **Locked:** `<Locked compact hint=…>`.
  - Only openable nodes are buttons; they open the Level screen.
- **Current node:** amber ring, with a 2 s breathing glow made by animating the opacity of a pseudo-element ring (no box-shadow animation). It is off under reduced motion. On open, the map scrolls so this node sits about 40% down the viewport (instant under reduced motion), or to the world in `params.worldId`.
- **Boss Recital node:** 64 px, a double ring, the label `BOSS RECITAL` above its title.
- **A locked world:** the dimmed header, a compact list of its level titles (no row of locked nodes), and one `<Locked>` line ("Pass the Foundations Boss Recital to unlock Vibrato.").
- **Song Stage section (last):** no nodes. A row to the Songs screen with "N songs open · M locked", or `<Locked>` until Song Stage unlocks.
- **Power-on:** after a take opened something (`lastOutcome.unlocked`), the newly opened node powers on once, with an amber glow fade-in over 600 ms.
- **Memorable thing:** the cable. One line from the first note you sang to the Boss Recital, lit up to where you are.

### 13.3 Level screen
- **Header:** the label `LEVEL 04` (or `BOSS RECITAL`), the title (`display-l`), the goal (`body`, max 65 ch).
- **Pass lines:** a compact list with a lucide `Target` glyph ("70% in tune", "Settle under 150 ms").
- **Chips:**
  - tolerance ("±25¢");
  - tempo: "72 bpm", or for a Runs ladder "Tempo climbs 72 → 96 bpm as you pass";
  - the best score and tally lights once attempted.
- **Bottom bar:** Listen (left), **Sing** (centre, primary, 64 px), More (right): Setup & calibration and the demo options.
- **No saved range** (and this is not the Range finder): an info Banner, "Using a default range until you pass the Range finder."
- **Boss Recital variant:** a stage treatment.
  - The header area has a static radial spotlight (`radial-gradient` from `--bg-2` at top centre to `--bg-0`, no animation).
  - The label reads `BOSS RECITAL · one continuous take`, with the skills it chains as a list.
- **Passed levels** offer "Sing again" for mastery, plus "Chase a record" once Personal records unlock.

### 13.4 Sing screen (the take)
- **Layout:** the Live layout (§7): app bar (level title, mic pill), readout cluster, the canvas with target bars and tolerance band, and the bottom bar.
- **States:**
  - **ready**
  - **demo:** Listen reads "Stop".
  - **count-in:** a big beat counter (`readout-xl` "3 · 2 · 1") centred over the canvas while the starting pitch sounds.
  - **singing:**
    - the cue pill at the canvas's top-left (`label` style: STRAIGHT, BLOOM, VIBRATO ON, or the syllable "ah");
    - a 2 px `--tally` progress hairline across the top of the canvas;
    - Sing becomes **Stop**.
  - **analyzing:** the canvas freezes and the button shows "Scoring…" with an inline spinner.
- **Context chips** (top-right of the canvas, one at a time): "96 bpm · rung 3 of 4" for a ladder, "Test 2 of 4" for an audition, "Workout · 3 of 6" for a workout.
- **Errors:** a mic block or interruption shows an inline Banner with the fix and "Try again". Nothing is written.
- **Desktop keys:** Space = Sing/Stop, L = Listen, Esc = back (it stops the take first).
- **Memorable thing:** the target bar "locks" while you're inside the band (§1). Nothing else competes with it.

### 13.5 Take report
Top to bottom:
1. **Verdict line with a glyph.** Passed: `CircleCheck`, "Passed", in `--on`. Missed: `RotateCcw`, "Not yet", in `--text-mid`.
2. **ScoreRing:** 160 px, score count-up to `readout-l` (600 ms).
3. **The three tally lights.**
4. **Metric tiles:** 2–4 in a two-column grid. Each tile has a `label`, the value in `data` style, the target ("≥ 70%"), and a met/unmet glyph (`Check` / `Minus`). It is never colour-only.
5. **Trace replay:** a static canvas with the targets, the trace, crack ticks and per-note run verdict glyphs (§3). It spans the full width and is 160 px tall.
6. **The one coaching tip:** a Card with a `Lightbulb` glyph.
7. **Playback:** "Play take", "Slow (0.5×)", and for runs "Slow + target".

**Actions** come from `afterTakeActions`: exactly one primary, in the bottom bar.

**Special cases:**
- **Celebration (pass only, §9):** the ring count-up, the tally lights in a 120 ms stagger, and an **Unlocked** strip listing what opened (`LockOpen` glyph and the unlock event titles). Reduced motion makes it instant.
- **Folded take:** "Not judged: this exercise doesn't fit your saved range", the score greyed, and the unfit-range tip.
- **Range finder pass:** a range card showing comfortable C3–A4 and extended A2–C5 on a mini keyboard strip.
- **Ladder:** "Next take at 104 bpm" under the verdict when the tempo climbed.
- **Memorable thing:** the ring and the three lights lighting in sequence, the app's one celebration.

### 13.6 Auditions
- **Intro screen:**
  - The world title and "Placement audition".
  - One paragraph: "Sing N short tests. Each pass unlocks the levels it covers. The run stops at the first miss. Nothing you've earned is ever locked again."
  - The tests as a numbered list. Each has an "unlocks Pitch match – Crispness" caption and a status: passed (`Check`), next (`--tally`), or not reached.
  - Primary button: "Start test 1" (or "Retake test 2").
  - When the audition can't be taken: `<Locked>` with its line and no Start button.
- **Results (after a miss or the last test):** "You placed at *Sirens & glides*", what opened, and a primary button "Go to Sirens & glides".

### 13.7 Song Stage: library
- **Layout:** the open songs first, then the locked ones, which are dimmed with `<Locked hint="Pass the Vibrato Boss Recital to unlock this song.">`.
- **Each row:**
  - the title (`display-m` 22) and composer/artist (`body-s`);
  - the range "F3–A4" and the length "1:40";
  - a world chip (an accent dot plus the world name);
  - the top difficulty reason's `detail` as the caption.
- **Chips:** bundled charts carry a "Public domain" chip; imported songs carry "Yours".
- **Import:** a trailing app-bar button once import unlocks. Before that, the list ends with the `<Locked>` import line.

### 13.8 Song import
One screen, in steps:
1. **Choose a file:** UltraStar `.txt` or `.mid`/`.midi`.
2. **MIDI only: pick the melody track.** The candidates show name, note count and range, each with a 6 s preview button. The best one is preselected.
3. **Optional backing track (MP3/WAV) and offset:** a slider of ±2000 ms in 10 ms steps, plus a "Play with click" check.
4. **The rating:** the required world, the reason details, and **Save**.

The line "Your files stay on this device." sits under the picker. Parser errors appear next to the picker in plain words. Purchased karaoke MIDI often has several tracks and a drum channel, and the track step is where that gets resolved.

### 13.9 Song player
- **App bar:** the song title and the mic pill.
- **Transport row:** play/pause, loop-phrase toggle, speed segmented (50 / 75 / 100%), and a transpose stepper (± semitones, with the suggested key marked "fits your range").
- **Canvas:** the piano roll (PitchView: song notes as target bars, the live trace).
- **Lyrics strip under the canvas:**
  - the current phrase in `body` 20 px, with the current syllable underlined in `--tally`;
  - the next phrase in `--text-lo`.
- **Phrase scrubber:** one pill per phrase, showing its last score as a number with an on/off tint. It scrolls horizontally inside its own row, so the page itself never scrolls sideways.
- **Bottom bar:** Listen (the melody or backing for the selected phrase), **Sing** (the phrase, or the whole song), More (offset, backing volume, metronome).
- **After a take:** a sheet with the phrase-by-phrase breakdown (phrase text, score bar and %, in-tolerance %), the overall score, and the actions "Retry phrase" / "Next phrase".
- **No latency calibration for this route:** a Banner, "Calibrate latency first so your takes line up.", linking to Setup.
- **Memorable thing:** the lyric line with the tally underline walking the syllables.

### 13.10 Progress dashboard
- **Momentum:** the number in `readout-l`, one sentence ("Rest days keep it. It never drops to zero."), and 30 daily bars.
- **Level map completion:** per open world, "5 of 8 levels · Boss Recital next" and a 4 px bar in the world hue.
- **Skills:** one row per UNLOCKED skill. Each row has the name, the latest value, and a 30-day sparkline (120×32, `--text-hi` stroke, last point dotted in `--tally`). Tapping a row expands a table of the last 10 values.
- **Range over time:** a band chart (x = date, y = note) between the lowest and highest clean notes, with note names on the y axis, plus a table toggle.
- **Personal bests:** a list, shown once Personal records unlock.
- **Practice minutes:** this week against last week.
- Locked skills do not appear at all (SPEC §12).

### 13.11 Daily workout
- **Before:** a 5 / 10 / 20 min segmented control (saved as `workoutMinutes`), then the plan, grouped by stage: Warm-up, From *World*, Review, Cool-down.
  - Each item shows its title and its reason caption ("Your weakest skill: Crispness").
  - Takes ×N and an estimated duration.
  - The total sits at the bottom.
  - Primary button: **Start workout**.
- **During:** the Sing and Report screens carry "Workout · 3 of 6".
- **End:** a summary of items done, minutes sung, and Momentum before → after.

### 13.12 Profiles
- **Rows:** an initials avatar, the name, the voice type, the range ("C3–A4", or "Range not measured"), and the current world. The active profile has a `Check`.
- **Tap to switch.**
- **Actions:**
  - **New profile:** a name, and a voice type (Tenor, Baritone, Other, Not sure).
  - **Rename.**
  - **Delete:** a Sheet with typed-name confirmation and an "Also delete recordings" toggle, on by default. Errors are shown, and it never claims "Deleted" falsely.

### 13.13 Data & backup
- **Storage card:** durable ✓, or the warning. Attempts, takes, audio MB, and the origin quota when the browser reports it.
- **Backup:**
  - "Export backup" downloads `pitch-lab-backup-YYYY-MM-DD.json`.
  - "Import backup" opens a file picker and shows the ImportReport in plain words.
- **Recordings:** saved takes, newest first. Each row has the exercise title, date, length and an audio badge, with Play, **Export WAV**, and Delete. The note above the list: "Exporting is the only way audio leaves this device."
- **Danger zone:** Delete all data, through a Sheet where you type DELETE.

### 13.14 Vibrato meter (tool)
- **Layout:** the Live layout, with the vibrato zone band on the trace (§8).
- **Readouts:** three big readouts: rate (Hz), extent (±¢), centring (¢). Each shows the style's zone ("Pop 5–7 Hz") and an in-zone glyph.
- **Flags:** wobble, bleat and straight appear as chips. Straight tone is neutral (`--text-mid`, `Info` glyph). Wobble and bleat use `--alert` with a glyph.
