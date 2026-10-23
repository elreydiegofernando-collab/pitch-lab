/**
 * The coaching tip ids for song takes (owner, 2026-10-22: "I'd love to be able to practice on a song and get better at
 * it"). The song coach (src/coaching/song.ts) names one of these as a song take's main problem; each has a ladder of
 * help in src/coaching/content/song.ts, deepening with each miss in a row on the same phrase, exactly like exercises.
 *
 * Contract file (orchestrator-owned): the song coach and the song content builder share these ids and meanings.
 */
export const SONG_TIPS = {
  'song.flat': 'The phrase sat below the notes overall (flat).',
  'song.sharp': 'The phrase sat above the notes overall (sharp).',
  'song.off-notes': 'A few notes were clearly a different note from the one written (named by syllable).',
  'song.leap': 'A big jump between two notes landed off (named by the two syllables).',
  'song.high': 'The highest notes of the phrase came out flat, strained or broken.',
  'song.low': 'The lowest notes came out too quiet, breathy or off.',
  'song.late': 'Notes came in after the beat (late on the words).',
  'song.early': 'Notes came in ahead of the beat (rushing).',
  'song.breath': 'The sound dropped out in the middle of the phrase (running out of air, or a breath in the wrong place).',
  'song.cracks': 'The voice broke on a note of the phrase.',
  'song.unsteady': 'Long notes wavered or sank.',
  'song.unsung': 'Some notes or words were left unsung.',
  'song.polish': 'The phrase passed: what to work on next (the next phrase, full speed, joining phrases).',
  'song.join': 'Two phrases joined: keep the line going through the breath between them.',
} as const;

export type SongTipId = keyof typeof SONG_TIPS;

export const SONG_TIP_IDS: readonly SongTipId[] = Object.keys(SONG_TIPS) as SongTipId[];
