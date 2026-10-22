import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { importMidi, MidiImportError, monophonize, scoreMidiTracks } from './midi';
import * as F from './midi-fixtures';
import { backingTimeAt } from './timing';
import { expectValidSong, seededRandom } from './song-invariants';
import { parseUltraStar, serializeUltraStar } from './ultrastar';

type N = { midi: number; time: number; duration: number };

function addTrack(midi: Midi, name: string, notes: N[], channel?: number) {
  const track = midi.addTrack();
  track.name = name;
  for (const n of notes) track.addNote(n);
  if (channel !== undefined) track.channel = channel;
  return track;
}

/** A plain eighth-note-ish tune: `count` notes, 0.5 s apart, 0.4 s long. */
function tune(count: number, base = 60): N[] {
  return Array.from({ length: count }, (_, i) => ({ midi: base + (i % 5), time: i * 0.5, duration: 0.4 }));
}

function newMidi(bpm = 120): Midi {
  const m = new Midi();
  m.header.setTempo(bpm);
  return m;
}

/** 120 bpm, ppq 480: one second is 960 ticks. */
const SEC = 960;

describe('scoreMidiTracks: melody-track selection', () => {
  it('prefers a monophonic vocal-range track over a chordal pad', () => {
    const midi = newMidi();
    addTrack(midi, 'Lead Vocal', tune(16, 64));
    const pad = midi.addTrack();
    pad.name = 'Pad';
    for (let i = 0; i < 8; i++) for (const m of [48, 52, 55]) pad.addNote({ midi: m, time: i, duration: 0.9 });
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Lead Vocal');
    expect(c.find((x) => x.name === 'Pad')!.monophonicRatio).toBeLessThan(0.5);
  });

  it('never ranks percussion above a melody, however busy', () => {
    const midi = newMidi();
    addTrack(midi, 'Melody', tune(16, 67));
    addTrack(midi, 'Drums', tune(64, 38), 9);
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Melody');
    const drums = c.find((x) => x.name === 'Drums')!;
    expect(drums.percussion).toBe(true);
    expect(drums.score).toBeLessThan(0);
  });

  it('rewards a name match (vocal, melody, lead, voice, voz) as a tie-break', () => {
    for (const name of ['Vocals', 'melody', 'LEAD 1', 'Voice', 'Voz principal']) {
      const midi = newMidi();
      addTrack(midi, 'Synth 1', tune(16, 65));
      addTrack(midi, name, tune(16, 65));
      const c = scoreMidiTracks(midi);
      expect(c[0].name).toBe(name);
      expect(c[0].nameMatch).toBe(true);
    }
  });

  it('also matches the General MIDI instrument name', () => {
    const midi = newMidi();
    addTrack(midi, 'Track A', tune(16, 65));
    const choir = addTrack(midi, 'Track B', tune(16, 65));
    choir.instrument.number = 53; // voice oohs
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Track B');
    expect(c[0].instrument).toMatch(/voice/);
  });

  it('skips empty tracks and reports the index into midi.tracks', () => {
    const midi = newMidi();
    midi.addTrack().name = 'Empty';
    addTrack(midi, 'Melody', tune(8, 60));
    const c = scoreMidiTracks(midi);
    expect(c).toHaveLength(1);
    expect(c[0].index).toBe(1);
  });

  it('tolerates the tiny overlaps of legato sequencing, but not real polyphony', () => {
    const legato = newMidi();
    addTrack(legato, 'Legato', Array.from({ length: 16 }, (_, i) => ({ midi: 60 + (i % 4), time: i * 0.5, duration: 0.52 }))); // 20 ms overlap
    expect(scoreMidiTracks(legato)[0].monophonicRatio).toBe(1);

    const chords = newMidi();
    addTrack(chords, 'Chords', Array.from({ length: 16 }, (_, i) => ({ midi: 60 + (i % 4), time: i * 0.5, duration: 0.9 }))); // 400 ms overlap
    expect(scoreMidiTracks(chords)[0].monophonicRatio).toBeLessThan(0.1);
  });

  it('a three-note track is not a melody', () => {
    const midi = newMidi();
    addTrack(midi, 'Stinger', tune(3, 64));
    addTrack(midi, 'Tune', tune(24, 62));
    expect(scoreMidiTracks(midi)[0].name).toBe('Tune');
  });

  it('prefers melody-like density to a dense arpeggio', () => {
    const midi = newMidi();
    addTrack(midi, 'Arp', Array.from({ length: 64 }, (_, i) => ({ midi: 60 + (i % 7), time: i * 0.0625, duration: 0.06 }))); // 16 notes/s
    addTrack(midi, 'Tune', tune(24, 60));
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Tune');
    expect(c[0].score).toBeGreaterThan(c[1].score + 0.5);
  });

  it('prefers a track inside the singing range to a bass line below it', () => {
    const midi = newMidi();
    addTrack(midi, 'Bass', Array.from({ length: 16 }, (_, i) => ({ midi: 28 + (i % 4) * 2, time: i * 0.5, duration: 0.4 })));
    addTrack(midi, 'Tune', tune(16, 62));
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Tune');
    expect(c.find((x) => x.name === 'Bass')!.rangeFitRatio).toBeLessThan(0.5);
  });

  it('reports each track\'s pitch span and register', () => {
    const midi = newMidi();
    addTrack(midi, 'Tune', tune(10, 60));
    const c = scoreMidiTracks(midi)[0];
    expect([c.lowestMidi, c.highestMidi]).toEqual([60, 64]);
    expect(c.medianMidi).toBe(62);
    expect(c.noteCount).toBe(10);
  });

  it('breaks a tie toward the higher register: the melody is on top (piano right hand over left)', () => {
    const midi = newMidi();
    addTrack(midi, 'Left hand', tune(24, 46));
    addTrack(midi, 'Right hand', tune(24, 72));
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Right hand');
    expect(c[0].score - c[1].score).toBeGreaterThan(0.5);
  });

  it('prefers the line that runs through the song to a short decoration in the same register', () => {
    const midi = newMidi();
    addTrack(midi, 'Short', tune(24, 62)); // 12 s
    addTrack(midi, 'Whole song', tune(48, 62)); // 24 s
    const c = scoreMidiTracks(midi);
    expect(c[0].name).toBe('Whole song');
    expect(c[0].coverage).toBeCloseTo(1, 2);
    expect(c[1].coverage).toBeCloseTo(0.5, 1);
    expect(c[0].score - c[1].score).toBeGreaterThan(0.6);
  });

  it('but a register preference never outvotes polyphony: a clean line beats high chords', () => {
    const midi = newMidi();
    addTrack(midi, 'Clean low line', tune(24, 50));
    const chords = midi.addTrack();
    chords.name = 'High chords';
    // three notes per slot: two of every three consecutive pairs overlap completely
    for (let i = 0; i < 8; i++) for (const m of [76, 79, 83]) chords.addNote({ midi: m, time: i * 0.5, duration: 0.45 });
    expect(scoreMidiTracks(midi)[0].name).toBe('Clean low line');
  });
});

