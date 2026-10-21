# Manual Test Checklist — Phase 1

Run this on a **real iPhone**, in the **installed home-screen app** (Share → Add to
Home Screen → open from the Home Screen icon), not in a Safari tab. Standalone
mode has its own WebKit bugs (see docs/ARCHITECTURE.md's start-audio recipe and
recovery rules) that a browser tab will not reproduce. Sections N–O additionally
cover Windows Chrome and Edge.

Each phase's section of this checklist must pass, on a real device, before that
phase is signed off (docs/PHASES.md).

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

## Phase 2 — Analyzer suite

*(No items yet — fill in when Phase 2 ships: onset crispness, vibrato analyzer, transitions/crack detection, runs/DTW, dynamics, range, on a real iPhone against sung takes.)*

## Phase 3 — Exercise engine, progression, Foundations world

*(No items yet — fill in when Phase 3 ships: exercise JSON playback, level/world unlock flow, profile switching, take report, Foundations world exercises end-to-end on a real iPhone.)*

## Phase 4 — Vibrato & Inflections worlds

*(No items yet — fill in when Phase 4 ships: vibrato meter/pulse builder/oscillation drill/straight-to-bloom/on-off switching, scoop/falls/slides/turns/flips, on a real iPhone.)*

## Phase 5 — Runs & Riffs and Dynamics worlds

*(No items yet — fill in when Phase 5 ships: pattern library and tempo ladder, note-by-note colored feedback, slow-down playback, messa di voce/swell, on a real iPhone.)*

## Phase 6 — Song mode

*(No items yet — fill in when Phase 6 ships: MIDI/UltraStar loading, backing-track offset, piano roll with lyrics, phrase loop/slow-down/record, phrase scoring, on a real iPhone.)*

## Phase 7 — Coaching, progress, polish

*(No items yet — fill in when Phase 7 ships: progress dashboard, daily workout, coaching tips, profile export/import, WAV export, voice-health/break reminders, full accessibility/performance/offline pass, on a real iPhone.)*
