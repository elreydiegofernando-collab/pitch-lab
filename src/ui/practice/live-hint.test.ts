/**
 * The live hint's rules on synthesized frames (src/analysis/fixtures.ts makeTrack at the real ~94 frames a second):
 * sharp, flat, on it, steady, wobbly, silent, a Listen step, a rest, and the count-in's starting pitch; what the plan
 * leaves unjudged; and the stylesheet's promises (tokens only, opacity only, every hint has its glyph).
 */
import { describe, expect, it } from 'vitest';
import { FRAME_RATE } from '../../analysis/fixtures';
import { jargonIn } from '../../coaching/plain';
import { CONFIG } from '../../config';
import type { PitchFrame } from '../../core/types';
import { EXERCISES, WORLDS, getExercise } from '../../exercises';
import { lessonFor } from '../../lessons';
import { CUE } from '../../exercises/cues';
import type { RealizedStep } from '../../exercises/transpose';
import type { ExerciseDef } from '../../exercises/types';
import {
  HINTS,
  HINT_TICK_MS,
  MIN_JUDGED_STEP_SEC,
  MIN_PHASE_STEP_SEC,
  MIN_STEADY_STEP_SEC,
  createHintTracker,
  hintInfo,
  planHints,
  type HintKind,
  type HintPlan,
  type HintStep,
  type HintTracker,
} from './live-hint';
import { exercise, note as held, prepare, rest as pause, slide, voiceFrames } from './live-hint-fixtures';

const { readFileSync } = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(path: URL, encoding: 'utf8'): string };

/** Engine time of take time 0. */
const ORIGIN = 100;
const NOTE = 60;

// ---------------------------------------------------------------- builders

const sing = (start: number, end: number, over: Partial<HintStep> = {}): HintStep => ({
  role: 'sing', start, end, midi: NOTE, phase: true, judged: true, steady: true, ...over,
});
const listen = (start: number, end: number): HintStep => ({ role: 'listen', start, end, midi: NOTE, phase: true, judged: false, steady: false });
const rest = (start: number, end: number, over: Partial<HintStep> = {}): HintStep => ({
  role: 'rest', start, end, midi: NaN, phase: true, judged: false, steady: false, ...over,
});
const planOf = (steps: HintStep[], toleranceCents = 50, tones: HintPlan['tones'] = []): HintPlan => ({ toleranceCents, steps, tones });

/** One held note of 10 s, judged and steady, in an easy (+-50) or other zone. */
const holdPlan = (toleranceCents = 50, over: Partial<HintStep> = {}): HintPlan => planOf([sing(0, 10, over)], toleranceCents);

/** Frames from take time `from` to `to`: `midi(take)` is the pitch (NaN = silence), with Gaussian-ish jitter in cents. */
function voice(from: number, to: number, midi: (take: number) => number, jitterCents = 0, seed = 7): PitchFrame[] {
  return voiceFrames(ORIGIN, from, to, midi, jitterCents, seed);
}
const silence = (from: number, to: number): PitchFrame[] => voice(from, to, () => NaN);
const feed = (tracker: HintTracker, frames: readonly PitchFrame[]): void => {
  for (const f of frames) tracker.push(f);
};

/** A tracker fed `frames`, then read. */
function readAfter(plan: HintPlan, frames: readonly PitchFrame[]): HintKind {
  const tracker = createHintTracker(plan, ORIGIN);
  feed(tracker, frames);
  return tracker.read();
}

/** What a reader that looks every HINT_TICK_MS sees while `frames` arrive: the hint after each tick. */
function ticks(tracker: HintTracker, frames: readonly PitchFrame[]): HintKind[] {
  const per = Math.round((FRAME_RATE * HINT_TICK_MS) / 1000);
  const seen: HintKind[] = [];
  for (let i = 0; i < frames.length; i += per) {
    feed(tracker, frames.slice(i, i + per));
    seen.push(tracker.read());
  }
  return seen;
}
const collapse = (kinds: readonly HintKind[]): HintKind[] => kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]);