describe('monophonize (skyline)', () => {
  const n = (start: number, end: number, midi: number) => ({ start, end, midi });

  it('keeps only the top note of a chord', () => {
    expect(monophonize([n(0, 1, 60), n(0, 1, 64), n(0, 1, 67)])).toEqual([n(0, 1, 67)]);
  });

  it('trims a legato overlap and lets the next note take over', () => {
    expect(monophonize([n(0, 1.1, 60), n(1, 2, 62)])).toEqual([n(0, 1, 60), n(1, 2, 62)]);
  });

  it('drops accompaniment struck under a held higher note', () => {
    expect(monophonize([n(0, 2, 72), n(1, 1.5, 60)])).toEqual([n(0, 2, 72)]);
  });

  it('lets a higher note interrupt a held lower one', () => {
    expect(monophonize([n(0, 2, 60), n(1, 1.5, 72)])).toEqual([n(0, 1, 60), n(1, 1.5, 72)]);
  });

  it('drops duplicates, sub-30 ms fragments and unsorted input order', () => {
    const out = monophonize([n(1, 2, 62), n(0, 0.5, 60), n(0, 0.5, 60), n(0.5, 0.52, 61)]);
    expect(out).toEqual([n(0, 0.5, 60), n(1, 2, 62)]);
  });

  it('returns [] for no notes', () => {
    expect(monophonize([])).toEqual([]);
  });

  it('always returns a sorted, non-overlapping line of singable notes drawn from the input (seeded fuzz)', () => {
    let s = 12345;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let round = 0; round < 200; round++) {
      const input = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => {
        const start = Math.floor(rnd() * 40) / 8;
        return n(start, start + 0.02 + Math.floor(rnd() * 16) / 8, 48 + Math.floor(rnd() * 24));
      });
      const out = monophonize(input);
      for (let i = 0; i < out.length; i++) {
        expect(out[i].end - out[i].start).toBeGreaterThanOrEqual(0.03 - 1e-9);
        expect(input.some((x) => x.midi === out[i].midi && x.start === out[i].start)).toBe(true);
        if (i > 0) {
          expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
          expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end - 1e-9);
        }
      }
    }
  });
});

