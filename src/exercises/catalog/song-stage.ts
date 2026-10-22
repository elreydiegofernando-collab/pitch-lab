/**
 * Song Stage (SPEC §10, unlock map §11.2). Not a level ladder: it opens with
 * the Foundations Boss Recital, and each song (bundled or imported) unlocks
 * once the world matching its auto-rated difficulty (SongDifficulty.
 * requiredWorld, src/song) has been passed. So it has no levels, no audition
 * and no Boss Recital; songs are scored by phrase (song.* metrics), not by
 * ExerciseDefs.
 */
import type { WorldDef } from '../types';

export const SONG_STAGE: WorldDef = {
  id: 'song-stage',
  title: 'Song Stage',
  accent: '--world-song',
  summary: 'Sing real melodies against the line, phrase by phrase. Songs open as you earn the worlds they need.',
  levels: [],
  audition: null,
  unlockedBy: 'foundations.boss',
};
