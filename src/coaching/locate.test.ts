/**
 * The located problem, on takes sung by the synthetic singer through the real analyzers: where it happened (spots with
 * take times and plain labels) and one plain sentence with plain numbers, for every tip family.
 */
import { describe, expect, it } from 'vitest';
import { centsFromNearest, midiToHz } from '../core/music';
import type { PitchFrame, TargetNote } from '../core/types';
import { COACHING_TIPS } from '../exercises/tips';
import { flattened, POOR_SINGER, unvoiced } from '../exercises/test-singer';
import { WORLDS } from '../exercises';
import { locate, MAX_SPOTS, stalls } from './locate';
import { jargonIn } from './plain';
import { problemOf, sing, tipOf } from './test-takes';

/** `track` with the glide `g` sung as a staircase of `steps` flat stretches instead of one ramp. */
function staircase(track: PitchFrame[], g: TargetNote, steps: number): PitchFrame[] {
  const to = g.toMidi ?? g.midi;
  return track.map((f) => {
    if (f.t < g.start || f.t >= g.end || !f.voiced) return f;
    const u = Math.min(steps - 1, Math.floor(((f.t - g.start) / (g.end - g.start)) * steps));
    const midi = g.midi + ((to - g.midi) * (u + 0.5)) / steps;
    return { ...f, midi, f0Hz: midiToHz(midi), centsFromNearest: centsFromNearest(midi) };
  });
}

const plainEverywhere = (texts: readonly string[]) => {
  for (const text of texts) expect(jargonIn(text), text).toHaveLength(0);
};

describe('locate: accuracy', () => {
  const take = sing('foundations.03', { biasCents: -12 }, { edit: (t, r) => flattened(t, r.notes[1].start + 0.3, r.notes[1].end, r.notes[1].midi - 0.7) });

  it('names the furthest-off note first, by number and name, with sharp or flat', () => {
    const p = problemOf(take, 'acc.flat');
    expect(p.tipId).toBe('acc.flat');
    expect(p.metric).toBe('accuracy.absBiasCents');
    expect(p.spots[0].t).toBeCloseTo(take.realized.notes[1].start, 6);
    expect(p.spots[0].label).toMatch(/^note 2 \([A-G]♯?\d\), flat by /);
    expect(p.what).toMatch(/^On average you sang .*flat/);
    expect(p.what).toContain('note 2');
    expect(p.what).toContain('was the furthest off');
  });

  it('says the typical miss in words and points at the worst note', () => {
    const p = problemOf(take, 'acc.median');
    expect(p.what).toMatch(/^Your notes were typically off by /);
    expect(p.spots[0].label).toMatch(/^note 2 /);
  });

  it('says how much of the time was in tune, against what the level asks', () => {
    const p = problemOf(take, 'acc.in-tune-low');
    expect(p.what).toMatch(/^You were in tune \d+% of the time \(this level asks for \d+%\)/);
    expect(p.spots[0].label).toMatch(/^note 2 /);
  });

  it('says a wavering note wavered, and a sinking one sank', () => {
    const wobbly = sing('foundations.13', { jitterCents: 30 });
    expect(problemOf(wobbly, 'acc.unstable').what).toMatch(/^The pitch was (a little wavery|wavery|very wavery) as you held the notes/);
    const p = problemOf(take, 'acc.drift-flat');
    expect(p.what).toMatch(/^The pitch sank as you held the notes/);
  });

  it('says an octave away as an octave, not a count of half steps', () => {
    const low = sing('foundations.03', { offsetSemis: -12 });
    expect(problemOf(low, 'acc.bias').what).toMatch(/^On average you sang about an octave too low/);
  });
});