describe('importMidi: notes, tracks and metadata', () => {
  it('builds a Song from the best-scored track', () => {
    const midi = newMidi(100);
    addTrack(midi, 'Lead Vocal', tune(12, 60));
    addTrack(midi, 'Drums', tune(12, 36), 9);
    const { song, selectedTrackIndex, candidates, warnings } = importMidi(midi);
    expect(selectedTrackIndex).toBe(0);
    expect(candidates[0].index).toBe(0);
    expect(song.source).toBe('midi');
    expect(song.bpm).toBe(100);
    expect(song.notes).toHaveLength(12);
    expect(song.notes[0]).toMatchObject({ midi: 60, type: 'normal', lyric: '' });
    expect(song.notes[0].start).toBeCloseTo(0, 6);
    expect(song.backingRef).toBeNull();
    expect(song.offsetMs).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('honours a manual trackIndex override', () => {
    const midi = newMidi();
    addTrack(midi, 'Lead Vocal', tune(8, 64));
    addTrack(midi, 'Harmony', tune(8, 60));
    const { selectedTrackIndex, song } = importMidi(midi, { trackIndex: 1 });
    expect(selectedTrackIndex).toBe(1);
    expect(song.notes[0].midi).toBe(60);
  });

  it('rejects an override that does not exist or has no notes', () => {
    const midi = newMidi();
    addTrack(midi, 'Tune', tune(8));
    midi.addTrack().name = 'Empty';
    expect(() => importMidi(midi, { trackIndex: 9 })).toThrow(MidiImportError);
    expect(() => importMidi(midi, { trackIndex: 1 })).toThrow(/no notes/);
  });

  it('warns when the chosen track is percussion', () => {
    const midi = newMidi();
    addTrack(midi, 'Drums', tune(8, 36), 9);
    expect(importMidi(midi).warnings.join(' ')).toMatch(/percussion/);
  });

  it('reduces a polyphonic track to its top line and says so', () => {
    const midi = newMidi();
    const t = midi.addTrack();
    t.name = 'Piano';
    for (let i = 0; i < 8; i++) for (const m of [60, 64, 67]) t.addNote({ midi: m + (i % 2), time: i * 0.5, duration: 0.45 });
    const { song, warnings } = importMidi(midi);
    expect(song.notes).toHaveLength(8);
    expect(song.notes.map((x) => x.midi)).toEqual([67, 68, 67, 68, 67, 68, 67, 68]);
    expect(warnings.join(' ')).toMatch(/polyphonic/);
  });

  it('never emits overlapping notes', () => {
    const midi = newMidi();
    addTrack(midi, 'Messy', [
      { midi: 60, time: 0, duration: 1.2 },
      { midi: 62, time: 1, duration: 1 },
      { midi: 71, time: 1.5, duration: 0.5 },
      { midi: 55, time: 1.6, duration: 0.2 },
    ]);
    const { song } = importMidi(midi);
    for (let i = 1; i < song.notes.length; i++) {
      expect(song.notes[i].start).toBeGreaterThanOrEqual(song.notes[i - 1].start + song.notes[i - 1].duration - 1e-9);
    }
  });

  it('fails clearly for unreadable bytes and for files with no notes', () => {
    expect(() => importMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(MidiImportError);
    expect(() => importMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a readable MIDI file/);
    const empty = newMidi();
    empty.addTrack().name = 'Empty';
    expect(() => importMidi(empty)).toThrow(/no track with notes/);
  });

  it('produces a song that survives JSON unchanged (a stray NaN would come back as null and fail this)', () => {
    const midi = newMidi();
    addTrack(midi, 'Lead Vocal', tune(8, 60));
    const { song } = importMidi(midi);
    expect(JSON.parse(JSON.stringify(song))).toEqual(song);
  });

  it('rates the song itself', () => {
    const midi = newMidi();
    // 16 sixteenth-ish notes in 1.5 s across a wide span: a run, not a hymn.
    addTrack(midi, 'Run', Array.from({ length: 16 }, (_, i) => ({ midi: 60 + i, time: i * 0.09, duration: 0.08 })));
    const { song } = importMidi(midi);
    expect(song.difficulty.requiredWorld).toBe('runs');
    expect(song.difficulty.lowestMidi).toBe(60);
    expect(song.difficulty.highestMidi).toBe(75);
  });

  it('builds phrases at rests of at least CONFIG.song.phraseGapMs', () => {
    const gap = CONFIG.song.phraseGapMs / 1000;
    const just = importMidi(
      (() => {
        const m = newMidi();
        addTrack(m, 'T', [
          { midi: 60, time: 0, duration: 0.3 },
          { midi: 62, time: 0.3, duration: 0.3 },
          { midi: 64, time: 0.6 + gap + 0.01, duration: 0.3 }, // a rest just over the gap: a new phrase
          { midi: 65, time: 0.9 + gap + 0.01 + (gap - 0.05), duration: 0.3 }, // a rest just under the gap: same phrase
        ]);
        return m;
      })(),
    ).song;
    expect(just.phrases.map((p) => [p.from, p.to])).toEqual([[0, 2], [2, 4]]);
    expect(just.phrases[0].start).toBeCloseTo(0, 6);
    expect(just.phrases[0].end).toBeCloseTo(0.6, 3);
  });
});

describe('importMidi: ids and titles', () => {
  it('derives a stable content id, different per file and per chosen track', () => {
    const build = (pitch: number) => {
      const m = newMidi();
      addTrack(m, 'Lead Vocal', tune(8, pitch));
      addTrack(m, 'Other', tune(8, 70));
      return m.toArray();
    };
    const a = importMidi(build(60));
    expect(a.song.id).toMatch(/^midi-[0-9a-f]{16}-t0$/);
    expect(importMidi(build(60)).song.id).toBe(a.song.id);
    expect(importMidi(build(61)).song.id).not.toBe(a.song.id);
    expect(importMidi(build(60), { trackIndex: 1 }).song.id).toMatch(/-t1$/);
    expect(importMidi(build(60), { id: 'mine' }).song.id).toBe('mine');
  });

  it('reads bytes as an ArrayBuffer, a Uint8Array or a plain array alike', () => {
    const m = newMidi(90);
    addTrack(m, 'Lead Vocal', tune(8, 67));
    const bytes = m.toArray();
    const a = importMidi(bytes).song;
    const b = importMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).song;
    const c = importMidi(Array.from(bytes)).song;
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(a.bpm).toBeCloseTo(90, 3); // tempo is stored as integer microseconds per quarter note
    expect(a.notes[0].midi).toBe(67);
  });

  it('takes the title from the file name track unless it is generic, and lets a caller override it', () => {
    const named = F.smf([[F.trackName(0, 'My Tune'), F.tempoEvent(0, 120)], [F.trackName(0, 'Melody'), ...noteRun(8)]]);
    expect(importMidi(named).song.title).toBe('My Tune');
    const generic = F.smf([[F.trackName(0, 'Untitled'), F.tempoEvent(0, 120)], [F.trackName(0, 'Melody'), ...noteRun(8)]]);
    expect(importMidi(generic).song.title).toBe('');
    for (const name of ['Tempo Track', 'Track 1', 'Conductor', 'Sequence 2']) {
      expect(importMidi(F.smf([[F.trackName(0, name), F.tempoEvent(0, 120)], [F.trackName(0, 'Melody'), ...noteRun(8)]])).song.title).toBe('');
    }
    const real = F.smf([[F.trackName(0, 'Tempo di Valse'), F.tempoEvent(0, 120)], [F.trackName(0, 'Melody'), ...noteRun(8)]]);
    expect(importMidi(real).song.title).toBe('Tempo di Valse');
    expect(importMidi(named, { title: 'Chosen' }).song.title).toBe('Chosen');
  });
});

/** Eight quarter notes (0.5 s) on channel 0, rising a tone each. */
function noteRun(count: number, channel = 0, start = 60): F.TrackEvent[] {
  return Array.from({ length: count }, (_, i) => F.noteEvents(channel, start + i, i * 480, 420)).flat();
}

describe('importMidi: tempo and timing', () => {
  it('warns when there is no tempo and assumes 120', () => {
    const midi = new Midi();
    addTrack(midi, 'T', tune(4));
    const { song, warnings } = importMidi(midi);
    expect(song.bpm).toBe(120);
    expect(warnings.join(' ')).toMatch(/tempo/i);
  });

  it('keeps note times exact across a tempo change and reports the opening tempo', () => {
    // ppq 480; 120 bpm for the first two beats (1.0 s), then 240 bpm.
    const bytes = F.smf([
      [F.tempoEvent(0, 120), F.tempoEvent(960, 240)],
      [...F.noteEvents(0, 60, 0, 480), ...F.noteEvents(0, 62, 960, 480), ...F.noteEvents(0, 64, 1920, 480)],
    ]);
    const { song, warnings } = importMidi(bytes);
    expect(song.bpm).toBeCloseTo(120, 3);
    expect(song.notes.map((n) => n.start)).toEqual([expect.closeTo(0, 6), expect.closeTo(1.0, 4), expect.closeTo(1.5, 4)]);
    expect(song.notes[1].duration).toBeCloseTo(0.25, 4);
    expect(warnings.join(' ')).toMatch(/tempo changes/);
  });

  it('trims a long silent intro to a 2 s lead-in and records the trim as the backing offset', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...F.noteEvents(0, 60, 10 * SEC, 480), ...F.noteEvents(0, 62, 11 * SEC, 480)]]);
    const { song } = importMidi(bytes);
    expect(song.notes[0].start).toBeCloseTo(2, 6);
    expect(song.notes[1].start).toBeCloseTo(3, 6); // spacing is untouched
    expect(song.offsetMs).toBe(8000);
    expect(song.phrases[0].start).toBeCloseTo(2, 6);
    // a backing track recorded alongside the MIDI stays aligned: the file's own time 10 s is still audio position 10 s
    expect(backingTimeAt(song, song.notes[0].start)).toBeCloseTo(10, 6);
    expect(backingTimeAt(song, song.notes[1].start)).toBeCloseTo(11, 6);
  });

  it('can keep the file\'s own timing or use another lead-in', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...F.noteEvents(0, 60, 10 * SEC, 480), ...F.noteEvents(0, 62, 11 * SEC, 480)]]);
    const asIs = importMidi(bytes, { leadInSec: null }).song;
    expect([asIs.notes[0].start, asIs.offsetMs]).toEqual([expect.closeTo(10, 6), 0]);
    const noLead = importMidi(bytes, { leadInSec: 0 }).song;
    expect([noLead.notes[0].start, noLead.offsetMs]).toEqual([expect.closeTo(0, 6), 10000]);
    const five = importMidi(bytes, { leadInSec: 5 }).song;
    expect([five.notes[0].start, five.offsetMs]).toEqual([expect.closeTo(5, 6), 5000]);
  });

  it('leaves a melody that already starts within the lead-in alone', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...F.noteEvents(0, 60, SEC, 480)]]); // starts at 1 s
    const { song } = importMidi(bytes);
    expect(song.notes[0].start).toBeCloseTo(1, 6);
    expect(song.offsetMs).toBe(0);
  });

  it('trims in whole milliseconds so the offset and the note times agree exactly', () => {
    const tick = 2881; // 3.00104... s
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...F.noteEvents(0, 60, tick, 480)]]);
    const original = tick / 960;
    const { song } = importMidi(bytes);
    expect(Number.isInteger(song.offsetMs)).toBe(true);
    expect(backingTimeAt(song, song.notes[0].start)).toBeCloseTo(original, 9);
  });

  it('places lyrics before trimming, so they still land on the right notes', () => {
    const bytes = F.smf([
      [F.tempoEvent(0, 120)],
      [...[60, 62].flatMap((m, i) => F.noteEvents(0, m, (20 + i) * SEC, 800))],
      [F.lyricEvent(20 * SEC, 'Hel'), F.lyricEvent(21 * SEC, 'lo')],
    ]);
    const { song } = importMidi(bytes);
    // spaceless syllables: the second gets the word-start space, the first (a phrase start) does not
    expect(song.notes.map((n) => n.lyric)).toEqual(['Hel', ' lo']);
    expect(song.notes[0].start).toBeCloseTo(2, 6);
    expect(song.offsetMs).toBe(18000);
  });

  it('reads a format 0 file by splitting the channels and picking the melody', () => {
    const events = [
      F.tempoEvent(0, 120),
      ...Array.from({ length: 12 }, (_, i) => F.noteEvents(0, 64 + (i % 5), i * 480, 420)).flat(),
      ...Array.from({ length: 6 }, (_, i) => F.noteEvents(1, 36, i * 960, 900)).flat(),
    ];
    const { song, candidates } = importMidi(F.smf([events], { format: 0 }));
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(song.notes).toHaveLength(12);
    expect(song.notes[0].midi).toBe(64);
  });
});

