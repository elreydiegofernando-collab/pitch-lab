# Manual Test Checklist

Run this on a **real iPhone**, in the **installed home-screen app** (Share → Add to
Home Screen → open from the Home Screen icon), not in a Safari tab. Standalone
mode has its own WebKit bugs (see docs/ARCHITECTURE.md's start-audio recipe and
recovery rules) that a browser tab will not reproduce. Sections N–O additionally
cover Windows Chrome and Edge.

Sections A–O cover Phase 1. The owner waived per-phase sign-off on 2026-10-21, so
the Phase 2–7 sections below (P, Q, V, R, S, X, the coaching rows T, and the owner
decisions D) are the one end-to-end test at the end.

### What `npm run e2e` already proves (do not repeat it by hand)

The automated suite drives the production build in desktop Chrome with a fake
microphone, through the real UI. On every run it checks: the first-run sheets, Continue,
the Range finder take and its report (Passed, the range card, the Unlocked strip, the
take's audio captured on the first take of a launch, the mic released afterwards); the
map showing the next level open and the rest locked; Listen without the mic; Esc
mid-take saving nothing; a reload keeping progress, the attempt and the take (which
replays); the app working offline; locked deep links (later levels, other worlds,
auditions, Song Stage and its songs, song import, the dashboard, the workout, the vibrato
meter) refused with their requirement and never rendered; locked rows being text, not
controls; Export backup
(valid JSON, no audio) and Export WAV (the real take); a backup restoring the singer on a
fresh device; a hand-built backup that passes Foundations opening Song Stage and
its songs; files that are not backups changing nothing; a second profile not seeing the
first one's unlocks; and no network request leaving the app's own origin.

It cannot show anything that depends on an iPhone (the audio session, the permission
prompt, the share sheet, standalone mode, Bluetooth, the ring/silent switch) or on a
real voice (every threshold the analyzers judge it by). Those are the rows below.
A row marked "known issue" is one the automated suite already fails on: the fix belongs
to the app, and the row only asks what it sounds like. A row marked "known limit" is a
limit the builders reported and have not been able to test on a device.

## How to record results

For each item, fill in **Result** (Pass / Fail / Blocked) and **Notes**. Record
once per section header:

| Field | Value |
|---|---|
| Device & iOS version | |
| Browser (Windows sections only) | |
| Build / commit | |
| Date | |
| Tester | |

"Where to look" points at the Diagnostics screen's fields (sample rate,
latencies, applied track constraints, frames/s, detector cost, render fps,
storage persistence, service-worker status — SPEC.md §6.7/§14) when a field
confirms the result instead of (or in addition to) what you see/hear.

---

## A. Install & standalone launch

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| A1 | Open the GitHub Pages URL in Safari. Share → **Add to Home Screen**. | An icon is added with the app's name and icon (no browser chrome in the preview). | — | | |
| A2 | Tap the Home Screen icon. | App opens **standalone** (no Safari address bar/tabs), status bar matches the theme, splash is brief and not jarring. | — | | |
| A3 | From standalone, background the app (Home button/swipe) and reopen from the **app switcher** (not the Home Screen icon). | Resumes in place; no reload, no re-prompt for anything already granted. | — | | |