describe('locate: notes that missed both ways (review R1)', () => {
  /** Each note moved by its own offset (cents), in turn: sharp, flat, sharp, flat ... */
  const offsets = [40, -35, 30, -32, 6, -28, 33];
  const mixed = sing('foundations.07', {}, {
    edit: (track, r) =>
      track.map((f) => {
        const i = r.notes.findIndex((n) => f.t >= n.start - 0.05 && f.t <= n.end + 0.05);
        return i >= 0 && f.voiced ? { ...f, midi: f.midi + offsets[i % offsets.length] / 100 } : f;
      }),
  });

  it('is never told it sang sharp or flat: the lean is too small to explain the misses', () => {
    expect(mixed.evaluation.passed).toBe(false);
    expect(Math.abs(mixed.analysis.tipContext.biasCents ?? 0)).toBeLessThan(10);
    expect(mixed.tip.id).not.toMatch(/^acc\.(sharp|flat)$/);
  });

  it('says the notes went both ways, with spots on both sides, even for a direction tip', () => {
    for (const id of ['acc.bias', 'acc.sharp']) {
      const p = problemOf(mixed, id);
      expect(p.what, id).toMatch(/^Your notes landed off the middle both ways \(\d+ sharp and \d+ flat\), typically by /);
      expect(p.what, id).not.toMatch(/right on the note/);
      expect(p.spots.some((s) => / sharp by /.test(s.label)), id).toBe(true);
      expect(p.spots.some((s) => / flat by /.test(s.label)), id).toBe(true);
    }
  });

  it('still names one direction when the notes agree, and the way they went when a forced rule says otherwise', () => {
    const sharp = sing('foundations.07', { biasCents: 30 });
    expect(problemOf(sharp, 'acc.sharp').what).toMatch(/^On average you sang sharp by /);
    // Never "both ways (12 sharp and 0 flat)": every note leaned one way, so that way is the one said.
    const flatTip = problemOf(sharp, 'acc.flat');
    expect(flatTip.what).not.toMatch(/both ways/);
    expect(flatTip.spots.every((s) => / sharp by /.test(s.label))).toBe(true);
  });

  it('says held notes drifted both ways when some sank and some rose', () => {
    const sustain = sing('foundations.13');
    const notes = sustain.analysis.details.accuracy;
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // One sank, one rose, any others held level: no way wins.
    const drifts = notes.map((a, i) => ({ ...a, result: { ...a.result, driftCentsPerSec: i === 0 ? -12 : i === 1 ? 12 : 0 } }));
    const p = locate({
      def: sustain.def,
      realized: sustain.realized,
      metrics: { ...sustain.analysis.metrics, 'accuracy.absDriftCentsPerSec': 12 },
      analysis: { ...sustain.analysis, details: { ...sustain.analysis.details, accuracy: drifts }, tipContext: { ...sustain.analysis.tipContext, driftCentsPerSec: 0 } },
      tip: tipOf('acc.drift-any', sustain),
      notation: 'sharps',
    });
    expect(p.what).toMatch(/^The pitch drifted both ways as you held the notes \(\d+ sank, \d+ rose\)/);
    expect(p.spots.some((s) => / sank /.test(s.label))).toBe(true);
    expect(p.spots.some((s) => / rose /.test(s.label))).toBe(true);
  });
});