/** A note of the voice, `cents` off the step's note. */
const at = (cents: number) => (): number => NOTE + cents / 100;

// ---------------------------------------------------------------- the words

describe('the hints', () => {
  it('say exactly what the singer was promised', () => {
    expect(HINTS.listen.text).toBe('listen...');
    expect(HINTS.breathe.text).toBe('breathe');
    expect(HINTS.sing.text).toBe('sing now');
    expect(HINTS.higher.text).toBe('a little higher');
    expect(HINTS.lower.text).toBe('a little lower');
    expect(HINTS['on-it'].text).toBe('on it');
    expect(HINTS.steady.text).toBe('steady, good');
    expect(HINTS.wobbly.text).toBe('a bit wobbly: soften and keep the air even');
  });

  it('read plainly: no cents, Hz, onset or other jargon', () => {
    for (const info of Object.values(HINTS)) expect(jargonIn(info.text), info.text).toEqual([]);
  });

  it('always come with a glyph and a tone, and the two directions have their own arrows', () => {
    for (const info of Object.values(HINTS)) {
      expect(info.glyph.length).toBeGreaterThan(0);
      expect(info.tone.length).toBeGreaterThan(0);
    }
    expect(HINTS.higher.glyph).toBe('up');
    expect(HINTS.lower.glyph).toBe('down');
    expect(HINTS['much-higher'].glyph).toBe('up');
    expect(HINTS['much-lower'].glyph).toBe('down');
    expect(hintInfo('steady')).toBe(HINTS.steady);
    expect(hintInfo('none')).toBeNull();
  });
});

// ---------------------------------------------------------------- phases: listen, rest, sing now

describe('the phases of a take', () => {
  const echo = planOf([listen(0, 2), rest(2, 3), sing(3, 6)]);

  it('says nothing before any frame has arrived', () => {
    expect(createHintTracker(echo, ORIGIN).read()).toBe('none');
  });

  it('says "listen..." while the app plays the note, "breathe" in the rest, "sing now" when it is the singer\'s turn', () => {
    expect(readAfter(echo, silence(0, 1))).toBe('listen');
    expect(readAfter(echo, silence(0, 2.5))).toBe('breathe');
    expect(readAfter(echo, silence(0, 3.5))).toBe('sing');
  });

  it('says "listen..." even if the singer hums along, and "breathe" even if they are still singing', () => {
    expect(readAfter(echo, voice(0, 1, at(0)))).toBe('listen');
    expect(readAfter(echo, voice(0, 2.5, at(0)))).toBe('breathe');
  });

  it('says nothing after the last step (the take is finishing)', () => {
    expect(readAfter(echo, silence(0, 6.3))).toBe('none');
  });

  it('says "listen..." through the count-in while its starting pitch sounds, and nothing while it only clicks', () => {
    const withStart = planOf([sing(0, 4)], 50, [{ start: -2, end: 0 }]);
    expect(readAfter(withStart, silence(-3, -1))).toBe('listen');
    expect(readAfter(withStart, silence(-3, -2.5))).toBe('none');
    expect(readAfter(planOf([sing(0, 4)]), silence(-3, -1))).toBe('none');
  });

  it('says "listen..." when the app plays the next key\'s first note in a rest', () => {
    const plan = planOf([sing(0, 3), rest(3, 5), sing(5, 8)], 50, [{ start: 3.5, end: 4.5 }]);
    expect(readAfter(plan, silence(0, 2.5))).toBe('sing');
    expect(readAfter(plan, silence(0, 3.2))).toBe('breathe');
    expect(readAfter(plan, silence(0, 3.6))).toBe('listen');
    expect(readAfter(plan, silence(0, 4.8))).toBe('breathe');
  });

  it('says nothing in a step too short to read a hint in', () => {
    expect(readAfter(planOf([rest(0, 0.5, { phase: false }), sing(0.5, 4)]), silence(0, 0.3))).toBe('none');
    expect(readAfter(planOf([sing(0, 0.5, { phase: false, judged: false, steady: false })]), silence(0, 0.3))).toBe('none');
  });

  it('follows the take clock the caller gives it, even with no new frames', () => {
    const tracker = createHintTracker(echo, ORIGIN);
    feed(tracker, silence(0, 1));
    expect(tracker.read(ORIGIN + 1)).toBe('listen');
    expect(tracker.read(ORIGIN + 3.5)).toBe('sing');
  });
});

