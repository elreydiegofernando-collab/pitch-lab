/**
 * The song player's transport row (DESIGN.md §13.9): play/pause, loop the phrase, speed (50 / 75 / 100%), and the
 * key: a semitone stepper with the key that fits the singer's range marked "fits your range", and a plain line when
 * notes still fall outside it. Everything is disabled during a take (one fieldset), so a take is never re-planned
 * under the singer.
 */
import type { JSX } from 'preact';
import { Check, Minus, Pause, Play, Plus, Repeat } from 'lucide-preact';
import { MAX_TRANSPOSE, SONG_SPEEDS, type SongSession, type SongSpeed } from '../../runtime/song-session';
import { Segmented } from '../components/Segmented';
import { count, describeShift, formatShift } from './format';

const SPEED_OPTIONS = SONG_SPEEDS.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }));

export function Transport(props: { session: SongSession; disabled: boolean }): JSX.Element {
  const { session, disabled } = props;
  const playing = session.phase.value === 'playing';
  const loop = session.loop.value;
  const shift = session.shift.value;
  const suggested = session.suggestedShift;
  const fit = session.fit.value;
  return (
    <fieldset class="pl-song-transport" disabled={disabled}>
      <legend class="pl-visually-hidden">Playback</legend>
      <div class="pl-song-transport__row">
        <button type="button" class="pl-song-tbtn" aria-label={playing ? 'Pause' : 'Play from the selected phrase'} onClick={() => session.play()}>
          {playing ? <Pause size={24} strokeWidth={2} aria-hidden="true" /> : <Play size={24} strokeWidth={2} aria-hidden="true" />}
        </button>
        <button type="button" class="pl-song-tbtn" aria-pressed={loop} aria-label="Loop the phrase" onClick={() => session.setLoop(!loop)}>
          <Repeat size={22} strokeWidth={2} aria-hidden="true" />
        </button>
        <Segmented
          class="pl-song-speed"
          aria-label="Speed"
          options={SPEED_OPTIONS}
          value={String(session.speed.value)}
          onChange={(v) => session.setSpeed(Number(v) as SongSpeed)}
        />
      </div>
      <div class="pl-song-transport__row pl-song-key" role="group" aria-label="Key">
        <span class="pl-label">Key</span>
        <button type="button" class="pl-song-tbtn" aria-label="Down a semitone" disabled={shift <= -MAX_TRANSPOSE} onClick={() => session.setShift(shift - 1)}>
          <Minus size={20} strokeWidth={2} aria-hidden="true" />
        </button>
        <output class="pl-song-key__value pl-tabular" aria-live="polite" aria-label={describeShift(shift)}>
          {formatShift(shift)}
        </output>
        <button type="button" class="pl-song-tbtn" aria-label="Up a semitone" disabled={shift >= MAX_TRANSPOSE} onClick={() => session.setShift(shift + 1)}>
          <Plus size={20} strokeWidth={2} aria-hidden="true" />
        </button>
        {shift === suggested ? (
          <span class="pl-song-key__fit">
            <Check size={16} strokeWidth={2.5} aria-hidden="true" />
            fits your range
          </span>
        ) : (
          <button type="button" class="pl-song-key__suggest" onClick={() => session.setShift(suggested)}>
            Fits your range at {formatShift(suggested)}
          </button>
        )}
      </div>
      {fit.outsideExtended > 0 ? (
        <p class="pl-song-key__note pl-song-key__note--warn">
          {count(fit.outsideExtended, 'note')} in this key {fit.outsideExtended === 1 ? 'is' : 'are'} beyond your range.
        </p>
      ) : fit.outsideComfortable > 0 ? (
        <p class="pl-song-key__note">
          {count(fit.outsideComfortable, 'note')} in this key {fit.outsideComfortable === 1 ? 'sits' : 'sit'} outside your comfortable range.
        </p>
      ) : null}
    </fieldset>
  );
}