describe('importMidi: lyrics', () => {
  /** 4 notes, 1 s apart (ppq 480 at 120 bpm: 960 ticks per second). */
  const melody = (): F.TrackEvent[] => [60, 62, 64, 65].flatMap((m, i) => F.noteEvents(0, m, i * SEC, 800));

  it('attaches header.meta lyric events to the nearest note onset (in-memory Midi)', () => {
    const midi = newMidi();
    addTrack(midi, 'Lead Vocal', [
      { midi: 60, time: 0, duration: 0.4 },
      { midi: 62, time: 0.5, duration: 0.4 },
    ]);
    midi.header.meta.push({ type: 'lyrics', text: 'Hel', ticks: 0 }, { type: 'lyrics', text: 'lo', ticks: midi.header.secondsToTicks(0.52) });
    const { song, lyricSyllables, lyricsMatched } = importMidi(midi);
    expect(song.notes.map((n) => n.lyric)).toEqual(['Hel', ' lo']); // spaceless syllables: see "lyric spacing" below
    expect([lyricSyllables, lyricsMatched]).toEqual([2, 2]);
  });

  it('finds karaoke words on a separate track, with "/" line breaks and an @T title and artist', () => {
    const syllables = ['/Hel', 'lo ', '\\Wor', 'ld ', '/Come', ' on ', 'ba', 'by'];
    const bytes = F.smf([
      [F.tempoEvent(0, 120), F.trackName(0, 'ignored')],
      [F.trackName(0, 'Melody'), ...Array.from({ length: 8 }, (_, i) => F.noteEvents(0, 60 + i, i * SEC, 800)).flat()],
      [
        F.trackName(0, 'Words'),
        F.textEvent(0, '@KMIDI KARAOKE FILE'),
        F.textEvent(0, '@TMy Song'),
        F.textEvent(0, '@TSome Singer'),
        ...syllables.map((s, i) => F.textEvent(i * SEC, s)),
      ],
    ]);
    const { song, lyricSyllables, lyricsMatched } = importMidi(bytes);
    expect(song.title).toBe('My Song');
    expect(song.artist).toBe('Some Singer');
    expect(song.notes.map((n) => n.lyric)).toEqual(['Hel', 'lo ', 'Wor', 'ld ', 'Come', ' on ', 'ba', 'by']);
    // "\" starts a paragraph at the third note and "/" a line at the fifth, so the notes split there without any long rest
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 2], [2, 4], [4, 8]]);
    expect([lyricSyllables, lyricsMatched]).toEqual([8, 8]);
  });

  it('ignores plain text annotations that do not line up with notes, silently (they are not lyrics)', () => {
    const annotations = ['Allegro', 'Fuga 1', 'Fuga 2', 'Subject', 'Answer', 'Episode', 'Stretto', 'Coda'].map((t, i) => F.textEvent(100 * SEC + i * SEC, t));
    const bytes = F.smf([[F.tempoEvent(0, 120), ...annotations], [...melody()]]);
    const { song, lyricSyllables, warnings } = importMidi(bytes);
    expect(lyricSyllables).toBe(0);
    expect(song.notes.every((n) => n.lyric === '')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('still trusts real lyric events that fit this track badly, and says so', () => {
    const far = Array.from({ length: 6 }, (_, i) => F.lyricEvent(100 * SEC + i * SEC, 'la'));
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...melody()], far]);
    const { lyricSyllables, lyricsMatched, warnings } = importMidi(bytes);
    expect([lyricSyllables, lyricsMatched]).toEqual([6, 0]);
    expect(warnings.join(' ')).toMatch(/6 of 6 lyric syllables/);
  });

  it('reads lyric events from a non-first track', () => {
    const bytes = F.smf([
      [F.tempoEvent(0, 120)],
      [...melody()],
      [F.lyricEvent(0, 'a'), F.lyricEvent(SEC, 'b'), F.lyricEvent(2 * SEC, 'c'), F.lyricEvent(3 * SEC, 'd')],
    ]);
    expect(importMidi(bytes).song.notes.map((n) => n.lyric)).toEqual(['a', ' b', ' c', ' d']); // spaceless syllables
  });

  it('decodes Latin-1 lyric bytes', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...melody()], [F.metaBytes(0, 0x05, [0x63, 0x61, 0x66, 0xe9])]]);
    expect(importMidi(bytes).song.notes[0].lyric).toBe('café');
  });

  it('skips lyrics that line up with no note and reports how many', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...melody()], [F.lyricEvent(0, 'ok'), F.lyricEvent(20 * SEC, 'stray'), F.lyricEvent(30 * SEC, 'stray2')]]);
    const { song, warnings, lyricsMatched } = importMidi(bytes);
    expect(song.notes[0].lyric).toBe('ok');
    expect(lyricsMatched).toBe(1);
    expect(warnings.join(' ')).toMatch(/2 of 3 lyric syllables/);
  });

  it('joins two syllables that land on the same note (spaceless ones keep a word-start space between them)', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...melody()], [F.lyricEvent(0, 'Hel'), F.lyricEvent(30, 'lo')]]);
    expect(importMidi(bytes).song.notes[0].lyric).toBe('Hel lo');
    // with real spacing in the file nothing is added: the two syllables are glued exactly as written
    const spaced = F.smf([[F.tempoEvent(0, 120)], [...melody()], [F.lyricEvent(0, 'Hel'), F.lyricEvent(30, 'lo ')]]);
    expect(importMidi(spaced).song.notes[0].lyric).toBe('Hello ');
  });

  it('does not mistake a few annotations for lyrics', () => {
    const bytes = F.smf([[F.tempoEvent(0, 120), F.textEvent(0, 'Verse'), F.textEvent(SEC, 'Chorus')], [...melody()]]);
    const { song, lyricSyllables } = importMidi(bytes);
    expect(lyricSyllables).toBe(0);
    expect(song.notes.every((n) => n.lyric === '')).toBe(true);
  });
});

