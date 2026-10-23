/**
 * Coaching contract (owner, 2026-10-22): "the coaching tips should be where I'm messing up ... each time I mess up ...
 * it should have more and more advice to the point where it's hand walking me ... that should go for every lesson",
 * and "I should be able to, in this chat, say, hey, this is the lesson that I'm at. Look at where my last progress is
 * ... and analyze why I'm not able to get it."
 *
 * So every take gets a Coaching: the problem located in the take ("where"), plain words with plain numbers, compared
 * with the take before, and help that deepens with each miss in a row (depth 1 -> 4). And the singer can export a
 * coaching file ("Send to Claude") that a script re-analyzes on the PC (scripts/coach.mjs, docs/COACHING.md).
 *
 * Every word a singer reads here is written for someone relearning to sing: no cents, Hz, semitones, bpm or other
 * jargon (owner, 2026-10-22: "assume that I am just relearning how to sing and get into music").
 *
 * Contract file (orchestrator-owned): builders report needed changes, never edit it.
 */
import type { MetricKey } from '../analysis/types';
import type { Notation } from '../core/music';
import type { TargetNote, VibratoStyle } from '../core/types';
import type { DetectorKind } from '../dsp/detector-types';
import type { ExerciseDef } from '../exercises/types';
import type { AttemptRecord, TakeRecord, VocalRange } from '../storage/schema';

/** How much help a take gets: 1 = the plain tip; 2 = + why it happens; 3 = + a step-by-step walk-through; 4 = + a gentler way in and next moves. */
export type CoachDepth = 1 | 2 | 3 | 4;

/** One place in the take where the problem shows (a crack, the flattest note, a missed run note). */
export interface ProblemSpot {
  /** Take time in seconds (0 = the downbeat), for the replay marker. */
  t: number;
  /** Plain label: "0:04, near E4", "note 3 (G3)". */
  label: string;
}

/** The main problem of a take, located and in plain words. */
export interface TakeProblem {
  /** The tip rule it maps to (exercises/tips.ts COACHING_TIPS id): the ladder of help is keyed the same way. */
  tipId: string;
  metric: MetricKey | null;
  /** One plain sentence with plain numbers: "Your voice broke twice on the way up; this level allows none." */
  what: string;
  /** Where it happened, worst first, at most 4. Empty when the analysis cannot place it. */
  spots: ProblemSpot[];
}

/**
 * The help for one tip id, deepening with each miss in a row. Plain words for someone relearning to sing: second person,
 * kind, specific, no jargon or units (no cents, Hz, semitones, bpm), no exclamation marks, never "push" or "force",
 * and stop if anything hurts or goes hoarse.
 */
export interface CoachLadder {
  /** Depth 1: the fix in one or two plain sentences, without numbers (the located problem carries the numbers). */
  tip: string;
  /** Depth 2: why this happens, and the one thing to change. Two or three plain sentences. */
  why: string;
  /** Depth 3: a walk-through of 3 to 6 short steps, each one action the singer can do on the next take. */
  steps: readonly string[];
  /** Depth 4: a gentler way in: one to three plain sentences (on a lip trill, slower, softer, shorter, after a rest). */
  easier: string;
  /**
   * An earlier level whose skill this builds on, offered at depth 4 as "Practise <title>". Offered only when the singer
   * has passed it (replaying earned material never bypasses gating). A catalog level id.
   */
  practiseLevelId?: string;
}

export type CoachMove =
  /** Play the Listen demo again, slowly where the exercise supports it. */
  | { kind: 'listen-slow' }
  /** Replay an earlier, already PASSED level that builds this skill. */
  | { kind: 'practise-level'; levelId: string; title: string }
  /** Voice care: many takes in a short time, or several misses running. */
  | { kind: 'rest' }
  /** Export the coaching file for a look in chat ("Send to Claude"). */
  | { kind: 'send-to-claude' };

/** One line of "since last time": the same measure on the previous take of this exercise and on this one. */
export interface ProgressLine {
  label: string;
  before: string;
  now: string;
  /** True when it moved the right way, false when the wrong way, null when unchanged or not comparable. */
  better: boolean | null;
}

