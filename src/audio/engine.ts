/**
 * The audio engine: a lazily created singleton (`getEngine()`) that owns the
 * AudioContext, the mic graph and the capture worklet, and implements the
 * `AudioEngine` contract (./engine-types.ts).
 *
 *   mic ─► MediaStreamAudioSourceNode ─► AudioWorkletNode ─► GainNode(0) ─► destination
 *                                              │ port
 *                                              ▼
 *                                   handleWorkletMessage (frames, stats, transients, recording)
 *
 * `start()`, `resume()`, `reset()` and `ensureContext()` all follow the
 * start-audio recipe in docs/ARCHITECTURE.md: every gesture-sensitive call
 * (`new AudioContext`, `ctx.resume()`, `navigator.audioSession`,
 * `getUserMedia`) happens synchronously, before the method's first `await`,
 * so iOS Safari still considers the call to be inside the user gesture.
 */
import type { PitchFrame } from '../core/types';
import type { DetectorKind } from '../dsp/detector-types';
import { benchmarkDetector, createDetector } from '../dsp/detector';
import { CONFIG, hopSizeFor } from '../config';
import type {
  AudioEngine,
  EngineError,
  EngineErrorCode,
  EngineInfo,
  EngineState,
  EngineStats,
  Recording,
  Unsubscribe,
} from './engine-types';
import type { MainToWorklet, WorkletToMain } from './protocol';
import { WORKLET_PROCESSOR_NAME } from './protocol';
import * as platform from './platform';
import { RecordingAssembler } from './recorder';
// Pipeline agent owns capture.worklet.ts (docs/ARCHITECTURE.md module map); the
// `*?worker&url` shape is declared in vite/client.d.ts regardless of the target
// file's contents.
import workletUrl from './capture.worklet.ts?worker&url';

interface GatingOptions {
  minConfidence?: number;
  minRmsDb?: number;
}

interface TransientOptions {
  enabled: boolean;
  thresholdDb: number;
  refractorySec: number;
}

/** Removes the first occurrence of `item` from `list`, if present. */
function unsubscribeFrom<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i !== -1) list.splice(i, 1);
}

/** Releases a mic stream nobody will use (the recording indicator goes off). */
function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

class AudioEngineImpl implements AudioEngine {
  private _state: EngineState = 'idle';
  private _error: EngineError | null = null;
  private _context: AudioContext | null = null;
  private _output: GainNode | null = null;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private zeroGainNode: GainNode | null = null;
  private mediaStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;

  /** True once the current AudioContext's worklet module has been added (addModule is one-shot per context). */
  private workletLoaded = false;
  /** True once the mic graph is wired (track attached, worklet connected) and not yet stopped/ended. */
  private micOpen = false;
  /**
   * Bumped by every operation that opens the mic (start, reset, a mic-ended resume) and by stop(). An opening whose
   * generation is no longer current was abandoned: it releases the stream it gets and reports nothing.
   */
  private micGen = 0;
  /** True while an opening is in flight (a permission prompt may be up); a second start() waits for it instead. */
  private opening = false;
  /** False in 'idle' (never started, or stop()ped) and while only ensureContext() has been used (no mic). */
  private expectRunning = false;
  private gestureArmed = false;
  private hiddenAt: number | null = null;
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWarnAt = 0;

  private preferredInputId: string | null = null;
  private detectorKind: DetectorKind = CONFIG.audio.detector;
  private gating: Required<GatingOptions> = {
    minConfidence: CONFIG.audio.minConfidence,
    minRmsDb: CONFIG.audio.minRmsDb,
  };
  private transientOpts: TransientOptions = {
    enabled: false,
    thresholdDb: CONFIG.latency.loopback.thresholdDb,
    refractorySec: CONFIG.latency.loopback.refractorySec,
  };