/**
 * A score-sequenced (LEGATO) melody on one track: every note ends exactly where the next begins, so no rest ever marks a
 * breath, as in hymn and LilyPond exports. `spec` is [syllable | null, ticks, pitch]; each syllable is written as a lyric
 * event at its note's onset, byte for byte (the file's own spacing). 960 ticks = 1 s (ppq 480 at 120 bpm).
 */
function legatoMidi(spec: ReadonlyArray<readonly [string | null, number, number]>): Uint8Array {
  const events: F.TrackEvent[] = [];
  let tick = 0;
  for (const [syllable, ticks, pitch] of spec) {
    events.push(...F.noteEvents(0, pitch, tick, ticks));
    if (syllable !== null) events.push(F.lyricEvent(tick, syllable));
    tick += ticks;
  }
  return F.smf([[F.tempoEvent(0, 120)], events]);
}

const phraseText = (song: { notes: ReadonlyArray<{ lyric: string }>; phrases: ReadonlyArray<{ from: number; to: number }> }): string[] =>
  song.phrases.map((p) => song.notes.slice(p.from, p.to).map((n) => n.lyric).join(''));

describe('importMidi: legato hymn files are cut into phrases at their lyric clauses', () => {
  /**
   * HymnWiki's Excell "Amazing Grace" (a LilyPond export) rebuilt from the bundled chart's rhythm: 35 notes, 28 lyric events, NO
   * rest anywhere (the largest gap between notes is 0.000 s), 28.7 s in all. The events are bare syllables with no spaces or
   * hyphens. [syllable | null for a held "~" tail, beats, pitch]; one beat = 160 ticks = 1/6 s.
   */
  const AMAZING_GRACE: ReadonlyArray<readonly [string | null, number, number]> = [
    ['A', 4, 57], ['maz', 8, 62], ['ing', 2, 66], [null, 2, 62], ['grace!', 8, 66],
    ['How', 4, 64], ['sweet', 8, 62], ['the', 4, 59], ['sound', 8, 57],
    ['That', 4, 57], ['saved', 8, 62], ['a', 2, 66], [null, 2, 62], ['wretch', 8, 66], ['like', 4, 64], ['me!', 12, 69],
    ['I', 4, 66], ['once', 6, 69], [null, 2, 66], ['was', 2, 69], [null, 2, 66], ['lost,', 8, 62],
    ['but', 4, 57], ['now', 6, 59], [null, 2, 62], ['am', 2, 62], [null, 2, 59], ['found;', 8, 57],
    ['Was', 4, 57], ['blind,', 8, 62], ['but', 2, 66], [null, 2, 62], ['now', 8, 66], ['I', 4, 64], ['see.', 8, 62],
  ];
  const amazing = () => importMidi(legatoMidi(AMAZING_GRACE.map(([s, beats, pitch]) => [s, beats * 160, pitch] as const)));

  it('splits the real-shaped Amazing Grace into its clauses instead of one 28.7 s phrase, with readable spacing', () => {
    const { song, lyricSyllables, lyricsMatched } = amazing();
    expect(song.notes).toHaveLength(35);
    expect([lyricSyllables, lyricsMatched]).toEqual([28, 28]);
    for (let i = 1; i < song.notes.length; i++) {
      expect(song.notes[i].start - (song.notes[i - 1].start + song.notes[i - 1].duration)).toBeLessThan(0.001); // legato: no rest to mark a breath
    }
    const last = song.notes[34];
    expect(last.start + last.duration).toBeCloseTo(172 / 6, 3);

    // four clause cuts (after "grace!", "me!", "lost," and "found;"; "blind," is only two notes into its phrase) leave five pieces; the
    // second ("How ... me!", 10.7 s) is over the 10 s cap and is cut again before "a": every held 8-beat note is an equally strong boundary
    // there, and the one after "saved" is nearest the middle
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 5], [5, 11], [11, 16], [16, 22], [22, 28], [28, 35]]);
    expect(phraseText(song)).toEqual([
      'A maz ing grace!',
      'How sweet the sound That saved',
      'a wretch like me!',
      'I once was lost,',
      'but now am found;',
      'Was blind, but now I see.',
    ]);
    // the spacing is the bundled convention: a leading space on every word start, none on a phrase's first syllable
    expect(song.notes.slice(0, 7).map((n) => n.lyric)).toEqual(['A', ' maz', ' ing', '', ' grace!', 'How', ' sweet']);
  });

  it('every phrase tiles the notes, spans first note start to last note end, and starts on a syllable (never on a "~" tail)', () => {
    const { song } = amazing();
    let next = 0;
    for (const p of song.phrases) {
      expect(p.from).toBe(next);
      next = p.to;
      expect(p.start).toBe(song.notes[p.from].start);
      expect(p.end).toBe(song.notes[p.to - 1].start + song.notes[p.to - 1].duration);
      expect(song.notes[p.from].lyric.trim()).not.toBe('');
      expect(p.end - p.start).toBeLessThanOrEqual(10);
      expect(song.notes[p.from].lyric.startsWith(' ')).toBe(false);
    }
    expect(next).toBe(song.notes.length);
  });

  it('is a valid song, and survives the UltraStar round trip with its phrases and its spacing', () => {
    const { song } = amazing();
    expectValidSong(song);
    const back = parseUltraStar(serializeUltraStar(song)).song;
    expect(back.phrases.map((p) => [p.from, p.to])).toEqual(song.phrases.map((p) => [p.from, p.to]));
    expect(back.notes.map((n) => n.lyric)).toEqual(song.notes.map((n) => n.lyric));
    expect(phraseText(back)).toEqual(phraseText(song));
  });

  it('applies the same rules to a hymn whose events carry real spacing (the Ave Maria shape: "a, " with a trailing space)', () => {
    // [syllable | null, ticks]; 480 ticks = 0.5 s. Every line ends in a comma, the first and third also in a held tail.
    const AVE: ReadonlyArray<readonly [string | null, number]> = [
      ['Ma', 480], ['ri', 480], ['a, ', 480], [null, 960],
      ['Do', 480], ['mi', 480], ['nus ', 480], ['te', 480], ['cum, ', 960],
      ['Ma', 480], ['ri', 480], ['a, ', 480], [null, 480],
      ['be', 480], ['ne', 480], ['dic', 480], ['ta ', 480], ['tu ', 480], ['in ', 480], ['mu', 480], ['li', 480], ['e', 480], ['ri', 480], ['bus, ', 960],
      ['et ', 480], ['be', 480], ['ne', 480], ['dic', 480], ['tus ', 480], ['fruc', 480], ['tus ', 480], ['ven', 480], ['tris ', 480], ['tu', 480], ['i ', 480], ['Je', 480], ['sus.', 1440],
    ];
    const { song } = importMidi(legatoMidi(AVE.map(([s, ticks], i) => [s, ticks, 60 + (i % 5)] as const)));
    expect(song.notes).toHaveLength(37);
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 4], [4, 9], [9, 13], [13, 24], [24, 37]]);
    // the held tail after "a, " stays with its word: the phrase break is before the NEXT syllable
    expect(song.notes[3].lyric).toBe('');
    expect(phraseText(song)).toEqual(['Maria, ', 'Dominus tecum, ', 'Maria, ', 'benedicta tu in mulieribus, ', 'et benedictus fructus ventris tui Jesus.']);
    // spacing that is already in the file is never touched
    expect(song.notes.map((n) => n.lyric).slice(0, 3)).toEqual(['Ma', 'ri', 'a, ']);
  });

  it('a lyric-less legato tune is cut by the length cap instead of staying one phrase', () => {
    const tune = Array.from({ length: 36 }, (_, i) => [null, 480, 60 + (i % 5)] as const); // 18 s of half-second notes, no rests
    const { song } = importMidi(legatoMidi(tune));
    expect(song.notes).toHaveLength(36);
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 18], [18, 36]]);
    for (const p of song.phrases) expect(p.end - p.start).toBeLessThanOrEqual(10);
  });

  it('the cap cuts after the long held note that ends a line, not at the exact middle', () => {
    const line = (): Array<readonly [null, number, number]> => Array.from({ length: 12 }, (_, i) => [null, 480, 60 + (i % 5)] as const);
    const { song } = importMidi(legatoMidi([...line(), [null, 1920, 64], ...line()])); // 6 s, a 2 s note, 6 s
    expect(song.notes).toHaveLength(25);
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 13], [13, 25]]);
  });

  it('a 90 s legato tune ends up in phrases of 2 to 10 seconds that tile it', () => {
    const tune = Array.from({ length: 180 }, (_, i) => [null, 480, 55 + (i % 7)] as const);
    const { song } = importMidi(legatoMidi(tune));
    let next = 0;
    for (const p of song.phrases) {
      expect(p.from).toBe(next);
      next = p.to;
      expect(p.end - p.start).toBeLessThanOrEqual(10);
      expect(p.end - p.start).toBeGreaterThanOrEqual(2);
    }
    expect(next).toBe(180);
    expect(song.phrases.length).toBeGreaterThanOrEqual(9);
  });

  it('keeps the old behaviour where it already worked: rests and karaoke marks still start phrases', () => {
    // two runs of eight notes with a 0.56 s rest between them: the rest alone starts the second phrase, with no lyrics at all
    const bytes = F.smf([[F.tempoEvent(0, 120)], [...Array.from({ length: 16 }, (_, i) => F.noteEvents(0, 60 + (i % 5), i < 8 ? i * 480 : i * 480 + 480, 420)).flat()]]);
    expect(importMidi(bytes).song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 8], [8, 16]]);
  });
});

