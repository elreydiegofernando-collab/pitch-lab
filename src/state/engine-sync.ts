/**
 * Keeps the audio engine on the singer's saved choices: the pitch detector (a profile setting) and the input device (a
 * device setting). The engine starts every launch on its defaults (CONFIG.audio.detector, the default mic), and the
 * screens only push a choice when it is made, so without this a relaunch, a profile switch or a backup reload would show
 * YIN and the headset in Settings and Setup while the engine ran MPM on the default mic. Started once by app.tsx.
 */
import { effect } from '@preact/signals';
import type { AudioEngine } from '../audio/engine-types';
import { deviceSettings, settings } from './settings';

/**
 * Follow `settings.detector` and `deviceSettings.inputDeviceId` into `engine`: the detector is set only when it differs
 * from the engine's (each change re-initializes the worklet's detector), then `onDetectorChanged` refreshes what the
 * screens show. Returns the function that stops following.
 */
export function syncEngineSettings(engine: AudioEngine, onDetectorChanged: () => void = () => undefined): () => void {
  let lastInput: string | null | undefined;
  return effect(() => {
    const kind = settings.value.detector;
    const input = deviceSettings.value.inputDeviceId;
    if (engine.info().detector !== kind) {
      engine.setDetector(kind);
      onDetectorChanged();
    }
    if (input !== lastInput) {
      lastInput = input;
      engine.setPreferredInput(input);
    }
  });
}
