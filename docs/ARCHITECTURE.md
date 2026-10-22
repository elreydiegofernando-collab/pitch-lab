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