describe('locate: breaks and slides', () => {
  it('places each break at its time, near the note the voice was on', () => {
    // The synthetic singer's breaks are short silences: the sound cut out, which the analyzer counts as a break. Both
    // fall on the first sung slide up (the app plays the siren first, so the singing starts a few seconds in).
    const up = sing('foundations.05').realized.notes.find((n) => n.toMidi !== undefined && n.toMidi > n.midi)!;
    const at = [up.start + 0.4 * (up.end - up.start), up.start + 0.75 * (up.end - up.start)];
    const take = sing('foundations.05', { breaks: at });
    expect(take.analysis.details.cracks.every((c) => c.kind === 'dropout')).toBe(true);
    const p = problemOf(take, 'glide.cracks');
    expect(p.what).toMatch(/^Your voice broke or cut out twice on the way up/);
    const times = p.spots.map((s) => s.t).sort((a, b) => a - b);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(at[0], 1);
    expect(times[1]).toBeCloseTo(at[1], 1);
    for (const s of p.spots) expect(s.label).toMatch(/^0:\d\d, near [A-G]♯?\d, the sound cut out$/);
    // The level's own allowance is said in words.
    expect(p.what).toMatch(/\(this level allows (none|one|up to \d+)\)/);
  });

  it('says only "broke" when every break was a jump in pitch, not the sound cutting out', () => {
    const take = sing('foundations.05');
    const problem = locate({
      def: take.def,
      realized: take.realized,
      metrics: { ...take.analysis.metrics, 'glide.cracks': 1 },
      analysis: { ...take.analysis, details: { ...take.analysis.details, cracks: [{ t: 2, kind: 'jump', cents: 400, durationMs: 20 }] } },
      tip: tipOf('glide.cracks', take),
      notation: 'sharps',
      track: take.track,
    });
    expect(problem.what).toMatch(/^Your voice broke once/);
    expect(problem.spots[0].label).toMatch(/^0:02, near [A-G]♯?\d$/);
  });

  it('finds where a stair-stepped slide stalled, and how far up the slide that was', () => {
    let glide: TargetNote | undefined;
    const take = sing('foundations.05', {}, {
      edit: (t, r) => {
        glide = r.notes.find((n) => n.toMidi !== undefined && n.toMidi - n.midi === 12);
        return staircase(t, glide!, 6);
      },
    });
    const g = glide!;
    const stepped = take.analysis.details.glides.find((x) => x.note.start === g.start)!;
    expect(stepped.result.stairSteps).toBeGreaterThan(0);
    const p = problemOf(take, 'glide.stairs');
    expect(p.what).toMatch(/moved in steps instead of one smooth line/);
    const inside = p.spots.filter((s) => s.t > g.start && s.t < g.end);
    expect(inside.length).toBeGreaterThan(0);
    for (const s of inside) {
      expect(s.label).toMatch(/^0:\d\d, stalled (near the start of|a quarter of the way along|half way along|three quarters of the way along|near the end of) the slide up, near [A-G]♯?\d$/);
    }
    const found = stalls(take.track, g, 3);
    expect(found.length).toBeGreaterThan(0);
    for (const s of found) expect(s.progress).toBeGreaterThanOrEqual(0.1);
  });

  it('says how far off the end of a slide was', () => {
    const take = sing('foundations.05', { biasCents: -40 });
    const p = problemOf(take, 'glide.end');
    expect(p.what).toMatch(/^The ends of your slides were typically off by /);
    expect(p.spots[0].label).toMatch(/^0:\d\d, the slide to [A-G]♯?\d ended flat by /);
  });
});

describe('locate: the start of the note', () => {
  it('names the note that scooped most, and the one slowest to settle, in plain time', () => {
    const take = sing('foundations.06', { scoopCents: 60, settleTauMs: 120 });
    const scoop = problemOf(take, 'onset.scoop-big');
    expect(scoop.what).toMatch(/^Your notes started below the pitch and slid up into it/);
    expect(scoop.spots[0].label).toMatch(/from .* below$/);
    const settle = problemOf(take, 'onset.settle-slow');
    expect(settle.what).toMatch(/^Your notes typically took (a split second|about .*second) to find the pitch/);
    expect(settle.spots.every((s) => /took (a split second|about .*second)|never found the pitch/.test(s.label))).toBe(true);
    expect(settle.what).not.toMatch(/settl/i);
  });

  it('says notes that never landed in tune stayed off the pitch, and which way', () => {
    const take = sing('foundations.06', { biasCents: -40 });
    const p = problemOf(take, 'onset.settle-missing');
    expect(p.what).toMatch(/^Most notes never landed in tune: \d+ of the \d+ stayed off the pitch; most sat flat by /);
  });
});

