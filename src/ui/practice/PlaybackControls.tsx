/**
 * PlaybackControls: "Play take", "Slow (0.5×)" and, for runs, "Slow + target" (docs/DESIGN.md §13.5). Each is a toggle that
 * calls the player straight from its click handler, because the AudioContext may need resuming inside the gesture. The
 * slowed copy is computed in the background; its buttons wait with an inline spinner until it is ready. All three are
 * secondary buttons: the report's one amber button is its next step.
 */
import { useEffect, useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import { Hourglass, Layers, Play, Square } from 'lucide-preact';
import type { TakeAudio } from '../../audio/take-recorder';
import type { Timbre } from '../../audio/synth-types';
import { getEngine } from '../../audio/engine';
import type { TargetNote } from '../../core/types';
import { getSynth } from '../../state/audio';
import { Button } from '../components/Button';
import { createTakePlayer, type PlaybackEnv, type PlaybackMode } from './playback';

/** The real device: the engine's AudioContext and output, and the app's reference synth. */
const deviceEnv: PlaybackEnv = {
  acquire() {
    const engine = getEngine();
    const ctx = engine.ensureContext();
    const destination = engine.output;
    if (!destination) throw new Error('The audio output is not ready.');
    return { ctx, destination };
  },
  synth: getSynth,
};

export interface PlaybackControlsProps {
  audio: TakeAudio;
  /** Run notes for "Slow + target"; empty hides that button. */
  targetNotes: readonly TargetNote[];
  timbre: Timbre;
  gain: number;
  env?: PlaybackEnv;
}

export function PlaybackControls(props: PlaybackControlsProps): JSX.Element {
  const { audio, targetNotes, timbre, gain, env = deviceEnv } = props;
  const player = useMemo(() => createTakePlayer({ audio, targetNotes, timbre, gain, env }), [audio, targetNotes, timbre, gain, env]);
  useEffect(() => () => player.dispose(), [player]);

  const playing = player.playing.value;
  const slowReady = player.slowReady.value;
  const error = player.error.value;
  const toggle = (mode: PlaybackMode): void => {
    if (playing === mode) player.stop();
    else player.play(mode);
  };

  return (
    <section class="pl-playback" aria-label="Hear your take">
      <h2 class="pl-label">Hear it back</h2>
      <div class="pl-playback__row">
        <Button variant="secondary" icon={playing === 'normal' ? Square : Play} onClick={() => toggle('normal')} data-testid="play-take">
          {playing === 'normal' ? 'Stop' : 'Play take'}
        </Button>
        <Button
          variant="secondary"
          icon={playing === 'slow' ? Square : Hourglass}
          loading={!slowReady}
          onClick={() => toggle('slow')}
          aria-label={slowReady ? undefined : 'Slow, half speed: getting it ready'}
          data-testid="play-slow"
        >
          {playing === 'slow' ? 'Stop' : 'Slow (0.5×)'}
        </Button>
        {targetNotes.length > 0 ? (
          <Button
            variant="secondary"
            icon={playing === 'slow-target' ? Square : Layers}
            loading={!slowReady}
            onClick={() => toggle('slow-target')}
            aria-label={slowReady ? undefined : 'Slow with the target notes: getting it ready'}
            data-testid="play-slow-target"
          >
            {playing === 'slow-target' ? 'Stop' : 'Slow + target'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p class="pl-body-s pl-playback__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