describe('importMidi: lyric spacing for files that carry none', () => {
  const sing = (spec: ReadonlyArray<string | null>): string[] =>
    importMidi(legatoMidi(spec.map((s, i) => [s, 480, 60 + (i % 5)] as const))).song.notes.map((n) => n.lyric);

  it('gives every bare syllable the word-start space, except where the previous one ends in a hyphen', () => {
    expect(sing(['A', 'maz', 'ing', 'grace'])).toEqual(['A', ' maz', ' ing', ' grace']);
    // hyphenated exports: "Ma-" "ry" is one word
    const lamb = ['Ma-', 'ry', 'had', 'a', 'lit-', 'tle', 'lamb'];
    expect(sing(lamb)).toEqual(['Ma-', 'ry', ' had', ' a', ' lit-', 'tle', ' lamb']);
    expect(sing(lamb).join('')).toBe('Ma-ry had a lit-tle lamb');
  });

  it('leaves a file with whitespace anywhere in its syllables verbatim', () => {
    expect(sing(['Hel', 'lo ', 'there', 'now'])).toEqual(['Hel', 'lo ', 'there', 'now']);
    expect(sing(['Hel', ' lo', 'there'])).toEqual(['Hel', ' lo', 'there']);
  });

  it('does not space out a script that is not written with a space per syllable (Chinese here)', () => {
    expect(sing(['你', '好', '吗'])).toEqual(['你', '好', '吗']);
  });

  it('keeps a held tail empty and a single syllable as it is', () => {
    expect(sing(['la', null, null, 'li'])).toEqual(['la', '', '', ' li']);
    expect(sing(['la'])).toEqual(['la']);
    expect(sing([null, null])).toEqual(['', '']);
  });

  it('takes the space off the first syllable of EVERY phrase, also when the phrase starts on a note without one', () => {
    // a rest of 0.6 s starts the second phrase at a note that has no syllable; the next note carries "c"
    const bytes = F.smf([
      [F.tempoEvent(0, 120)],
      [...F.noteEvents(0, 60, 0, 420), ...F.noteEvents(0, 62, 480, 420), ...F.noteEvents(0, 64, 1536, 420), ...F.noteEvents(0, 65, 2016, 420)],
      [F.lyricEvent(0, 'a'), F.lyricEvent(480, 'b'), F.lyricEvent(2016, 'c')],
    ]);
    const { song } = importMidi(bytes);
    expect(song.phrases.map((p) => [p.from, p.to])).toEqual([[0, 2], [2, 4]]);
    expect(song.notes.map((n) => n.lyric)).toEqual(['a', ' b', '', 'c']);
  });

  it('does not change what a hyphen-continued syllable at a phrase start looks like', () => {
    // the phrase break falls between "Ma-" and "ry": "ry" had no space added, so none is taken off
    const bytes = F.smf([
      [F.tempoEvent(0, 120)],
      [...F.noteEvents(0, 60, 0, 420), ...F.noteEvents(0, 62, 480, 420), ...F.noteEvents(0, 64, 1536, 420), ...F.noteEvents(0, 65, 2016, 420)],
      [F.lyricEvent(0, 'Hi'), F.lyricEvent(480, 'Ma-'), F.lyricEvent(1536, 'ry'), F.lyricEvent(2016, 'ok')],
    ]);
    expect(importMidi(bytes).song.notes.map((n) => n.lyric)).toEqual(['Hi', ' Ma-', 'ry', ' ok']);
  });
});

