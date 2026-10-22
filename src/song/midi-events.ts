/**
 * Lyric extraction from raw Standard MIDI File bytes.
 *
 * Why not just use @tonejs/midi's `header.meta`? It only collects text/lyric/marker events
 * from the FIRST track (node_modules/@tonejs/midi/src/Header.ts), but karaoke (.kar) files
 * keep their words on a dedicated "Words" track. So this module scans every MTrk chunk
 * itself. It is pure (no tonejs, no DOM) and never throws: a corrupt or unsupported file
 * just yields no events (tonejs reports real parse errors when the notes are read).
 *
 * Conventions understood (RP-026 lyric events and the .kar karaoke de-facto standard):
 *  - meta 0x05 "lyrics" events are syllables; meta 0x01 "text" events are used when a file
 *    has no lyric events (karaoke style) and enough of them to be words, not annotations;
 *  - in text events, a leading "/" starts a new line and "\" a new paragraph;
 *  - text events starting "@" are headers: "@T" lines give the title, then the artist;
 *  - CR/LF inside an event ends a line.
 */
import { decodeUtf8OrWindows1252 } from './text';

export type MidiTextKind = 'text' | 'lyrics' | 'marker' | 'cue';

export interface MidiTextEvent {
  /** Index of the raw MTrk chunk (0-based, before @tonejs/midi splits or drops tracks). */
  track: number;
  /** Absolute position in ticks. */
  ticks: number;
  kind: MidiTextKind;
  text: string;
}

const META_KINDS: Record<number, MidiTextKind> = { 0x01: 'text', 0x05: 'lyrics', 0x06: 'marker', 0x07: 'cue' };

/** UTF-8 when valid, else windows-1252 (legacy karaoke files). */
const decodeText = decodeUtf8OrWindows1252;

/**
 * Every text-like meta event (text, lyrics, marker, cue point) of every track, in file order
 * per track. Returns [] for anything that is not a parseable ticks-per-beat SMF.
 */
export function scanMidiTextEvents(bytes: Uint8Array): MidiTextEvent[] {
  const events: MidiTextEvent[] = [];
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 14 || view.getUint32(0) !== 0x4d546864 /* MThd */) return events;
    const headerLen = view.getUint32(4);
    const division = view.getUint16(12);
    if (division & 0x8000) return events; // SMPTE time: ticks are not beats, tonejs cannot place them either

    let pos = 8 + headerLen;
    let track = -1;
    while (pos + 8 <= bytes.length) {
      const id = view.getUint32(pos);
      const len = view.getUint32(pos + 4);
      const body = pos + 8;
      const limit = Math.min(bytes.length, body + len);
      pos = body + len;
      if (id !== 0x4d54726b /* MTrk */) continue;
      track++;

      let i = body;
      let ticks = 0;
      let running = 0;
      const varLen = (): number => {
        let v = 0;
        for (let n = 0; n < 4; n++) {
          if (i >= limit) throw new RangeError('truncated');
          const b = bytes[i++];
          v = (v << 7) | (b & 0x7f);
          if (!(b & 0x80)) return v;
        }
        throw new RangeError('bad variable-length quantity');
      };

      while (i < limit) {
        ticks += varLen();
        if (i >= limit) break;
        let status = bytes[i];
        if (status < 0x80) {
          if (running === 0) break; // data byte with no status: corrupt, stop this track
          status = running;
        } else {
          i++;
          if (status < 0xf0) running = status;
        }
        if (status === 0xff) {
          running = 0;
          const type = bytes[i++];
          const size = varLen();
          const kind = META_KINDS[type];
          if (kind !== undefined && i + size <= limit) {
            events.push({ track, ticks, kind, text: decodeText(bytes.subarray(i, i + size)) });
          }
          i += size;
          if (type === 0x2f) break; // end of track
        } else if (status === 0xf0 || status === 0xf7) {
          running = 0;
          const size = varLen(); // read first: `i += varLen()` would add to the stale value of `i`
          i += size;
        } else {
          const hi = status & 0xf0;
          i += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        }
      }
    }
  } catch {
    // keep whatever was read before the damage
  }
  return events;
}

export interface LyricSyllable {
  ticks: number;
  /** The syllable exactly as sung (spaces kept: they separate words). Never empty. */
  text: string;
  /** True when the file marks a new line or paragraph before this syllable. */
  lineBreakBefore: boolean;
}

export interface ExtractedLyrics {
  syllables: LyricSyllable[];
  /** From the ".kar" "@T" header events, when present. */
  title?: string;
  artist?: string;
  /** Which event kind supplied the syllables. */
  source: 'lyrics' | 'text' | 'none';
}

/** Text events shorter than this many events are annotations ("Verse", "Piano"), not lyrics. */
const MIN_TEXT_EVENTS_AS_LYRICS = 6;
/** Longer text events are comments, copyright lines or credits. */
const MAX_SYLLABLE_CHARS = 40;

/** Picks the track with the most events of one kind. */
function busiestTrack(events: readonly MidiTextEvent[]): MidiTextEvent[] {
  const counts = new Map<number, number>();
  for (const e of events) counts.set(e.track, (counts.get(e.track) ?? 0) + 1);
  let best = -1;
  let bestCount = 0;
  for (const [track, count] of counts) {
    if (count > bestCount) {
      best = track;
      bestCount = count;
    }
  }
  return events.filter((e) => e.track === best);
}

/** Turns raw text/lyric events into clean syllables, line-break marks and (karaoke) title/artist. */
export function extractLyrics(events: readonly MidiTextEvent[]): ExtractedLyrics {
  const headerLines: string[] = [];
  const lyricEvents: MidiTextEvent[] = [];
  const textEvents: MidiTextEvent[] = [];
  for (const e of events) {
    if (e.kind === 'text' && e.text.startsWith('@')) {
      if (e.text.startsWith('@T')) headerLines.push(e.text.slice(2).trim());
      continue;
    }
    if (e.kind === 'lyrics') lyricEvents.push(e);
    else if (e.kind === 'text') textEvents.push(e);
  }

  let source: ExtractedLyrics['source'] = 'none';
  let chosen: MidiTextEvent[] = [];
  if (lyricEvents.length > 0) {
    source = 'lyrics';
    chosen = busiestTrack(lyricEvents);
  } else {
    const words = busiestTrack(textEvents.filter((e) => e.text.length <= MAX_SYLLABLE_CHARS));
    if (words.length >= MIN_TEXT_EVENTS_AS_LYRICS) {
      source = 'text';
      chosen = words;
    }
  }

  const syllables: LyricSyllable[] = [];
  let pendingBreak: boolean = false;
  for (const e of [...chosen].sort((a, b) => a.ticks - b.ticks)) {
    let text = e.text;
    let breakBefore: boolean = pendingBreak;
    pendingBreak = false;
    if (text.startsWith('/') || text.startsWith('\\')) {
      breakBefore = true;
      text = text.slice(1);
    }
    if (/[\r\n]/.test(text)) {
      text = text.replace(/[\r\n]+/g, '');
      pendingBreak = true;
    }
    if (text === '') {
      pendingBreak = pendingBreak || breakBefore; // a bare line-break event
      continue;
    }
    syllables.push({ ticks: e.ticks, text, lineBreakBefore: breakBefore });
  }

  return { syllables, title: headerLines[0] || undefined, artist: headerLines[1] || undefined, source };
}
