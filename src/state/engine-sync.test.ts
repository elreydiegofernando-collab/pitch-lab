/** The engine follows the saved detector and input device whenever the settings (re)load, not only when they are changed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, EngineInfo } from '../audio/engine-types';
import { syncEngineSettings } from './engine-sync';
import { deviceSettings, settings } from './settings';
import { DEFAULT_DEVICE_SETTINGS, DEFAULT_SETTINGS } from './settings-types';

function fakeEngine() {
  let detector: EngineInfo['detector'] = 'mpm';
  const engine = {
    info: () => ({ detector }) as EngineInfo,
    setDetector: vi.fn((kind: EngineInfo['detector']) => {
      detector = kind;
    }),
    setPreferredInput: vi.fn(),
  };
  return { engine: engine as unknown as AudioEngine, mocks: engine };
}

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  settings.value = DEFAULT_SETTINGS;
  deviceSettings.value = DEFAULT_DEVICE_SETTINGS;
});

describe('syncEngineSettings', () => {
  it('applies the stored choices when they load (a relaunch, a profile switch), and each later change', () => {
    const { engine, mocks } = fakeEngine();
    const refreshed = vi.fn();
    stop = syncEngineSettings(engine, refreshed);
    expect(mocks.setDetector).not.toHaveBeenCalled(); // the default already runs
    expect(mocks.setPreferredInput).toHaveBeenCalledWith(null);

    // The session loads the profile's settings and the device's: YIN and a headset mic.
    settings.value = { ...DEFAULT_SETTINGS, detector: 'yin' };
    deviceSettings.value = { ...DEFAULT_DEVICE_SETTINGS, inputDeviceId: 'headset' };
    expect(mocks.setDetector).toHaveBeenCalledWith('yin');
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(mocks.setPreferredInput).toHaveBeenLastCalledWith('headset');

    // Unrelated changes post nothing to the engine.
    settings.value = { ...settings.value, theme: 'dark' };
    deviceSettings.value = { ...deviceSettings.value, headphoneGuideSeen: true };
    expect(mocks.setDetector).toHaveBeenCalledTimes(1);
    expect(mocks.setPreferredInput).toHaveBeenCalledTimes(2);

    // A switch to a profile on the default detector goes back to it.
    settings.value = { ...DEFAULT_SETTINGS };
    expect(mocks.setDetector).toHaveBeenLastCalledWith('mpm');
  });
});
