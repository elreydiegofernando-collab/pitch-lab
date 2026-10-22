/**
 * A screen that turned the mic on turns it off again when it is left: the recording indicator goes off, and stop() puts
 * the audio session back to playback so the next screen's playback routes normally (docs/ARCHITECTURE.md). A mic that
 * was already on when the screen opened is left as it was. The Sing screen's runner and the song player release the mic
 * of their own takes the same way.
 */
import { useEffect } from 'preact/hooks';
import type { AudioEngine } from '../../audio/engine-types';

export function useReleaseMicOnLeave(engine: AudioEngine): void {
  useEffect(() => {
    const wasOn = engine.state !== 'idle' && engine.state !== 'error';
    return () => {
      if (!wasOn && engine.state !== 'idle') void engine.stop().catch(() => undefined);
    };
  }, [engine]);
}
