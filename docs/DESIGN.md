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
- **Readout cluster above the canvas:** note name (`readout-xl`), the cents gauge (a horizontal ±50¢ scale with the tolerance band shaded and a needle, plus `+12¢` text and a ▲/▼ glyph), and Hz and dB in `data` style. (Since 2026-10-23, owner: plain words. The gauge says "On it", "A little high" or "A little low" with a glyph and no number; Hz, dB and cents sit behind Live's small Details toggle. On the Sing screen the gauge reads the voice against the note asked for: §13.4.)

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

**Coaching is the exception to "numbers with units"** (owner, 2026-10-22: "assume that I am just relearning how to sing ... a little bit more layman's terms"). Everything the coaching card says (§13.5, `src/coaching`) is written to the singer as "you", in plain words and plain numbers: "a little flat", "about a quarter of the way to the next note", "about six wobbles a second", "0:04", never cents, Hz, dB, semitones, bpm or singing jargon, no exclamation marks, never "push", "force" or "strain" as advice, and "stop if anything hurts, scratches or goes hoarse". The rules live in `src/coaching/types.ts` and are tested (`src/coaching/content/index.test.ts`, `src/coaching/plain.ts`). The tiles, chips and live readouts keep their units.

**Plain words everywhere** (owner, 2026-10-23: "why are you using technical terms without teaching me first?"): the tiles, the Live chips and the readouts now speak plain words too (`src/teach/plain-metrics.ts`, `CentsGauge`, `LiveStatus`), with the numbers only behind Live's Details; level names and unlock lines name today's lessons. Every music word is a glossary term, taught on the Learn page of the lesson that introduces it (a glossary entry never leans on a word taught later) and tappable where it appears, the coaching card included (`src/ui/lesson/terms.tsx`). Nothing tells the singer to start singing when the count-in ends: in an echo the app plays the note first.

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
- **Voice check-up card** (`src/ui/checkup/home-card.ts`, §13.15). It only invites: it opens the check-up's own screen or its results.
  - A profile that has sung nothing: "Start with a 4-minute voice check-up", above the Continue card, with the amber button. Continue then steps back to a secondary button, so Home keeps one amber button.
  - A check-up left part way: "Finish your voice check-up", above the Continue card in the same way.
  - A profile that has sung but never took one: "Take your voice check-up". Once the last one is three weeks old: "Time for a re-check". Otherwise a quiet row to the latest results.
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

### 13.3 Lesson screen (and the classic level screen)
**Training, not testing** (owner, 2026-10-23: "What about the training? What about the teaching?" and "I don't need the note playing along while I'm singing. I need to know the note before I sing it."). A level with a lesson (`src/lessons`) opens as a lesson in three parts: Learn, Practise, Check (`src/ui/lesson/LessonScreen.tsx`). A level without one (the later worlds, until they are converted) keeps the classic level screen, below.

- **Header:** the label `LESSON 5` (`LESSON 13 · BOSS RECITAL` on a Boss Recital, which keeps its stage treatment), the lesson title (`display-l`), and its outcome: one plain line on what you will be able to do (`body`, max 65 ch).
- **The lesson as a set list (the memorable thing):** Learn, Practise and Check are three numbered entries on one cable (a 2 px line, lit in the world hue below each part that is done). The part the singer is at wears the amber tally ring with the word "Now" under it; a done part shows a check glyph. Learn is the part before the first try, Practise until every step is done, then the Check; a passed lesson is done throughout. Never colour alone.
- **What is done is what was done** (review R2, 2026-10-23): on a passed lesson, Learn is ticked only once one of this lesson's own tries was sung, and Practise only once every step has its good tries; a lesson passed another way (an audition, or a pass of the material it replaced) still opens on Learn. Takes of retired material are never this lesson's tries.
- **After a missed check, back to practice** (review R4, 2026-10-23): the step that trains what the check missed (the last step whose good-try rule reads the first gate the take missed, else the last step) is marked Now and is the amber **Practise**, until a good try is sung after the miss; the Check part then offers a quiet ghost **Take the check again** ("Practise the step marked Now first: it trains what the check missed."). The report of a missed check leads with **Back to practice**, with **Take the check again** secondary.
- **1 Learn:** a short, friendly teaching page: what it is, why it matters, "Words in this lesson" (each music word the lesson teaches, tappable, with its plain explanation and example right there, before the steps that use it: the first place the singer meets it), how to do it (3 to 5 numbered steps), and what you will see on screen. A secondary **Listen** plays the lesson's simplest try (its first practice step). Learn opens by itself the first time (no tries yet); after that it folds under its heading, a 48 px toggle ("Read again").
- **2 Practise:** one line (short tries, no pass or fail: the app plays it first, then it is your turn; a step is done after a few good tries), then the steps as cards. Each card: its number (a check glyph once done), its title, its ask, and its good tries as dots (filled for each good try, a ring for each still to come) with the words "2 of 3 good tries". The step the singer is on is marked "Now" (amber ring and word; "Next" while Learn is still the part they are at, so the screen never says "Now" twice); a done step reads "Again"; on a passed lesson every step is open ("Practise"). Each of those cards is one large button (thumb zone); a step still ahead is quiet, plain text (the steps build on each other). Nothing in practice passes, fails or opens anything.
- **3 Check:** the level's own exercise, whose pass passes the level (only it can). Its goal, "To pass:" with the exercise's `passPlain` (or "Pass it to finish the lesson."), the chips "In-tune zone: wide / medium / narrow" (easy / default / studio, the words "in-tune zone" a tappable term) and, only where it applies, "A click keeps the beat" or "Starts slow, and speeds up each time you pass". How it went: "Not taken yet", "Best so far 57%", or "Passed · best 86%" with the tally lights. "Last time" (the coaching of the latest check take, when it missed) sits here, before the next try. Before every step is done, a quiet ghost **Skip to the check** (allowed, never pushed: "Practice first is the easier way in, but you can take the check any time."); once they are, the line "Every practice step is done: you are ready for the check." "Chase a record" is a button once passed and records open, otherwise its `<Locked>` line (never hidden); the Range finder has none, and shows the saved range ("Your range: C3–A4", or "Not measured yet") instead of a score.
- **Bottom bar:** Listen (left) plays what the amber button will have you sing (one demo at a time: starting one stops another); the one amber primary: **Practise** (the current step) → **Take the check** (every step done) → **Sing the check again** (passed, for the tally lights); More (right): Setup & calibration, the demo volume, and Send to Claude for the check's exercise. Desktop keys as everywhere (Space = the primary, L = Listen).
- **Plain words:** nothing on the lesson screen says cents, Hz, semitones, bpm, tolerance, onset, settle or scoop. No generated pass lines, no numbered tempo and no personal-best list (their readings carry units). Every music word is a `Term` (`src/ui/teach/Term.tsx`): the glossary's words are linked the first time they appear in each part (`src/ui/lesson/terms.tsx`; never inside a button).
- **No saved range** (and this is not the Range finder): the info Banner, "Using a default range until you pass the Range finder."
- **A lesson that is not open:** the header and its `<Locked>` requirement line only: no parts, no bar.
- **The practice report** (the Report screen after a practice try, §13.5): calm, because practice is not a test. The app bar reads "Practice". The verdict is "Good try" (`CircleCheck`, in `--on-text`) or "Not quite yet" (`RotateCcw`, `--text-mid`), or "Nothing came through" / "Not judged" with the reason ("Stopped early: a try counts when you sing it to the end."); the caption "Lesson 5 · Step 2 of 3: Echo both notes"; the step's good tries (dots and words); and, when this try finished its step, "This step is done. On to the next one." or "Every practice step is done: you are ready for the check." Then the coaching card, the replay and playback, as for any take. No score ring, no metric tiles, no tally lights and no Unlocked strip. Its Listen plays the drill's own demo. Actions come from `afterTakeActions`: "Again" / "Try again" (the same step), "Next step", "Take the check", "Back to the lesson" (back to the lesson page beneath, never a second copy of it).
- **On the map and Home:** a level with a lesson reads as one: the node's title is the lesson title, a screen reader hears "Lesson 5: Two notes, one step apart", and the current node's status says where its practice is ("Up next · Practice 2 of 3", "Up next · Ready for the check", "Up next · New lesson"). The Continue card reads "Next up · Lesson 5", the lesson title, its outcome, the practice line with a small mark per step done, and "Best on the check 42%" once there is one.

#### The classic level screen (a level without a lesson)
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
- **Last time:** when the latest take of this level's exercise missed, its coaching card (§13.5, titled "Last time") sits above the pass lines, so the advice comes before the next try. It is the saved take read back and re-analyzed against the notes it was sung against (from its numbers alone when its pitch line was not kept), at the same depth as its report: the spots are plain text here, since there is no replay to mark. It disappears once a take passes.
- **More › Send to Claude** (always offered): a sheet that saves this exercise's coaching file through the share sheet: the last five takes with their pitch lines and scores, for a closer look in chat (docs/COACHING.md). **Include audio** adds each kept take's sound; it is off every time the sheet opens. The file is made when the sheet opens, so the Share tap opens the share sheet at once (iOS needs the fresh tap).

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
- **The live hint** (owner, 2026-10-23): one plain line at the bottom of the canvas, over the history and left of the now line, so it never covers the note being sung: "listen..." while the app plays, "breathe" in a rest, "sing now" on the singer's turn, then "a little higher / lower" ("a lot" from a whole step off), "on it", "steady, good" or "a bit wobbly: soften and keep the air even". Words plus a glyph, faded with opacity only, read about five times a second and written only when it changes (`src/ui/practice/live-hint.ts`, `LiveHint.tsx`). It never judges the Range finder, glides or notes of 1.2 s or less; it says steady or wobbly only on holds of 2 s or more, never on an exercise that asks for vibrato, and never on the wide zone of the first lessons, before Hold it steady teaches those words.
- **The gauge during a take** (review R1, 2026-10-23): the readout cluster reads the voice against the note being asked for (`src/ui/practice/gauge-target.ts`), never the nearest note, so it says what the live hint says: "On it" inside the in-tune zone, "A little high / low" outside it, "Too high / Too low" from a whole step off (`CONFIG.display.farOffCents`). It shows nothing in the count-in, a rest, a slide or the Range finder, and neither it nor the note name reads the voice while the app plays a note (on a phone speaker the microphone hears the app).
- **The echo** (owner, 2026-10-23): in a lesson's echo the app plays each chunk before the singer sings it and nothing while they sing; a slide or a siren is played as it is to be sung, one sliding sound (`runner.ts referenceVoices`, `audio/demos.ts`), never as its two end notes.
- **Context chips** (top-right of the canvas, one at a time): "Check-up · 2 of 5" for a check-up task (it wins over the rest), "96 bpm · rung 3 of 4" for a ladder, "Test 2 of 4" for an audition, "Workout · 3 of 6" for a workout.
- **A check-up task** is titled by its plain task title ("Slide up and down"). With no range saved it shows the info Banner "Using a default range until you pass the Range finder." under the readouts (it has no Level screen to say so), except on the Range finder task itself.
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
6. **Coaching (CoachCard):** a Card with a `Lightbulb` glyph, under the replay. Still one problem per take (the tip that cost the most), now located and in plain words (§11):
   - **What went wrong**, one sentence with plain numbers: "Your voice broke 5 times on the way up (this level allows up to 3)."
   - **Where:** up to four spot chips, worst first ("0:08, near G♯3"). Tapping one marks that moment on the replay with an amber line (and scrolls the replay into view); tapping it again clears it.
   - **Try this:** the tip.
   - **More help with each miss in a row** on this exercise, with a line saying why ("Third try in a row, so here is a step-by-step."): why it happens from the second miss, a numbered step-by-step from the third, an easier way in from the fourth (one step deeper with each miss).
   - **Since last time:** the same measures on the previous take and this one, in the same words, each marked better, not as good or about the same with a glyph and words (a measure one take could not read is left out; the score stands in when nothing else compares).
   - **Moves**, all secondary buttons (the report's own action stays the one amber button): Send to Claude from the third miss; from the fourth, Listen slowly (or Listen again, without a slow demo) and "Practise" an earlier level, offered only when the help names a level that comes before this one and is already passed (never the Range finder). When that level trains a focus of the latest voice check-up (§13.15), "Practise" is offered from the second miss instead: the coaching leans on what the check-up found. The song coach (§13.9) does the same.
   - **Rest:** after six misses in a row, or eight takes in twenty minutes, a voice-care note: rest a few minutes, sip some water, stop if anything hurts, scratches or goes hoarse. (Review R8, 2026-10-23: "eight takes" is now the singing itself, three minutes of sung notes within twenty minutes (`coach.ts REST_SINGING_SEC`), so a lesson's short practice tries weigh what they sing. A practice try is coached as the good try it was or was not, by its step's rule, never by the drill's own stricter pass rule.)
   - **A pass** shows "Next" with the take's own line (the next rung, every tally lit) and nothing more.
   - If the coaching ever fails to build, the take's own tip still shows: the report never goes blank over it.
7. **Playback:** "Play take", "Slow (0.5×)", and for runs "Slow + target".

**Actions** come from `afterTakeActions`: exactly one primary, in the bottom bar.

**Special cases:**
- **Celebration (pass only, §9):** the ring count-up, the tally lights in a 120 ms stagger, and an **Unlocked** strip listing what opened (`LockOpen` glyph and the unlock event titles). Reduced motion makes it instant.
- **Folded take:** "Not judged: this exercise doesn't fit your saved range", the score greyed, and the unfit-range coaching.
- **Range finder pass:** a range card showing comfortable C3–A4 and extended A2–C5 on a mini keyboard strip. The verdict says "Range saved" only when the range was saved; otherwise it is a plain "Passed" beside the banner that says so.
- **A check-up task** (§13.15) is measured, never graded:
  - Its caption is the plain task title, and it shows no score ring and no tally lights.
  - The verdict is "Sung" (`Check`) for a take that measured its task, pass or miss, and "Passed" for a test that passed, with the Unlocked strip when it opened levels.
  - A take that measured nothing says so: "Not measured" with "Stopped early, so this task was not measured." or "Not all of this task was heard, so it was not measured.", or "Nothing came through" for a silent take.
  - Actions: "Next task" (primary) and "Sing it again". "Sing it again" leads instead after a take that measured nothing, and after a Range finder take that saved no range when none was saved before. After the last task, "See your results" ends the check-up and returns to its screen.
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
- (Examples since the 2026-10-23 rebuild: a caption reads "Unlocks Match one note – Hold it steady", and a run that passes the first test and misses the second places the singer at *Two notes, one step apart*. A pass of a test of the audition before the rebuild keeps what it granted then, and no more: SPEC §11.)

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
- **Phrase scrubber, which is also the song's progress strip:** "Whole song", then one pill per phrase showing its best full-speed score from the log as a number and a `Check` glyph once the phrase is learned (a full-speed take at the pass score, `src/song/practice.ts`), tinted on (learned) or off (sung, not yet learned). The number and the glyph carry the meaning; the tint only repeats it. Phrases joined into one selection are all marked selected. It scrolls horizontally inside its own row, so the page itself never scrolls sideways.
- **"Learn this song" panel:** the learning path's current step ("Step 4 of 17": listen, each phrase slowly then at full speed, pairs joined, the whole song), with one **secondary** action that sets the step up (its phrases, speed and loop) and starts it, and a link to the song's progress (§13.16). The bar's Sing stays the screen's one amber button. The path is a suggestion: the scrubber still picks any phrase.
- **Bottom bar:** Listen (the melody or backing for the selected phrase), **Sing** (the phrase, or the whole song), More (offset, backing volume, metronome).
- **After a take:** a sheet with the phrase-by-phrase breakdown (phrase text, score bar and %, in-tolerance %), the overall score, the coaching card (§13.5's CoachCard: where it went wrong by syllable and time as static spot chips, more help with each miss in a row on the same phrases, "since last time", Listen slowly and the moves, all secondary), and the actions "Retry phrase" / "Next phrase". After a pass, the forward action is the path's next step ("Full speed", "Next phrase", "Phrases 2 and 3", "Whole song").
- **No latency calibration for this route:** a Banner, "Calibrate latency first so your takes line up.", linking to Setup.
- **Memorable thing:** the lyric line with the tally underline walking the syllables.

### 13.10 Progress dashboard
- **Momentum:** the number in `readout-l`, one sentence ("Rest days keep it. It never drops to zero."), and 30 daily bars.
- **Level map completion:** per open world, "5 of 8 levels · Boss Recital next" and a 4 px bar in the world hue.
- **Skills:** one row per UNLOCKED skill. Each row has the name, the latest value, and a 30-day sparkline (120×32, `--text-hi` stroke, last point dotted in `--tally`). Tapping a row expands a table of the last 10 values.
- **Range over time:** a band chart (x = date, y = note) between the lowest and highest clean notes, with note names on the y axis, plus a table toggle.
- **Personal bests:** a list, shown once Personal records unlock.
- **Practice minutes:** this week against last week.
- **Check-ups:** each finished voice check-up, newest first, with its date and its focus, opening its results (§13.15); a "Re-check" button once one is due; before the first one, an offer to take it.
- Locked skills do not appear at all (SPEC §12).

### 13.11 Daily workout
- **Before:** a 5 / 10 / 20 min segmented control (saved as `workoutMinutes`), then the plan, grouped by stage: Warm-up, From *World*, Review, Cool-down.
  - Each item shows its title and its reason caption ("Your weakest skill: Crispness"). The levels behind the latest voice check-up's focus lead the weakness ranking (`src/runtime/workout.ts`), so the plan leans on them until a re-check shows otherwise; only open levels are ever planned.
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

### 13.15 Voice check-up
**A check-up, not a test** (owner, 2026-10-22): about four minutes, the five tasks of `CHECKUP_TASKS` (the Range finder, then the four Foundations placement tests), sung on the Sing screen through the runner. Nothing in it can lower progress, and it grants only what the placement audition could (`src/progress/engine.ts`).
- **One route (`checkup`), three states**, read from the running session and the log:
  - **Intro:** "A check-up, not a test", two plain sentences, the five tasks as a numbered list, the voice-care line, and a primary **Start**. A re-check names the last check-up and links to its results.
  - **Part way:** "Task 3 of 5" with **Continue** and a quiet "Start over". It promises only what the app keeps: a check-up left part way is picked up again when Pitch Lab opens within a day of its first task (`resumeCheckup`).
  - **Results:** the range in note names (or its span in words), "Then and now" with its headline from the second check-up on, each skill as a word and a glyph with the engine's sentence, what to focus on, where you start with **Continue**, and what opened.
- **Ratings** are words and glyphs in the text-safe hues ("Solid", "Getting there", "Focus here", "Not measured"), never a grade and never an alarm colour. A crack is something to focus on, never a fail. The range is measured, not graded: an octave or more is "Solid".
- **Focus** offers its level as a button only when the level is openable; otherwise a `<Locked>` line.
- **Check-up results (`checkup-results`):** a finished check-up set against the one before it, with the held-note and slide pitch lines from the saved takes (the report's replay). The pair stacks on a phone, older first, and sits in two columns from 720 px. A take that was not saved gets a plain sentence.
- **Memorable thing:** "Then and now", one plain line per skill ("Slides: 5 breaks then, 1 break now").

### 13.16 Song progress
One song's practice (route `song-progress`), read from the log (`src/song/practice.ts`). Nothing here is amber: the screen informs, and the player is one tap back.
- **The next step** of the learning path, and how many phrases are learned.
- **Phrase by phrase:** its words, best and latest full-speed score, how many takes, and learned (a glyph and the word).
- **The whole song:** its best and latest score, and its takes.
- **Then and now:** the first take of the song against the best whole-song take, with their scores and their pitch lines drawn over the song's notes (inline SVG, with "Show as table").
- **Send to Claude** for the song: up to eight recent takes, with their audio only when Include audio is ticked.
- A song the singer has not earned is refused by the route guard, and the screen checks again (fail closed).