// ---------------------------------------------------------------- the voice against the note

describe('the voice against the note', () => {
  // 8 s long and judged; the voice comes in a third of a second after the step starts.
  const IN = 0.3;
  const sung = (cents: number, to = 1.4, jitter = 2): PitchFrame[] => voice(IN, to, at(cents), jitter);

  it('stays quiet while the voice is only just starting, then speaks', () => {
    const tracker = createHintTracker(holdPlan(25), ORIGIN);
    const seen = collapse(ticks(tracker, [...silence(0, IN), ...sung(0, 1.6)]));
    expect(seen[0]).toBe('sing');
    expect(seen[1]).toBe('none');
    expect(seen[2]).toBe('on-it');
  });

  it('says "a little lower" to a singer who is sharp', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(40)])).toBe('lower');
  });

  it('says "a little higher" to a singer who is flat', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(-40)])).toBe('higher');
  });

  it('says "a lot" when the voice is a whole step or more away, an octave included', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(300)])).toBe('much-lower');
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(-300)])).toBe('much-higher');
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(-1200)])).toBe('much-higher');
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(1200)])).toBe('much-lower');
  });

  it('reads the zone the level draws: the same 40 cents is on it in an easy zone and flat in a default one', () => {
    expect(readAfter(holdPlan(50), [...silence(0, IN), ...sung(-40)])).toBe('on-it');
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(-40)])).toBe('higher');
    expect(CONFIG.tolerance.easy).toBe(50);
    expect(CONFIG.tolerance.default).toBe(25);
  });

  it('says "on it" inside the zone, before it has been long enough to call it steady', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(5, 1.3, 3)])).toBe('on-it');
  });

  it('judges the part just sung, not the voice finding its way in', () => {
    // Starts 80 cents flat and slides into the note over a quarter second: by 1.3 s it is on it.
    const approach = voice(IN, 1.3, (t) => NOTE - 0.8 * Math.exp(-(t - IN) / 0.08), 2);
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...approach])).toBe('on-it');
  });

  it('says "steady, good" once the voice has stayed inside the zone, steadily, for about a second', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(3, 2.6, 3)])).toBe('steady');
    expect(readAfter(holdPlan(50), [...silence(0, IN), ...sung(0, 4, 4)])).toBe('steady');
  });

  it('does not call it steady before the second is up', () => {
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...sung(3, 1.5, 3)])).not.toBe('steady');
  });

  it('says "a bit wobbly" when the voice is inside the zone on average but swinging', () => {
    const swing = (cents: number, hz = 3.5) => (t: number) => NOTE + (cents / 100) * Math.sin(2 * Math.PI * hz * t);
    expect(readAfter(holdPlan(50), [...silence(0, IN), ...voice(IN, 2.6, swing(35), 2)])).toBe('wobbly');
    // A narrow zone: a swing that keeps crossing its edge looks wobbly on the canvas whatever its spread.
    expect(readAfter(holdPlan(10), [...silence(0, IN), ...voice(IN, 2.6, swing(15), 0)])).toBe('wobbly');
    // The same narrow zone, a swing that stays inside it: steady.
    expect(readAfter(holdPlan(10), [...silence(0, IN), ...voice(IN, 2.6, swing(5), 0)])).toBe('steady');
  });

  it('calls a slow waver a wobble too, not only a fast shake, wherever in its swing the look falls', () => {
    const waver = (t: number): number => NOTE + 0.35 * Math.sin(2 * Math.PI * 1.5 * t);
    for (const end of [2.6, 2.75, 2.9, 3.05, 3.2]) {
      expect(readAfter(holdPlan(50), [...silence(0, IN), ...voice(IN, end, waver, 2)]), `look at ${end}`).toBe('wobbly');
    }
  });

  it('does not mistake a correction for a wobble: from sharp onto the note it goes on it, and then steady', () => {
    for (const [tolerance, off] of [[50, 80], [25, 80], [10, 30]] as const) {
      const tracker = createHintTracker(holdPlan(tolerance), ORIGIN);
      const seen = ticks(tracker, [...silence(0, IN), ...voice(IN, 2.2, at(off), 2), ...voice(2.2, 5.5, at(0), 2)]);
      expect(seen, `zone ${tolerance}`).toContain('lower');
      expect(seen, `zone ${tolerance}`).not.toContain('wobbly');
      expect(seen, `zone ${tolerance}`).toContain('on-it');
      expect(seen[seen.length - 1], `zone ${tolerance}`).toBe('steady');
    }
  });

  it('prefers "wobbly" to "higher" or "lower" when the swing straddles the zone and the middle is inside', () => {
    const swing = (t: number): number => NOTE + 0.35 * Math.sin(2 * Math.PI * 3.5 * t);
    const tracker = createHintTracker(holdPlan(25), ORIGIN);
    const seen = ticks(tracker, [...silence(0, IN), ...voice(IN, 3.5, swing, 0)]);
    expect(seen[seen.length - 1]).toBe('wobbly');
  });

  it('says nothing about steadiness in an exercise that asks for vibrato: a swing is not a fault there', () => {
    const swing = (t: number): number => NOTE + 0.35 * Math.sin(2 * Math.PI * 5.8 * t);
    const plan = holdPlan(50, { steady: false });
    const seen = readAfter(plan, [...silence(0, IN), ...voice(IN, 3, swing, 0)]);
    expect(['on-it', 'higher', 'lower']).toContain(seen);
    expect(readAfter(plan, [...silence(0, IN), ...voice(IN, 3, at(0), 2)])).toBe('on-it');
  });

  it('is not thrown by a detector glitch: a stray octave frame does not spoil a steady note', () => {
    const glitchy = (t: number): number => (Math.abs((t % 0.3) - 0.15) < 0.01 ? NOTE + 12 : NOTE);
    expect(readAfter(holdPlan(25), [...silence(0, IN), ...voice(IN, 3, glitchy, 2)])).toBe('steady');
  });

  it('asks the singer to sing again after a silence that is longer than a breath', () => {
    const plan = holdPlan(25);
    expect(readAfter(plan, [...silence(0, IN), ...sung(0, 1.5), ...silence(1.5, 1.7)])).not.toBe('sing');
    expect(readAfter(plan, [...silence(0, IN), ...sung(0, 1.5), ...silence(1.5, 2.2)])).toBe('sing');
  });

  it('says "sing now" in a step that is not judged, then nothing while the voice is there (nothing to say about its pitch)', () => {
    const plan = planOf([sing(0, 6, { judged: false, steady: false })]);
    expect(readAfter(plan, silence(0, 1))).toBe('sing');
    expect(readAfter(plan, [...silence(0, IN), ...sung(0, 2)])).toBe('none');
    expect(readAfter(plan, [...silence(0, IN), ...sung(900, 2)])).toBe('none');
  });

  it('starts over in each step: a steady note does not carry its praise into the next one', () => {
    const plan = planOf([sing(0, 4), sing(4, 8, { midi: NOTE + 2 })], 25);
    const tracker = createHintTracker(plan, ORIGIN);
    const first = ticks(tracker, [...silence(0, IN), ...voice(IN, 4, at(0), 2)]);
    expect(first[first.length - 1]).toBe('steady');
    // The next note: right on it from the first frame, yet the first moments say nothing, not "steady".
    const next = ticks(tracker, voice(4, 5.1, () => NOTE + 2, 2));
    expect(next[0]).toBe('none');
    expect(next).not.toContain('steady');
    expect(next[next.length - 1]).toBe('on-it');
  });

  it('keeps the last verdict when the voice drops out for a moment: the hint does not blink', () => {
    const tracker = createHintTracker(holdPlan(25), ORIGIN);
    feed(tracker, [...silence(0, IN), ...voice(IN, 1.5, at(0), 2)]);
    expect(tracker.read()).toBe('on-it');
    // A 0.15 s hole (a consonant, a detector dropout): the run of voice starts again, the hint does not blink.
    feed(tracker, [...silence(1.5, 1.65), ...voice(1.65, 1.75, at(0), 2)]);
    expect(tracker.read()).toBe('on-it');
  });
});

