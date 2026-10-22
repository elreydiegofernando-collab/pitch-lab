/**
 * Regression coverage for the engine's recovery/robustness paths that need a
 * (fake) browser to exercise: wake-lock renewal, mic track mute handling, and
 * the iOS < 16.4 silent-audio ringer unlock. These are deliberately NOT pure
 * (engine.ts owns the live AudioContext/mic/wake-lock state), so the fakes
 * below model just enough of the Web Audio / Media Capture / Screen Wake
 * Lock surface to drive engine.ts through its start-audio recipe
 * (docs/ARCHITECTURE.md) without a real browser - the same approach
 * synth.test.ts uses for its fake Web Audio graph.
 *
 * Each test imports a fresh copy of engine.ts (`vi.resetModules()` + dynamic
 * `import()`) so the module-level `getEngine()` singleton never leaks state
 * between tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from './engine-types';

// ---------------------------------------------------------------------------
// Fakes

/** Minimal EventTarget: enough for 'ended'/'mute'/'release'/'visibilitychange'. */
class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  /** Test helper: fire every listener registered for `type`. */
  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }
}

class FakeAudioNode {
  connect(): FakeAudioNode {
    return this;
  }
  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeWorkletNode {
  /** Every node the engine created since the harness was set up. */
  static instances: FakeWorkletNode[] = [];
  port = { onmessage: null as ((ev: MessageEvent) => void) | null, postMessage: vi.fn() };
  onprocessorerror: (() => void) | null = null;
  constructor(_ctx: unknown, _name: string, _opts: unknown) {
    FakeWorkletNode.instances.push(this);
  }
  connect(): FakeWorkletNode {
    return this;
  }
  disconnect(): void {}
}

class FakeAudioContext extends FakeEventTarget {
  state: 'running' | 'suspended' | 'interrupted' | 'closed' = 'running';
  sampleRate = 48000;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  onstatechange: (() => void) | null = null;
  constructor(_opts?: unknown) {
    super();
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createMediaStreamSource(_stream: unknown): FakeAudioNode {
    return new FakeAudioNode();
  }
}

class FakeMediaStreamTrack extends FakeEventTarget {
  readyState: 'live' | 'ended' = 'live';
  label = 'Fake Mic';
  stop(): void {
    this.readyState = 'ended';
  }
  getSettings(): MediaTrackSettings {
    return {};
  }
}

class FakeMediaStream {
  constructor(private readonly track: FakeMediaStreamTrack) {}
  getAudioTracks(): FakeMediaStreamTrack[] {
    return [this.track];
  }
  getTracks(): FakeMediaStreamTrack[] {
    return [this.track];
  }
}

/** Mimics the real WakeLockSentinel: `release()` AND the UA's own automatic
 *  'release' (e.g. on visibilitychange to hidden) both fire the same event. */
class FakeWakeLockSentinel extends FakeEventTarget {
  released = false;
  release(): Promise<void> {
    this.released = true;
    this.dispatch('release');
    return Promise.resolve();
  }
}

class FakeAudioElement {
  loop = false;
  volume = 1;
  src: string;
  constructor(src = '') {
    this.src = src;
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

class FakeDocument extends FakeEventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}

// ---------------------------------------------------------------------------
// Harness

interface Harness {
  engine: AudioEngine;
  getUserMedia: ReturnType<typeof vi.fn>;
  wakeLockRequest: ReturnType<typeof vi.fn>;
  document: FakeDocument;
  /** Mutable: refreshed every time the fakes hand out a new track/sentinel/<audio>. */
  readonly state: {
    audioConstructs: number;
    lastTrack: FakeMediaStreamTrack | null;
    lastSentinel: FakeWakeLockSentinel | null;
  };
}

/**
 * Stubs just enough of window/document/navigator/AudioContext/AudioWorkletNode/Audio
 * for engine.ts's start-audio recipe to run, then imports a FRESH engine.ts
 * (so getEngine()'s module-level singleton starts clean) and returns it plus
 * the fakes, so tests can both drive the engine and inspect/trigger the fakes.
 *
 * `iosLessThan164`: true gives an iPhone UA with no `navigator.audioSession`
 * (platform.isIOS() true, platform.supportsAudioSession() false) - the exact
 * matrix cell the silent-audio-unlock fix targets.
 */
async function setUpHarness(opts: { iosLessThan164?: boolean } = {}): Promise<Harness> {
  vi.resetModules();
  FakeWorkletNode.instances = [];

  const state: Harness['state'] = { audioConstructs: 0, lastTrack: null, lastSentinel: null };

  const getUserMedia = vi.fn(async () => {
    state.lastTrack = new FakeMediaStreamTrack();
    return new FakeMediaStream(state.lastTrack);
  });
  const wakeLockRequest = vi.fn(async () => {
    state.lastSentinel = new FakeWakeLockSentinel();
    return state.lastSentinel;
  });

  const fakeDocument = new FakeDocument();
  const fakeMediaDevices = {
    getUserMedia,
    enumerateDevices: vi.fn(async () => []),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const fakeNavigator = opts.iosLessThan164
    ? {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
        platform: 'iPhone',
        maxTouchPoints: 5,
        mediaDevices: fakeMediaDevices,
        wakeLock: { request: wakeLockRequest },
        // Deliberately no `audioSession`: this is the iOS < 16.4 matrix cell.
      }
    : {
        userAgent: 'test-agent',
        platform: 'test-platform',
        maxTouchPoints: 0,
        mediaDevices: fakeMediaDevices,
        wakeLock: { request: wakeLockRequest },
      };

  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('navigator', fakeNavigator);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal(
    'Audio',
    class extends FakeAudioElement {
      constructor(src?: string) {
        super(src);
        state.audioConstructs++;
      }
    },
  );

  const { getEngine } = await import('./engine');
  return { engine: getEngine(), getUserMedia, wakeLockRequest, document: fakeDocument, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A getUserMedia call the test answers by hand (the permission prompt is "up" until then). */
function deferMic(h: Harness): (track: FakeMediaStreamTrack) => void {
  let answer: (stream: FakeMediaStream) => void = () => {};
  h.getUserMedia.mockImplementationOnce(() => new Promise<FakeMediaStream>((resolve) => (answer = resolve)));
  return (track) => answer(new FakeMediaStream(track));
}

// ---------------------------------------------------------------------------
// [running-before-the-worklet-exists]: a take started on 'running' recorded nothing on the first Sing of a page load

describe('the mic opening', () => {
  it('reports running only once the worklet is wired, so a recording started then is captured', async () => {
    const h = await setUpHarness();
    const answer = deferMic(h);
    const states: string[] = [];
    h.engine.onState((s) => states.push(s));

    const started = h.engine.start();
    // The context resumes while the permission prompt is still up: that is not the mic running.
    (h.engine.context as unknown as FakeAudioContext).onstatechange?.();
    expect(h.engine.state).toBe('starting');

    answer(new FakeMediaStreamTrack());
    await started;
    expect(states).toEqual(['starting', 'running']);
    const [worklet] = FakeWorkletNode.instances;
    h.engine.startRecording();
    expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: 'record-start' });
  });

  it('opens one stream and one worklet: start() while running does nothing', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    await h.engine.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeWorkletNode.instances).toHaveLength(1);
    expect(h.engine.state).toBe('running');
  });

  it('stop() during a start releases the mic the moment it opens and stays idle', async () => {
    const h = await setUpHarness();
    const answer = deferMic(h);
    const started = h.engine.start();
    expect(h.engine.state).toBe('starting');

    await h.engine.stop();
    expect(h.engine.state).toBe('idle');

    const late = new FakeMediaStreamTrack();
    answer(late);
    await started;
    expect(late.readyState).toBe('ended');
    expect(h.engine.state).toBe('idle');
    expect(FakeWorkletNode.instances).toHaveLength(0);
  });

  it('is idle as soon as stop() is called, so a start right after it opens a fresh mic', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    const first = h.state.lastTrack;
    void h.engine.stop();
    expect(h.engine.state).toBe('idle');
    expect(first?.readyState).toBe('ended');

    await h.engine.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.engine.state).toBe('running');
  });