## B. Microphone permission

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| B1 | First run. Go to Live, tap **Sing**. | The OS mic-permission prompt appears **synchronously after the tap**, not before it and not with a delay that suggests a dropped gesture. | — | | |
| B2 | Allow the prompt. | Engine state goes to "running"; pitch shows within ~1 s of a sung note. | `engine-state`, Diagnostics → audio session | | |
| B3 | Force-quit the app, relaunch from the Home Screen, tap Sing again. | **Does not re-prompt** (permission persisted for the installed app's origin). If it does re-prompt, that's a regression to flag, not expected behaviour. | — | | |
| B4 | Deny the prompt (fresh install or Settings → reset permission first), tap Sing. | A plain-language error with the fix appears ("Microphone blocked. In Settings › Safari › Microphone choose Allow, then tap Try again.") — DESIGN.md §6. No silent failure. | `engine-state` = error | | |

## C. Wired headphones — live pitch

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| C1 | Plug in wired headphones (Lightning/USB-C or 3.5 mm adapter). Go to Live, tap Sing, hold a comfortable sustained note. | The trace locks onto the note (green/blue `--on` fill when a target is shown; free-sing trace in `--text-hi` otherwise) within a second of starting. | Live canvas, `live-note`/`live-hz`/`live-cents` | | |
| C2 | While still sustaining, check the readouts update smoothly, no stutter or long freezes. | Readout cluster updates continuously; no visible stall. | `live-hz`, `live-db` | | |

## D. Setup: audio-session check & Reset audio

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| D1 | Open **Setup**. Run the audio check with the built-in speaker (no headphones). Play the reference tone. | Tone plays from the **main speaker**, at normal media volume — **not** the tiny earpiece speaker and **not** ducked/quiet (ARCHITECTURE.md's `audioSession.type='play-and-record'`). | Setup screen's check result, Diagnostics → audio session | | |
| D2 | Repeat D1 with wired headphones in. | Tone plays in both ears at normal volume, not ducked. | Setup screen's check result | | |
| D3 | Reproduce a stuck route: start Live, background the app for 30+ s (see H1), foreground it, then try D1 again if audio sounds wrong (earpiece/ducked). Tap **Reset audio**. | After Reset, audio is back on the correct route at normal volume — this is the escape hatch for WebKit's earpiece/duck bugs (ARCHITECTURE.md). | Setup screen, Diagnostics → audio session (re-run) | | |

## E. Bluetooth / AirPods

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| E1 | Connect AirPods (or any Bluetooth headset), open Setup or Live. | A visible warning explains Bluetooth/AirPods add noticeable latency and that calibration is recommended (SPEC.md §6.5). | Setup/Live banner | | |
| E2 | With AirPods connected and selected as the input, open Setup's mic picker (if offered) or just observe the warning. | A **Bluetooth-mic warning** specifically calls out the mic (not just output) — HFP mics are 8–16 kHz and hurt pitch detection; recommend the phone's own mic instead. | Setup screen | | |
| E3 | Disconnect AirPods, then reconnect them while the app is open. | The app detects the route change (`devicechange`) and **offers recalibration** rather than silently keeping a stale number. | Setup/Live banner | | |

## F. Latency calibration

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| F1 | Setup → Calibrate → **Loopback**, using the built-in speaker (phone on a hard surface, mic can hear the speaker). Run it. | Completes with a plausible round-trip number (tens of ms for a phone speaker) and low jitter; result is saved per route. | Calibration result screen | | |
| F2 | Run **Loopback** again, this time holding a wired earbud (plugged into the phone, playing the clicks) right up to the mic. | Completes; round-trip in the same rough order as F1 (wired path), saved for the "wired" route separately from "speaker"/"bluetooth". | Calibration result screen | | |
| F3 | Run the **Sing** method (sing a short "ta" on each click/cue). | Completes with `matched >= minMatches` and a plausible number; works even with Bluetooth connected (unlike loopback). | Calibration result screen | | |
| F4 | Run the **Tap** method (tap the screen on each click). | Completes; the reported value is noticeably **larger** than Sing/Loopback for the same route (it also includes touch latency) — that's expected, not a bug. | Calibration result screen | | |
| F5 | Compare F1–F4's saved values across routes. | Wired/speaker loopback is the smallest; Bluetooth (if tested) is clearly larger (often 150–300 ms); nothing is negative or wildly implausible (>1 s). | Diagnostics or Settings' saved-calibration list | | |

## G. Ring/Silent switch

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| G1 | Flip the physical Ring/Silent switch to **silent**. Open Live or Setup and play a reference tone / vibrato demo. | Reference tones are still **audible** (Web Audio media playback is not muted by the silent switch when the audio session is configured correctly) — SPEC.md §6.3. | Setup/Live | | |
| G2 | With the switch still on silent, sing into the mic. | Pitch capture still works normally (silent switch doesn't affect recording). | `live-hz`/`live-note` | | |

## H. Backgrounding, interruptions, rotation

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| H1 | Start Live/Sing, lock the screen (or background the app) for **30+ seconds**, then return. | A "Tap to reconnect mic" affordance appears (or the app auto-resumes); tapping anywhere restarts capture cleanly — no silent dead state (ARCHITECTURE.md's `backgroundSuspectSec`). | `engine-state` | | |
| H2 | Start Live/Sing. Trigger an **incoming call** (or ask Siri something) mid-session, then dismiss/end it. | Engine goes to "interrupted"; after the interruption ends, tapping resumes capture without a full reload. | `engine-state` | | |
| H3 | While Live is running and the trace is drawing, **rotate** the phone to landscape and back. | Canvas repaints correctly at the new size (no blank canvas — a known iOS rotation bug per ARCHITECTURE.md); layout matches the wide layout at ≥ 900 px if landscape width crosses that. | Live canvas | | |

## I. Low Power Mode

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| I1 | Enable Low Power Mode (Settings or Control Centre). Open Live, sing. | App stays usable: canvas still scrolls and pitch still reads correctly at a reduced rate (~30 fps is expected and acceptable, not a bug) — DESIGN.md §9, SPEC.md §7. | Diagnostics → render fps (`diag-render-fps`) | | |

## J. Offline / Airplane Mode

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| J1 | With the app already opened once (so it installed its service worker), enable **Airplane Mode**. Launch the app fresh from the Home Screen icon. | App launches fully offline — Home screen renders, no network-error page. | Diagnostics → service worker (`diag-sw`) | | |
| J2 | Still in Airplane Mode, go to Live and tap Sing. | Singing works exactly as online (mic capture and the AudioWorklet don't need the network). | `live-hz`/`live-note` | | |

## K. Persistence

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| K1 | Change a setting (e.g. theme, notation, reference volume) and run a latency calibration. Force-quit the app (swipe up in the app switcher) and relaunch. | The changed setting and the calibration result are both still there. | Settings screen, Diagnostics (latency) | | |
| K2 | Open Diagnostics. | **Storage persisted** reads true/granted (`navigator.storage.persist()` succeeded) — if false, note it; data can still work but is less durable (SPEC.md §6.7). | Diagnostics → storage persisted (`diag-persisted`) | | |

## L. Mic check, pitch self-test & Diagnostics sanity

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| L1 | Run Diagnostics' mic record → playback check. Speak/sing normally, then listen to the playback. | Sounds like an **unprocessed** recording of your voice — no pumping (level jumping), no noise-gate chopping breath tails, no obvious EQ coloring. This confirms EC/NS/AGC are truly off, not just reported off. | Diagnostics mic check | | |
| L2 | Run (or perform) a pitch self-test: sing a steady, comfortable note at a known pitch (e.g. match a reference tone first) and read the live cents readout. | Reads within **±10 cents** of the true pitch. | `live-cents` | | |
| L3 | Open Diagnostics while the mic is active. | **echoCancellation / noiseSuppression / autoGainControl all show false** (what the browser actually applied, not just what was requested). | Diagnostics → track settings (`diag-track-settings`) | | |
| L4 | Still in Diagnostics with Live running, read sample rate, frames/s and detector cost. | Sample rate is **44100 or 48000**; frames/s is **roughly 90+** (SPEC.md §7); detector cost is a small number of milliseconds (well under 1 ms expected per ARCHITECTURE.md). None are 0, `NaN`, or implausibly large. | Diagnostics → sample rate (`diag-samplerate`), frames/s (`diag-fps`), detector cost (`diag-detector-cost`) | | |
| L5 | While recalibrating or switching routes, re-check the audio-session result (D1–D3). | Diagnostics' own audio-session field agrees with what you heard (not routed to the earpiece, not ducked). | Diagnostics → audio session (`diag-audio-session`) | | |

## M. Subjective voice-to-screen latency

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| M1 | Sing short, clearly-attacked notes ("ta-ta-ta") on Live and watch the trace. | The trace visibly lags the voice by **a small, consistent amount that feels tight, not sluggish** — SPEC.md's target is < 50 ms, which should feel essentially immediate. Note your subjective impression (immediate / slightly behind / noticeably laggy). | Live canvas | | |

---

## N. Windows Chrome

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| N1 | Open `chrome://settings/content/microphone`, confirm no Chrome-level "noise suppression" enhancement is forced on for the mic; use the app normally with the built-in mic. | Diagnostics reports EC/NS/AGC false, same as iPhone. | Diagnostics → track settings | | |
| N2 | Use a wired USB/3.5 mm headset. Sing on Live. | Pitch locks on cleanly; no different behaviour than the built-in mic beyond audio quality. | `live-note`/`live-hz` | | |
| N3 | Connect a Bluetooth headset (HFP profile, i.e. a headset mic, not just A2DP output) and select it as the input. | A **Bluetooth-mic warning** appears, same message intent as iOS's (E2): HFP mics are low-bandwidth and hurt pitch detection. | Setup/Live banner | | |
| N4 | On Live, test the desktop keyboard shortcuts: press **Space** (Sing/Stop), **L** (Listen), **Esc** (back). | Space toggles Sing/Stop, L plays the Listen demo, Esc navigates back — DESIGN.md §6. Focus-visible ring appears when tabbing to controls. | Live screen | | |

## O. Windows Edge

Repeat **N1–N4** in Microsoft Edge.

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| O1 | Same as N1. | Same as N1. | Diagnostics → track settings | | |
| O2 | Same as N2. | Same as N2. | `live-note`/`live-hz` | | |
| O3 | Same as N3. | Same as N3. | Setup/Live banner | | |
| O4 | Same as N4. | Same as N4. | Live screen | | |

---

## Phase 2 — Real-voice checks for every PROVISIONAL threshold

Every number the analyzers judge a take by was tuned on synthesized signals; none has a
real-voice corpus behind it yet. They are marked PROVISIONAL in `src/config.ts`, or in a
comment at the top of the analyzer that owns them. Each row below takes one group of them,
says what to sing (well, and badly on purpose) and what the take report should say.

How to run it:

- Both singers (the tenor and the beginner), in **wired headphones**, in a quiet room, phone
  on a stand at arm's length (the way the app is meant to be used).
- Later worlds open only by earning them, so reach each row's level in order. To test a
  later world without singing through everything before it, restore a backup from a profile
  that has passed the worlds before it (Data & backup → Import backup; `e2e/backup-fixture.ts`
  builds a Foundations-complete one to copy from). That is a legitimate earned log, not a bypass.
- Take the numbers from the report (score, the tiles, the tip) and write them in Notes.
- A row **fails** when a clean take does not pass, a sloppy take passes, or the tip names the
  wrong problem. Write down which constant you would move, and which way.
- Sing each take in full. A take stopped early is practice only and is not judged for the level, and a take that leaves notes unsung cannot pass (P17).

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| P1 | **Voicing gate** (`CONFIG.audio.minConfidence` 0.8, `minRmsDb` −50). On Live: speak, hum softly, breathe out, whisper "sss", sing very quietly, then stay silent with a fan or traffic noise in the room. | Sung and hummed notes trace within about a second; breath, sibilants and room noise draw nothing and make no ghost notes. A very quiet sung note still traces, without dropping out every few frames. | Live canvas, `live-note` | | |
| P2 | **Late start** (`CONFIG.accuracy.lateStartAllowanceSec` 0.6). As the beginner, on Pitch match (02) and Sustain I (03): come in about 0.5 s, 0.9 s and 1.2 s after each note starts; then sing only the last seconds of a long hold. | 0.5 s late: scored normally. 0.9 s late: still passes, at a reduced score. 1.2 s late: does not pass. Singing only the last seconds of a hold never passes. | Take report: In tune, verdict | | |
| P3 | **Onsets** (`CONFIG.onset.settleTargetMs` 400 / 250 / 150, `crispMaxScoopCents` 30, `crispMaxOvershootCents` 20, `hardMaxRiseMs` 60, `breathyMinRiseMs` 160, and the `ONSET_*` constants at the top of `analysis/onset.ts`). On Pitch match (02) and Crispness (06): sing a clean attack; scoop up from about 50¢ below; overshoot sharp and settle; start breathy; attack hard (glottal) but accurately. | Clean: settles under the level's target, crisp. Scoop: the Scoop tile is over 30¢ and the tip says to start on the pitch. Overshoot: named. Breathy: not crisp (a slow, soft start is not a crisp landing). A hard but accurate attack still passes (only a breathy onset vetoes crisp). | Take report: Settle, Scoop, Overshoot tiles, tip | | |
| P4 | **Vibrato zone and flags** (`CONFIG.vibrato`: pop 5–7 Hz ±20–60¢, classical ±40–100¢, `wobbleBelowHz` 4.5, `wobbleAboveExtentCents` 120, `bleatAboveHz` 8, `straightBelowExtentCents` 10, `rateRampAllowance` 0.15, and the constants at the top of `analysis/vibrato.ts`). On the Vibrato meter and Free vibrato: a natural vibrato near 5.5 Hz; a deliberately slow, wide one near 4 Hz; a fast tremolo near 9 Hz; a straight tone; a long note whose vibrato speeds up a little; a vibrato held right at 5.0 Hz, and at 7.0 Hz. Then Settings → Vibrato style: Pop, then Classical, with a ±70¢ vibrato. | Natural: in the zone. Slow and wide: the wobble flag, with its glyph. Fast: the bleat flag. Straight: the neutral "straight" chip, never an error colour. A speed-up across a long note is not called irregular. At 5.0 and 7.0 Hz the reading can land on 4.99 or 7.01 and flip "in zone": note whether it does, and that no pass depends on it alone. ±70¢ is in the zone for Classical, out for Pop. | Vibrato meter, take report | | |
| P5 | **Switching and bloom** (`analysis/switch.ts`: `EARLY_TOLERANCE_SEC` 0.3, `LATE_TOLERANCE_SEC` 0.7, `REATTACK_GAP_SEC` 0.08, `BLOOM_FULL_SEC` 0.25, `BLOOM_ZERO_SEC` 1.5). On Straight to bloom and On/off switching: switch on the cue; then 0.5 s early; then a second or more late; then breathe and re-attack the note instead of switching. | On the cue: a clean switch and a full bloom score. Early or late: not clean. A re-attack is not a switch. | Take report: Clean switches, Bloom on cue | | |
| P6 | **Pulses and oscillation** (the pulse and oscillation analyzers, built on the vibrato primitives). On Pulse builder I–III and Oscillation I–II with the metronome: "ha-ha-ha" without stopping the sound, at the clicked rate; too slow; too fast; stopping the sound between pulses. | At the clicked rate: passes. Off-rate: "Pulse rate off" names the error in Hz. Stopped sound does not count as connected pulses. | Take report: Pulse tiles | | |
| P7 | **Sirens, stairs and breaks** (`CONFIG.transitions`: `dropoutMaxMs` 300, `stairPlateauMs` 60, `vibratoMisfitMinCents` 12, `vibratoMisfitNoiseFactor` 2.2, `vibratoBandMarginHz` 0.5, and the constants at the top of `analysis/glide.ts`). On Sirens & glides (05): a smooth siren; one with a real, slightly irregular vibrato riding on it (**the first thing to check**); one in stair-steps; one through your break so the voice cracks or flips; one where you stop for a breath in the middle of a siren (and, separately, the breaths you take in the rests between sirens). | Smooth: passes. Vibrato on a siren: **not** scored as stairs. Stair-stepped: flagged as stairs. The crack: marked on the replay with the zig-zag glyph and "crack". A breath in the rests between sirens is not a break; a hole in the middle of one siren is (a siren is meant to be unbroken). | Take report: Smoothness, Breaks, replay | | |
| P8 | **Leaps and legato** (`analysis/transitions.ts`: `BUDGET_FRACTION` 0.2, `BUDGET_FLOOR_MS` 80, `RISING_MS_PER_SEMITONE` 8, `BAND_MAX_FRACTION_OF_INTERVAL` 0.45, `SETTLE_SLACK_SEC` 0.15; the DTW penalties in `analysis/dtw.ts`). On Interval jumps I–II and Legato lines: clean fifths and octaves; the same with a scoop into each; a slow slur. | Clean leaps count as clean transitions. A scoop or a late settle counts against. A wide upward leap is given the extra settle time it needs. | Take report: Clean transitions | | |
| P9 | **Inflections** (the tuning block at the top of `analysis/inflections.ts`). On Intentional scoop, Falls, Slides I–II, Turns, Flips (Inflections world): each done properly, then the flat version (no scoop; a step instead of a slide; no fall; no neighbour note; a slide instead of a flip). | The proper figure passes. The flat version fails the shape gate, and the tip names that figure. | Take report: Inflection tiles, tip | | |
| P10 | **Smeared or defined runs** (`CONFIG.runs`: `definitionBandFraction` 0.12, `definitionBandMinCents` 8, `definitionSlideFree` 0.4, `definitionSlideZero` 0.8, `weights`; `analysis/runs.ts`: `DEFINED_MIN_DEFINITION` 0.6, `NEAR_MISS_CENTS` 100, `TIMING_FREE_MS` 25). On every rung of a Runs ladder (3, 4.5, 6, 9 and 12 notes a second): articulate every note ("ha ha ha"); slur the run as a slide; leave two notes out. | Articulated: every note a filled circle, "defined" — **including at 12 notes a second** (the detector's 43 ms window leaves a clean fast run no flat plateau, so this is the number most likely to need moving). Slurred: half circles, "smeared". Left out: ✕, "missed". The glyphs match what **Slow + target** lets you hear. | Take report: replay, Run tiles | | |
| P11 | **Dynamics** (`CONFIG.dynamics`: `minRangeDb` 10, `maxDriftCentsPerDb` 1, `shapeSmoothSec` 0.3, `endDownShare` 0.1–0.4, `minShapeScore` 0.5; the constants at the top of `analysis/dynamics.ts`). On Crescendo, Decrescendo and Messa di voce I–III: a real swell of 10 dB or more; an unvarying level; the opposite of the cue; getting sharp as you get louder; a lopsided swell (long start, short end). | A real swell passes. An unvarying level fails the loudness-range gate. Against the cue counts no range and fails. Going sharp when loud: the tip says to keep the breath steady and not to push. A lopsided swell earns partial symmetry credit, not zero. | Take report: Loudness range, Symmetry, tip | | |
| P12 | **Range** (`CONFIG.range`: `holdSec` 1, `holdBandCents` 65, `referenceSec` 0.5, `centreSmoothSec` 0.31, `maxDriftCentsPerSec` 40; `RANGE_MIN_SPAN` 12). On the Range finder: hold your lowest and highest easy notes for 3 s or more; the same with a wide (±100¢) vibrato; slide slowly up and down without holding; sing only the guide bars (an octave); hold a note for 0.6 s only. | The range card matches the notes you held, give or take a semitone, and matches Profiles. A wide vibrato is still one note. A slow siren is **not** counted as holds. An octave passes. A 0.6 s note is not counted. | Range card, Profiles | | |
| P13 | **Score bands** (`exercises/catalog/scoring.ts`: `POPULATION`, `PASS` 0.6, `GATE_POINT` 0.25, `CORE_POINT` 0.5, tally `TIERS` 0.8 and 0.92). Each singer sings Foundations 02–09 as naturally as they can. The tiers are easy (02–03), default (04–08) and studio (09 and the Boss Recital). | Each tier is pitched so that its entry singer scores about the pass mark: a beginner on easy, a developing singer on default, a competent amateur on studio. So the beginner clears 02–03 at around 60–75% and should find 04–08, then 09 and the Boss Recital, progressively hard; the trained tenor passes all of them, near full marks on 02–08. Write down each level's score for each singer; a level far easier or harder than its tier is a band to move. | Map (Best, tally lights), take reports | | |
| P14 | **Song scoring** (`runtime/song-session.ts` `SONG_PASS_SCORE` 0.7; `CONFIG.song` `phraseGapMs` 350, `dtwBandMs` 200, `octaveAgnostic`; `analysis/phrases.ts` `ONSET_ALLOWANCE_MS` 50, `LONG_NOTE_SEC` 0.75; `analysis/dtw.ts` `DEFAULT_TIME_PENALTY_CENTS` 30). Sing three phrases of Twinkle, Auld Lang Syne or The Holy City: accurately; a fourth too low; an octave down; half a beat late. | Accurate: 70% or more passes. A fourth off: does not. An octave down scores as in tune (octave-agnostic is on): say in Notes if that feels wrong. Half a beat late is forgiven but not without limit. | Song take sheet | | |
| P15 | **Song ratings, MIDI track pick and phrasing** (`song/difficulty.ts` knobs; `song/midi.ts` melody-pick and lyric-match rules; `CONFIG.song` `maxPhraseSec` 10, `minPhraseNotes` 3, `minPhraseSec` 1.5, `minSplitSideSec` 2, `splitWindowShare` 0.25). Open Song Stage on a profile that has it; then import two or three real hymn or karaoke MIDI files, and the same hymn as an UltraStar chart if you have one. | Each bundled song's world feels right (Twinkle is easy; Ave Maria's run really is a run) and the caption under it is true. In each imported MIDI the preselected track really is the melody (not the bass or a drum track), karaoke words land on the right notes, phrases end where you would breathe, and none runs past about 10 s. | Songs, Song import | | |
| P16 | **Momentum, workout, weakness** (`progress/momentum.ts` `MOMENTUM_KNOBS`, `progress/workout.ts` `WORKOUT_KNOBS`, `progress/weakness.ts` `WEAKNESS_KNOBS`). After a week of use, or with a restored backup that spans days. | Momentum rises with practice, decays slowly and never reaches zero; a rest day is not punished. A 5, 10 or 20 minute workout lands within a couple of minutes of what you chose, and its review item is the weakest unlocked skill. | Dashboard, Workout | | |
| P17 | **Note reach: the "unsung notes" rule** (`REACH` in `exercises/analyze.ts`: `holdShare` 0.65, short notes need 0.15 s or half their length; `MIN_REACH_SHARE` 0.9 in `exercises/evaluate.ts`; a Boss Recital, and any level with fewer than 10 notes, needs every note). Sing **clean, complete** takes on Crispness (06, staccato), Interval jumps, the fastest Runs rung (12 notes a second), Pulse builder and a Boss Recital. Then sing one deliberately leaving two notes out, and one going quiet for the last third. | Every clean, complete take is judged normally: none is refused with "Some notes went unsung". **This is the number most likely to need moving**: short staccato notes and fast runs leave few voiced frames. The two incomplete takes cannot pass, and their tip says notes went unsung. | Take report: verdict, tip | | |

## Phase 3 — First run, the map, levels and takes

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| Q1 | Fresh install, first launch. | **Voice care** sheet first ("Got it"), then **Before you start** (Later / Set up now). Both sheets sit inside the screen, and their buttons are reachable without scrolling the page. A second launch shows neither. | Home | | |
| Q2 | Home → **Continue**. | Opens LEVEL 01 Range finder: goal, "To pass" lines, the ±50¢ chip, "Not sung yet". | Level screen | | |
| Q3 | Home → World map. | Scrolled so the current node sits about 40% down. Only passed and current nodes respond to a tap; each locked node says what opens it ("Pass Pitch match to unlock."); locked worlds are dimmed text with one line. | Map | | |
| Q4 | Fresh launch, Level → Sing → **Sing** (the first take of the launch: the permission prompt may appear). | The count-in starts only once the mic is open (no clicks lost under the prompt). The report shows **Play take** and **Slow (0.5×)**, and Play take sounds like the take. | Take report | | |
| Q5 | Pass the Range finder. | The report says **Range saved** ("Every exercise now fits your voice."), with no score ring or tally lights: the Range finder measures, it does not grade. The range card shows your practice range and full reach in plain words, with middle C marked, and the **Unlocked** strip lists Pitch match and the features. The range card's notes match Profiles' range line. | Take report, Profiles | | |
| Q6a | **The architecture must-do.** Fresh install (or Data & backup → Delete all data first). Sing the Range finder until the report says Passed. The instant the report appears, before touching anything, **force-quit** the app (swipe it away in the app switcher). | The take was already written: iOS can kill an installed web app at any moment, and nothing may depend on leaving the report first. | — | | |
| Q6b | Relaunch from the Home Screen icon. | No first-run sheets. Continue reads "Next up · 02 Pitch match". On the map: Range finder passed, Pitch match "Up next", the level after it locked. | Home, Map | | |
| Q6c | Open Level 01, then Profiles. | Level 01 shows "Your range" (the practice range, no score); Profiles shows the same range line, equal to the report's range card. | Level, Profiles | | |
| Q6d | Data & backup. | Storage reads "Saved on this device"; Attempts 1; Recordings 1 with an "Audio" chip. **Play** replays your take, audibly, on the speaker at normal volume (not the earpiece). | Data & backup | | |
| Q6e | Repeat Q6b–Q6d with Airplane Mode on. | Identical: everything is on the device. | — | | |
| Q6f | Start a take on Pitch match and force-quit in the middle of it; relaunch. | Nothing was saved from the half take: Attempts is still 1, Level 02 still reads "Not sung yet". | Data & backup, Level | | |
| Q7 | Speaker (no headphones; route Speaker in Setup): sing Pitch match. Then repeat in wired headphones (route Wired). | Speaker: the count-in's starting pitch ends about 0.6 s before the downbeat; Pitch match's Listen tones still play in full; only clicks sound while you sing. Headphones: every reference tone plays as written. | Sing screen | | |
| Q8 | Pass a level, then open the map. Open it again. | The newly opened node powers on with an amber glow once; it does not replay on the second visit. | Map | | |
| Q9 | Foundations **Placement audition**: Start test 1, miss one on purpose. | "See your placement" shows where you placed and what opened, with "Go to <level>". Back from the report returns to the audition intro. | Audition screen | | |
| Q10 | Start the mic on Live, then go back. Same on the Vibrato meter and Setup. | The iOS microphone indicator goes off when you leave each screen. | Status bar indicator | | |
| Q11 | Report → **Retry** a few times. | Each Retry reopens the mic quickly (about 0.3 s; the indicator may flicker). Note whether that feels acceptable. | Sing screen | | |
| Q12 | Desktop: press **Esc** in the middle of a take. | It goes back to the level and nothing is saved (Best and Data & backup unchanged). Space still starts and stops a take. | Level, Data & backup | | |
| Q13 | At 375–430 px wide, look at the report's trace replay and the bottom bars. On a long take, tap **Slow (0.5×)**. | Nothing overflows sideways; the replay is readable. Slow prepares in a few seconds with a spinner, without freezing the screen. | Take report | | |
| Q14 | Press Listen on a level that has a metronome (Oscillation I, Slides I, Pulse builder II), once at the default Reference volume and once with it at maximum (Settings). Then Listen on the Range finder. Do it in wired headphones and on the speaker. | Clean clicks and notes, with no crackle, including where the Range finder's starting pitch hands over to its first note. (Fixed in Wave 3: the click follows the reference volume and a soft limiter guards the demo path. The automated check proves it in Chrome only, so this is the WebKit check.) | Level → Listen | | |
| Q15 | Fresh install: watch the voice-care sheet for its first three seconds. | The "ready to work offline" toast never covers the sheet: it waits until the sheet closes. | Home | | |
| Q16 | On Pitch match, tap **Stop** halfway through a take. Then, on the next take, sing the first half and stay silent for the rest. | Stopped: the report says "Stopped early: practice only, not judged for the level", and the level stays as it was (no pass, the tempo ladder does not climb). Silent half: it cannot pass, and the tip says notes went unsung. | Take report, Level, Map | | |
| Q17 | On a passed Range finder, open Level 01. | There is no "Chase a record": the Range finder measures your range and has no personal records (a wider strained span is never rewarded). | Level 01 | | |
| Q18 | Settings → Theme: Light, on the installed app. | The iPhone status bar (time, battery) stays readable over the app's light top bar. (Wave 3 X12: only a device can show this.) | Any screen, top edge | | |

## Phase 4 — Vibrato & Inflections worlds

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| V1 | Before passing the Foundations Boss Recital, look at Home, Live's More sheet and Settings. | Vibrato meter, the vibrato readouts and the vibrato style setting are shown **locked** with "Pass the Foundations Boss Recital to …", and cannot be opened (also not by `#/vibrato-meter`). | Home, Live, Settings | | |
| V2 | After passing it: open the Vibrato meter, sing with and without vibrato. | Rate, extent and centring read sensibly against the zone ("Pop 5–7 Hz"); a straight tone shows the neutral "straight" chip, never an error colour. | Vibrato meter | | |

## Phase 5 — Runs & Riffs and Dynamics worlds

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| R1 | Climb a Runs tempo ladder one rung, force-quit, relaunch, open the level again. | The take starts on the rung you reached (the context chip reads "96 bpm · rung N of M"), not back at the bottom. | Sing screen | | |
| R2 | After a Runs take, use **Slow + target**. | The slowed take plays with the target notes, in time with each other. Per-note glyphs on the replay match what you heard. | Take report | | |

## Phase 6 — Song mode

Song mode needs a profile that has passed the Foundations Boss Recital (restore a backup that
has, or sing through), a **latency calibration for the route you are on**, and, for the backing
rows, one of your own songs: a MIDI or UltraStar chart and its MP3 (3–5 minutes). Use wired
headphones unless a row says speaker.

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| S1 | Open Song Stage on a profile that has just passed the Foundations Boss Recital. | The 12 bundled public-domain songs are listed, the open ones first. At the time of writing: three open (Auld Lang Syne, The Holy City, Twinkle, Twinkle, Little Star) and nine locked, each dimmed, as plain text, naming the Boss Recital that opens it ("Pass the Vibrato Boss Recital to unlock this song."). Tapping a locked one does nothing. | Songs | | |
| S2 | **Calibration.** Open an open song on a route with no latency calibration saved (a fresh install, or a route you have not calibrated). | A banner reads "Calibrate latency first so your takes line up.", and the amber button says **Calibrate**, not Sing. Setup & calibration → Loopback → Run → Save, then Back: the banner is gone, the button reads **Sing**. | Song player, Setup | | |
| S3 | Calibrated: sing a phrase in time with the melody guide, in wired headphones, on a steady note. | The trace sits on the bars, in time: no steady lead or lag you can see. Then switch the route in Setup to one you have not calibrated (for example Speaker): the banner and Calibrate come back for that route, and calibrating one route does not calibrate another. | Song player | | |
| S4 | Speaker route: sing a phrase. Then in headphones. | Speaker: the melody guide is silent during the take (More says why). Headphones: it plays. Listen and Play always play it. | Song player | | |
| S5 | **Import your own song.** Song Stage → Import → Choose a file (a MIDI first). Pick the melody track (Preview each for 6 s); Add an MP3 or WAV; move the Offset; Preview 8 s; Save. | A MIDI shows its tracks (name, notes, range) with the best preselected; the rating names the world it needs and why; after Save the song is in the library marked "Yours", and **locked** if it needs a world you have not passed. "Your files stay on this device." | Song import, Songs | | |
| S6 | Open an imported song that has a backing track and tap Play. | The backing is ready before the first tap and plays aligned at its offset. In More: Backing volume, and Offset (raise it if the backing sounds late, lower it if early); the offset is remembered with the song. | Song player | | |
| S7 | Import a 4–5 minute MP3 backing and choose 50% speed. | The slowed backing prepares without stalling the phone (a "Preparing the backing at 50% speed" line under the transport). | Song player | | |
| S8 | Sing a phrase **with the backing** in headphones, then on the speaker. | Headphones: scored normally. Speaker: More warns "On the speaker the mic hears the backing too: keep it low, or sing in headphones." | Song player | | |
| S9 | Loop a phrase; change the speed to 75% and 50%; step the Key up and down; use the Fits your range button. | The loop repeats the phrase; the speed changes the pace and keeps the pitch; the key moves the bars and the lyric; "fits your range" marks the key that suits you, and a line says how many notes still fall outside your range. | Song player | | |
| S10 | Turn the Metronome on (More). Sing along on an imported MIDI, then on a bundled chart. | The click follows the chart's beat. **Known limit:** some MIDI imports have no beat grid anchor, so the click can sit off the beat; note which file. | Song player | | |
| S11 | After a take, read the sheet; **Retry phrase**; **Next phrase**; **Play take**. | The sheet shows the score ring, "Passed" or "Not yet", each phrase's text with its score bar, %, and "% in tune". Retry starts a new count-in from the tap. Next selects the next phrase. The take is in Data & backup, titled by the song. | Song player, Data & backup | | |
| S12 | Delete an imported song (More → Delete this song → Delete). | The song and its backing are gone from the library, with a toast that says so. A failed delete would say so and keep the song. | Songs | | |
| S13 | Leave the player while the mic is on. | The mic indicator goes off. | Status bar indicator | | |
| S14 | With a song open to this profile, launch `#/song/<id>` (an installed app can use a shortcut or a link). | The song opens directly; for a profile that has not earned it, the library opens with the requirement line. | Song player / Songs | | |

## Phase 7 — Progress, workout, profiles, data, polish

### Backup, round trip and WAV export

Use a profile with real progress and at least one saved take (Keep take audio on). Do the round
trip once on the iPhone, then restore the same file on the Windows laptop.

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| X1 | Data & backup → **Export backup**. | The iOS share sheet opens with `pitch-lab-backup-YYYY-MM-DD.json` (dated the day you are in). If the sheet needs a fresh tap, the page shows "Your backup is ready" with **Share backup** and **Download instead**, and both work. Save to Files. | Data & backup | | |
| X2 | Open that file in Files or Quick Look. | Plain JSON starting `{"format":"pitch-lab-backup","version":1`, listing your profiles and attempts. **No audio**: no recordings, no pitch tracks, no base64 blobs. | Files | | |
| X3 | **The round trip.** Delete all data (type DELETE → Delete everything). | A toast says "All data deleted." Home shows a fresh "Me" (the voice-care sheet comes back, since it is read per profile: dismiss it; "Before you start" and your latency calibration belong to the phone and are kept), Continue reads Range finder, the dashboard and Song Stage are locked again, and Data shows 0 attempts, 0 recordings. | Home, Data & backup | | |
| X4 | Data & backup → **Import backup** → choose the file from X1. | A report in plain words: "Backup imported.", "Added 1 profile.", "Added N attempts to the practice history.", "Replaced the empty starter profile.", "Restored the settings of 1 profile." | Data & backup | | |
| X5 | Check what came back. | Your name, voice type, range (Profiles), Continue and the map (the same level is current), Best scores and tally lights, the dashboard, and your settings (theme, notation, Keep take audio). The first-run voice-care sheet does **not** come back. **Recordings is empty**: a backup carries no audio, by design. | Home, Map, Profiles, Settings | | |
| X6 | Import the same file again. | "Nothing new in that backup." and "Skipped N attempts that were already here." Nothing is duplicated. | Data & backup, Dashboard | | |
| X7 | Damage a copy of the file (delete a bracket from it in Files) and import it. | "That file was not imported." and "Nothing on this device changed." | Data & backup | | |
| X8 | Import the file from X1 on the Windows laptop (Chrome), into a fresh browser profile. | The same progress, range and settings appear; the starter "Me" is replaced, not kept beside it. | Home, Profiles | | |
| X9 | Recording → **Export WAV**. | The share sheet (or a download on Windows) offers `pitch-lab-take-YYYY-MM-DD.wav`. | Data & backup | | |
| X10 | Open that WAV in Files, QuickTime or any player. | It plays **your take**: your voice, about 21 seconds for a Range finder (the pre-roll, the 20 s of material and a short tail), mono, not silence, not clipped. | Files | | |
| X11 | Turn **Keep take audio** off, sing a take, open Data & backup. | The new recording says "Pitch trace only"; Play and Export WAV are disabled for it; the report says audio is off. Turn it back on. Nothing else in the app can export audio. | Settings, Take report, Data & backup | | |
| X12 | Recording → **Play**. | Audible on the speaker at normal volume (not the earpiece). Stop works. | Data & backup | | |
| X13 | Delete one recording (the trash button, then **Delete this recording**). | A recording that deletes disappears and the Recordings figure drops; one that cannot delete says so and stays. Attempts and progress are untouched. | Data & backup | | |

### Profile switching

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| X14 | Profiles → **New profile**: name "Sam", voice type Tenor, leave "Switch to this profile now" on → **Create profile**. | The switch lands on Home, for Sam: the voice-care sheet appears again (it is read per profile), Continue reads Range finder, and Daily workout, Song Stage, Vibrato meter and the dashboard are locked lines. The profile chip shows Sam's initials. | Home | | |
| X15 | Open the map and Profiles. | Sam's Pitch match is locked ("Pass Range finder to unlock."), Sam's range reads "Range not measured", and the first singer's row still shows their range and "Up next: Pitch match (Foundations)". | Map, Profiles | | |
| X16 | Tap the first singer's row ("Sing as …"). | Back on Home as them: their Continue card, their unlocks, their range. Nothing of Sam's leaked, and nothing of theirs is lost. | Home | | |
| X17 | Change something per profile (theme, notation, Keep take audio) as Sam; switch to the first singer. | Each profile keeps its own settings. **Latency calibration is the exception**: calibrate once and both profiles see it (it belongs to the device and route, not the singer). | Settings, Setup | | |
| X18 | Sing a take as Sam, then look at Data & backup as each singer. | The Recordings list shows only the active singer's takes. The Storage card's Attempts and Recordings figures count the whole device, so they add up across both singers. | Data & backup | | |
| X19 | Edit (pencil) → rename Sam and change the voice type. | The new name and type show at once; the singer's range and progress are unchanged. Until a range is measured, the voice type sets the default range the exercises use. | Profiles | | |
| X20 | Edit → **Delete this profile**: type the name, leave "Also delete recordings" on. Then delete the **active** profile, and last the **only** one. | The typed name gates the button; the recordings go with the profile (Recordings count drops); the app lands on Home as another profile; deleting the only profile leaves a new empty "Me". A failed delete says it failed and keeps the profile; "Export a backup first" opens Data & backup. | Profiles, Home | | |

### The rest of Phase 7

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| X21 | Delete all data when you have nothing to lose: type DELETE. | It says what really happened; Home shows a fresh default profile and asks for the voice-care note again. The phone's latency calibration and audio route are kept (known limit: the sheet's copy says "all settings"). | Data & backup, Home | | |
| X22 | A **daily workout** from start to summary (one item early with End workout, once all the way). | Each take goes through the Sing and Report screens with "Workout · N of M"; the summary shows items, minutes and Momentum before → after. | Workout | | |
| X23 | Sing for about 30 minutes in one session. | A gentle break reminder appears. | Any screen | | |

### Coaching and Send to Claude (added 2026-10-22)

The coaching card that replaced the one tip (DESIGN.md §13.5), "Last time" on the Level
screen, and the coaching file for a look in chat (docs/COACHING.md). Use a level you
cannot pass yet; Sirens & glides (05) is a good one.

| # | Steps | Expected | Where to look | Result | Notes |
|---|---|---|---|---|---|
| T1 | Miss the same level five times in a row (Retry from the report each time). | Each report's coaching card says what went wrong and where, in plain words: no ¢, Hz, dB, ms or bpm anywhere on the card. It grows with each miss: "Try this" alone at first; "Why it happens" on the 2nd miss in a row; a numbered "Step by step" and **Send to Claude** on the 3rd; "An easier way in" and **Listen again** (or **Listen slowly**) on the 5th, each with a line saying which try it is. Only the report's own action is amber. | Take report | | |
| T2 | On a report with spot chips ("0:08, near G♯3"), tap a chip, then tap it again. | The replay comes into view and an amber line marks that moment; the second tap clears it. The marked moment matches what you remember singing there. | Take report | | |
| T3 | After a miss, go back to the Level screen. Then pass the level once and open it again. | After the miss: a "Last time" card above the pass lines, with the same advice as that report, before you sing. After the pass: no "Last time" card. | Level | | |
| T4 | Level → **More** → **Send to Claude**. Close the sheet, open it again. Tap **Share**. | The sheet says what the file holds; **Include audio** is off, and is off again after reopening; it says how many takes are ready. Share opens the iOS share sheet **straight from the tap** (no second tap needed); Save to Files or OneDrive saves `pitch-lab-coach-<level>-<date>-<time>.json`. If it asks to tap Share once more, note it. | Level, share sheet | | |
| T5 | Turn **Include audio** on and Share again. Then open Settings. | The file is much bigger (it carries the sound of each kept take). Settings' privacy line names Export WAV and Send to Claude with Include audio as the two ways audio leaves the phone. | Share sheet, Settings | | |
| T6 | On the PC, after OneDrive syncs: `npm run coach -- --list`, then `npm run coach -- "<the path it printed>"`. | The file from T4 is listed first, with its full path. The read names the level, each take's verdict, where the problem is, and what changed across the takes. | Terminal | | |
| T7 | Sing eight takes of anything within twenty minutes, or miss one level six times in a row. | The coaching card adds a rest note: rest a few minutes, sip some water, stop if anything hurts, scratches or goes hoarse. It is a note, not a button. | Take report | | |
| T8 | Miss a level whose notes you sing some a little sharp and some a little flat. | The card does not tell you that you sang sharp (or flat): it says the notes landed off the middle both ways, or how much of the time you were in tune, with spots on both sides. | Take report | | |

### Decisions the builders left to the owner

Not pass/fail; say which way you want each, then it is a one-line change.

| # | Question | Where to look |
|---|---|---|
| D1 | Speaker route: reference tones are **trimmed** so the mic does not hear them, which keeps Pitch match working without headphones. Keep trimming, or drop them entirely? | Sing (Pitch match), speaker vs wired |
| D2 | Each **Retry** from the report reopens the microphone (about 0.3 s, the indicator may flicker). Keep the mic open between retries instead? | Report → Retry |
| D3 | Song-mode **metronome** and the folded click that can sit off the beat on some MIDI imports. Keep, hide, or make it an offset? | Song player → More |
| D4 | **Song pass mark** 0.7 (`SONG_PASS_SCORE`): too easy, too hard? | Song take sheet |
| D5 | Practice minutes: **calendar weeks or rolling seven days**? | Dashboard |
| D6 | Backup export is **all profiles**; add a per-profile export? | Data & backup |
| D7 | Boss naming: "Foundations Boss Recital" everywhere, with the world name under the BOSS RECITAL label on the map. | Map, Level |
| D8 | **Esc on the Sing screen is Back** and discards the take (DESIGN.md 13.4); the Live, Vibrato meter, Setup and Diagnostics screens turn the mic off when you leave. | Sing, Live |
| D9 | Level's **Sing** opens the Sing screen and a second tap starts the take: redundant, or the right moment to get ready? | Level → Sing |