describe('robustness: corrupted files never crash', () => {
  const base = F.smf([
    [F.tempoEvent(0, 120), F.trackName(0, 'Song')],
    [F.trackName(0, 'Melody'), ...[60, 62, 64, 65, 67, 69, 71, 72].flatMap((m, i) => F.noteEvents(0, m, i * 480, 400))],
    [F.trackName(0, 'Words'), ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t, i) => F.textEvent(i * 480, t))],
  ]);

  it('imports a valid song or throws MidiImportError, never anything else (1500 seeded corruptions)', () => {
    const rnd = seededRandom(7);
    let imported = 0;
    let rejected = 0;
    for (let i = 0; i < 1500; i++) {
      const bytes = Uint8Array.from(base);
      const edits = 1 + Math.floor(rnd() * 5);
      for (let e = 0; e < edits; e++) {
        const pos = Math.floor(rnd() * bytes.length);
        const kind = rnd();
        if (kind < 0.7) bytes[pos] = Math.floor(rnd() * 256);
        else if (kind < 0.85) bytes[pos] ^= 1 << Math.floor(rnd() * 8);
        else bytes[pos] = rnd() < 0.5 ? 0xff : 0x00;
      }
      const input = rnd() < 0.2 ? bytes.slice(0, Math.floor(rnd() * bytes.length)) : bytes; // some are also truncated
      try {
        expectValidSong(importMidi(input).song);
        imported++;
      } catch (e) {
        if (!(e instanceof MidiImportError)) throw e;
        rejected++;
      }
    }
    expect(imported).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });

  it('rejects empty, tiny and junk input with MidiImportError', () => {
    for (const junk of [new Uint8Array(0), Uint8Array.of(0x4d), new TextEncoder().encode('MThd but not really a midi file'), new Uint8Array(1000).fill(0xff)]) {
      expect(() => importMidi(junk)).toThrow(MidiImportError);
    }
  });

  it('a zero-length tempo event is ignored, not turned into an infinite bpm', () => {
    const bytes = F.smf([[{ tick: 0, data: [0xff, 0x51, 0x03, 0x00, 0x00, 0x00] }], [...noteRun(8)]]); // 0 microseconds per beat
    try {
      const { song, warnings } = importMidi(bytes);
      expect(song.bpm).toBe(120);
      expect(warnings.join(' ')).toMatch(/tempo/i);
      expectValidSong(song);
    } catch (e) {
      expect(e).toBeInstanceOf(MidiImportError); // acceptable: nothing singable survives a collapsed timeline
    }
  });

  it('imports a large file (8000 notes, longer than almost any song) without trouble', () => {
    // @tonejs/midi matches note-offs quadratically, so keep this well inside the default test timeout.
    const events = Array.from({ length: 8000 }, (_, i) => F.noteEvents(0, 48 + (i % 24), i * 240, 200)).flat();
    const bytes = F.smf([[F.tempoEvent(0, 120)], events], { ppq: 480 });
    const { song } = importMidi(bytes);
    expect(song.notes).toHaveLength(8000);
    // 1000 s with only 25 ms between notes: no rest and no lyric, so only the length cap can make phrases
    expect(song.phrases.length).toBeGreaterThanOrEqual(100);
    for (const p of song.phrases) expect(p.end - p.start).toBeLessThanOrEqual(10);
  });
});