  it('resume() with no mic open opens it rather than claiming to run', async () => {
    const h = await setUpHarness();
    await h.engine.resume();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.engine.state).toBe('running');
    expect(FakeWorkletNode.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [wake-lock-never-renewed-after-first-release]

describe('wake lock renewal', () => {
  it('re-requests the wake lock on the next visibilitychange after the UA auto-releases the sentinel', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    expect(h.engine.state).toBe('running');
    expect(h.wakeLockRequest).toHaveBeenCalledTimes(1);

    const sentinel = h.state.lastSentinel;
    expect(sentinel).not.toBeNull();

    // The UA releases the lock on its own - e.g. the document went hidden - without the
    // engine ever calling releaseWakeLock(). Per the Screen Wake Lock spec this still
    // fires the sentinel's 'release' event.
    sentinel?.dispatch('release');

    // A background/foreground cycle, same as a phone lock/unlock while singing.
    h.document.visibilityState = 'hidden';
    h.document.dispatch('visibilitychange');
    h.document.visibilityState = 'visible';
    h.document.dispatch('visibilitychange');

    // Without the fix, wakeLockSentinel still holds the released-but-non-null sentinel,
    // so the `=== null` re-request guard never fires again and this stays at 1.
    expect(h.wakeLockRequest).toHaveBeenCalledTimes(2);
  });

  /** Every sentinel the fake granted, so a test can count the ones still held. */
  function trackSentinels(h: Harness): FakeWakeLockSentinel[] {
    const all: FakeWakeLockSentinel[] = [];
    h.wakeLockRequest.mockImplementation(async () => {
      const s = new FakeWakeLockSentinel();
      all.push(s);
      h.state.lastSentinel = s;
      return s;
    });
    return all;
  }

  it('Reset audio replaces the wake lock instead of leaking the old one, and stop() releases the last', async () => {
    const h = await setUpHarness();
    const sentinels = trackSentinels(h);
    await h.engine.start();
    await h.engine.reset();
    expect(sentinels).toHaveLength(2);
    expect(sentinels.filter((s) => !s.released)).toHaveLength(1);
    await h.engine.stop();
    expect(sentinels.filter((s) => !s.released)).toHaveLength(0);
  });

  it('a reconnect after a mute holds one wake lock, and stop() releases it', async () => {
    const h = await setUpHarness();
    const sentinels = trackSentinels(h);
    await h.engine.start();
    h.state.lastTrack?.dispatch('mute');
    await h.engine.resume();
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinels.filter((s) => !s.released)).toHaveLength(1);
    await h.engine.stop();
    expect(sentinels.filter((s) => !s.released)).toHaveLength(0);
  });

  it('a wake lock granted after stop() is released, never kept', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    h.state.lastTrack?.dispatch('mute');
    let grant: (s: FakeWakeLockSentinel) => void = () => {};
    h.wakeLockRequest.mockImplementationOnce(() => new Promise<FakeWakeLockSentinel>((resolve) => (grant = resolve)));
    await h.engine.resume(); // the rewire asks for a lock; the request is still pending
    await h.engine.stop();
    const late = new FakeWakeLockSentinel();
    grant(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.released).toBe(true);
  });

  it('does not re-request on visibilitychange while the held sentinel is still live', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    expect(h.wakeLockRequest).toHaveBeenCalledTimes(1);

    h.document.visibilityState = 'hidden';
    h.document.dispatch('visibilitychange');
    h.document.visibilityState = 'visible';
    h.document.dispatch('visibilitychange');

    expect(h.wakeLockRequest).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// [mic-track-mute-not-handled]

describe('mic track mute', () => {
  it('treats a mute event the same as ended: interrupted with mic-ended', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    expect(h.engine.state).toBe('running');

    h.state.lastTrack?.dispatch('mute');

    expect(h.engine.state).toBe('interrupted');
    expect(h.engine.error?.code).toBe('mic-ended');
  });

  it('reconnecting after a mute (a call, Siri) releases the old capture track: nothing stays live once stopped', async () => {
    const h = await setUpHarness();
    const tracks: FakeMediaStreamTrack[] = [];
    h.getUserMedia.mockImplementation(async () => {
      const t = new FakeMediaStreamTrack();
      tracks.push(t);
      h.state.lastTrack = t;
      return new FakeMediaStream(t);
    });
    await h.engine.start();
    const first = tracks[0];
    first.dispatch('mute');
    expect(h.engine.state).toBe('interrupted');

    await h.engine.resume(); // 'mic-ended' with a worklet: the light rewire
    expect(h.engine.state).toBe('running');
    expect(tracks).toHaveLength(2);
    expect(first.readyState).toBe('ended'); // released as soon as the new capture took over
    expect(tracks.filter((t) => t.readyState === 'live')).toHaveLength(1);

    first.dispatch('ended'); // a late event from the replaced track
    first.dispatch('mute');
    expect(h.engine.state).toBe('running');

    await h.engine.stop();
    expect(tracks.filter((t) => t.readyState === 'live')).toHaveLength(0);
  });

  it('stops listening for mute (and ended) once stop() has torn the track down', async () => {
    const h = await setUpHarness();
    await h.engine.start();
    const track = h.state.lastTrack;
    expect(track).not.toBeNull();

    await h.engine.stop();
    expect(h.engine.state).toBe('idle');

    track?.dispatch('mute'); // a late event from the now-detached track
    expect(h.engine.state).toBe('idle'); // must not resurrect 'interrupted'
  });
});

// ---------------------------------------------------------------------------
// [silent-audio-unlock-missing-in-ensureContext-and-reset]

describe('silent-audio ringer unlock (iOS < 16.4)', () => {
  it('arms it on ensureContext(), and does not needlessly re-arm on a second call', async () => {
    const h = await setUpHarness({ iosLessThan164: true });

    h.engine.ensureContext();
    expect(h.state.audioConstructs).toBe(1);

    h.engine.ensureContext();
    expect(h.state.audioConstructs).toBe(1); // guarded by `!this.silentAudioStop`
  });

  it('arms it on reset() when reset() is the first mic-opening call of the session', async () => {
    const h = await setUpHarness({ iosLessThan164: true });

    await h.engine.reset();

    expect(h.engine.state).toBe('running');
    expect(h.state.audioConstructs).toBe(1);
  });

  it('does not re-arm on reset() if ensureContext() already armed it this session', async () => {
    const h = await setUpHarness({ iosLessThan164: true });

    h.engine.ensureContext();
    expect(h.state.audioConstructs).toBe(1);

    await h.engine.reset();
    expect(h.state.audioConstructs).toBe(1);
  });

  it('never arms it off iOS, or where navigator.audioSession is supported', async () => {
    const h = await setUpHarness(); // default fake navigator: not iOS

    h.engine.ensureContext();
    await h.engine.reset();

    expect(h.state.audioConstructs).toBe(0);
  });
});