/** Everything the report's coaching card shows for one take. */
export interface Coaching {
  depth: CoachDepth;
  /** Misses in a row on this exercise, this take included; 0 after a pass. */
  missesInARow: number;
  passed: boolean;
  problem: TakeProblem;
  /** Depth 1 (always): the ladder's plain tip. */
  tip: string;
  /** Depth >= 2. */
  why: string | null;
  /** Depth >= 3. */
  steps: readonly string[];
  /** Depth 4. */
  easier: string | null;
  /** Since the previous take of this exercise (empty on a first take). */
  progress: ProgressLine[];
  /** Buttons under the card; 'send-to-claude' from depth 3. */
  moves: CoachMove[];
}

/** Bump when the shape changes; scripts/coach.mjs reads every version it knows. */
export const COACHING_FILE_VERSION = 1;

/**
 * The coaching file "Send to Claude" exports: JSON, saved through the share sheet (OneDrive, Files, Mail). It holds the
 * pitch line of each take, never audio unless the singer ticks "Include audio" (audio leaves the device only on an
 * explicit export, SPEC §4).
 */
export interface CoachingFile {
  app: 'pitch-lab';
  kind: 'coaching';
  version: typeof COACHING_FILE_VERSION;
  exportedAt: string;
  /** The app build, for matching analyzer behaviour (package.json version + the bundle's build id when known). */
  appVersion: string;
  level: { id: string | null; title: string; worldId: string };
  /** The exercise as defined at export (patterns, pass rule, analyzers), so the script needs no catalog. */
  exercise: ExerciseDef;
  profile: { name: string; voiceType: string; range: VocalRange | null };
  settings: {
    vibratoStyle: VibratoStyle;
    notation: Notation;
    keepTakeAudio: boolean;
    /** The pitch detector the takes were sung with (Settings), so audio is rebuilt with the same one; absent in older files (MPM, the default). */
    detector?: DetectorKind;
  };
  device: { route: string; latencyMs: number | null; userAgent: string };
  /** Newest first: up to 5 takes of this exercise. */
  takes: Array<{
    attempt: AttemptRecord;
    /** The targets the take was sung against (take time), so it can be re-analyzed exactly. */
    realized: { tonicMidi: number; bpm: number; countInSec: number; totalSec: number; notes: TargetNote[] };
    /** The saved pitch line (storage/track-codec.ts encoding); null when the take was not saved. */
    track: TakeRecord['track'] | null;
    /** Base64 WAV when the singer included audio; null otherwise. */
    audioWavBase64: string | null;
  }>;
}

/**
 * The song coaching file ("Send to Claude" from a song): the song as charted (notes, lyrics, phrases) and its recent
 * takes, each with the phrases it covered, its key and speed, and its pitch line. The song is the owner's own chart
 * (bundled public domain, or his own import): the file stays his, saved through the share sheet, never committed.
 */
export interface SongCoachingFile {
  app: 'pitch-lab';
  kind: 'song-coaching';
  version: typeof COACHING_FILE_VERSION;
  exportedAt: string;
  appVersion: string;
  song: import('../song/types').Song;
  profile: { name: string; voiceType: string; range: VocalRange | null };
  settings: {
    notation: Notation;
    /** The pitch detector the takes were sung with (Settings), so audio is rebuilt with the same one; absent in older files (MPM, the default). */
    detector?: DetectorKind;
  };
  device: { route: string; latencyMs: number | null; userAgent: string };
  /** Newest first: up to 8 takes of this song. */
  takes: Array<{
    attempt: AttemptRecord;
    /** [from, to) into pitchedView(song).phrases; null for the whole song. */
    phrase: { from: number; to: number } | null;
    /** Half steps from the chart's key, and the playback speed (0.5, 0.75 or 1). */
    shift: number;
    speed: number;
    /**
     * The saved pitch line (storage/track-codec.ts encoding) on the take's own timeline: t = 0 at the start of the window
     * it was sung over (one second before the first note of its phrases), in real seconds, so song time = window start +
     * t x speed (coaching/song-export.ts). Null when the take was not saved.
     */
    track: TakeRecord['track'] | null;
    audioWavBase64: string | null;
  }>;
}