  private stats: EngineStats = { framesPerSec: 0, droppedQuanta: 0, maxQuantum: 0 };
  private detectorCostMs: number | null = null;
  private trackSettings: MediaTrackSettings | null = null;
  private inputDeviceLabel: string | null = null;
  private audioSessionType: string | null = null;
  private wakeLockSentinel: WakeLockSentinel | null = null;
  private silentAudioStop: (() => void) | null = null;

  private recordingAssembler: RecordingAssembler | null = null;
  private recordingStopResolve: ((recording: Recording) => void) | null = null;

  private readonly frameListeners: Array<(frame: PitchFrame) => void> = [];
  private readonly stateListeners: Array<(state: EngineState, error: EngineError | null) => void> = [];
  private readonly statsListeners: Array<(stats: EngineStats) => void> = [];
  private readonly transientListeners: Array<(t: number, peakDb: number) => void> = [];

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
    }
  }

  // ---------------------------------------------------------------- readonly getters

  get state(): EngineState {
    return this._state;
  }
  get error(): EngineError | null {
    return this._error;
  }
  get context(): AudioContext | null {
    return this._context;
  }
  get output(): AudioNode | null {
    return this._output;
  }

  // ---------------------------------------------------------------- context lifecycle

  ensureContext(): AudioContext {
    const hadContext = this._context !== null && this._context.state !== 'closed';
    const ctx = this.getOrCreateContext();
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {
        // The statechange listener drives recovery from here.
      });
    }
    // iOS < 16.4 (no navigator.audioSession) ringer-channel fallback (docs/ARCHITECTURE.md start-audio
    // recipe step 3). Guarded by silentAudioStop so a Listen-button tap that calls this repeatedly
    // doesn't restart the near-silent <audio> loop every time; start() always arms it once anyway.
    if (platform.isIOS() && !platform.supportsAudioSession() && !this.silentAudioStop) {
      this.armSilentAudioUnlock();
    }
    if (!this.micOpen) {
      this.applyAudioSessionType('playback');
    }
    if (!hadContext) {
      this.expectRunning = false;
    }
    return ctx;
  }

  async start(): Promise<void> {
    if (this.opening) return;
    if (this.micOpen) {
      // Already open: one mic stream and one worklet, never two. A paused or interrupted one resumes (still inside
      // the caller's gesture: resume() has the same synchronous prefix).
      if (this._state === 'running') return;
      return this.resume();
    }
    const gen = this.beginOpening();
    this.setState('starting', null);

    const preflight = this.preflightError();
    if (preflight) {
      this.endOpening(gen);
      this.setState('error', preflight);
      return;
    }

    // ---- synchronous, gesture-sensitive prefix (docs/ARCHITECTURE.md start-audio recipe) ----
    this.applyAudioSessionType('play-and-record');

    const ctx = this.getOrCreateContext();
    if (!ctx.audioWorklet) {
      this.endOpening(gen);
      this.setState('error', { code: 'worklet-unsupported', message: 'This browser has no AudioContext.audioWorklet.' });
      return;
    }
    this.expectRunning = true;
    const resumePromise = ctx.resume();

    if (platform.isIOS() && !platform.supportsAudioSession()) {
      this.armSilentAudioUnlock();
    }

    const micPromise = this.openMic();
    // ---- end of the synchronous prefix: everything below runs after the gesture's call stack returns ----

    try {
      await resumePromise;
    } catch {
      // ctx.onstatechange drives recovery from here.
    }
    await this.finishOpening(gen, ctx, micPromise);
  }

  async stop(): Promise<void> {
    // Abandon an opening still in flight: its stream is released the moment it arrives (finishOpening).
    this.micGen++;
    this.opening = false;
    this.expectRunning = false;
    this.releaseMicGraph();

    this.silentAudioStop?.();
    this.silentAudioStop = null;

    // Idle at once (synchronously), so a start() right after this call opens a fresh mic instead of seeing 'running'.
    this.applyAudioSessionType('playback');
    this.setState('idle', null);

    const sentinel = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    await platform.releaseWakeLock(sentinel);
  }

  async resume(): Promise<void> {
    if (this.opening) return;
    const reasonCode = this._error?.code;

    if (reasonCode === 'route-changed') {
      await this.reset();
      return;
    }
    // Nothing to resume (the mic never opened, was stopped, or its graph is gone): open it, inside this same gesture.
    if (!this.micOpen && (reasonCode !== 'mic-ended' || !this.workletNode)) {
      await this.start();
      return;
    }

    // ---- synchronous, gesture-sensitive prefix ----
    this.applyAudioSessionType('play-and-record');
    const ctx = this.getOrCreateContext();
    this.expectRunning = true;
    const resumePromise = ctx.resume();

    if (reasonCode === 'mic-ended') {
      const gen = this.beginOpening();
      const micPromise = this.openMic();
      // ---- end of the synchronous prefix ----
      try {
        await resumePromise;
      } catch {
        // ctx.onstatechange drives recovery from here.
      }
      let stream: MediaStream;
      try {
        stream = await micPromise;
      } catch (err) {
        if (this.endOpening(gen)) this.setState('error', this.mapGetUserMediaError(err));
        return;
      }
      if (!this.endOpening(gen)) {
        stopTracks(stream); // stopped meanwhile
        return;
      }
      try {
        this.rewireMic(ctx, stream, gen);
      } catch (err) {
        stopTracks(stream);
        this.setState('error', this.mapGetUserMediaError(err));
      }
      return;
    }

    try {
      await resumePromise;
    } catch {
      // Left interrupted; the next tap (armResumeOnNextGesture) or statechange handler retries.
      return;
    }
    if (ctx.state === 'running' && this.micOpen) {
      this.setState('running', null);
    }
  }

  async reset(): Promise<void> {
    if (this.opening) return;

    const old = {
      ctx: this._context,
      source: this.sourceNode,
      worklet: this.workletNode,
      zeroGain: this.zeroGainNode,
      track: this.micTrack,
    };

    const gen = this.beginOpening();
    this.setState('starting', null);

    // ---- synchronous, gesture-sensitive prefix: a brand-new context + mic grab ----
    this.applyAudioSessionType('play-and-record');
    this._context = null; // force createContext() below to build a fresh one
    const ctx = this.createContext();
    if (!ctx.audioWorklet) {
      this.endOpening(gen);
      this.setState('error', { code: 'worklet-unsupported', message: 'This browser has no AudioContext.audioWorklet.' });
      return;
    }
    this.expectRunning = true;
    const resumePromise = ctx.resume();

    if (platform.isIOS() && !platform.supportsAudioSession() && !this.silentAudioStop) {
      this.armSilentAudioUnlock();
    }

    const micPromise = this.openMic();
    // ---- end of the synchronous prefix ----

    // Tear down the OLD graph/track/context; safe to do after the gesture-critical calls above.
    this.teardownNodes(old.source, old.worklet, old.zeroGain);
    old.track?.removeEventListener('ended', this.handleTrackEnded);
    old.track?.removeEventListener('mute', this.handleTrackEnded);
    old.track?.stop();
    if (old.ctx && old.ctx !== ctx) {
      old.ctx.onstatechange = null;
      void old.ctx.close().catch(() => {
        // Already closed/closing.
      });
    }
    this.sourceNode = null;
    this.workletNode = null;
    this.zeroGainNode = null;
    this.mediaStream = null;
    this.micTrack = null;
    this.micOpen = false;

    try {
      await resumePromise;
    } catch {
      // ctx.onstatechange drives recovery from here.
    }
    await this.finishOpening(gen, ctx, micPromise);
  }

  // ---------------------------------------------------------------- listeners

  onFrame(listener: (frame: PitchFrame) => void): Unsubscribe {
    this.frameListeners.push(listener);
    return () => unsubscribeFrom(this.frameListeners, listener);
  }

  onState(listener: (state: EngineState, error: EngineError | null) => void): Unsubscribe {
    this.stateListeners.push(listener);
    return () => unsubscribeFrom(this.stateListeners, listener);
  }

  onStats(listener: (stats: EngineStats) => void): Unsubscribe {
    this.statsListeners.push(listener);
    return () => unsubscribeFrom(this.statsListeners, listener);
  }

  onTransient(listener: (t: number, peakDb: number) => void): Unsubscribe {
    this.transientListeners.push(listener);
    return () => unsubscribeFrom(this.transientListeners, listener);
  }

  // ---------------------------------------------------------------- diagnostics & settings

  info(): EngineInfo {
    const ctx = this._context;
    return {
      state: this._state,
      sampleRate: ctx?.sampleRate ?? null,
      baseLatency: ctx?.baseLatency ?? null,
      outputLatency: ctx && typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      windowSize: CONFIG.audio.windowSize,
      hopSize: ctx ? hopSizeFor(ctx.sampleRate) : null,
      detector: this.detectorKind,
      detectorCostMs: this.detectorCostMs,
      trackSettings: this.trackSettings,
      audioSessionType: this.audioSessionType,
      inputDeviceLabel: this.inputDeviceLabel,
      isIOS: platform.isIOS(),
      isStandalone: platform.isStandalone(),
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    };
  }

  async listInputs(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.enumerateDevices !== 'function') return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  setPreferredInput(deviceId: string | null): void {
    this.preferredInputId = deviceId;
  }

  setDetector(kind: DetectorKind): void {
    this.detectorKind = kind;
    this.postToWorklet({ type: 'set-detector', detector: kind });
    if (this._state === 'running') this.scheduleDetectorBenchmark();
  }

  setGating(opts: GatingOptions): void {
    if (opts.minConfidence !== undefined) this.gating.minConfidence = opts.minConfidence;
    if (opts.minRmsDb !== undefined) this.gating.minRmsDb = opts.minRmsDb;
    this.postToWorklet({ type: 'set-gating', ...opts });
  }

  setTransientDetection(opts: TransientOptions): void {
    this.transientOpts = opts;
    this.postToWorklet({ type: 'transients', ...opts });
  }

  startRecording(): void {
    this.recordingAssembler = new RecordingAssembler();
    this.postToWorklet({ type: 'record-start' });
  }

  stopRecording(): Promise<Recording> {
    if (!this.recordingAssembler) {
      const sampleRate = this._context?.sampleRate ?? 0;
      return Promise.resolve({ samples: new Float32Array(0), sampleRate, startTime: 0 });
    }
    return new Promise<Recording>((resolve) => {
      this.recordingStopResolve = resolve;
      this.postToWorklet({ type: 'record-stop' });
    });
  }

  // ---------------------------------------------------------------- context/graph internals

  private getOrCreateContext(): AudioContext {
    return this._context && this._context.state !== 'closed' ? this._context : this.createContext();
  }

  private createContext(): AudioContext {
    const ctx = new AudioContext({ latencyHint: 'interactive' }); // never pass sampleRate; read ctx.sampleRate instead
    ctx.onstatechange = this.handleContextStateChange;
    const output = ctx.createGain();
    output.connect(ctx.destination);
    this._context = ctx;
    this._output = output;
    this.workletLoaded = false;
    return ctx;
  }

  private applyAudioSessionType(type: platform.AudioSessionType): void {
    this.audioSessionType = platform.setAudioSessionType(type);
  }

  private preflightError(): EngineError | null {
    if (typeof window === 'undefined' || !window.isSecureContext) {
      return { code: 'insecure-context', message: 'Microphone access requires a secure context (HTTPS, or localhost).' };
    }
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return { code: 'no-mediadevices', message: 'This browser has no navigator.mediaDevices.getUserMedia.' };
    }
    return null;
  }

  private mapGetUserMediaError(err: unknown): EngineError {
    const name = err instanceof DOMException ? err.name : undefined;
    const message = err instanceof Error ? err.message : String(err);
    let code: EngineErrorCode;
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        code = 'permission-denied';
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        code = 'no-microphone';
        break;
      case 'NotReadableError':
      case 'AbortError':
        code = 'mic-in-use';
        break;
      default:
        code = 'unknown';
    }
    return { code, message };
  }

  private buildConstraints(deviceId: string | null): MediaStreamConstraints {
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio, video: false };
  }

  /** Calls getUserMedia synchronously (inside the caller's gesture); the returned promise is awaited later
   *  (WebKit #325916: capture started outside the gesture's call stack silently dies after ~40s on iOS 27). */
  private openMic(): Promise<MediaStream> {
    const preferred = this.preferredInputId;
    return navigator.mediaDevices.getUserMedia(this.buildConstraints(preferred)).catch((err: unknown) => {
      const name = err instanceof DOMException ? err.name : undefined;
      if (preferred && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        return navigator.mediaDevices.getUserMedia(this.buildConstraints(null));
      }
      throw err;
    });
  }

  /** Starts an opening of the mic (abandoning any older one) and returns its generation. */
  private beginOpening(): number {
    this.opening = true;
    return ++this.micGen;
  }

  /** Ends the opening `gen`; false when it was abandoned meanwhile (a stop() or a newer opening owns the mic now). */
  private endOpening(gen: number): boolean {
    if (gen !== this.micGen) return false;
    this.opening = false;
    return true;
  }

  /** The awaited half of start()/reset(): wire the mic once it opens, unless the opening was abandoned meanwhile. */
  private async finishOpening(gen: number, ctx: AudioContext, micPromise: Promise<MediaStream>): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await micPromise;
    } catch (err) {
      if (this.endOpening(gen)) this.setState('error', this.mapGetUserMediaError(err));
      return;
    }
    if (gen !== this.micGen) {
      stopTracks(stream); // stop() came first: the mic must not stay open behind it
      return;
    }
    try {
      await this.wireGraph(ctx, stream, gen);
    } catch (err) {
      if (gen === this.micGen) {
        stopTracks(stream);
        this.setState('error', this.mapGetUserMediaError(err));
      }
    } finally {
      this.endOpening(gen);
    }
  }

  /** Stops the mic's tracks and disconnects its graph (stop(), and before a new graph replaces a dead one). */
  private releaseMicGraph(): void {
    this.micTrack?.removeEventListener('ended', this.handleTrackEnded);
    this.micTrack?.removeEventListener('mute', this.handleTrackEnded);
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.teardownNodes(this.sourceNode, this.workletNode, this.zeroGainNode);
    this.sourceNode = null;
    this.workletNode = null;
    this.zeroGainNode = null;
    this.mediaStream = null;
    this.micTrack = null;
    this.micOpen = false;
    this.trackSettings = null;
  }

  /**
   * Builds the mic source -> worklet -> zero-gain -> destination graph. The engine reports 'running' only from here
   * (and from a resume of a graph built here): a 'running' engine always has its worklet, so recording works at once.
   */
  private async wireGraph(ctx: AudioContext, stream: MediaStream, gen: number): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('getUserMedia resolved with no audio track');

    this.releaseMicGraph(); // a dead mic's graph, if any: one stream and one worklet, never two
    this.mediaStream = stream;
    this.micTrack = track;
    this.trackSettings = track.getSettings();
    this.inputDeviceLabel = track.label || null;
    track.addEventListener('ended', this.handleTrackEnded);
    track.addEventListener('mute', this.handleTrackEnded);

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;

    if (!this.workletLoaded) {
      await ctx.audioWorklet.addModule(workletUrl);
      this.workletLoaded = true;
    }
    if (gen !== this.micGen) return; // stop() ran meanwhile: it already released this stream and its source node

    // WebKit #281978: an un-mixed, explicit-channel node keeps the mic on channel 0 even when
    // echoCancellation is off (otherwise Safari can put the voice on the left channel only).
    const workletNode = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    workletNode.port.onmessage = this.handleWorkletMessage;
    workletNode.onprocessorerror = () => this.warnRateLimited('AudioWorkletNode processor error.');
    this.workletNode = workletNode;

    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0; // WebKit only processes nodes reachable from the destination; the mic is never audible.
    this.zeroGainNode = zeroGain;

    source.connect(workletNode);
    workletNode.connect(zeroGain);
    zeroGain.connect(ctx.destination);

    this.sendInit(ctx.sampleRate);
    if (this.transientOpts.enabled) {
      this.postToWorklet({ type: 'transients', ...this.transientOpts });
    }

    this.micOpen = true;
    this.expectRunning = true;
    this.setState('running', null);

    const sentinel = await platform.requestWakeLock();
    if (!this.adoptWakeLock(sentinel, gen)) return; // stopped while the lock was being granted
    this.scheduleDetectorBenchmark();
  }

  /** Lighter recovery for a dead mic track: reuses the existing worklet node/registration,
   *  just swaps in a new MediaStreamAudioSourceNode and drops the worklet's buffered state. */
  private rewireMic(ctx: AudioContext, stream: MediaStream, gen: number): void {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('getUserMedia resolved with no audio track');

    try {
      this.sourceNode?.disconnect();
    } catch {
      // Already disconnected.
    }

    // Release the muted or ended capture this replaces before adopting the new one (the new getUserMedia has already
    // resolved, so the mic stays available): stop() only stops the CURRENT stream, so an old track left live here
    // would keep the recording indicator on, and a late 'mute'/'ended' on it would still drive handleTrackEnded.
    if (this.micTrack && this.micTrack !== track) {
      this.micTrack.removeEventListener('ended', this.handleTrackEnded);
      this.micTrack.removeEventListener('mute', this.handleTrackEnded);
    }
    if (this.mediaStream && this.mediaStream !== stream) stopTracks(this.mediaStream);

    this.mediaStream = stream;
    this.micTrack = track;
    this.trackSettings = track.getSettings();
    this.inputDeviceLabel = track.label || null;
    track.addEventListener('ended', this.handleTrackEnded);
    track.addEventListener('mute', this.handleTrackEnded);

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;
    if (this.workletNode) {
      source.connect(this.workletNode);
      this.postToWorklet({ type: 'reset' });
    }

    this.micOpen = true;
    this.expectRunning = true;
    this.setState('running', null);
    void platform.requestWakeLock().then((sentinel) => this.adoptWakeLock(sentinel, gen));
  }

  private teardownNodes(
    source: MediaStreamAudioSourceNode | null,
    worklet: AudioWorkletNode | null,
    zeroGain: GainNode | null,
  ): void {
    if (worklet) worklet.port.onmessage = null;
    try {
      source?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      worklet?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      zeroGain?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  private sendInit(sampleRate: number): void {
    this.postToWorklet({
      type: 'init',
      hopSize: hopSizeFor(sampleRate),
      windowSize: CONFIG.audio.windowSize,
      detector: this.detectorKind,
      minHz: CONFIG.audio.minHz,
      maxHz: CONFIG.audio.maxHz,
      minConfidence: this.gating.minConfidence,
      minRmsDb: this.gating.minRmsDb,
      rmsFloorDb: CONFIG.audio.rmsFloorDb,
      mpmK: CONFIG.audio.mpmK,
      yinThreshold: CONFIG.audio.yinThreshold,
      statsIntervalSec: CONFIG.audio.statsIntervalSec,
    });
  }

  private postToWorklet(msg: MainToWorklet): void {
    this.workletNode?.port.postMessage(msg);
  }

  private setState(state: EngineState, error: EngineError | null): void {
    this._state = state;
    this._error = error;
    for (let i = 0; i < this.stateListeners.length; i++) this.stateListeners[i](state, error);
  }

  // ---------------------------------------------------------------- recovery

  private handleContextStateChange = (): void => {
    const ctx = this._context;
    if (!ctx || !this.expectRunning) return;

    if (ctx.state === 'running') {
      // Only a wired mic graph is 'running': while start() is still opening the mic, the context resuming is not it.
      if (this._state !== 'running' && this.micOpen) this.setState('running', null);
      return;
    }

    if (ctx.state === 'interrupted' || ctx.state === 'suspended') {
      if (this._state === 'running') this.setState('suspended', null); // optimistic: resume() may just work
      ctx.resume().catch(() => {
        // Checked by the timeout below regardless of outcome.
      });
      setTimeout(() => {
        if (this._context !== ctx || !this.expectRunning) return; // superseded by reset(), or stopped
        if (ctx.state !== 'running') {
          this.setState('interrupted', {
            code: 'session-interrupted',
            message: `AudioContext is "${ctx.state}" and resume() did not recover it within 300 ms.`,
          });
          this.armResumeOnNextGesture();
        }
      }, 300);
    }
  };

  private armResumeOnNextGesture(): void {
    if (this.gestureArmed || typeof document === 'undefined') return;
    this.gestureArmed = true;
    const onGesture = (): void => {
      document.removeEventListener('click', onGesture, true);
      document.removeEventListener('touchend', onGesture, true);
      this.gestureArmed = false;
      if (this._state === 'interrupted') void this.resume();
    };
    document.addEventListener('click', onGesture, true);
    document.addEventListener('touchend', onGesture, true);
  }

  /** Fires for both the track's 'ended' and 'mute' events (WebKit can mute just the capture
   *  track - e.g. during a call or Siri activation - without ending it, while the AudioContext
   *  itself stays 'running'), so the message covers either cause rather than naming one. */
  private handleTrackEnded = (): void => {
    if (!this.expectRunning) return; // stop() already handled this
    this.micOpen = false;
    this.setState('interrupted', {
      code: 'mic-ended',
      message: 'The microphone track ended or was muted (often during a call or ~30s after the page was backgrounded on iOS).',
    });
  };

  private handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      return;
    }

    const hiddenMs = this.hiddenAt !== null ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = null;
    if (!this.expectRunning) return;

    if (this.wakeLockSentinel === null) {
      const gen = this.micGen;
      void platform.requestWakeLock().then((sentinel) => this.adoptWakeLock(sentinel, gen));
    }

    const trackDead = this.micTrack !== null && this.micTrack.readyState === 'ended';
    const ctxDead = this._context === null || this._context.state !== 'running';
    if (hiddenMs / 1000 >= CONFIG.engine.backgroundSuspectSec || trackDead || ctxDead) {
      if (trackDead) this.micOpen = false;
      this.setState('interrupted', {
        code: trackDead ? 'mic-ended' : 'session-interrupted',
        message: 'Resuming after the page was backgrounded; tap to reconnect.',
      });
    }
  };

  private handleDeviceChange = (): void => {
    if (this.deviceChangeTimer !== null) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null;
      if (this._state !== 'running') return;
      this.setState('interrupted', {
        code: 'route-changed',
        message: 'The audio input/output route changed; tap to reconnect and recalibrate.',
      });
    }, CONFIG.engine.deviceChangeDebounceMs);
  };

  private handleWorkletMessage = (ev: MessageEvent<WorkletToMain>): void => {
    const msg = ev.data;
    switch (msg.type) {
      case 'frame':
        for (let i = 0; i < this.frameListeners.length; i++) this.frameListeners[i](msg.frame);
        break;
      case 'stats':
        this.stats = { framesPerSec: msg.framesPerSec, droppedQuanta: msg.droppedQuanta, maxQuantum: msg.maxQuantum };
        for (let i = 0; i < this.statsListeners.length; i++) this.statsListeners[i](this.stats);
        break;
      case 'transient':
        for (let i = 0; i < this.transientListeners.length; i++) this.transientListeners[i](msg.t, msg.peakDb);
        break;
      case 'record-chunk':
        this.recordingAssembler?.add(msg.frame0, msg.samples);
        break;
      case 'record-end':
        this.finishRecording();
        break;
      case 'error':
        this.warnRateLimited(msg.message);
        break;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
      }
    }
  };

  private finishRecording(): void {
    const sampleRate = this._context?.sampleRate ?? 0;
    const recording = this.recordingAssembler?.finish(sampleRate) ?? { samples: new Float32Array(0), sampleRate, startTime: 0 };
    this.recordingAssembler = null;
    const resolve = this.recordingStopResolve;
    this.recordingStopResolve = null;
    resolve?.(recording);
  }

  private scheduleDetectorBenchmark(): void {
    const ctx = this._context;
    if (!ctx) return;
    const kind = this.detectorKind;
    const sampleRate = ctx.sampleRate;
    setTimeout(() => {
      if (this._context !== ctx || this.detectorKind !== kind) return; // superseded
      try {
        const detector = createDetector(kind, {
          sampleRate,
          windowSize: CONFIG.audio.windowSize,
          minHz: CONFIG.audio.minHz,
          maxHz: CONFIG.audio.maxHz,
          mpmK: CONFIG.audio.mpmK,
          yinThreshold: CONFIG.audio.yinThreshold,
        });
        this.detectorCostMs = benchmarkDetector(detector, CONFIG.engine.benchmarkIterations);
      } catch (err) {
        this.warnRateLimited(`Detector benchmark failed: ${String(err)}`);
      }
    }, 0);
  }

  private armSilentAudioUnlock(): void {
    this.silentAudioStop?.();
    this.silentAudioStop = platform.startSilentAudioUnlock();
  }

  /**
   * Assigns `wakeLockSentinel` and listens for the sentinel's own 'release'
   * event, which the UA fires automatically (per the Screen Wake Lock spec)
   * whenever the document goes hidden - not only when `releaseWakeLock()` is
   * called. Without this, the field keeps pointing at a released-but-non-null
   * sentinel after the first background/foreground cycle, and the
   * `visibilitychange` re-request (`wakeLockSentinel === null` check) never
   * fires again for the rest of the session.
   */
  private setWakeLock(sentinel: WakeLockSentinel | null): void {
    // One lock at a time: a reset() or a reconnect asks for a new one while the old is still held, and stop()
    // releases only the latest, so the one it replaces is released here (else the screen never auto-locks again).
    const prev = this.wakeLockSentinel;
    this.wakeLockSentinel = sentinel;
    sentinel?.addEventListener('release', () => {
      if (this.wakeLockSentinel === sentinel) this.wakeLockSentinel = null;
    });
    if (prev && prev !== sentinel) void platform.releaseWakeLock(prev);
  }

  /**
   * Keep a wake lock granted for the mic opening `gen`, or release it when that opening was stopped (or superseded)
   * while the lock was being granted. True when it was kept.
   */
  private adoptWakeLock(sentinel: WakeLockSentinel | null, gen: number): boolean {
    if (gen !== this.micGen || !this.expectRunning) {
      void platform.releaseWakeLock(sentinel);
      return false;
    }
    this.setWakeLock(sentinel);
    return true;
  }

  private warnRateLimited(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 2000) return;
    this.lastWarnAt = now;
    console.warn(`[pitch-lab audio] ${message}`);
  }
}

let instance: AudioEngineImpl | null = null;

/** The single AudioEngine instance, created on first use. */
export function getEngine(): AudioEngine {
  if (!instance) instance = new AudioEngineImpl();
  return instance;
}
