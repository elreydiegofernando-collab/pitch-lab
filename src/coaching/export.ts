/**
 * "Send to Claude": the coaching file of one exercise (src/coaching/types.ts CoachingFile), saved through the share
 * sheet (OneDrive, Files, Mail) so the owner can ask for a look in chat.
 *
 * WAVE CONTRACT STUB: the coaching-engine builder replaces the bodies and keeps these signatures.
 */
import type { CoachingFile } from './types';

/** Build the file from the active profile's log and saved takes (newest first, up to 5). Audio only when asked. */
export function buildCoachingFile(exerciseId: string, opts: { includeAudio: boolean }): Promise<CoachingFile> {
  void exerciseId;
  void opts;
  return Promise.reject(new Error('buildCoachingFile: not built yet'));
}

/** "pitch-lab-coach-foundations-05-2026-10-22-1405.json". */
export function coachingFileName(file: CoachingFile): string {
  void file;
  throw new Error('coachingFileName: not built yet');
}