describe('locate: runs', () => {
  it('lists the missed run notes by number', () => {
    const take = sing('runs.03', {}, {
      edit: (t, r) => {
        const [a, b] = [r.notes[2], r.notes[4]];
        return unvoiced(unvoiced(t, a.start, a.end), b.start, b.end);
      },
    });
    const missed = take.analysis.details.runs.flatMap((run, i) => run.result.notes.filter((n) => n.verdict === 'missed').map((n) => ({ run: i, index: n.index })));
    expect(missed.length).toBeGreaterThan(0);
    const p = problemOf(take, 'run.missed');
    expect(p.what).toMatch(/^You missed \d+ of the 15 run notes/);
    expect(p.spots.length).toBe(Math.min(MAX_SPOTS, missed.length));
    expect(p.spots[0].label).toBe(`run ${missed[0].run + 1}, note ${missed[0].index + 1} (${p.spots[0].label.match(/\(([^)]+)\)/)![1]}), missed`);
    expect(p.spots[0].t).toBeCloseTo(take.analysis.details.runs[missed[0].run].notes[missed[0].index].start, 6);
  });

  it('counts the blurred notes against the clear ones', () => {
    const take = sing('runs.03', { offsetSemis: 1 });
    const p = problemOf(take, 'run.smeared');
    expect(p.what).toMatch(/^(None|\d+) of the 15 run notes came out clear \(this level asks for \d+%\); \d+ blurred into their neighbours/);
  });

  it('calls the groups of an oscillation drill rounds, not runs', () => {
    const take = sing('vibrato.01', { offsetSemis: 1 });
    const p = problemOf(take, 'run.smeared');
    expect(p.what).not.toMatch(/\brun\b/);
    expect(p.spots[0].label).toMatch(/^round \d+, note \d+/);
  });
});

describe('locate: vibrato', () => {
  it('says too slow or too fast in wobbles a second, a little or a lot', () => {
    const slow = sing('vibrato.06', { vibrato: { rateHz: 3.8, extentCents: 35 } });
    expect(problemOf(slow, 'vib.slow').what).toBe('Your vibrato ran at about four wobbles a second, a little too slow; aim for five to seven wobbles a second.');
    const fast = sing('vibrato.06', { vibrato: { rateHz: 9.5, extentCents: 35 } });
    expect(problemOf(fast, 'vib.fast').what).toMatch(/^Your vibrato ran at about nine and a half wobbles a second, a lot too fast/);
  });

  it('says too wide or too narrow in words', () => {
    const wide = sing('vibrato.06', { vibrato: { rateHz: 5.8, extentCents: 140 } });
    expect(problemOf(wide, 'vib.wide').what).toMatch(/^Your vibrato swung a (little|lot) too wide: /);
    const narrow = sing('vibrato.06', { vibrato: { rateHz: 5.8, extentCents: 12 } });
    expect(problemOf(narrow, 'vib.narrow').what).toMatch(/^Your vibrato was a (little|lot) too narrow: it swung only /);
  });

  it('places switches that missed the cue at the cue, with how late or early', () => {
    const take = sing('vibrato.08', { vibratoIgnoresCues: true });
    const p = problemOf(take, 'vib.switch');
    expect(p.what).toMatch(/^\d+ of your \d+ switches landed cleanly on the cue/);
    const cues = take.analysis.details.switch!.boundaries.map((b) => b.t);
    for (const s of p.spots) expect(cues).toContain(s.t);
    expect(p.spots[0].label).toMatch(/^0:\d\d, (into vibrato|back to straight): /);
  });
});

