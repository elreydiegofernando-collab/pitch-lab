/**
 * MoreSheet: what the "More" button of the Level, Sing and Vibrato meter screens opens (docs/DESIGN.md §13.3). The
 * demo option every screen shares is the Listen volume; screens add their own sections above it. Setup & calibration is
 * here too, and "Reset audio" on the screens that open the microphone (the iOS escape hatch for output stuck on the
 * earpiece). The Level screen also offers "Send to Claude" here, always (the coaching file of its exercise). These are
 * non-skill preferences and tools, so they are always available (SPEC §11.1).
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { RotateCcw, Send, SlidersHorizontal } from 'lucide-preact';
import { navigate } from '../../router';
import { resetAudio } from '../../state/audio';
import { settings, updateSettings } from '../../state/settings';
import { Button } from '../components/Button';
import { Sheet } from '../components/Sheet';
import { Slider } from '../components/Slider';

export interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  /** Offer "Reset audio" (screens that open the microphone). */
  showReset?: boolean;
  /** Offer "Send to Claude": the sheet closes, then this opens the coaching-file sheet (the Level screen). */
  onSendToClaude?: () => void;
  /** Screen-specific sections, above the shared ones. */
  children?: ComponentChildren;
}

export function MoreSheet(props: MoreSheetProps): JSX.Element {
  const { open, onClose, showReset = false, onSendToClaude, children } = props;
  const [resetBusy, setResetBusy] = useState(false);
  const volume = settings.value.referenceVolume;

  function handleReset(): void {
    // Direct call inside the gesture: resetAudio() starts engine.reset() before any await.
    const pending = resetAudio();
    setResetBusy(true);
    pending.catch(() => {}).finally(() => setResetBusy(false));
  }

  return (
    <Sheet open={open} title="More" onClose={onClose}>
      {children}
      {onSendToClaude ? (
        <div class="pl-stack" data-testid="more-send">
          <Button
            variant="secondary"
            icon={Send}
            onClick={() => {
              onClose();
              onSendToClaude();
            }}
          >
            Send to Claude
          </Button>
          <p class="pl-body-s pl-muted pl-prose">Save a file of your last takes of this exercise, for a closer look in chat.</p>
        </div>
      ) : null}
      <div class="pl-stack">
        <div class="pl-row-flex">
          <span class="pl-label">Listen volume</span>
          <span class="pl-data pl-tabular">{Math.round(volume * 100)}%</span>
        </div>
        <Slider value={volume} min={0} max={1} step={0.05} aria-label="Listen volume" onChange={(v) => updateSettings({ referenceVolume: v })} />
      </div>
      {showReset ? (
        <Button variant="secondary" icon={RotateCcw} loading={resetBusy} onClick={handleReset}>
          Reset audio
        </Button>
      ) : null}
      <Button
        variant="ghost"
        icon={SlidersHorizontal}
        onClick={() => {
          onClose();
          navigate('setup');
        }}
      >
        Setup &amp; calibration
      </Button>
    </Sheet>
  );
}
