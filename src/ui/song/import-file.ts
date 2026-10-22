/**
 * Reading the song file the singer picked (DESIGN.md §13.8 step 1): an UltraStar .txt (decodeUltraStarBytes, so a
 * legacy windows-1252 chart keeps its accents, then parseUltraStar) or a MIDI file (importMidi, which scores every
 * track with scoreMidiTracks and builds the song from the best one). The two are told apart by the MIDI header,
 * not the name, since phones rename downloads. Every failure is a plain sentence with the fix, for the line next to
 * the picker. Nothing here leaves the device.
 */
import { MidiImportError, importMidi, type MidiImportResult } from '../../song/midi';
import { UltraStarParseError, decodeUltraStarBytes, parseUltraStar } from '../../song/ultrastar';
import type { Song } from '../../song/types';

/** Charts are small text or MIDI files; anything bigger was picked by mistake. */
const MAX_CHART_BYTES = 5 * 1024 * 1024;
/** A backing track: minutes of MP3, or a few minutes of 16-bit WAV. */
export const MAX_BACKING_BYTES = 80 * 1024 * 1024;

export type PickedSong =
  | { kind: 'ultrastar'; fileName: string; song: Song; warnings: string[]; audioFile: string | null }
  | { kind: 'midi'; fileName: string; bytes: Uint8Array; result: MidiImportResult };

/** A Standard MIDI File starts with "MThd". */
function isMidiBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
}

/** The file name without its extension: the title of a chart that names none. */
export function baseName(fileName: string): string {
  const name = fileName.replace(/^.*[\\/]/, '');
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

function midiResult(bytes: Uint8Array, trackIndex?: number): MidiImportResult {
  try {
    return importMidi(bytes, trackIndex === undefined ? {} : { trackIndex });
  } catch (err) {
    if (err instanceof MidiImportError) throw new Error(`This MIDI file can't be imported: ${err.message}.`);
    throw err;
  }
}

/** Reads and parses a picked chart. Rejects with a plain message (shown next to the picker). */
export async function readSongFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<PickedSong> {
  if (file.size === 0) throw new Error('That file is empty. Pick an UltraStar .txt or a MIDI file.');
  if (file.size > MAX_CHART_BYTES) throw new Error('That file is too big to be a song chart. Pick an UltraStar .txt or a MIDI file.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isMidiBytes(bytes)) return { kind: 'midi', fileName: file.name, bytes, result: midiResult(bytes) };
  if (/\.(mid|midi|kar)$/i.test(file.name)) throw new Error("That file is named like a MIDI file but isn't one. Export it again from your music app.");
  try {
    const parsed = parseUltraStar(decodeUltraStarBytes(bytes));
    return { kind: 'ultrastar', fileName: file.name, song: parsed.song, warnings: parsed.warnings, audioFile: parsed.audioFile };
  } catch (err) {
    if (err instanceof UltraStarParseError) throw new Error(`That isn't a chart Pitch Lab can read (${err.message}). Pick an UltraStar .txt or a MIDI file.`);
    throw err;
  }
}

/** The same MIDI file built from another track (the track picker). */
export function chooseMidiTrack(picked: Extract<PickedSong, { kind: 'midi' }>, trackIndex: number): Extract<PickedSong, { kind: 'midi' }> {
  return { ...picked, result: midiResult(picked.bytes, trackIndex) };
}

/** The parsed song of a pick. */
export function pickedSong(picked: PickedSong): Song {
  return picked.kind === 'midi' ? picked.result.song : picked.song;
}

/** Notes worth showing about a pick (duet voices dropped, lyrics that did not line up, a polyphonic track ...). */
export function pickedWarnings(picked: PickedSong): string[] {
  return picked.kind === 'midi' ? picked.result.warnings : picked.warnings;
}

/** The song as it will be saved: the singer's title and artist, and the backing offset they set (ms added to the chart's). */
export function songToSave(song: Song, edits: { title: string; artist: string; offsetAdjustMs: number }, fileName: string): Song {
  return {
    ...song,
    title: edits.title.trim() || song.title || baseName(fileName) || 'Untitled song',
    artist: edits.artist.trim(),
    offsetMs: song.offsetMs + Math.round(edits.offsetAdjustMs),
  };
}
