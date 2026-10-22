/**
 * The public-domain charts shipped in public/songs. These tests read the real files (through
 * Vite's `?raw` glob, so they see exactly what gets copied into dist) and check that they
 * parse, still carry the verified melodies and lyrics (bundled.fixture.ts), fit a tenor and a
 * baritone, rate where the unlock design expects, and round-trip.
 */
import { describe, expect, it } from 'vitest';
import { BUNDLED_EXPECTED } from './bundled.fixture';
import { analyzeSong } from './difficulty';
import { parseBundledChart, parseSongIndex } from './library';
import { suggestTransposition, transposeSong, transposeSongToRange } from './transpose';
import { parseUltraStar, serializeUltraStar } from './ultrastar';
import type { Song } from './types';
import type { VocalRange } from '../storage/schema';
import type { WorldId } from '../exercises/types';

const charts = import.meta.glob('../../public/songs/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const indexFiles = import.meta.glob('../../public/songs/index.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const chartText = new Map<string, string>(Object.entries(charts).map(([path, text]) => [path.split('/').pop() as string, text]));
const index = parseSongIndex(JSON.parse(Object.values(indexFiles)[0]));

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (m: number): string => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/** `<startBeat>.<lengthBeats>.<pitch>[~]` per note, the format of bundled.fixture.ts. */
function canon(song: Song): string {
  const spb = 60 / ((song.bpm as number) * 4);
  return song.notes.map((n) => `${Math.round(n.start / spb)}.${Math.round(n.duration / spb)}.${pitchName(n.midi)}${n.lyric === '' ? '~' : ''}`).join(' ');
}

function load(id: string): { song: Song; warnings: string[]; headers: Record<string, string> } {
  const entry = index.songs.find((s) => s.id === id);
  if (!entry) throw new Error(`no index entry for ${id}`);
  const r = parseUltraStar(chartText.get(entry.file) as string, { id, source: 'bundled' });
  return { song: r.song, warnings: r.warnings, headers: r.headers };
}

const TENOR: VocalRange = { comfortable: { low: 48, high: 72 }, extended: { low: 45, high: 76 }, measuredAt: '2026-10-21T00:00:00.000Z' };
const BARITONE: VocalRange = { comfortable: { low: 43, high: 67 }, extended: { low: 40, high: 71 }, measuredAt: '2026-10-21T00:00:00.000Z' };
const BEGINNER: VocalRange = { comfortable: { low: 48, high: 64 }, extended: { low: 45, high: 69 }, measuredAt: '2026-10-21T00:00:00.000Z' };

/** The intended spread: Foundations starters first, then songs at every later world, so each Boss Recital opens something (SPEC §11.2). */
const EXPECTED_WORLD: Record<string, { world: WorldId; reasons: string[] }> = {
  'auld-lang-syne': { world: 'foundations', reasons: [] },
  'the-holy-city': { world: 'foundations', reasons: [] },
  'twinkle-twinkle': { world: 'foundations', reasons: [] },
  'amazing-grace': { world: 'vibrato', reasons: ['sustained-style'] },
  'holy-holy-holy': { world: 'vibrato', reasons: ['sustained-style'] },
  'it-is-well': { world: 'vibrato', reasons: ['sustained-style'] },
  'o-holy-night': { world: 'vibrato', reasons: ['sustained-style'] },
  'panis-angelicus': { world: 'vibrato', reasons: ['sustained-style'] },
  'be-thou-my-vision': { world: 'inflections', reasons: ['wide-range'] },
  'danny-boy': { world: 'inflections', reasons: ['wide-range'] },
  'silent-night': { world: 'inflections', reasons: ['wide-range'] },
  'ave-maria': { world: 'runs', reasons: ['fast-run'] },
};

describe('public/songs index', () => {
  it('lists exactly the chart files, once each, under slug ids that match the file names', () => {
    expect(index.songs.map((s) => s.file).sort()).toEqual([...chartText.keys()].sort());
    for (const s of index.songs) expect(s.file).toBe(`${s.id}.txt`);
    expect(new Set(index.songs.map((s) => s.id)).size).toBe(index.songs.length);
  });

  it('has a fixture entry for every chart and nothing else', () => {
    expect(BUNDLED_EXPECTED.map((e) => e.id).sort()).toEqual(index.songs.map((s) => s.id).sort());
    expect(Object.keys(EXPECTED_WORLD).sort()).toEqual(index.songs.map((s) => s.id).sort());
  });

  it('ships between 4 and 16 songs (a small starter library that is precached for offline use: raise the cap on purpose)', () => {
    expect(index.songs.length).toBeGreaterThanOrEqual(4);
    expect(index.songs.length).toBeLessThanOrEqual(16);
  });
});

describe('raw chart files', () => {
  for (const [file, text] of chartText) {
    it(`${file} is clean printable ASCII with LF endings and no trailing spaces`, () => {
      // A Windows checkout with core.autocrlf=true turns LF into CRLF: the repo-root .gitattributes line
      // `public/songs/** text eol=lf` keeps these byte-exact (the charts are hashed, snapshotted and served as they are).
      expect(text.includes('\r'), `${file} has CR bytes: check out with LF endings (.gitattributes: public/songs/** text eol=lf)`).toBe(false);
      expect(text).toMatch(/^#VERSION:1\.1\.0\n/);
      expect(text.endsWith('E\n')).toBe(true);
      expect(/[^\x20-\x7e\n]/.test(text)).toBe(false); // no tabs, CR, or non-ASCII (the Windows encoding pitfall)
      expect(/ $/m.test(text)).toBe(false); // editors strip trailing spaces: words are joined by LEADING spaces instead
    });
  }
});

describe.each(BUNDLED_EXPECTED)('bundled chart: $id', (expected) => {
  const { song, warnings, headers } = load(expected.id);

  it('parses cleanly as a bundled song with a public-domain licence note', () => {
    expect(warnings).toEqual([]);
    expect(song.id).toBe(expected.id);
    expect(song.source).toBe('bundled');
    expect(song.title).toBe(expected.title);
    expect(song.artist.length).toBeGreaterThan(0);
    expect(song.licence).toMatch(/^Public domain\./);
    expect(song.licence).toMatch(/Pitch Lab/);
    expect(headers.LANGUAGE).toBeTruthy();
    expect(song.bpm).toBeGreaterThan(0);
    expect(song.offsetMs).toBe(0);
    expect(song.backingRef).toBeNull();
  });

  it('is exactly the verified melody and lyrics (a snapshot of the checked chart)', () => {
    expect(canon(song)).toBe(expected.notes);
    const lines = song.phrases.map((p) => song.notes.slice(p.from, p.to).map((n) => n.lyric).join(''));
    expect(lines).toEqual(expected.lines);
  });

  it('is well-formed: ordered, singable, phrases cover every note, each phrase starts on a syllable', () => {
    for (let i = 0; i < song.notes.length; i++) {
      expect(song.notes[i].duration).toBeGreaterThan(0);
      expect(song.notes[i].type).toBe('normal');
      if (i > 0) expect(song.notes[i].start).toBeGreaterThanOrEqual(song.notes[i - 1].start + song.notes[i - 1].duration - 1e-9);
    }
    expect(song.phrases[0].from).toBe(0);
    expect(song.phrases[song.phrases.length - 1].to).toBe(song.notes.length);
    song.phrases.forEach((p, k) => {
      if (k > 0) expect(p.from).toBe(song.phrases[k - 1].to);
      expect(song.notes[p.from].lyric.trim().length).toBeGreaterThan(0);
      expect(p.start).toBeLessThanOrEqual(song.notes[p.from].start + 1e-9);
    });
    const last = song.notes[song.notes.length - 1];
    expect(song.phrases[song.phrases.length - 1].end).toBeCloseTo(last.start + last.duration, 9);
    const seconds = last.start + last.duration;
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThan(240); // a whole song, not an excerpt: the full Panis Angelicus (both statements) is 178 s
  });

  it('sits in a tenor-friendly default key (C3 to C5)', () => {
    expect(song.difficulty.lowestMidi).toBeGreaterThanOrEqual(48);
    expect(song.difficulty.highestMidi).toBeLessThanOrEqual(72);
  });

  it('stays inside the detector range E2-C6, and inside the singer\'s comfortable range, for tenor, baritone and beginner', () => {
    for (const range of [TENOR, BARITONE, BEGINNER]) {
      const t = transposeSongToRange(song, range);
      const midis = t.notes.map((n) => n.midi);
      expect(Math.min(...midis)).toBeGreaterThanOrEqual(40);
      expect(Math.max(...midis)).toBeLessThanOrEqual(84);
      expect(t.difficulty.lowestMidi).toBe(Math.min(...midis));
      if (song.difficulty.rangeSemitones <= range.comfortable.high - range.comfortable.low) {
        expect(Math.min(...midis)).toBeGreaterThanOrEqual(range.comfortable.low);
        expect(Math.max(...midis)).toBeLessThanOrEqual(range.comfortable.high);
      } else {
        // wider than a beginner's comfortable range: at least inside the extended range
        expect(Math.min(...midis)).toBeGreaterThanOrEqual(range.extended.low);
        expect(Math.max(...midis)).toBeLessThanOrEqual(range.extended.high);
      }
    }
  });

  it('is rated where the unlock design expects, for stated reasons', () => {
    const a = analyzeSong(song);
    const want = EXPECTED_WORLD[expected.id];
    expect(song.difficulty.requiredWorld).toBe(want.world);
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(want.reasons));
    expect(a.reasons.map((r) => r.code)).not.toContain('long-melisma'); // no starter chart has a 6+ note run on one syllable
    if (want.reasons.length === 0) expect(a.reasons).toEqual([]);
    expect(a.lyricsAvailable).toBe(true);
    expect(song.difficulty).toEqual(a.difficulty); // the parser stored a real rating, not the placeholder
  });

  it('is rated the same after any transposition', () => {
    for (const semis of [-9, -5, 0, 3, 12]) expect(analyzeSong(transposeSong(song, semis)).difficulty.requiredWorld).toBe(song.difficulty.requiredWorld);
  });

  it('round-trips through serializeUltraStar without losing a note, syllable or phrase', () => {
    const back = parseUltraStar(serializeUltraStar(song), { id: song.id, source: 'bundled' }).song;
    expect(canon(back)).toBe(canon(song));
    expect(back.phrases.map((p) => [p.from, p.to])).toEqual(song.phrases.map((p) => [p.from, p.to]));
    back.phrases.forEach((p, i) => {
      expect(p.start).toBeCloseTo(song.phrases[i].start, 6);
      expect(p.end).toBeCloseTo(song.phrases[i].end, 6);
    });
    expect(back.notes.map((n) => n.lyric)).toEqual(song.notes.map((n) => n.lyric));
  });

  it('survives JSON unchanged (storage persists songs; a stray NaN would come back as null and fail this)', () => {
    expect(JSON.parse(JSON.stringify(song))).toEqual(song);
  });

  it('is exactly what the library builds from the same text', () => {
    const entry = index.songs.find((s) => s.id === expected.id)!;
    expect(parseBundledChart(chartText.get(entry.file) as string, expected.id)).toEqual(song);
  });
});

describe('the starter set as a whole', () => {
  const songs = index.songs.map((s) => load(s.id).song);

  it('has at least two Foundations starters so the Song Stage opens with something to sing', () => {
    expect(songs.filter((s) => s.difficulty.requiredWorld === 'foundations').length).toBeGreaterThanOrEqual(2);
  });

  it('adds songs at later worlds, so each Boss Recital visibly opens something', () => {
    const worlds = new Set(songs.map((s) => s.difficulty.requiredWorld));
    for (const w of ['foundations', 'vibrato', 'inflections', 'runs'] as WorldId[]) expect(worlds.has(w)).toBe(true);
  });

  it('never requires Dynamics or the Song Stage itself (neither has a rating rule or a boss to pass)', () => {
    for (const s of songs) expect(['dynamics', 'song-stage']).not.toContain(s.difficulty.requiredWorld);
  });

  it('has a suggested transposition for both a tenor and a baritone that is at most an octave and a half away', () => {
    for (const s of songs) {
      expect(Math.abs(suggestTransposition(s, TENOR))).toBeLessThanOrEqual(18);
      expect(Math.abs(suggestTransposition(s, BARITONE))).toBeLessThanOrEqual(18);
    }
  });
});
