/**
 * Test-only Standard MIDI File builder. @tonejs/midi can write notes and (first-track) text
 * events, but not lyrics on other tracks, running status, sysex or odd encodings, which the
 * importer must survive, so the tests assemble real bytes here. Not imported by app code.
 */

export interface TrackEvent {
  /** Absolute position in ticks. */
  tick: number;
  /** Raw event bytes (status byte first; for running status pass `running: true` and omit it). */
  data: number[];
  /** Emit without the status byte when the previous event had the same status (SMF running status). */
  running?: boolean;
}

export function varLen(value: number): number[] {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Meta event with raw text bytes. */
export function metaBytes(tick: number, type: number, bytes: ArrayLike<number>): TrackEvent {
  return { tick, data: [0xff, type, ...varLen(bytes.length), ...Array.from(bytes)] };
}
/** Meta event with UTF-8 text. */
export function meta(tick: number, type: number, text: string): TrackEvent {
  return metaBytes(tick, type, new TextEncoder().encode(text));
}
export const trackName = (tick: number, text: string): TrackEvent => meta(tick, 0x03, text);
export const textEvent = (tick: number, text: string): TrackEvent => meta(tick, 0x01, text);
export const lyricEvent = (tick: number, text: string): TrackEvent => meta(tick, 0x05, text);
export const markerEvent = (tick: number, text: string): TrackEvent => meta(tick, 0x06, text);
export const cueEvent = (tick: number, text: string): TrackEvent => meta(tick, 0x07, text);
export function tempoEvent(tick: number, bpm: number): TrackEvent {
  const us = Math.round(60_000_000 / bpm);
  return { tick, data: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] };
}
export const programChange = (tick: number, channel: number, program: number): TrackEvent => ({ tick, data: [0xc0 | channel, program] });
export const noteOn = (tick: number, channel: number, note: number, velocity = 90): TrackEvent => ({ tick, data: [0x90 | channel, note, velocity] });
export const noteOff = (tick: number, channel: number, note: number): TrackEvent => ({ tick, data: [0x80 | channel, note, 0] });
export const sysex = (tick: number, payload: number[]): TrackEvent => ({ tick, data: [0xf0, ...varLen(payload.length + 1), ...payload, 0xf7] });

/** A note as a noteOn/noteOff pair (ticks). */
export function noteEvents(channel: number, note: number, startTick: number, lengthTicks: number): TrackEvent[] {
  return [noteOn(startTick, channel, note), noteOff(startTick + lengthTicks, channel, note)];
}

/** MTrk chunk bytes. Events are sorted by tick (stable); delta times and the end-of-track event are added. */
export function trackChunk(events: readonly TrackEvent[], opts: { endTick?: number } = {}): number[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i).map((x) => x.e);
  const body: number[] = [];
  let last = 0;
  let prevStatus = -1;
  for (const e of sorted) {
    body.push(...varLen(e.tick - last));
    last = e.tick;
    const status = e.data[0];
    if (e.running && status === prevStatus && status < 0xf0) body.push(...e.data.slice(1));
    else body.push(...e.data);
    prevStatus = status < 0xf0 ? status : -1;
  }
  body.push(...varLen(Math.max(0, (opts.endTick ?? last) - last)), 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}

/** A complete SMF. `format` 1 puts the first track first as the conductor track. */
export function smf(tracks: ReadonlyArray<readonly TrackEvent[]>, opts: { format?: number; ppq?: number } = {}): Uint8Array {
  const format = opts.format ?? 1;
  const ppq = opts.ppq ?? 480;
  const head = [...ascii('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq)];
  const chunks = tracks.flatMap((t) => trackChunk(t));
  return Uint8Array.from([...head, ...chunks]);
}