// ---------------------------------------------------------------- hysteresis

describe('a change of hint', () => {
  it('waits to hold before it shows, so the line does not flicker at the edge of the zone', () => {
    const plan = holdPlan(25, { steady: false });
    const tracker = createHintTracker(plan, ORIGIN);
    // On the note, then sharp from 2.0 s on. Looks come every 0.2 s: look 9 is just after the jump, look 10 at 2.2 s.
    const seen = ticks(tracker, [...silence(0, 0.3), ...voice(0.3, 2, at(0), 2), ...voice(2, 4, at(40), 2)]);
    expect(seen[9]).toBe('on-it');
    expect(seen[10]).toBe('on-it');
    // The voice reads sharp from about look 10 or 11 at the soonest and the change needs 0.35 s to hold: not before look 12.
    const first = seen.indexOf('lower');
    expect(first).toBeGreaterThanOrEqual(12);
    expect(first).toBeLessThanOrEqual(14);
    expect(seen[seen.length - 1]).toBe('lower');
    expect(collapse(seen).slice(-2)).toEqual(['on-it', 'lower']);
  });

  it('ignores a blip shorter than that', () => {
    const plan = holdPlan(25, { steady: false });
    const tracker = createHintTracker(plan, ORIGIN);
    const seen = ticks(tracker, [...silence(0, 0.3), ...voice(0.3, 2, at(0), 2), ...voice(2, 2.3, at(40), 2), ...voice(2.3, 4, at(0), 2)]);
    expect(seen).not.toContain('lower');
    expect(seen[seen.length - 1]).toBe('on-it');
  });

  it('shows the phases at once, without waiting', () => {
    const tracker = createHintTracker(planOf([sing(0, 3, { steady: false }), rest(3, 5), sing(5, 8)], 25), ORIGIN);
    feed(tracker, [...silence(0, 0.3), ...voice(0.3, 3, at(0), 2)]);
    expect(tracker.read()).toBe('on-it');
    feed(tracker, silence(3, 3.1));
    expect(tracker.read()).toBe('breathe');
  });
});

