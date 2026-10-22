import { describe, expect, it } from 'vitest';
import { extractLyrics, scanMidiTextEvents, type MidiTextEvent } from './midi-events';
import * as F from './midi-fixtures';

const ev = (track: number, ticks: number, kind: MidiTextEvent['kind'], text: string): MidiTextEvent => ({ track, ticks, kind, text });

describe('scanMidiTextEvents', () => {
  it('finds text, lyric, marker and cue events on every track, with absolute ticks', () => {
    const bytes = F.smf([
      [F.tempoEvent(0, 120), F.trackName(0, 'Song'), F.textEvent(10, '@TTitle'), F.markerEvent(480, 'Verse')],
      [F.trackName(0, 'Melody'), ...F.noteEvents(0, 60, 0, 240), F.lyricEvent(0, 'la')],
      [F.trackName(0, 'Words'), F.textEvent(960, '/Hel'), F.cueEvent(1000, 'cue')],
    ]);
    expect(scanMidiTextEvents(bytes).map((e) => [e.track, e.ticks, e.kind, e.text])).toEqual([
      [0, 10, 'text', '@TTitle'],
      [0, 480, 'marker', 'Verse'],
      [1, 0, 'lyrics', 'la'],
      [2, 960, 'text', '/Hel'],
      [2, 1000, 'cue', 'cue'],
    ]);
  });

  it('copes with running status, sysex and multi-byte delta times', () => {
    const bytes = F.smf([
      [
        F.noteOn(0, 0, 60),
        { ...F.noteOn(10, 0, 62), running: true },
        { ...F.noteOn(20, 0, 64), running: true },
        F.sysex(30, [0x7e, 0x7f, 0x09, 0x01]),
        F.noteOff(40, 0, 60),
        F.lyricEvent(100000, 'far'), // 100000 ticks needs a three-byte variable-length delta
      ],
    ]);
    expect(scanMidiTextEvents(bytes)).toEqual([{ track: 0, ticks: 100000, kind: 'lyrics', text: 'far' }]);
  });

  describe('channel messages are skipped by their real length', () => {
    const texts = (bytes: Uint8Array): string[] => scanMidiTextEvents(bytes).map((e) => e.text);

    it('a program change (C0 pp) before the lyrics, which nearly every real file has, leaves them readable', () => {
      // Read as a two-byte message it would swallow the next delta time and the first byte of the event behind it,
      // and the lyrics would silently vanish from every imported song.
      expect(texts(F.smf([[F.programChange(0, 0, 5), F.lyricEvent(10, 'la '), F.lyricEvent(20, 'di ')]]))).toEqual(['la ', 'di ']);
      expect(texts(F.smf([[F.programChange(0, 3, 40), F.programChange(0, 9, 0), F.lyricEvent(10, 'la ')]]))).toEqual(['la ']);
    });

    it('channel pressure (D0 pp) and a program change BETWEEN two lyrics leave both readable', () => {
      expect(texts(F.smf([[F.lyricEvent(0, 'la '), { tick: 10, data: [0xd0, 0x40] }, F.lyricEvent(20, 'di ')]]))).toEqual(['la ', 'di ']);
      expect(texts(F.smf([[F.lyricEvent(0, 'la '), F.programChange(10, 0, 5), F.lyricEvent(20, 'di ')]]))).toEqual(['la ', 'di ']);
    });

    it('keeps running status straight across program changes (one data byte) and note-ons (two)', () => {
      const bytes = F.smf([
        [
          F.programChange(0, 0, 5),
          { ...F.programChange(5, 0, 6), running: true }, // no status byte: the running C0 means ONE data byte
          F.noteOn(10, 0, 60),
          { ...F.noteOn(15, 0, 62), running: true }, // the running 90 means two
          { ...F.noteOn(20, 0, 64), running: true },
          F.lyricEvent(30, 'la '),
          F.programChange(35, 1, 7),
          F.noteOff(40, 0, 60),
          F.lyricEvent(50, 'di '),
        ],
      ]);
      expect(texts(bytes)).toEqual(['la ', 'di ']);
    });

    it('knows every channel message size: two data bytes for note off/on, key pressure, controllers and pitch bend; one for program and channel pressure', () => {
      const channel: F.TrackEvent[] = [
        { tick: 10, data: [0x80, 60, 0] },
        { tick: 20, data: [0x90, 60, 64] },
        { tick: 30, data: [0xa0, 60, 33] },
        { tick: 40, data: [0xb0, 7, 100] },
        { tick: 50, data: [0xc0, 9] },
        { tick: 60, data: [0xd0, 55] },
        { tick: 70, data: [0xe0, 0, 0x40] },
      ];
      const events = channel.flatMap((e, i) => [e, F.lyricEvent(e.tick + 5, `s${i}`)]);
      expect(texts(F.smf([events]))).toEqual(channel.map((_, i) => `s${i}`));
      // the same messages on other channels
      const other = channel.map((e) => ({ ...e, data: [(e.data[0] & 0xf0) | 0x0f, ...e.data.slice(1)] }));
      expect(texts(F.smf([other.flatMap((e, i) => [e, F.lyricEvent(e.tick + 5, `s${i}`)])]))).toEqual(channel.map((_, i) => `s${i}`));
    });
  });

  it('returns nothing for non-MIDI bytes, SMPTE timing and short input', () => {
    expect(scanMidiTextEvents(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(scanMidiTextEvents(new TextEncoder().encode('this is not a midi file at all, honest'))).toEqual([]);
    const smpte = F.smf([[F.lyricEvent(0, 'x')]]);
    smpte[12] = 0xe7; // division = -25 frames/s, 40 ticks/frame: ticks are not beats
    smpte[13] = 0x28;
    expect(scanMidiTextEvents(smpte)).toEqual([]);
  });

  it('keeps what it read before a truncated tail', () => {
    const bytes = F.smf([[F.lyricEvent(0, 'ok'), F.lyricEvent(10, 'also ok'), F.lyricEvent(20, 'cut off here')]]);
    const cut = bytes.slice(0, bytes.length - 12); // chops the last event and the end-of-track
    expect(scanMidiTextEvents(cut).map((e) => e.text)).toEqual(['ok', 'also ok']);
  });

  it('survives a corrupt chunk without throwing', () => {
    const bytes = F.smf([[F.lyricEvent(0, 'good')]]);
    const bad = Uint8Array.from([...bytes, 0x4d, 0x54, 0x72, 0x6b, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]); // MTrk claiming 4 GB
    expect(() => scanMidiTextEvents(bad)).not.toThrow();
    expect(scanMidiTextEvents(bad)[0].text).toBe('good');
  });

  it('decodes UTF-8 and falls back to windows-1252', () => {
    expect(scanMidiTextEvents(F.smf([[F.lyricEvent(0, 'café')]]))[0].text).toBe('café');
    const latin = F.smf([[F.metaBytes(0, 0x05, [0x63, 0x61, 0x66, 0xe9])]]); // "caf" + a lone 0xE9
    expect(scanMidiTextEvents(latin)[0].text).toBe('café');
  });
});

describe('extractLyrics', () => {
  it('prefers lyric events over text events and uses the busiest track', () => {
    const out = extractLyrics([
      ev(1, 0, 'lyrics', 'one'),
      ev(2, 0, 'lyrics', 'la'),
      ev(2, 480, 'lyrics', 'la'),
      ev(2, 960, 'lyrics', 'la'),
      ev(3, 0, 'text', 'x'),
      ev(3, 10, 'text', 'x'),
    ]);
    expect(out.source).toBe('lyrics');
    expect(out.syllables.map((s) => s.text)).toEqual(['la', 'la', 'la']);
  });

  it('reads karaoke text events: ignores "@" headers and long comments, takes @T as title then artist', () => {
    const words = ['Twin', 'kle ', 'twin', 'kle ', 'lit', 'tle ', 'star'].map((t, i) => ev(3, 100 * i, 'text', t));
    const out = extractLyrics([
      ev(0, 0, 'text', '@KMIDI KARAOKE FILE'),
      ev(0, 0, 'text', '@LENGL'),
      ev(0, 0, 'text', '@TTwinkle'),
      ev(0, 0, 'text', '@TTraditional'),
      ev(3, 5, 'text', 'Copyright 1999 by somebody who really wants you to read this notice'),
      ...words,
    ]);
    expect(out.source).toBe('text');
    expect(out.title).toBe('Twinkle');
    expect(out.artist).toBe('Traditional');
    expect(out.syllables.map((s) => s.text)).toEqual(['Twin', 'kle ', 'twin', 'kle ', 'lit', 'tle ', 'star']);
  });

  it('treats a handful of text events as annotations, not lyrics', () => {
    const out = extractLyrics(['Piano', 'Verse', 'Chorus', 'Bridge', 'Outro'].map((t, i) => ev(0, i * 960, 'text', t)));
    expect(out).toEqual({ syllables: [], title: undefined, artist: undefined, source: 'none' });
  });

  it('marks "/", "\\" and CR/LF as line breaks and strips the control characters', () => {
    const out = extractLyrics([
      ev(1, 0, 'lyrics', '/Hel'),
      ev(1, 10, 'lyrics', 'lo'),
      ev(1, 20, 'lyrics', '\\Wor'),
      ev(1, 30, 'lyrics', 'ld\r'),
      ev(1, 40, 'lyrics', 'Next'),
      ev(1, 50, 'lyrics', '\r'),
      ev(1, 60, 'lyrics', 'Line'),
      ev(1, 70, 'lyrics', ''),
    ]);
    expect(out.syllables).toEqual([
      { ticks: 0, text: 'Hel', lineBreakBefore: true },
      { ticks: 10, text: 'lo', lineBreakBefore: false },
      { ticks: 20, text: 'Wor', lineBreakBefore: true },
      { ticks: 30, text: 'ld', lineBreakBefore: false },
      { ticks: 40, text: 'Next', lineBreakBefore: true },
      { ticks: 60, text: 'Line', lineBreakBefore: true },
    ]);
  });

  it('keeps syllable spacing exactly as written', () => {
    const out = extractLyrics([ev(1, 0, 'lyrics', 'Hel'), ev(1, 10, 'lyrics', 'lo '), ev(1, 20, 'lyrics', ' wor')]);
    expect(out.syllables.map((s) => s.text)).toEqual(['Hel', 'lo ', ' wor']);
  });

  it('sorts syllables by tick', () => {
    const out = extractLyrics([ev(1, 20, 'lyrics', 'b'), ev(1, 0, 'lyrics', 'a')]);
    expect(out.syllables.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('returns no lyrics for no events', () => {
    expect(extractLyrics([]).source).toBe('none');
  });
});