describe('locate: loudness', () => {
  it('says what the cue asked and what the loudness did instead', () => {
    const take = sing('dynamics.01', { loudnessAgainstCues: 'invert' });
    const p = problemOf(take, 'dyn.against-cue');
    expect(p.what).toBe('On note 1 (' + p.what.match(/note 1 \(([^)]+)\)/)![1] + ') the cue asked you to grow from soft to full, but your loudness faded from loud to soft.');
  });

  it('says the pitch went sharp when loud or flat when soft, on which notes', () => {
    const take = sing('dynamics.01', { centsPerDb: 3 });
    const p = problemOf(take, take.tip.id === 'dyn.sharp-loud' ? 'dyn.sharp-loud' : 'dyn.flat-soft');
    expect(p.what).toMatch(/^Your pitch went (sharp as you got louder|flat as you got softer) on /);
  });

  it('says how little the loudness changed', () => {
    const take = sing('dynamics.03', { flatLoudness: true });
    expect(problemOf(take, 'dyn.range-small').what).toMatch(/^From softest to loudest, your loudness barely changed \(this level needs a clear change from soft to loud\)/);
  });
});

describe('locate: figures, note changes, pulses and range', () => {
  it('names the weakest figure, when it came, and what was off', () => {
    const take = sing('inflections.01', { offsetSemis: 1 });
    const p = problemOf(take, 'scoop.shape');
    expect(p.what).toMatch(/^The scoop into [A-G]♯?\d at 0:\d\d was the weakest(, more than this level allows| \(this level asks for \d+%\))?: /);
    expect(p.spots[0].label).toMatch(/^0:\d\d, scoop into [A-G]♯?\d$/);
  });

  it('counts the clean note changes and names the slowest', () => {
    const take = sing('foundations.09', { transitionMs: 300 });
    const p = problemOf(take, 'transition.smeared');
    expect(p.what).toMatch(/^\d+ of your \d+ note changes were clean \(this level asks for \d+%\); the change from note \d+ \([A-G]♯?\d\)( at 0:\d\d)? to [A-G]♯?\d (took|never landed|went past)/);
    expect(p.spots[0].label).toMatch(/^0:\d\d, [A-G]♯?\d to [A-G]♯?\d, (took|never landed|went past)/);
  });

  it('says whether the pulses ran too fast or too slow for the clicks', () => {
    const take = sing('vibrato.03');
    const train = take.analysis.details.pulses[0];
    const off = (measured: number) =>
      locate({
        def: take.def,
        realized: take.realized,
        metrics: { ...take.analysis.metrics, 'pulse.rateErrorHz': Math.abs(measured - train.rateHz) },
        analysis: { ...take.analysis, details: { ...take.analysis.details, pulses: [{ ...train, result: { ...train.result, measuredRateHz: measured, rateErrorHz: measured - train.rateHz } }] } },
        tip: tipOf('pulse.rate', take),
        notation: 'sharps',
      }).what;
    expect(off(train.rateHz + 1)).toMatch(/^Your pulses ran too fast on the [A-G]♯?\d at 0:\d\d: about .* pulses a second, where the clicks asked for about .* a second\.$/);
    expect(off(train.rateHz - 1)).toMatch(/^Your pulses ran too slow /);
  });

  it('says where no clear pulses came through', () => {
    const take = sing('vibrato.03', { pulseCents: 0 });
    const p = problemOf(take, 'pulse.missing');
    expect(p.what).toMatch(/^No clear pulses came through/);
    expect(p.spots[0].label).toMatch(/^0:\d\d, [A-G]♯?\d, no clear pulses$/);
  });

  it('names the lowest and highest notes held, and how far apart they are', () => {
    const take = sing('foundations.01');
    const p = problemOf(take, 'range.any');
    expect(p.what).toMatch(/^You held notes from [A-G]♯?\d to [A-G]♯?\d, (an octave|\d+ half steps|an octave and \d+ half steps?) apart\.$/);
    expect(p.spots.map((s) => s.label.replace(/^0:\d\d, /, '').replace(/, [A-G]♯?\d$/, ''))).toEqual(['your lowest held note', 'your highest held note']);
  });
});

