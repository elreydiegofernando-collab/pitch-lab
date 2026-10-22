/** Plain-language messages the exercise runner, song mode and the route guard share (DESIGN.md §6: the problem and what to do). */

/** A personal-record attempt on the Range finder, refused by the runner and the route guard alike (progress/unlocks.ts isRecordAttemptAllowed). */
export const RANGE_FINDER_NO_RECORDS = 'The Range finder measures your range: it has no personal records to chase.';

/**
 * The take was written (the attempt counts, its pitch trace is kept), but the store could not keep its sound: an audio
 * write that failed, or no older audio left to free on a full device (storage/takes-repo.ts saves the take without it).
 */
export const TAKE_AUDIO_NOT_KEPT =
  'The take counted and its pitch trace was kept, but its sound could not be saved (this device may be low on space). Listen now: it will not be in Recordings later.';
