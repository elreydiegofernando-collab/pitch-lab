# Build phases

The rule is one phase at a time. A phase is done only when all of the following hold:

1. `npm run check` passes (typecheck, unit tests, production build).
2. `npm run e2e` passes (headless Chrome, fake mic fed from a synthesized WAV, production build).
3. That phase's section of docs/MANUAL-TEST-CHECKLIST.md passes on a real iPhone.
4. The owner signs off.

## Phase 1 — Platform & live pitch  *(current)*
The riskiest part (the iPhone audio path) gets proven first.
- Repo scaffold: Vite 8, TypeScript 7, Preact 11, Vitest 5. Base path `/pitch-lab/`. CI and Pages deploy workflow.
- Design system (docs/DESIGN.md) implemented as CSS tokens and base components.
- Audio engine: start and resume inside the gesture, `audioSession` set to `play-and-record`, mic constraints off, AudioWorklet capture → analysis Web Worker → frames. Handles interruption and route changes, 44.1 and 48 kHz.
- DSP: in-house FFT, McLeod (MPM) and YIN detectors with E2–C6 lag bounds, voicing gate, a hop scheduler with sample-accurate timestamps, and display-only smoothing.
- Live pitch canvas at 60 fps: piano-roll lanes, now line, target bar with tolerance band, smoothed trace.
- Reference synth (notes, glides, vibrato tone, metronome) on plain Web Audio.
- Setup: headphone guidance, Bluetooth warning, output-route choice, latency calibration (loopback / sing / tap), and an audio-session check ("did it go to the earpiece or duck?").
- Diagnostics: sample rate, latencies, applied constraints, frames/s, detector cost, render fps, storage persistence, service-worker status, and a mic record → playback check.
- PWA: manifest, icons, iOS meta tags, offline service worker with an update prompt, `storage.persist()`.
- Settings stored in IndexedDB (profile-ready key scheme).
- Tests: FFT, MPM/YIN on synthesized signals (cross-checked against pitchy), framer timing, gating, smoothing, latency math, music utilities, KV store. E2E: fake-mic pitch accuracy, frame rate, offline relaunch.

## Standing rules for every phase
- **Everything is earned** (SPEC §11.1). Any new feature registers an unlock requirement in the unlock registry. Locked items can't be opened, deep links included.
- **Never-do checklist** (attach to every design review): no difficulty picker or per-profile difficulty preset; no global or public leaderboard; no countdown-pressure timers; no hard-reset streaks; no mascots or childish game jargon; no pay-to-skip; no silent audio upload; no account wall before first use (v2).

## Phase 2 — Analyzer suite
- Pure analyzers with synthesized-signal tests: accuracy and stability, onset crispness and onset type, vibrato (rate, extent, regularity, centring, wobble/bleat/straight flags), transitions and glides with crack detection, inflections (scoop, fall, slide, turn, flip), runs (DTW, reached, accuracy, definition, timing, run score), dynamics (loudness–pitch-drift correlation), range.
- Take recorder: frames + optional audio → take-relative, latency-compensated PitchTrack.
- A developer "analyze take" screen to view analyzer output on recorded takes.
- **Real-voice test corpus:** the owner's own takes (exported WAV plus expected outputs), kept **local and private**. Never committed to the public repo; `.gitignore` covers `corpus/`. The analyzers are regression-tested against it alongside synthesized signals.

## Phase 3 — Exercise engine, progression, Foundations world
- Exercise JSON schema with validation. Auto-transpose to the saved range. Listen demo.
- Level/world progression (linear, earned) and the setlist-path world map. Includes:
  - **placement auditions**: one per world, sung, and they can only skip levels inside an unlocked world;
  - a **Boss Recital** capstone per world.
- **Unlock registry** (`src/progress/unlocks.ts`): the single gate for every feature, readout, setting, exercise and song, with router guards. Retrofit the Phase 1 surfaces: Live readouts become progressive, and the vibrato-style setting is hidden until the Vibrato world unlocks.
- **Sync-ready data model** (cheap now, painful later; enables v2 accounts):
  - client-generated UUIDs on every record;
  - a hybrid-logical-clock `updatedAt`;
  - soft deletes (`deletedAt` tombstones);
  - append-only attempt log, one row per attempt, with aggregates computed as views;
  - a `profileId` on every row;
  - a per-table **syncable-fields allowlist** (nothing audio-derived);
  - large binaries (takes, exports) in **OPFS** with a version manifest, not in IndexedDB blobs.
- Profiles (multiple local).
- Take report v1.
- Foundations world: range finder, pitch match, sustain, sirens & glides, crispness, interval jumps, legato lines.

## Phase 4 — Vibrato & Inflections worlds
- Vibrato meter, pulse builder (with metronome), oscillation drill, straight-to-bloom, on/off switching. The synthesized vibrato demo plays at the style's target zone.
- Intentional scoop, falls, slides/portamento, turns, flips.

## Phase 5 — Runs & Riffs and Dynamics worlds
- Pattern library (pentatonic and blues, 3/5/7 notes, ascending and descending). Tempo ladder auto-advances when a take passes the level's own pass rule at that tempo (SPEC §9.4). Note-by-note colored feedback. Slow-down playback next to the target.
- Messa di voce / swell.

## Phase 6 — Song mode
- MIDI and UltraStar `.txt` loading (with lyrics). Optional MP3/WAV backing track with an offset. Transpose to range.
- Piano roll with lyrics. Phrase loop, slow-down, playback, recorded takes, phrase-by-phrase scoring with latency compensation.

## Phase 7 — Coaching, progress, polish
- Progress dashboard, daily workout, **Momentum** (not a hard-reset streak), coaching-tip rules, profile export/import, WAV export, voice-health notes and break reminders. Everything shows only unlocked skills.
- Final accessibility, performance and offline pass, plus the full manual checklist on iPhone.