describe('locate: the general tips', () => {
  it('says nobody sang, with nowhere to point', () => {
    const take = sing('foundations.03', { silent: true });
    const p = problemOf(take);
    expect(p.tipId).toBe('general.no-voice');
    expect(p.spots).toEqual([]);
  });

  it('lists the notes that went unsung, and how many the level needs', () => {
    const take = sing('foundations.09', POOR_SINGER);
    expect(take.tip.id).toBe('general.unsung');
    const p = problemOf(take);
    expect(p.what).toMatch(/^You sang \d+ of the 16 notes, and this level needs 15/);
    expect(p.spots.length).toBeGreaterThan(0);
    for (const s of p.spots) expect(s.label).toMatch(/^note \d+ \([A-G]♯?\d\)( at 0:\d\d)?, not sung$/); // a long exercise says when
  });

  it('says every note is needed on a short exercise (review R7: Clean starts has 9)', () => {
    const take = sing('foundations.06', {}, { edit: (t, r) => unvoiced(t, r.notes[4].start, r.notes[4].end) });
    expect(take.realized.notes).toHaveLength(9);
    const p = problemOf(take, 'general.unsung');
    expect(p.what).toMatch(/^You sang \d of the 9 notes, and this level needs all 9/);
  });

  it('says where the singing stopped on a take stopped part way', () => {
    const take = sing('foundations.03', {}, { edit: (t) => unvoiced(t, 7, 99) });
    const p = problemOf(take, 'general.stopped');
    expect(p.what).toBe(`You stopped at 0:07, before the end of the exercise at 0:${String(Math.round(take.realized.totalSec)).padStart(2, '0')}.`);
    expect(p.spots).toHaveLength(1);
    expect(p.spots[0].t).toBeLessThanOrEqual(7);
  });

  it('says a clean take is clean', () => {
    const take = sing('foundations.03');
    expect(problemOf(take, 'general.polish').what).toBe('Nothing stood out to fix in this take.');
  });
});

describe('locate: without the detail', () => {
  it('says the measure in words and places nothing when only the metrics are known', () => {
    const take = sing('foundations.03', { biasCents: -30 });
    const p = locate({ def: take.def, realized: take.realized, metrics: take.analysis.metrics, analysis: null, tip: tipOf('acc.median', take), notation: 'sharps' });
    expect(p.spots).toEqual([]);
    expect(p.what).toMatch(/^Your notes were typically off by /);
    const unmeasured = locate({ def: take.def, realized: take.realized, metrics: {}, analysis: null, tip: tipOf('acc.unstable', take), notation: 'sharps' });
    expect(unmeasured.what).toBe('The app could not measure “How steady” in this take.');
  });
});

describe('locate: plain words for every tip family on every level', () => {
  const general = ['general.no-voice', 'general.unfit-range', 'general.unsung', 'general.stopped', 'general.polish', 'general.retry'];

  it('never uses jargon, keeps to four spots, and places each spot inside the take', () => {
    const levels = WORLDS.flatMap((w) => w.levels.map((l) => l.id));
    for (const levelId of levels) {
      for (const singer of [POOR_SINGER, { offsetSemis: 1 }]) {
        const take = sing(levelId, singer);
        const ids = [...(take.def.tipIds ?? COACHING_TIPS.map((t) => t.id)), ...general];
        for (const id of ids) {
          const p = problemOf(take, id);
          expect(p.what.length, `${levelId} ${id}`).toBeGreaterThan(0);
          expect(p.what, `${levelId} ${id}`).not.toMatch(/undefined|NaN|\[object/);
          plainEverywhere([p.what, ...p.spots.map((s) => s.label)]);
          expect(p.spots.length).toBeLessThanOrEqual(MAX_SPOTS);
          for (const s of p.spots) {
            expect(Number.isFinite(s.t), `${levelId} ${id} ${s.label}`).toBe(true);
            expect(s.t).toBeGreaterThanOrEqual(-1);
            expect(s.t).toBeLessThanOrEqual(take.realized.totalSec + 1);
          }
        }
      }
    }
  }, 120_000);
});