// ---------------------------------------------------------------- the hot path

describe('the tracker', () => {
  it('counts the frames it takes in, so a reader can tell that the engine has stopped', () => {
    const tracker = createHintTracker(holdPlan(), ORIGIN);
    expect(tracker.framesSeen).toBe(0);
    feed(tracker, silence(0, 1));
    expect(tracker.framesSeen).toBe(Math.floor(FRAME_RATE));
  });

  it('keeps no frames and works after its ring has wrapped many times', () => {
    const tracker = createHintTracker(planOf([sing(0, 60)], 25), ORIGIN);
    const frames = [...silence(0, 0.3), ...voice(0.3, 40, at(2), 2)];
    expect(frames.length).toBeGreaterThan(256 * 10);
    feed(tracker, frames);
    expect(tracker.read()).toBe('steady');
  });

  it('starts afresh when the engine restarts its clock', () => {
    const tracker = createHintTracker(planOf([listen(0, 2), sing(2, 6)]), ORIGIN);
    feed(tracker, [...silence(0, 1), ...voice(10, 11, at(0))]);
    feed(tracker, silence(0.2, 0.5));
    expect(tracker.framesSeen).toBe(Math.floor(FRAME_RATE) * 2 + Math.floor(0.3 * FRAME_RATE));
    expect(tracker.read()).toBe('listen');
  });

  it('ignores a frame that has no time, and never throws on odd input: no steps, odd frames, a clock that jumps about', () => {
    const KINDS: readonly HintKind[] = ['none', 'listen', 'breathe', 'sing', 'higher', 'lower', 'much-higher', 'much-lower', 'on-it', 'steady', 'wobbly'];
    const noTime = createHintTracker(holdPlan(), ORIGIN);
    noTime.push({ t: NaN, f0Hz: 220, midi: NOTE, centsFromNearest: 0, confidence: 1, rmsDb: -20, voiced: true });
    expect(noTime.framesSeen).toBe(0);
    expect(noTime.read()).toBe('none');
    expect(createHintTracker(planOf([]), ORIGIN).read(ORIGIN + 1)).toBe('none');

    // A seeded scramble: random plans, frames with unvoiced and wild pitches, and a clock that sometimes runs backwards.
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial++) {
      const steps: HintStep[] = [];
      let at = random() < 0.3 ? -random() : 0;
      for (let i = 0, n = 1 + Math.floor(random() * 6); i < n; i++) {
        const length = random() < 0.1 ? 0 : 0.2 + random() * 5;
        const role = (['sing', 'listen', 'rest'] as const)[Math.floor(random() * 3)];
        steps.push({ role, start: at, end: at + length, midi: NOTE + Math.floor(random() * 12), phase: random() < 0.8, judged: random() < 0.7, steady: random() < 0.5 });
        at += length;
      }
      const tracker = createHintTracker(planOf(steps, [0, 10, 25, 50][Math.floor(random() * 4)], random() < 0.3 ? [{ start: -1, end: 0.5 }] : []), ORIGIN);
      let t = ORIGIN - random() * 2;
      for (let f = 0; f < 150 + Math.floor(random() * 500); f++) {
        t += random() < 0.02 ? -random() * 3 : 1 / FRAME_RATE;
        const voiced = random() < 0.8;
        const midi = voiced ? NOTE + (random() - 0.5) * (random() < 0.1 ? 40 : 1) : NaN;
        tracker.push({ t, f0Hz: voiced ? 220 : NaN, midi, centsFromNearest: 0, confidence: 1, rmsDb: -20, voiced });
        if (f % 17 === 0) expect(KINDS, `trial ${trial} frame ${f}`).toContain(tracker.read());
      }
      expect(KINDS).toContain(tracker.read());
      expect(KINDS).toContain(tracker.read(ORIGIN + random() * 20 - 2));
    }
  });
});

