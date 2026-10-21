# Research decision log (2026-10-21)

Seven parallel research passes, each followed by an adversarial fact-check against primary sources. This file keeps the decisions and the evidence that matters. "✔" = confirmed by the fact-check; "~" = partially correct, with the correction already applied below.

## 1. Pitch detection

| Decision | Evidence |
|---|---|
| **In-house FFT McLeod (MPM) + YIN; pitchy only as a test oracle** | pitchy 4.1.0 (2024-01-04) is feature-frozen; its CI can't even publish (issue #215) ✔. It has **no lag bounds**: its documented real-world glitch is ~3 kHz spikes on sibilants (issue #63) ✔, which a `maxHz` lag bound removes. It allocates per call. The published 4.1.0 tarball says MIT; the repo was relicensed to 0BSD minutes later ~. |
| Avoid pitchfinder, aubiojs, essentia.js | pitchfinder has open low-pitch YIN bugs (#26, #58) and no LICENSE file. aubio is GPL-3.0 and essentia.js is AGPL-3.0, both with stale JS releases ✔. |
| Fixed 2048-sample window, E2–C6 | ≥ 2 periods of f_min are needed; 2048 gives 3.5–3.8 periods of E2 at 48/44.1 kHz ✔. |
| MPM k = 0.9 | Literature band 0.8–1; Tartini used 0.93 ~ (the range phrasing comes from pitchy's docs). |
| MPM ≈ YIN for voice when FFT-based | sevagh/pitch-detection benchmark ✔. |
| Detection runs **inside the AudioWorklet** | It's light pure-JS DSP. Chrome's design-pattern guidance moves only *heavy or variable* work (ML) to a Worker ✔. |
| ML hook later: **SwiftF0** first | MIT, 16 kHz, 16 ms frames, 46.9–2093.75 Hz, onnxruntime-web demo exists. The README says ~14k params but the paper says ~96k: verify before adopting ~. CREPE has no official web port; PESTO is LGPL-3.0; RMVPE/FCPE are too big; SPICE (2019) is superseded. onnxruntime-web 1.30 has a WebGPU EP (Safari/iOS 26+ ship WebGPU); the WASM EP is the mandatory fallback. transformers.js WebGPU is opt-in, not default ~. |

## 2. iPhone Safari audio (iOS 27 current)

- `navigator.audioSession.type` since Safari 16.4. **Only `type` exists**: `state`/`statechange` are unimplemented (WebKit #283417) ✔.
- getUserMedia forces a play-and-record route. Open bugs: output **stuck on the earpiece** after release (#295889); playback **forced to the speaker** (#282939); AirPods drop A2DP → HFP ✔. Mitigations: `play-and-record` before gUM, `playback` after stop, a **Reset audio** escape hatch, and a manual "where did you hear it?" check.
- **echoCancellation: false** is required. EC on engages voice processing: cross-app ducking (#294623) ✔ and the iOS 27 crackle regression (#326286, filed 2026-10-04) ✔. It's an inferred mechanism, not WebKit-stated ~.
- **#281978:** EC off → voice on the **left channel only** → use `channelCount 1`, `channelInterpretation 'discrete'`.
- **#236219:** granting mic permission roughly **halves playback volume** on iOS (open since 2022).
- **#325916 (iOS 27):** capture started outside the gesture call stack dies after about 40 s → call getUserMedia synchronously in the tap.
- AudioContext creation/resume must happen synchronously in a gesture. click/touchend are confirmed; pointerup isn't ~. The `'interrupted'` state is documented on MDN; recover via `statechange` plus the next tap ~.
- Don't pass `sampleRate`. Read `ctx.sampleRate`; the rate is route-dependent ~ (the original citation was wrong; the premise holds).
- AudioWorklet since 14.5 ✔. Point-release regressions have happened (a 44.1 kHz distortion in 17.5.1; 960-frame quanta in 16.3), so accept any quantum size.
- Mic permission in home-screen apps can re-prompt on URL changes and isn't reliably kept across relaunches (#215884, RESOLVED/CONFIG CHANGED, but still reported Oct 2026) ~ → **memory router, never write the URL**.
- Standalone mode has had capture bugs of its own (#273938) ✔ → **QA in the installed app**.
- A backgrounded mic track ends after about 30 s (#204681) ✔. A ~20 s suspicion threshold triggers a reconnect.
- Ring/Silent switch: plain Web Audio is on the ringer channel. Setting audioSession covers it; a silent `<audio>` loop is the fallback when audioSession is missing ✔.
- `baseLatency` since 14.5, `outputLatency` since 18.4. **`MediaTrackSettings.latency` is never supported** on iOS ✔ → in-app calibration.
- Wake lock works in a tab since 16.4 and in installed apps since **18.4** (#254545) ✔. The visibilitychange re-acquire fix was earlier (#255363, 2023) ~.
- `permissions.query({name:'microphone'})` isn't available on Safari, so infer permission state from getUserMedia.
- Dev on a phone needs HTTPS (secure context) → `npm run dev:host` (self-signed).
- #204467 (2019, NEW): reports of wrong FFT results on raw audio in PWAs → Diagnostics **pitch self-test** on the real device.

## 3. Chrome/Edge on Windows

- EC/NS/AGC `false` is honoured (long-stable) ✔. `voiceIsolation` and EC mode strings are irrelevant here.
- **OS-level processing sits below the browser.** Realtek/Dolby/Waves APOs (SFX/MFX/EFX), Windows 11 24H2 Deep Noise Suppression, and Studio Effects Voice Focus (Copilot+) can't be detected or disabled from the web ~. Whether Chrome requests the Windows "Raw" capture mode is unconfirmed. → Show a Setup guide plus Diagnostics mic check (record → playback).
- **Bluetooth headsets switch to HFP** (mono, 8–16 kHz) when the mic opens ✔ → recommend wired, and offer a mic picker.
- Render quantum is 128 (`renderSizeHint` not shipped) ✔. Autoplay: resume in a gesture ✔. Edge behaves the same as Chrome. `setSinkId` is available since Chrome 110 (a later nice-to-have).

## 4. Tooling, PWA, Pages

- Vite 8 = Rolldown; `worker.rolldownOptions` replaces `worker.rollupOptions` ✔. `worker.format` defaults to `'iife'` ✔. Worklet via `?worker&url` ✔. Fallback if production misbehaves: a prebuilt JS file in `public/` (an unconfirmed forum suggestion) ~.
- Vitest 5 needs Node ≥ 22.12, so CI uses Node 24 ✔. Preact 11.0.1 is stable `latest` ✔. TS 7.0 is the native compiler.
- Actions (Releases pages, 2026-10-21): checkout **v7**, setup-node **v7**, configure-pages **v6**, upload-pages-artifact **v5**, deploy-pages **v5** ✔. Permissions: `pages: write`, `id-token: write` ✔.
- No custom headers on Pages ✔ → no COOP/COEP → no SharedArrayBuffer (not needed). Safari has **not** shipped COEP credentialless (#230550) ~.
- Manifest `id`/`start_url`/`scope` = `/pitch-lab/`. The Apple meta tags (from a 2016-archived doc) are still the only documented ones; ship them plus `mobile-web-app-capable` ~.
- `viewport-fit=cover` is needed for safe-area insets ~. `storage.persist` since 15.2, `estimate` since 17 ✔. Home-screen apps are exempt from the 7-day cap ✔. Keep the precache small (the 50 MiB figure is unverified) ~.

## 5. Canvas & UX

- Target 60 fps. Safari defaults to ~60 even on ProMotion ✔. Low Power Mode caps rAF at 30 ✔. There's no battery API in Safari ~.
- Static and dynamic layers, DPR ≤ 2, no shadowBlur/filter, batching ✔. The iOS canvas cap is **4096 px**. Use `{alpha:false}` and never `willReadFrequently`.
- Repaint on resize and visualViewport changes (rotation blanking) ~. OffscreenCanvas-in-worker still has open WebKit bugs (Sep 2026) → main-thread canvas.
- Display smoothing is median-of-3 → One Euro, with the cutoff kept above vibrato rates. Analyzers get raw frames.
- UX convention: scrolling piano roll, target bars, live line. Encoding is **blue/orange + position + text**, never red/green alone ✔.
- Latency reality: the 2048 window alone is ~43–46 ms, so window-centre timing means ~21 ms of algorithmic delay before messaging and display. Diagnostics measures end to end. An adaptive shorter window for higher notes is the lever if needed.

## 6. Singing science → `src/config.ts`

- **Vibrato:** rate is style-invariant, about 5.5–6.5 Hz (Prame) ✔. Extent separates styles: MT ~63¢ and opera ~78¢ half-extent (JoV 2025). The ~27¢ peak-to-peak straight-tone threshold (≈ ±13.5) is weakly sourced ~. Natural rate rises ~15% across long tones. The detrend window is 0.6–0.8 s. The "1.28 cycles" claim couldn't be verified, so we require ≥ 2 cycles and ≥ 300 ms ~.
- **Accuracy:** a **±25¢** tolerance matches the measured melodic mistuning threshold (Larrouy-Maestri 2018) ✔. Trained singers deviate 30–42¢ on melodies, so ±10 is an *elite* bar. Report signed bias and dispersion separately.
- **Onset:** VRT bands < 60 ms hard, > 160 ms breathy (from the Koike tradition; the attribution in the cited paper is weak) ~. Automated onset measures correlate weakly with listener ratings (JoV 2024), so label the result an *estimate*. Settle-time tiers 400/250/150 ms are **provisional**.
- **Transitions:** < 20 ms is heard as a clean step. Rising transition time grows with interval size, falling stays flat. No absolute norm exists → use tempo-relative budgets.
- **Inflections:** scoop, fall, slide, turn and flip have distinct f0/RMS shapes. "Intentional vs error" can't be certified automatically; use location, repeat consistency or user intent (the exercise says what to do). Cry/sob is out of scope (timbral).
- **Runs:** the notes/s ladder 3 / 4.5 / 6 / 9 / 12 isn't peer-reviewed. The 1-semitone plateau split rule comes from instrumental work ~. Fast runs need short-window segmentation, separate from the vibrato window.
- **Dynamics:** RMS is **relative only**. Score the slope of cents vs dB (target ≈ 0) and the envelope shape (messa di voce is often asymmetric).
- **Ranges:** tenor C3–C5 (passaggi ~C♯4–E4 / G4); baritone G2/A2–G4/A4 (~B♭3–B3 / E♭4–E4); untrained male comfortable ~C3–E4, so beginner exercises centre around F3–G3.

## 7. Song mode & latency (Phase 6 inputs)

- **UltraStar `.txt` is the native format.** Phrase breaks (`-`), pitch (0 = C4), syllables, golden/freestyle/rap notes and `#BPM`/`#GAP` are all in the file ✔ (spec v1.1.0).
- MIDI via `@tonejs/midi` (dormant since May 2023 but API-complete) ~. Lyrics come from lyric/marker meta events on any track and from text events on track 0 only. Melody-track pick: composite score plus a manual override.
- No Tone.js (~77 KB gzip) ✔; plain Web Audio. Salamander piano V3 is **CC-BY 3.0** (not public domain) ~, so credit it if sampled.
- Scoring is octave-agnostic by default, with a transpose control. The "2.5 semitone" patent figure doesn't exist ~. Use a banded DTW (±150–250 ms) after latency removal.
- **Latency:** compensate the full round trip (out + in) as one scalar ✔. Acoustic loopback is primary. Note that MathWorks' "loopback" means cable loopback; ours is through the air, which is fine for our purpose ~. Sing-"ta" is secondary and tap is a quick approximation. **Recalibrate on route change.** AirPods Pro 2 ≈ 126 ms; 1st-gen Pro ≈ 153 ms; original AirPods ≈ 296 ms (2022 data; AirPods Pro 3 unmeasured) ~.
