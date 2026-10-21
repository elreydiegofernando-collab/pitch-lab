/**
 * Browser/OS feature detection and the small iOS-only helpers the audio
 * engine's start-audio recipe depends on (docs/ARCHITECTURE.md).
 *
 * Detection logic is written as a pure function of explicit inputs (so the
 * matrix is unit-testable without a DOM) plus a zero-argument wrapper that
 * reads `navigator`/`window` for callers. The wrappers degrade to a safe
 * default (never throw) outside a browser, since this module may be
 * evaluated before any DOM globals exist.
 */

// ---------------------------------------------------------------- iOS / platform detection

export interface UserAgentInfo {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

function currentUserAgentInfo(): UserAgentInfo {
  if (typeof navigator === 'undefined') return { userAgent: '', platform: '', maxTouchPoints: 0 };
  return { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints };
}

/**
 * True for iPhone/iPod/iPad Safari, including the iPadOS 13+ "desktop class"
 * UA: it reports `platform === 'MacIntel'` like a real Mac, but is touch
 * capable (`maxTouchPoints > 1`, 0 on an actual Mac with no touch screen).
 */
export function detectIOS(info: UserAgentInfo): boolean {
  if (/iPad|iPhone|iPod/.test(info.userAgent)) return true;
  return info.platform === 'MacIntel' && info.maxTouchPoints > 1;
}

export function isIOS(): boolean {
  return detectIOS(currentUserAgentInfo());
}

export function detectWindows(info: Pick<UserAgentInfo, 'userAgent'>): boolean {
  return /Windows/.test(info.userAgent);
}

export function isWindows(): boolean {
  return detectWindows(currentUserAgentInfo());
}

interface StandaloneNavigator {
  /** Legacy iOS Safari flag: true when launched from a Home Screen icon. */
  standalone?: boolean;
}

/** True when running installed (iOS Home Screen, or any PWA display-mode). */
export function isStandalone(): boolean {
  if (typeof navigator !== 'undefined' && (navigator as Navigator & StandaloneNavigator).standalone === true) {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(display-mode: standalone)').matches;
  }
  return false;
}

// ---------------------------------------------------------------- navigator.audioSession (Safari 16.4+)

/**
 * Safari-only, feature-detected. Only the `type` property exists (no
 * `state`/`statechange`): see docs/ARCHITECTURE.md's start-audio recipe.
 */
export type AudioSessionType =
  | 'auto'
  | 'play-and-record'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'ambient-mixed';

interface NavigatorAudioSession {
  type: AudioSessionType;
}

interface AudioSessionNavigator {
  audioSession?: NavigatorAudioSession;
}

function getAudioSession(): NavigatorAudioSession | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & AudioSessionNavigator).audioSession ?? null;
}

export function supportsAudioSession(): boolean {
  return getAudioSession() !== null;
}

/** Sets `navigator.audioSession.type` when supported. Returns the resulting type, or null when unsupported. */
export function setAudioSessionType(type: AudioSessionType): AudioSessionType | null {
  const session = getAudioSession();
  if (!session) return null;
  try {
    session.type = type;
    return session.type;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Bluetooth mic heuristic

/**
 * Soft substring heuristic over a MediaDeviceInfo/MediaStreamTrack label.
 * Bluetooth HFP mics run at 8-16 kHz and badly degrade pitch detection, so
 * Setup uses this to warn and suggest the built-in mic. Labels are only
 * populated once mic permission is granted, vary a lot by OS/browser, and
 * carry no device-type flag, so this is deliberately a guess, not a fact.
 */
const BLUETOOTH_LABEL_HINTS = [
  'airpods',
  'bluetooth',
  'hands-free',
  'hands free',
  'hfp',
  'headset',
  'buds',
  'beats',
  'bose',
  'jabra',
  'sony wh-',
  'sony wf-',
  'jbl',
  'sennheiser',
  'skullcandy',
  'soundcore',
  'powerbeats',
  'galaxy buds',
  'pixel buds',
] as const;

export function isLikelyBluetoothLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return BLUETOOTH_LABEL_HINTS.some((hint) => lower.includes(hint));
}

// ---------------------------------------------------------------- Screen wake lock

/**
 * Requests a screen wake lock (try/catch: only reliable in installed PWAs
 * from iOS 18.4, unsupported or denied elsewhere). Returns null on failure
 * so callers can treat "no wake lock" as a normal, non-fatal outcome.
 */
export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

export async function releaseWakeLock(sentinel: WakeLockSentinel | null): Promise<void> {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch {
    // Already released, or released out from under us (e.g. tab hidden).
  }
}

// ---------------------------------------------------------------- Silent-audio ringer unlock

let cachedSilentWavUri: string | null = null;

/**
 * A ~1 s mono 8 kHz WAV at a very low, non-zero amplitude, as a base64 data
 * URI. Non-zero (not true digital silence) so playback engines that special
 * case all-zero buffers still treat it as real audio output.
 */
function nearSilentWavDataUri(): string {
  if (cachedSilentWavUri) return cachedSilentWavUri;

  const sampleRate = 8000;
  const frameCount = sampleRate; // 1 second, looped
  const amplitude = 0.004; // ~ -48 dBFS: inaudible in practice, never muted
  const toneHz = 220;
  const blockAlign = 2; // mono, 16-bit
  const dataSize = frameCount * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < frameCount; i++) {
    const sample = Math.sin((2 * Math.PI * toneHz * i) / sampleRate) * amplitude;
    view.setInt16(44 + i * blockAlign, Math.round(sample * 32767), true);
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  cachedSilentWavUri = `data:audio/wav;base64,${btoa(binary)}`;
  return cachedSilentWavUri;
}

/**
 * iOS < 16.4 (no `navigator.audioSession`) fallback for the Ring/Silent
 * switch: a looping, un-muted, low-volume `<audio>` element moves Web Audio
 * off the ringer channel. Must be started synchronously inside the same
 * gesture as the rest of the start-audio recipe. Returns a stop function.
 */
export function startSilentAudioUnlock(): () => void {
  if (typeof Audio === 'undefined') return () => {};

  const audio = new Audio(nearSilentWavDataUri());
  audio.loop = true;
  audio.volume = 0.05;
  audio.play().catch(() => {
    // Best-effort: if this fails, the Ring/Silent switch risk simply remains.
  });

  return () => {
    audio.pause();
    audio.loop = false;
    audio.src = '';
  };
}