// ---------------------------------------------------------------- the plan

describe('planHints', () => {
  const planFor = (def: ExerciseDef): { plan: HintPlan; steps: RealizedStep[] } => {
    const { realized } = prepare(def);
    return { plan: planHints(def, realized), steps: realized.steps };
  };

  it('reads an echo exercise as listen, rest, sing, and judges the sung note', () => {
    const { plan } = planFor(exercise([held(0, 2, { cue: CUE.listen }), pause(1), held(0, 3, { cue: CUE.sing }), pause(1)], { tolerance: 'default' }));
    expect(plan.steps.map((s) => s.role)).toEqual(['listen', 'rest', 'sing', 'rest']);
    expect(plan.steps.map((s) => s.phase)).toEqual([true, true, true, true]);
    // Three seconds: long enough to be asked to be steady.
    expect(plan.steps[2]).toMatchObject({ judged: true, steady: true });
    expect(plan.steps[0]).toMatchObject({ judged: false, steady: false });
    expect(plan.tones).toEqual([{ start: 0, end: 2 }]);
    expect(plan.toleranceCents).toBe(CONFIG.tolerance.default);
  });

  it('never says steady or wobbly on the wide zone of the first lessons, before Hold it steady teaches those words', () => {
    const { plan } = planFor(exercise([held(0, 2, { cue: CUE.listen }), pause(1), held(0, 3, { cue: CUE.sing }), pause(1)], { tolerance: 'easy' }));
    expect(plan.toleranceCents).toBe(CONFIG.tolerance.easy);
    expect(plan.steps[2]).toMatchObject({ judged: true, steady: false }); // still higher, lower or on it
    // The Foundations lessons on the wide zone teach neither word; the first lesson that asks for steady teaches both.
    const ordered = [...WORLDS[0].levels].sort((a, b) => a.index - b.index);
    const firstSteady = ordered.findIndex((l) => planFor(getExercise(l.exerciseId)!).plan.steps.some((s) => s.steady));
    expect(firstSteady).toBeGreaterThan(0);
    for (const level of ordered.slice(0, firstSteady)) expect(getExercise(level.exerciseId)!.tolerance, level.id).toBe('easy');
    const taught = ordered.slice(0, firstSteady + 1).flatMap((l) => lessonFor(l.id)?.learn.terms ?? []);
    expect(taught).toEqual(expect.arrayContaining(['steady', 'wobble']));
    for (const level of ordered.slice(0, firstSteady)) {
      const terms = lessonFor(level.id)?.learn.terms ?? [];
      expect(terms, level.id).not.toContain('steady');
      expect(terms, level.id).not.toContain('wobble');
    }
  });

  it('takes its zone from the level: easy, default or studio', () => {
    for (const tolerance of ['easy', 'default', 'studio'] as const) {
      expect(planFor(exercise([held(0, 4)], { tolerance })).plan.toleranceCents).toBe(CONFIG.tolerance[tolerance]);
    }
  });

  it('knows the starting pitch the app plays in the count-in', () => {
    const { plan } = planFor(exercise([held(0, 4)], { countInBeats: 3 }));
    expect(plan.tones).toEqual([{ start: -3, end: 0 }]);
  });

  it('never judges the Range finder: the singer goes where the voice goes', () => {
    const finder = exercise([held(0, 2), slide(0, -5, 4), held(-5, 3), pause(2)], { kind: 'range-finder', analyzers: ['range'] });
    const { plan } = planFor(finder);
    expect(plan.steps.some((s) => s.judged || s.steady)).toBe(false);
    expect(plan.steps.filter((s) => s.role === 'sing').every((s) => s.phase)).toBe(true);
  });

  it('never judges a glide or a slide, whose line is a shape', () => {
    const siren = exercise([held(0, 1.5), slide(0, 7, 2), held(7, 3)], { kind: 'siren', analyzers: ['glide', 'cracks'], tolerance: 'default' });
    const { plan } = planFor(siren);
    expect(plan.steps.map((s) => s.judged)).toEqual([true, false, true]);
    expect(plan.steps.map((s) => s.steady)).toEqual([false, false, true]);
  });

  it('judges the held notes of an inflection exercise (the moving step is a glide)', () => {
    const scoop = exercise([{ semis: -2, glideToSemis: 0, beats: 0.5, cue: CUE.scoop }, held(0, 2.5), pause(1)], { kind: 'scoop', analyzers: ['inflection', 'accuracy'] });
    const { plan } = planFor(scoop);
    expect(plan.steps.map((s) => s.judged)).toEqual([false, true, false]);
  });

  it('leaves quick notes to the beat: a note of a second or less is not judged (the first note of a two-note chunk, a note of a scale), and a step under 0.6 s says nothing at all', () => {
    const { plan } = planFor(exercise([held(0, 0.8), held(2, 1), held(4, 0.5), pause(0.5), held(5, 1.5)]));
    expect(plan.steps.map((s) => s.judged)).toEqual([false, false, false, false, true]);
    expect(plan.steps.map((s) => s.phase)).toEqual([true, true, false, false, true]);
  });

  it('never asks an exercise that wants vibrato to be steady, but still says where the note is', () => {
    const cued = planFor(exercise([held(0, 4, { cue: CUE.vibrato })])).plan; // a vibrato cue, whatever is scored
    expect(cued.steps[0]).toMatchObject({ judged: true, steady: false });
    for (const analyzers of [['vibrato'], ['pulse', 'accuracy'], ['switch', 'vibrato']] as const) {
      const meter = planFor(exercise([held(0, 4)], { kind: 'vibrato-meter', analyzers: [...analyzers] })).plan;
      expect(meter.steps[0], analyzers.join()).toMatchObject({ judged: true, steady: false });
    }
  });

  it('holds for every exercise in the catalog, whatever the levels ask', () => {
    expect(EXERCISES.length).toBeGreaterThan(20);
    for (const def of EXERCISES) {
      const { plan, steps } = planFor(def);
      expect(plan.steps, def.id).toHaveLength(steps.length);
      expect(plan.toleranceCents).toBe(CONFIG.tolerance[def.tolerance]);
      steps.forEach((s, i) => {
        const p = plan.steps[i];
        const where = `${def.id} step ${i}`;
        expect(p.role, where).toBe(s.role);
        // Only a held, sung note, long enough, is ever judged; only a judged one is asked to be steady.
        if (p.judged) expect(s.role === 'sing' && s.toMidi === undefined && s.end - s.start >= MIN_JUDGED_STEP_SEC, where).toBe(true);
        if (p.steady) expect(p.judged && s.end - s.start >= MIN_STEADY_STEP_SEC, where).toBe(true);
        if (s.end - s.start < MIN_PHASE_STEP_SEC && s.role !== 'listen') expect(p.phase, where).toBe(false);
      });
      if (def.kind === 'range-finder') expect(plan.steps.some((s) => s.judged), def.id).toBe(false);
      if (def.kind === 'run') expect(plan.steps.some((s) => s.judged), def.id).toBe(false);
      if (def.analyzers.some((a) => a === 'vibrato' || a === 'pulse' || a === 'switch')) expect(plan.steps.some((s) => s.steady), def.id).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- the stylesheet

describe('styles/live-hint.css', () => {
  const css = readFileSync(new URL('../../styles/live-hint.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('uses the design tokens only: no colour of its own, and no new font', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|hsl)a?\(/);
    const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) expect(family).toMatch(/^var\(--font-/);
  });

  it('moves nothing but opacity (and visibility, after the fade), and not at all under reduced motion', () => {
    expect(css).not.toMatch(/animation|@keyframes|transform/);
    const transitioned = [...css.matchAll(/transition:([^;]*);/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+/)[0]));
    expect(transitioned.length).toBeGreaterThan(0);
    for (const property of transitioned) expect(['opacity', 'visibility', 'none'], property).toContain(property);
    expect(css).toMatch(/\[data-motion='reduce'\][^{]*\{\s*transition: none;/);
  });

  it('shows the glyph of every hint, in the hue of its tone', () => {
    for (const glyph of new Set(Object.values(HINTS).map((h) => h.glyph))) {
      expect(css, glyph).toContain(`.pl-live-hint[data-glyph='${glyph}'] .pl-live-hint__glyph[data-glyph='${glyph}']`);
    }
    for (const tone of new Set(Object.values(HINTS).map((h) => h.tone))) expect(css, tone).toContain(`.pl-live-hint[data-tone='${tone}']`);
  });

  it('uses the text-safe hues for the glyph and the border, so they hold up in both themes', () => {
    expect(css).toContain('--hint-hue: var(--on-text)');
    expect(css).toContain('--hint-hue: var(--off-text)');
    expect(css).toContain('--hint-hue: var(--tally-text)');
  });
});
