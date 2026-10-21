# ML pitch detector hook

How to add a CREPE-style ML detector later, without touching the Phase 1
audio path. Nothing in v1 implements this; `src/dsp/detector-types.ts`
already declares the interface it hooks into (`AsyncPitchDetector`) so the
engine side has a stable contract to build against whenever this lands.

## Why not now

`createDetector()` (`src/dsp/detector.ts`) returns a synchronous
`PitchDetector`, run inline inside the AudioWorklet, because an FFT-based
MPM pass on a 2048-sample window costs well under 1 ms (see the `detect()`
benchmarks in `src/dsp/*.test.ts`) - there's no latency or CPU budget left
to justify a model. A learned detector earns its place later specifically
for what MPM/YIN structurally can't do: resolving breathy or very quiet
onsets, and disambiguating a weak/missing fundamental from genuine noise
with more confidence than periodicity alone provides. That's a Phase 2+
decision, not a Phase 1 one.

## Candidate: SwiftF0

**Recommended starting point:** [SwiftF0](https://github.com/lars76/swift-f0)
(MIT license). Releases through v0.3.0 (Sep 2026). Runs at 16 kHz input,
16 ms frames, and reports a range of 46.9-2093.75 Hz - wider on both ends
than this app's E2-C6 (82.4-1046.5 Hz) requirement, with headroom to spare.
There's a browser demo using `onnxruntime-web` at
[swift-f0.github.io](https://swift-f0.github.io), so the ONNX-in-browser
path is already proven for this model specifically, not just in theory.

**Verify before adopting:** SwiftF0's README states ~14k parameters, but
its paper (Aug 2025) states ~96k. That's close to a 7x discrepancy, not
rounding - re-check the actual exported ONNX graph's parameter count and
file size directly (`onnx` opset + `onnxruntime-web`'s own model
inspection) before sizing the download/cache budget or quoting a number in
product copy. Don't trust either document's number blind.

**Alternatives ruled out for now:**
- **CREPE** has no official web port. A community ONNX/TF.js conversion
  would need the same verification pass (architecture, parameter count,
  licensing of the specific converted artifact) before it's a real option.
- **PESTO** is LGPL-3.0. That's copyleft on the library itself (weak
  copyleft - it permits dynamic linking/separate-work use without forcing
  the host app's license, unlike GPL), but it still obligates making PESTO's
  own source/modifications available and carries more legal review than
  SwiftF0's permissive MIT. Re-evaluate only if SwiftF0 turns out unusable.

Re-run this comparison before implementing, since the ML pitch-model space
moves fast; this is a snapshot as of the Oct 2026 research pass, not a
permanent recommendation.

## Integration plan

### 1. Where it runs

**In a Worker, never inside the AudioWorklet.** The worklet thread is
real-time-constrained and must stay allocation-free and synchronous
(docs/ARCHITECTURE.md's performance rules); `onnxruntime-web` inference is
neither. The worklet instead forwards raw audio frames to a dedicated
Worker over a `MessageChannel` (the worklet already posts frames to the
main thread over `node.port`; a second port, transferred once at setup,
carries the raw samples the ML path needs - the existing synchronous
MPM/YIN path is completely unaffected and keeps running in the worklet as
today's primary detector).

### 2. The interface

`AsyncPitchDetector` (`src/dsp/detector-types.ts`) is the contract:

```ts
export interface AsyncPitchDetector {
  readonly kind: 'ml';
  readonly modelSampleRate: number; // 16000 for SwiftF0
  readonly windowSize: number; // samples at modelSampleRate (16 ms @ 16kHz = 256)
  readonly latencySec: number; // resample + batch + inference time
  init(): Promise<void>;
  detectBatch(windows: readonly Float32Array[], out: DetectResult[]): Promise<void>;
  dispose(): void;
}
```

A future `src/audio/ml-worker.ts` (owned by whichever module ends up
responsible for it - likely `pipeline` or a new `ml` module, not `dsp`,
since it is audio-engine plumbing, not a pure detector) wraps the model
behind this shape and runs entirely inside the Worker; `dsp` keeps owning
only the pure algorithms (`fft.ts`, `mpm.ts`, `yin.ts`, `detector.ts`),
exactly as today.

### 3. Resampling

Mic audio arrives at 44.1 or 48 kHz; SwiftF0 wants 16 kHz. Use a proper
band-limited resampler - **windowed-sinc or polyphase**, not linear
interpolation or naive decimation, both of which alias energy above the
new Nyquist (8 kHz) back down into the band the model actually listens to.
Do the resampling in the Worker (not the worklet), since it's not a
hot-path operation at the audio thread's budget once it's off that thread.

### 4. Batching and latency

Accumulate resampled audio into the model's 16 ms frames and run inference
in batches rather than one frame at a time - fixed per-call overhead in
`onnxruntime-web` (session run setup, WASM/WebGPU dispatch) makes batching
meaningfully cheaper per frame than calling once per 16 ms tick.

Batching and inference both add delay on top of the synchronous path's
near-zero latency. **Report it**: `latencySec` must reflect resampling +
batching + inference time end to end, measured on-device (not a published
benchmark number), so analyzers can subtract it from `PitchFrame.t` the
same way `LatencyCalibration`'s offset already gets subtracted for
song-mode scoring (docs/ARCHITECTURE.md's timebase section) - an ML track
that doesn't declare its own latency would silently desync from the
synchronous MPM/YIN track it's meant to complement or replace.

### 5. Execution provider

- **WASM EP: mandatory.** Works everywhere this app runs (the Safari/iOS
  target above all), so it's the baseline that must always succeed.
- **WebGPU EP: opportunistic.** Available on Safari/iOS 26+; feature-detect
  and prefer it when present for lower latency and CPU cost, but never
  require it - the WASM path is the one every device must fall back to.

### 6. Caching

**Runtime-cache the model; never precache it.** The model file (even at
the smaller end of the parameter-count discrepancy above) is large enough
that it should not be part of the PWA's install-time precache - that would
block or bloat the initial offline-install payload (`src/pwa/*`,
`vite-plugin-pwa`) for every user, including the vast majority who never
touch the ML detector. Fetch and cache it (a `CacheStorage` entry keyed by
model version, via a `runtimeCaching` route) only the first time the
feature is actually used, same as any other optional, heavy asset.

## What ships through the contract, and what doesn't

Nothing above requires touching `src/dsp/detector-types.ts`,
`src/config.ts` or any other contract file to *plan* this - the
`AsyncPitchDetector` shape already anticipated it. Adding it for real will
need: a config section for the ML detector (model URL/version, batch size,
EP preference), a `DetectorKind` or a parallel "which track is primary"
switch in state, and a decision on whether it runs alongside MPM/YIN as a
second opinion or replaces them as the primary track - all product
decisions for whoever picks this up, not implementation details this
module can preempt.
