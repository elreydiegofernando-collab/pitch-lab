/**
 * Short previews on the import screen (DESIGN.md §13.8): a few seconds of a MIDI track's melody line, and the
 * backing track against the melody (and, when asked, a click) at the offset being set. Both play through the
 * reference synth and the engine's output on the AudioContext clock. Call them straight from a click handler:
 * getSynth() creates and resumes the AudioContext inside the gesture (iOS). Nothing is recorded.
 */
import { getEngine } from '../../audio/engine';
import { musicalClickGain } from '../../audio/synth';
import { backingSchedule, metronomeBpm, PHRASE_LEAD_SEC } from '../../runtime/song-session';
import { getSynth } from '../../state/audio';
import { settings } from '../../state/settings';
import { isPitchedNote } from '../../song/pitched';
import type { Song, SongNote } from '../../song/types';

export interface PreviewHandle {
  /** AudioContext time the preview ends. */
  readonly endAt: number;
  stop(): void;
}

/** Lead before the first sound, so nothing is scheduled in the past. */
const START_LEAD_SEC = 0.08;

/** The pitched notes from the first one on, for `seconds`, relative to that first note (cut at the end). */
function opening(notes: readonly SongNote[], fromSec: number, seconds: number): Array<{ midi: number; start: number; duration: number }> {
  return notes
    .filter((n) => isPitchedNote(n) && n.start >= fromSec - 1e-9 && n.start < fromSec + seconds)
    .map((n) => ({ midi: n.midi, start: n.start - fromSec, duration: Math.min(n.duration, fromSec + seconds - n.start) }));
}

/** Play the first `seconds` of a melody line (a MIDI track candidate). Null when it has no pitched note. */
export function previewMelody(notes: readonly SongNote[], seconds: number): PreviewHandle | null {
  const synth = getSynth();
  const ctx = getEngine().context;
  const first = notes.find(isPitchedNote);
  if (!ctx || !first) return null;
  const prefs = settings.value;
  return synth.playSequence(opening(notes, first.start, seconds), {
    startAt: ctx.currentTime + START_LEAD_SEC,
    timbre: prefs.referenceTimbre,
    gain: prefs.referenceVolume,
  });
}

/**
 * Play `seconds` of the song from just before its first note: the backing at the song's offset (backingTimeAt), the
 * melody on the synth, and a click on the chart's beat when `withClick`. The singer moves the offset until they line up.
 */
export function previewBacking(song: Song, buffer: AudioBuffer, seconds: number, withClick: boolean): PreviewHandle | null {
  const synth = getSynth();
  const engine = getEngine();
  const ctx = engine.context;
  const output = engine.output;
  const first = song.notes.find(isPitchedNote);
  if (!ctx || !output || !first) return null;
  const prefs = settings.value;
  const from = first.start - PHRASE_LEAD_SEC;
  const startAt = ctx.currentTime + START_LEAD_SEC;

  let source: AudioBufferSourceNode | null = null;
  const slot = backingSchedule(song, from, 1, startAt, seconds, buffer.duration);
  if (slot) {
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.start(slot.when, slot.offset, slot.duration);
  }
  const melody = synth.playSequence(opening(song.notes, from, seconds), { startAt, timbre: prefs.referenceTimbre, gain: prefs.referenceVolume });
  if (withClick) {
    const beat = 60 / metronomeBpm(song);
    const clickGain = musicalClickGain(prefs.referenceVolume);
    for (let k = Math.ceil(from / beat); k * beat < from + seconds; k++) synth.click(startAt + (k * beat - from), false, clickGain);
  }
  const endAt = startAt + seconds;
  return {
    endAt,
    stop(): void {
      melody.stop();
      synth.stopAll(); // the clicks already handed to the synth
      if (source) {
        source.stop();
        source.disconnect();
        source = null;
      }
    },
  };
}
