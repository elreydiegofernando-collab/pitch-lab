/**
 * Home's two first-run sheets, in this order: the voice-care note (once per profile, docs/DESIGN.md 13.1 and SPEC 12),
 * then the headphone and Setup prompt (once per device). Closing a sheet any way counts as having read it. Both are
 * sheets to read first, so they open with focus on the sheet itself, not on a button.
 */
import type { JSX } from 'preact';
import { SlidersHorizontal } from 'lucide-preact';
import { Button } from '../components/Button';
import { Sheet } from '../components/Sheet';
import { VoiceCareNote } from '../components/VoiceCareNote';

export function VoiceCareSheet(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;
  return (
    <Sheet open={open} title="Voice care" onClose={onClose} initialFocus="sheet">
      <p class="pl-body pl-prose">Your voice is the instrument. A few habits keep it healthy.</p>
      <VoiceCareNote />
      <Button variant="primary" block onClick={onClose} data-testid="voice-care-done">
        Got it
      </Button>
    </Sheet>
  );
}

export function HeadphoneSheet(props: { open: boolean; onLater: () => void; onSetup: () => void }): JSX.Element | null {
  const { open, onLater, onSetup } = props;
  return (
    <Sheet open={open} title="Before you start" onClose={onLater} initialFocus="sheet">
      <p class="pl-body">Wired headphones are recommended: the reference tones won't bleed into the mic while you sing.</p>
      <p class="pl-body-s pl-muted">
        Bluetooth and AirPods add about 120-300 ms of delay and their mic is narrowband. Pitch Lab will ask you to use the
        phone or laptop mic even when your headphones are connected.
      </p>
      <div class="pl-row-flex">
        <Button variant="ghost" onClick={onLater}>
          Later
        </Button>
        <Button variant="primary" icon={SlidersHorizontal} onClick={onSetup}>
          Set up now
        </Button>
      </div>
    </Sheet>
  );
}
