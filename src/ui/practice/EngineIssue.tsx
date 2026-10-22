/**
 * EngineIssue: what the free-singing screens (Live, Vibrato meter) say when the microphone is not in a good state: the
 * reason with the fix and one "Tap to reconnect" (called straight from the click, as iOS needs), plus the Bluetooth-mic
 * warning (docs/DESIGN.md §6: errors next to the cause, in plain words, with the fix).
 */
import type { JSX } from 'preact';
import { isLikelyBluetoothLabel } from '../../audio/platform';
import type { AudioEngine, EngineError, EngineErrorCode } from '../../audio/engine-types';
import { engineError, engineInfo, engineState } from '../../state/engine-store';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';

const REASONS: Partial<Record<EngineErrorCode, string>> = {
  'permission-denied': 'Microphone access was blocked.',
  'mic-ended': 'The microphone stopped — this can happen after a while in the background on iOS.',
  'route-changed': 'Your audio route changed (headphones plugged in or out).',
  'session-interrupted': 'The audio session was interrupted — a call, Siri, or the lock screen.',
  'no-microphone': 'No microphone was found.',
  'mic-in-use': 'The microphone is being used by another app.',
  'insecure-context': 'This page needs HTTPS to use the microphone.',
  'no-mediadevices': 'This browser cannot access the microphone.',
  'worklet-unsupported': "This browser doesn't support the audio processing Pitch Lab needs.",
};

function reasonMessage(error: EngineError | null): string {
  if (!error) return 'The microphone connection was lost.';
  return REASONS[error.code] ?? error.message;
}

export function EngineIssue(props: { engine: AudioEngine }): JSX.Element | null {
  const { engine } = props;
  const state = engineState.value;
  const error = engineError.value;
  const needsReconnect = state === 'interrupted' || state === 'error';
  const bluetooth = isLikelyBluetoothLabel(engineInfo.value.inputDeviceLabel ?? '');
  if (!needsReconnect && !bluetooth) return null;

  function reconnect(): void {
    const pending = engineError.value?.code === 'route-changed' ? engine.reset() : engine.resume();
    pending.catch(() => {});
  }

  return (
    <>
      {needsReconnect ? (
        <Banner kind={state === 'error' ? 'error' : 'warn'} message={reasonMessage(error)}>
          {error?.code === 'permission-denied' ? (
            <p class="pl-body-s pl-muted">
              iPhone: Settings &rsaquo; Safari &rsaquo; Microphone (or the "aA" menu &rsaquo; Website Settings).
              <br />
              Chrome: tap the site-info icon in the address bar &rsaquo; Site settings &rsaquo; Microphone &rsaquo; Allow.
            </p>
          ) : null}
          <Button variant="secondary" block onClick={reconnect}>
            Tap to reconnect
          </Button>
        </Banner>
      ) : null}
      {bluetooth ? <Banner kind="warn" message="Bluetooth mic detected: use the phone or laptop mic for accurate pitch." /> : null}
    </>
  );
}
