# Architecture

Read with docs/SPEC.md (what), docs/DESIGN.md (look and feel) and docs/RESEARCH.md (why).

## Threads & data flow

```
            user tap (gesture)
                 │  engine.start()  — synchronous prefix: new AudioContext(), ctx.resume(),
                 │                    audioSession.type='play-and-record', getUserMedia(...) call
                 ▼
 mic ─► MediaStreamAudioSourceNode ─► AudioWorkletNode "pitchlab-capture" ─► GainNode(0) ─► destination
                                        │  (ring buffer → every hop: detector → PitchFrame)
                                        │  node.port.postMessage({type:'frame', frame})
                                        ▼
                                   main thread: AudioEngine ── onFrame ──► PitchView (canvas, rAF)
                                        │                    └──────────► readouts (rAF-throttled DOM writes)
                                        │                    └──────────► take recorder / analyzers (Phase 2+)
 ReferenceSynth (oscillators, samples, metronome) ─► engine.output (→ destination)
```

- **Detection runs inside the AudioWorklet.** An FFT-based McLeod pass on 2048 samples costs well under 1 ms. A separate Worker would add MessageChannel complexity and latency for nothing, and two independent research passes agreed. All DSP lives in **pure modules** (`src/dsp/*`, `src/audio/framer.ts`) that know nothing about worklet globals, so a future ML detector can run the same framer in a Worker.
- The worklet output feeds a **zero-gain node into the destination** so every engine pulls it (WebKit doesn't process disconnected nodes). The mic is **never** routed audibly (no monitoring, no feedback).
- **Timebase:** `PitchFrame.t` is the AudioContext time of the analysis window's centre, computed from the worklet's `currentFrame` (sample-accurate). Reference audio is scheduled on the same clock, so sing-along scoring only needs one scalar: `takeTime = frame.t − roundTripLatency − downbeatTime`.
- **Steady state allocates nothing** on the audio thread except the small posted frame object. The ring buffer, FFT buffers and detector buffers are preallocated at init. The worklet accepts **any render-quantum size**; it doesn't assume 128.

## Start-audio recipe (iOS Safari first; also correct for Chrome/Edge)

`engine.start()` / `engine.reset()` / `engine.ensureContext()` are called **synchronously from a click/touchend handler**. Before the first `await` they must:
1. If `navigator.audioSession` exists, set `type = 'play-and-record'` (or `'playback'` for `ensureContext()` without the mic).
2. `new AudioContext({ latencyHint: 'interactive' })`. **Never pass `sampleRate`**; read `ctx.sampleRate` afterwards. Then call `ctx.resume()` without awaiting yet.
3. If iOS and `navigator.audioSession` is missing (iOS < 16.4), start a looping near-silent `<audio>` element. That moves Web Audio off the ringer channel so the Ring/Silent switch can't mute it.
4. **Call** `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 }, video:false })` and keep the promise. Calling inside the gesture matters on iOS 27 (WebKit #325916: capture started outside the gesture dies after about 40 s).

Then, after the awaits:

5. Read `track.getSettings()` and record what was *actually* applied (Diagnostics shows it).
6. `await ctx.audioWorklet.addModule(workletUrl)` (from `import workletUrl from './capture.worklet.ts?worker&url'`). Create the node, `connect(source → node → zeroGain → destination)`, and send `init` with `hopSize = hopSizeFor(ctx.sampleRate)`.
7. Run the detector micro-benchmark on the main thread (`CONFIG.engine.benchmarkIterations`) for Diagnostics.
8. Request a screen wake lock (feature-detected, try/catch). Re-request on `visibilitychange`.

Recovery:
- `ctx.onstatechange`: on `'interrupted'` or `'suspended'`, try `resume()`. If still not running, set state `'interrupted'` and re-arm on the **next tap anywhere** (one capturing `pointerup`/`click` listener).
- Mic track `ended`/`mute` → `'interrupted'`. On `visibilitychange` back to visible after ≥ `backgroundSuspectSec`, check `track.readyState` and the context state, and if either is dead, show "Tap to reconnect mic".
- `navigator.mediaDevices.ondevicechange` (debounced `deviceChangeDebounceMs`) while running → full rebuild on the next tap (the route's sample rate may have changed). Calibration for the new route is offered again.
- `reset()` is the **"Reset audio"** escape hatch. It closes everything (tracks, nodes, `ctx.close()`) and starts fresh, for iOS output stuck on the earpiece or forced to the speaker (open WebKit bugs #295889, #282939).
- `stop()` stops all tracks, disconnects nodes, then sets `audioSession.type = 'playback'` so later playback-only screens route normally.

## Routing (UI)

**Memory router: the URL never changes after load.** On iOS home-screen apps, a URL or hash change while the mic is open can re-trigger the permission prompt (WebKit #215884). The initial hash is read **once** at boot (deep links / e2e: `#/live`, `#/diagnostics`, …) and never written. Back is an in-app button plus `Esc`.

## Performance rules (hot paths)

- **No allocation per audio frame or per animation frame** in the worklet, the framer, the PitchView render loop, or the display smoother. Use preallocated typed-array ring buffers.
- **Readouts** (note name, cents, Hz, dB) update through rAF-throttled direct `textContent` writes on refs, **not** Preact state at 94 Hz.
- **Canvas:** static grid layer (redrawn only on resize or range change) plus dynamic layer. DPR capped at 2. No `shadowBlur`/`filter`. Text only on the static layer. Batch same-colour runs into one path. Repaint after `resize` and `visualViewport` resize (iOS can blank a canvas on rotation). Measure the rAF interval and adapt (Low Power Mode = 30 fps).
- Stop the rAF loop when the page is hidden.

## Module map & Phase 1 ownership

Contract files (owned by the orchestrator; build agents must **not** edit them, and report needed changes instead): `src/core/types.ts`, `src/core/music.ts`, `src/config.ts`, `src/dsp/detector-types.ts`, `src/audio/protocol.ts`, `src/audio/engine-types.ts`, `src/audio/synth-types.ts`, `src/audio/latency-types.ts`, `src/ui/pitch-view/types.ts`, `src/storage/kv-types.ts`, `src/state/settings-types.ts`, `package.json`, `tsconfig*.json`, `docs/SPEC.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/PHASES.md`.

| Agent | Owns (creates/edits only these) |
|---|---|
| **dsp** | `src/dsp/fft.ts`, `src/dsp/mpm.ts`, `src/dsp/yin.ts`, `src/dsp/detector.ts` (`createDetector`), `src/dsp/rms.ts`, `src/dsp/test-signals.ts` (synthesized test signals shared by all later tests), `src/dsp/*.test.ts`, `docs/ML-HOOK.md` |
| **pipeline** | `src/audio/framer.ts` (pure: ring buffer, hop scheduling, timestamps, gating → PitchFrame), `src/audio/transients.ts` (pure), `src/audio/capture.worklet.ts`, `src/audio/*.test.ts` for those |
| **engine** | `src/audio/engine.ts` (`getEngine()`), `src/audio/platform.ts` (isIOS, isStandalone, audioSession helpers, wake lock, Bluetooth-label heuristic, silent-audio unlock), `src/audio/recorder.ts` (assembles `record-chunk`s into a Recording), tests for the pure parts |
| **synth** | `src/audio/synth.ts` (`createSynth(ctx, destination)`), `src/audio/latency.ts` (`startCalibration`), `src/audio/latency-math.ts` (pure `estimateOffset`), tests |
| **view** | `src/ui/pitch-view/*` except `types.ts`: `pitch-view.ts` (`createPitchView`), `smoother.ts`, `track-ring.ts`, `geometry.ts`, `PitchViewHost.tsx` (Preact wrapper), tests |
| **pwa** | `index.html`, `vite.config.ts`, `public/**`, `scripts/make-icons.mjs`, `src/pwa/*` (SW registration and update prompt, `storage.persist()`), `src/storage/kv.ts` (`openKV`), `.github/workflows/*`, tests for kv |
| **ui** | `src/main.tsx`, `src/app.tsx`, `src/router.ts`, `src/styles/*`, `src/ui/components/*`, `src/ui/screens/*`, `src/state/*` (except `settings-types.ts`) |
| **qa** | `e2e/**`, `vitest.e2e.config.ts`, `docs/MANUAL-TEST-CHECKLIST.md`, `README.md` |

Cross-module imports go only through the contract types plus each module's documented factory:
- `createDetector(kind, opts)` from `src/dsp/detector.ts`
- `Framer` from `src/audio/framer.ts`
- `getEngine()` from `src/audio/engine.ts`
- `createSynth()` from `src/audio/synth.ts`
- `startCalibration()` from `src/audio/latency.ts`
- `createPitchView()` and `<PitchViewHost>` from `src/ui/pitch-view/`
- `openKV()` from `src/storage/kv.ts`
- `registerServiceWorker()` and `requestPersistentStorage()` from `src/pwa/`

## Testing

- Unit tests: Vitest, `environment: 'node'` by default. Preact component tests opt into happy-dom per file with `// @vitest-environment happy-dom`.
- Signals: synthesized in `src/dsp/test-signals.ts` (sine, harmonic-rich voice-like tones, vibrato, glides, cracks, noise, silence) at 44.1 and 48 kHz.
- E2E (`npm run e2e`): build, `vite preview`, then the installed Chrome launched by playwright-core with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<synth.wav>`. It asserts the detected pitch, frame rate, and offline relaunch.
- E2E, Wave 1 engines (`e2e/wave1-browser.e2e.test.ts`): nothing in the app imports the Wave 1 engines until the Wave 2 runner exists, so the production build cannot reach them. This test bundles them with Vite into `e2e/.artifacts/wave1/`, serves the bundle to the installed Chrome and runs `e2e/browser/wave1-checks.js` in the page: storage on real IndexedDB and OPFS (relaunch, delete, wipe, backup round trip) and every exercise's Listen demo built with the real synth into a real `OfflineAudioContext`, read back through the production framer and detector. The Node unit tests use fake-indexeddb, a fake OPFS and a hand-rolled Web Audio evaluator, so this is the check against the real APIs. Once the runner exists, drive the real UI instead and keep this as the engine-level guard.
- Manual: docs/MANUAL-TEST-CHECKLIST.md on a real iPhone, **as an installed home-screen app** (standalone mode has its own bugs).

## Phases 2–7 module map

The owner waived per-phase sign-off on 2026-10-21; the end-to-end test happens at the end.

Contract files owned by the orchestrator (read-only for builders):
- `src/analysis/types.ts`
- `src/analysis/fixtures.ts`
- `src/exercises/types.ts`
- `src/progress/types.ts`
- `src/song/types.ts`
- `src/storage/schema.ts`

### Wave 1: engines (pure, tested)
| Agent | Owns |
|---|---|
| analysis-core | `src/analysis/{track,accuracy,onset,vibrato,pulse,switch,range,dynamics,score}.ts` + tests |
| analysis-advanced | `src/analysis/{transitions,glide,cracks,inflections,runs,dtw,segment,phrases}.ts` + tests |
| exercises | `src/exercises/**` except `types.ts`: catalog for every world, auditions, bosses, transpose, validation, coaching tips |
| progress | `src/progress/**` except `types.ts`: unlock registry, engine, auditions, mastery, momentum, records, workout builder, weakness |
| storage | `src/storage/**` except `schema.ts`, `kv*`: IndexedDB stores, HLC, OPFS binaries, repos, migration, backup export/import |
| song | `src/song/**` except `types.ts`, plus `public/songs/**`: UltraStar and MIDI import, transpose/fold, phrases, difficulty, bundled public-domain charts |
| dsp-ext | `src/dsp/wsola.ts`, `src/audio/{demos,take-recorder,wav}.ts` + tests |

### Wave 2: experience (UI and runtime)
Exercise runner, world map, take report, per-world views, song mode, dashboard, workout, profiles, export, auditions and recitals.

### Wave 3: integration, review, e2e, deploy

## Wave 1 integration: how one sung take flows (2026-10-21)

The Wave 1 engines are pure and tested alone; `src/integration/wave1.test.ts` proves them together with no UI and is the
reference for the Wave 2 runner. One take, in order:

| Step | Call | Where |
|---|---|---|
| Place the material | `realize(def, profile.range, profile.voiceType, { bpm })` | `src/exercises/transpose.ts` |
| Listen demo | `buildDemo(def, realized, synth, ctx, dest, opts)` | `src/audio/demos.ts` |
| Record | `new TakeRecorder(engine, { downbeat, latency })` ... `await rec.stop()` | `src/audio/take-recorder.ts` |
| Analyze | `analyzeTake(def, realized, take.track, { vibratoStyle })` | `src/exercises/analyze.ts` (runs the real analyzers, `metricsFromResults` aggregates) |
| Judge | `evaluate(def, a.metrics, a)`, `pickTip(a.metrics, def, a.tipContext)` (pass the whole analysis `a`: a take whose realization folded notes by octaves, or dropped a figure, is refused, `Evaluation.passed` false with `notJudged: 'folded'`, and the tip is `general.unfit-range`) | `src/exercises/evaluate.ts` (= `scoreExercise`), `tips.ts` |
| Write the attempt | `buildAttempt({ profileId, def, source, realized, evaluation, metrics, takeId })` then `storage.attempts.add(fields)` | `src/progress/attempt.ts`, `src/storage` |
| Progress | `computeSnapshot(profileId, WORLDS, await storage.attempts.listByProfile(id), now, { getExercise: withRoutines(getExercise), utcOffsetMinutes })` after EVERY new attempt | `src/progress/engine.ts` |

Rules that keep the log honest (each is enforced in code, not left to the UI):
- **Attempt conventions live in `buildAttempt`**: practice rep = kind `practice` + levelId; Boss Recital = `boss`; workout level = `workout` + levelId; warm-up/cool-down = `workout` with levelId null; audition = `audition` + the audition exercise id, levelId null; song = `buildSongAttempt` (`song`, songId, `song.<id>` exercise id). `passed` is the evaluation's AND, for a Runs ladder, "sung at the pass tempo" (`canPassAtTempo`): the lower rungs are practice. The engine applies the same rule again when given `getExercise`, so a runner that forgets still cannot pass a level on a lower rung. A Runs ladder climbs with `nextTempo(def, bpm, a.metrics, a)` (`src/exercises/ladder.ts`): one rung up only when the take PASSES the level's own pass rule at that rung, not at a fixed run.score (a fixed 85% trapped every studio ladder and advanced smeared takes; `CONFIG.runs.tempoAdvanceScore` now only triggers the run.score coaching tip).
- **Auditions are sung in order, stopping at the first miss, and the registry enforces it.** `nextAuditionExercise(worldId, snapshot, WORLDS)` names the one test to sing next; `isExerciseOpenable` opens only that test (a deep link to a later one is refused, a failed test stays open for a retake, a passed one closes); the runner stops after a miss. Each test grants only its own slice of levels (`auditionSpans`: past what the earlier tests reach, up to its `unlockThrough`, never a Boss Recital), and a grant counts once every earlier level is passed, so a later test alone grants nothing. The Range finder is always sung: the Foundations audition is withheld until it is (`auditionRequirementHint` gives the line to show), and no audition ever passes it, because every exercise transposes to the saved range.
- **Gate everything through `src/progress`**: `isLevelOpenable`, `isExerciseOpenable` (levels, auditions, routines, deep links), `isFeatureUnlocked`, `isSongUnlocked(song.difficulty.requiredWorld, ...)`, `isRecordAttemptAllowed`. Unknown ids are locked.
- **One track codec**: `src/storage/track-codec.ts` (`encodeTrack`/`decodeTrack`), re-exported by `take-recorder.ts`. It resamples a track with dropped frames onto the frame grid (time is never compressed) and decoding damaged data returns `[]`, never throws.
- **One storage entry point**: `await getStorage()` from `src/storage` once at boot (never `openDb()` twice in a page). Recompute progress from the stored log; do not patch a cached snapshot.
- **Song mode scores `pitchedView(song)`** (freestyle and rap notes removed, phrases re-indexed) with `scoreSongTake(rawFrames, songStartT, latencyMs, ...)`, after `transposeSongToRange(song, profile.range)`. Shift songs only with `transposeSong`.
- `src/core/math.ts` holds the shared `clamp`/`clamp01`; `src/analysis/track.ts` holds the shared window, median, spacing and fit helpers (`segment.ts` keeps only the voiced contour and plateau segmentation).

Wave 2 must-dos found while integrating:
- Phase 1's `src/state/settings.ts` still reads `profile:default:settings`; the first `getStorage()` runs `migrateFromV1`, which MOVES that key to `profile:<id>:settings` (`profileSettingsKey`). Switch settings.ts to the active profile's key in the same change that first calls `getStorage()`, or saved settings will look reset. In that change also (a) validate on READ: `{ ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) }`, with `sanitizeSettings` imported from `src/storage`, because a raw merge of an out-of-set `vibratoStyle` crashes `Settings.tsx` and `analysis/vibrato.ts` (`CONFIG.vibrato.styles[style]` is undefined); and (b) when `storage.db.persistent` is false, do not write profile-keyed settings: the active profile id is then a throwaway that vanishes with the page, and `migrateFromV1` leaves `profile:default:settings` in place until a durable launch moves it, so keys written under the ghost id would be orphaned.
- Show a non-dismissable warning when `storage.persistent` is false.
- Call `storage.reconcile()` once per launch, off the critical path (fire and forget after the first screen), and show `report.skipped` (`db-not-durable` | `binaries-not-durable` | `backend-changed`) in Diagnostics, with `usage().binaryBackend`. It deliberately does nothing on a degraded launch, so it can never delete anything it cannot see. A switch of binary backend between launches (OPFS to IndexedDB or back) is handled transparently: `usage().binaryBytes` and `storage.opfs` cover both.
- `takes.delete`, `songs.delete`, `profiles.delete({ removeRecordings })` and `deleteAllData()` REJECT when a file will not delete (the record is kept; `deleteAllData` clears the rest first). Show the error, never a false "deleted". `takes.save({ id })` rejects with "already being saved" on an overlapping double tap: disable the Save control while a save runs.
- The runner calls `evaluate(def, a.metrics, a)` and `pickTip(a.metrics, def, a.tipContext)` with the whole analysis (see the Judge row), and `nextTempo(def, bpm, a.metrics, a)` for a ladder. It saves the profile range ONLY from a PASSED Range finder take: the finder's `range.spanSemitones >= 12` gate equals the widest material in the catalog (`validate.ts` enforces material <= that gate and that the guide bars reach it), so nothing folds for a range saved that way. `buildAttempt` is the second line of defence: pass it the `RealizedExercise` and it writes `passed = false` for a `fit` of `'folded'` even when the evaluation was made without the analysis.
- Auditions: sing `nextAuditionExercise(worldId, snapshot, WORLDS)` (null until the Foundations Range finder is sung), recompute the snapshot after each test, and stop at the first miss. Show `auditionRequirementHint(worldId, snapshot, WORLDS)` on a locked audition tile and `auditionSpans(audition, orderedLevels)` for "unlocks X to Y" captions.
- Song difficulty: show `DifficultyReason.detail` ("a 16-note melisma near 0:05") rather than switching exhaustively on `DifficultyReason.code`; `'long-melisma'` is a code in world `runs`. Imported MIDI phrases no longer need a rest between them (legato hymns are cut at lyric clauses and at a 10 s cap, so adjacent phrases can touch end to start, and every clause or cap phrase starts on a syllable-bearing note).
- Pass `opts.gain = settings.referenceVolume` to `buildDemo` (its custom voices bypass the synth's master volume).
- Device checks to add to the manual checklist when the UI exists: sing, force-quit right after the report, relaunch (attempt present, progress intact, saved take replays); real-voice corpus regression for every PROVISIONAL threshold. They live in `src/config.ts` (comments say PROVISIONAL) or in named local constants at the top of the analyzer that uses them (each with a PROVISIONAL comment). The first ones to check on real voices: `CONFIG.transitions.vibratoMisfit*` (how irregular a real vibrato may be before its stalls on a siren count as stairs), `CONFIG.runs.definition*` (the smeared/defined verdict at 3-12 notes/s), `CONFIG.accuracy.lateStartAllowanceSec` (against real beginners' reaction time), `CONFIG.range.*`, `CONFIG.dynamics.endDownShare`/`minShapeScore`, and the vibrato zone edges (a 5.0 or 7.0 Hz vibrato measures 4.99 or 7.01, and 8 c of jitter inflates a small extent, so `vibrato.inZone` can flip at an edge; the catalog's gates sit half way up the inZone band, or a quarter of the way on bloom and switching, so a flip alone never decides a pass).
- `npm run e2e` builds with `NODE_ENV=production` (e2e/preview-server.ts); under vitest's inherited `NODE_ENV=test` the build ships Preact's debug code and is a different app from the one that deploys.
- `.gitattributes` pins `public/songs/**` to LF: the bundled charts are hashed, snapshotted and served byte-exact, and a Windows checkout with `core.autocrlf=true` would otherwise rewrite them to CRLF and fail `src/song/bundled.test.ts`.
