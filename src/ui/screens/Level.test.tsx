// @vitest-environment happy-dom
/**
 * Level on the real catalog and the real progression engine, with a fake runner for Listen. A level with a lesson opens
 * as the lesson screen (Learn, Practise, Check): fixture lessons stand in for src/lessons and each test sets the lesson's
 * progress, so nothing here depends on the Foundations content. A level without one keeps the classic screen; those
 * tests use the later worlds (which keep it) or a Foundations level the fixtures give no lesson.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../runtime/runner', async () => (await import('../practice/test-fakes')).runnerModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
vi.mock('../../lessons', async () => (await import('../lesson/test-support')).lessonsModule());
vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  ...(await import('../lesson/test-support')).lessonProgressModule(),
}));
const exportMock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../coaching/export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../coaching/export')>()), buildCoachingFile: exportMock.build }));

import { METRIC_INFO, WORLDS, formatMetric, getExercise, getLevel, getWorld, realize } from '../../exercises';
import { GOOD_SINGER, singTake } from '../../exercises/test-singer';
import { levelRequirementHint } from '../../progress';
import { attempt } from '../../progress/test-fixtures';
import { bindDesktopBackKey, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import type { AppStorage } from '../../storage';
import type { AttemptRecord, TakeRecord } from '../../storage/schema';
import { encodeTrack } from '../../storage/track-codec';
import { GLOSSARY } from '../../teach/glossary-content';
import { ZONE_WORDS, lessonNumber } from '../lesson/model';
import { fixtureLesson, progressOf, resetLessons, setLessons, setProgress } from '../lesson/test-support';
import { bossChain, levelNumber, tempoLabel, toleranceLabel } from '../practice/copy';
import {
  TENOR_RANGE,
  createRunnerMock,
  levelsBefore,
  resetRunner,
  resetSession,
  runnerState,
  session,
  settingsSignal,
  snapshotAfter,
  updateSettingsMock,
  type FakeRunner,
} from '../practice/test-fakes';
import { Level } from './Level';

let container: HTMLElement;

async function mount(levelId: string): Promise<void> {
  resetRouterForTests([routeOf('home'), routeOf('map'), routeOf('level', { levelId })]);
  installRouteGuard(() => ({ ok: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(() => {
    render(<Level />, container);
  });
}

async function unmount(): Promise<void> {
  await act(() => {
    render(null, container);
  });
  container.remove();
}

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const buttonNamed = (name: string): HTMLButtonElement | undefined => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(name));
const levelOf = (id: string) => getLevel(id)!;
const defOf = (id: string) => getExercise(levelOf(id).exerciseId)!;

/** A level without a lesson, with no metronome (a held note has no tempo to show): Dynamics' first level. */
const CLASSIC = 'dynamics.01';
/** Everything before `levelId` passed, so it is the current level. */
const currentAt = (levelId: string): void => {
  session.snapshot.value = snapshotAfter(levelsBefore(levelId));
};

beforeEach(() => {
  resetSession(['foundations.01', 'foundations.02']);
  resetRunner();
  resetLessons();
  exportMock.build.mockReset();
  bindDesktopBackKey();
});

afterEach(async () => {
  await unmount();
});

// ================================================================ the classic level screen (no lesson)

describe('Level without a lesson: the current level', () => {
  beforeEach(() => currentAt(CLASSIC));

  it('shows the number, the title, the goal, the pass lines and the tolerance, and is not a lesson', async () => {
    await mount(CLASSIC);
    const level = levelOf(CLASSIC);
    const def = defOf(CLASSIC);
    expect(q('[data-testid="level-label"]')?.textContent).toBe(`Level ${levelNumber(getWorld(level.worldId), level)}`);
    expect(text()).toContain(level.title);
    expect(text()).toContain(def.goal);
    // The pass lines are the exercise's own (exercises/evaluate.ts passRequirements).
    expect(text()).toContain(`Score ≥ ${Math.round(def.pass.score * 100)}%`);
    expect(text()).toContain(toleranceLabel(def));
    // A held note has no tempo worth showing.
    expect(tempoLabel(def)).toBeNull();
    expect(text()).not.toContain('bpm');
    expect(q('[data-testid="lesson-title"]')).toBeNull();
    expect(q('.pl-lesson-set')).toBeNull();
  });

  it('has not been sung yet: no best score, and the tally says where each light comes', async () => {
    await mount(CLASSIC);
    const def = defOf(CLASSIC);
    expect(q('[data-testid="best-score"]')?.textContent).toBe('Not sung yet');
    expect(text()).toContain(`Lights at ${Math.round(def.pass.score * 100)}%, ${Math.round(def.tiers.solid * 100)}% and ${Math.round(def.tiers.studio * 100)}%.`);
    expect(container.querySelector('[role="img"][aria-label^="0 of 3"]')).not.toBeNull();
  });

  it('opens the Sing screen for this level from the Sing button', async () => {
    await mount(CLASSIC);
    const sing = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(sing.textContent).toContain('Sing');
    expect(sing.textContent).not.toContain('again');
    sing.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: CLASSIC }));
  });

  it('shows the personal-record line locked, never hidden, until the level is passed', async () => {
    await mount(CLASSIC);
    const locked = container.querySelector('.pl-locked');
    expect(locked).not.toBeNull();
    expect(locked!.textContent).toContain('Locked.');
    expect(locked!.textContent).toContain('Chase a record');
    expect(locked!.textContent).toContain(`Pass ${levelOf(CLASSIC).title} to chase personal records on it.`);
    expect(buttonNamed('Chase a record')).toBeUndefined();
  });

  it('offers no personal records on the Range finder at all, passed or not (it measures; a wider span is a strained one)', async () => {
    resetSession([]);
    await mount('foundations.01');
    expect(text()).not.toContain('Chase a record');
    expect(q('[data-testid="chase-record"]')).toBeNull();
    await unmount();
    resetSession(['foundations.01', 'foundations.02']);
    await mount('foundations.01');
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing again');
    expect(text()).not.toContain('Chase a record');
    expect(text()).not.toContain('Personal bests');
  });
});

describe('Level without a lesson: a level that is not open', () => {
  it('shows what unlocks it and offers no way in', async () => {
    currentAt(CLASSIC);
    await mount('dynamics.03');
    const locked = container.querySelector('.pl-locked');
    expect(locked).not.toBeNull();
    expect(locked!.textContent).toContain(levelRequirementHint('dynamics.03', session.snapshot.value, WORLDS)!);
    expect(q('[data-testid="sing-button"]')).toBeNull();
    expect(q('[data-testid="listen-button"]')).toBeNull();
    expect(text()).not.toContain('To pass');
  });

  it('says so for a level that does not exist', async () => {
    await mount('nonsense.99');
    expect(q('[data-testid="unavailable"]')).not.toBeNull();
  });
});

describe('Level without a lesson: a passed level', () => {
  beforeEach(() => {
    session.snapshot.value = snapshotAfter([...levelsBefore(CLASSIC), CLASSIC], { score: 0.86, mastery: 2 });
  });

  it('offers "Sing again", shows the best score and its tally, and lets you chase a record', async () => {
    await mount(CLASSIC);
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing again');
    expect(q('[data-testid="best-score"]')?.textContent).toBe('86%');
    expect(container.querySelector('[role="img"][aria-label^="2 of 3"]')).not.toBeNull();
    const chase = buttonNamed('Chase a record')!;
    expect(chase).toBeDefined();
    expect(container.querySelector('.pl-locked')).toBeNull();
    chase.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'record', levelId: CLASSIC }));
  });

  it('lists the personal bests of the exercise', async () => {
    const id = defOf(CLASSIC).id;
    session.snapshot.value = {
      ...session.snapshot.value,
      records: {
        [`${id}:accuracy.inTolerancePct`]: { value: 96, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
        [`${id}:accuracy.sdCents`]: { value: 8, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
        [`${id}:not.a.metric`]: { value: 1, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
      },
    };
    await mount(CLASSIC);
    expect(text()).toContain('Personal bests');
    expect(text()).toContain(METRIC_INFO['accuracy.inTolerancePct'].label);
    expect(text()).toContain(formatMetric('accuracy.inTolerancePct', 96));
    expect(text()).toContain(formatMetric('accuracy.sdCents', 8));
    expect(text()).not.toContain('not.a.metric');
  });

  it('never shows a lower rung\'s score as the level\'s best: a Runs level sung only on its lower rungs is not sung at its tempo yet', async () => {
    const snap = snapshotAfter(['foundations.01', 'foundations.02', 'foundations.03']);
    // What the engine reports for a Runs level with takes on its lower rungs only: attempts, but no best at its tempo.
    snap.levels['runs.03'] = { ...snap.levels['runs.03'], status: 'current', attempts: 2, bestScore: 0, mastery: 0 };
    session.snapshot.value = snap;
    await mount('runs.03');
    expect(q('[data-testid="best-score"]')?.textContent).toBe(`Not sung at ${defOf('runs.03').tempoBpm} bpm yet`);
  });

  it('says a level passed by audition has no score yet', async () => {
    const snap = snapshotAfter([...levelsBefore(CLASSIC), CLASSIC]);
    snap.levels[CLASSIC] = { ...snap.levels[CLASSIC], attempts: 0, bestScore: 0, mastery: 1, viaAudition: true };
    session.snapshot.value = snap;
    await mount(CLASSIC);
    expect(q('[data-testid="best-score"]')?.textContent).toBe('Not sung yet');
    expect(text()).toContain('Passed by audition');
  });
});

describe('Level without a lesson: the saved range', () => {
  it('says a default range is in use until the Range finder is passed', async () => {
    resetSession(['foundations.01'], null);
    await mount('foundations.02');
    expect(text()).toContain('Using a default range until you pass the Range finder.');
  });

  it('says nothing on the Range finder itself, which is what saves the range', async () => {
    resetSession([], null);
    await mount('foundations.01');
    expect(text()).not.toContain('default range');
  });

  it('says nothing once a range is saved', async () => {
    await mount('foundations.03');
    expect(text()).not.toContain('default range');
  });
});

describe('Level without a lesson: Boss Recital and Runs ladder', () => {
  it('gives the Boss Recital a stage and lists the sections of its one take', async () => {
    currentAt('vibrato.boss');
    await mount('vibrato.boss');
    const def = defOf('vibrato.boss');
    expect(q('.pl-level__head--boss')).not.toBeNull();
    expect(q('[data-testid="level-label"]')?.textContent).toBe('Boss Recital · one continuous take');
    expect(text()).toContain(def.title);
    const steps = [...container.querySelectorAll('.pl-level__chain li')].map((li) => li.textContent);
    expect(steps).toEqual(bossChain(def).map((cue, i) => `${i + 1}${cue}`));
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing');
  });

  it('says where a Runs ladder is headed, and shows the metronome tempo of other levels', async () => {
    currentAt('runs.03');
    await mount('runs.03');
    const rungs = defOf('runs.03').tempoLadder!;
    expect(text()).toContain(`Tempo climbs ${rungs[0]} → ${rungs[rungs.length - 1]} bpm as you pass`);
    await unmount();

    currentAt('vibrato.03');
    const def = defOf('vibrato.03');
    expect(def.metronome).toBe(true);
    await mount('vibrato.03');
    expect(text()).toContain(`${def.tempoBpm} bpm`);
  });
});

describe('Level without a lesson: Listen and More', () => {
  it('plays the demo from the click itself, with one runner that is disposed on leaving', async () => {
    await mount('foundations.03');
    const listen = q<HTMLButtonElement>('[data-testid="listen-button"]')!;
    expect(createRunnerMock).not.toHaveBeenCalled();
    listen.click();
    expect(createRunnerMock).toHaveBeenCalledTimes(1);
    expect(createRunnerMock).toHaveBeenCalledWith({ kind: 'level', levelId: 'foundations.03' });
    const runner = runnerState.last as FakeRunner;
    expect(runner.listen).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledTimes(1);
    expect(runner.listen).toHaveBeenCalledTimes(2);
    await act(() => {
      render(null, container);
    });
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('reads Stop while the demo plays', async () => {
    await mount('foundations.03');
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    const runner = runnerState.last as FakeRunner;
    await act(() => {
      runner.phase.value = 'listening';
    });
    expect(q('[data-testid="listen-button"]')!.textContent).toContain('Stop');
  });

  it('shows a runner error next to the cause', async () => {
    await mount('foundations.03');
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    const runner = runnerState.last as FakeRunner;
    await act(() => {
      runner.error.value = { code: 'internal', message: 'The demo could not play.' };
    });
    expect(text()).toContain('The demo could not play.');
  });

  it('opens More with the Listen volume and Setup, and the volume is a setting', async () => {
    await mount('foundations.03');
    q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    await act(() => {});
    expect(document.body.textContent).toContain('Listen volume');
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-label')).toBe('Listen volume');
    slider.value = '0.4';
    await act(() => {
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(updateSettingsMock).toHaveBeenCalledWith({ referenceVolume: 0.4 });
    expect(settingsSignal.value.referenceVolume).toBe(0.4);
    const setup = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Setup'))!;
    setup.click();
    expect(route.value.name).toBe('setup');
  });

  it('Space sings from the keyboard', async () => {
    await mount('foundations.03');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    expect(route.value.name).toBe('sing');
  });

  it('Back goes back', async () => {
    await mount('foundations.03');
    q<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    expect(route.value.name).toBe('map');
  });
});

describe('Level without a lesson: the Range finder, in plain words', () => {
  it('lists the steps, says what passing means without jargon, and shows no tolerance chip or score', async () => {
    await mount('foundations.01');
    const def = defOf('foundations.01');
    if (def.steps && def.steps.length > 0) expect(q('[data-testid="level-steps"]')?.querySelectorAll('li')).toHaveLength(def.steps.length);
    if (def.passPlain) expect(text()).toContain(def.passPlain);
    expect(text()).not.toContain('Score ≥');
    expect(text()).not.toContain('semitone');
    expect(text()).not.toContain('¢');
    expect(q('[data-testid="best-score"]')).toBeNull();
    // The profile has a saved range: the level shows it, as notes.
    expect(q('[data-testid="saved-range"]')?.textContent).toMatch(/^[A-G][♯♭]?\d–[A-G][♯♭]?\d$/);
  });

  it('says "Not measured yet" before a range is saved', async () => {
    resetSession([], null);
    await mount('foundations.01');
    expect(q('[data-testid="saved-range"]')?.textContent).toBe('Not measured yet');
  });

  it('keeps the generated pass lines and the tolerance chip on levels that are judged', async () => {
    currentAt(CLASSIC);
    await mount(CLASSIC);
    expect(text()).toContain(toleranceLabel(defOf(CLASSIC)));
  });
});

describe('Level without a lesson: "Last time", before the next try', () => {
  const def = defOf('foundations.03');
  const realized = realize(def, TENOR_RANGE, 'tenor');
  /** A take of the level sung a whole step sharp: it misses. */
  const sharpTrack = singTake(realized, { ...GOOD_SINGER, offsetSemis: 2 });
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  function row(over: Partial<AttemptRecord>): AttemptRecord {
    return attempt({ profileId: 'singer-1', exerciseId: def.id, levelId: 'foundations.03', tonicMidi: realized.tonicMidi, tempoBpm: def.tempoBpm, ...over });
  }

  function takesStore(records: TakeRecord[]): void {
    session.appStorage.value = { takes: { get: vi.fn(async (id: string) => records.find((r) => r.id === id)) } } as unknown as AppStorage;
  }

  const saved: TakeRecord = {
    id: 'take-1',
    profileId: 'singer-1',
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    deletedAt: null,
    exerciseId: def.id,
    track: encodeTrack(sharpTrack),
    audioRef: null,
    sampleRate: 48000,
    latencyMs: 0,
  };

  it('brings the last missed take’s coaching here, read back from its saved pitch line', async () => {
    takesStore([saved]);
    session.attemptLog.value = [row({ passed: false, score: 0.2, takeId: null }), row({ passed: false, score: 0.2, takeId: 'take-1' })];
    await mount('foundations.03');
    await flush();
    const card = q('[data-testid="last-time"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Last time');
    expect(q('[data-testid="coach-card"]')?.getAttribute('data-depth')).toBe('2');
    expect(q('[data-testid="coach-what"]')?.textContent?.length).toBeGreaterThan(0);
    // The spots are listed (there is no replay here to mark).
    expect(q('[data-testid="coach-spot"]')?.tagName).toBe('SPAN');
    expect(q('[data-testid="coach-why"]')).not.toBeNull();
    // Before the pass lines: the advice comes first.
    expect(card.compareDocumentPosition(q('section[aria-label="To pass"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('falls back to the take’s numbers when its pitch line was not saved', async () => {
    takesStore([]);
    const sharp = { 'accuracy.inTolerancePct': 0, 'accuracy.medianAbsCents': 200, 'accuracy.sdCents': 4, 'accuracy.absBiasCents': 200, 'accuracy.absDriftCentsPerSec': 0.5 };
    session.attemptLog.value = [row({ passed: false, score: 0.1, takeId: 'missing', metrics: sharp })];
    await mount('foundations.03');
    await flush();
    expect(q('[data-testid="last-time"]')).not.toBeNull();
    expect(q('[data-testid="coach-what"]')?.textContent?.length).toBeGreaterThan(0);
    expect(q('[data-testid="coach-spot"]')).toBeNull();
  });

  it('says nothing before the first take, or after a pass', async () => {
    await mount('foundations.03');
    expect(q('[data-testid="last-time"]')).toBeNull();
    expect(q('[data-testid="last-time-loading"]')).toBeNull();
    await unmount();
    session.attemptLog.value = [row({ passed: false, score: 0.2 }), row({ passed: true, score: 0.9, mastery: 2 })];
    await mount('foundations.03');
    await flush();
    expect(q('[data-testid="last-time"]')).toBeNull();
  });

  it('offers Send to Claude in More, always, and it makes the file for this level’s exercise', async () => {
    exportMock.build.mockResolvedValue({ level: { id: 'foundations.03' }, exercise: def, exportedAt: '2026-10-22T14:05:00.000Z', takes: [] });
    await mount('foundations.03');
    await act(() => {
      q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    });
    const send = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="more-send"] button')].find((b) => b.textContent?.includes('Send to Claude'))!;
    expect(send).toBeDefined();
    await act(() => {
      send.click();
    });
    await flush();
    expect(document.querySelector('[role="dialog"][aria-label="More"]')).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Send to Claude"]')).not.toBeNull();
    expect(exportMock.build).toHaveBeenCalledWith(def.id, { includeAudio: false });
  });
});

// ================================================================ the lesson screen

/** The lesson tests' level: the current Foundations level once everything before it is passed (Hold it steady, fourth). */
const LESSON_AT = 'foundations.13';
const LESSON = fixtureLesson(LESSON_AT);

describe('Lesson: the first visit (nothing tried yet)', () => {
  beforeEach(() => {
    currentAt(LESSON_AT);
    setLessons(LESSON);
  });

  it('opens as a lesson: "Lesson N", the lesson title and what you will be able to do', async () => {
    await mount(LESSON_AT);
    const n = lessonNumber(getWorld('foundations'), levelOf(LESSON_AT));
    expect(q('[data-testid="level-screen"]')?.dataset.lesson).toBe(LESSON_AT);
    expect(q('[data-testid="level-label"]')?.textContent).toBe(`Lesson ${n}`);
    expect(q('[data-testid="lesson-title"]')?.textContent).toBe(LESSON.title);
    expect(q('[data-testid="lesson-outcome"]')?.textContent).toBe(LESSON.outcome);
    // Three parts on one cable, the singer at Learn.
    const parts = [...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')];
    expect(parts.map((p) => p.dataset.testid)).toEqual(['part-learn', 'part-practise', 'part-check']);
    expect(parts.map((p) => p.dataset.state)).toEqual(['now', 'next', 'next']);
    expect(parts[0].getAttribute('aria-current')).toBe('step');
    expect(parts[0].querySelector('.pl-part__now')?.textContent).toBe('Now');
  });

  it('shows Learn open: what, why, how, what you will see, and the lesson’s words with their meanings', async () => {
    await mount(LESSON_AT);
    expect(q('[data-testid="learn-toggle"]')?.getAttribute('aria-expanded')).toBe('true');
    const page = q('[data-testid="learn-page"]')!;
    expect(page.textContent).toContain(LESSON.learn.what);
    expect(page.textContent).toContain(LESSON.learn.why);
    for (const how of LESSON.learn.how) expect(page.textContent).toContain(how);
    for (const seen of LESSON.learn.onScreen) expect(page.textContent).toContain(seen);
    const words = q('[data-testid="learn-words"]')!;
    for (const id of LESSON.learn.terms) {
      expect(words.querySelector(`[data-term="${id}"]`), id).not.toBeNull();
      expect(words.textContent).toContain(GLOSSARY[id].plain);
    }
  });

  it('makes the music words in its text tappable, each one the first time it appears', async () => {
    await mount(LESSON_AT);
    const page = q('[data-testid="learn-page"]')!;
    // "in-tune zone" is one word (the longest wins), not "in tune" plus "zone".
    const zone = page.querySelectorAll('.pl-learn__screen [data-term="in-tune-zone"]');
    expect(zone).toHaveLength(1);
    expect(zone[0].textContent).toBe('in-tune zone');
    // "notes" appears in several sentences, and is linked once.
    expect(page.querySelectorAll('p [data-term="note"], li [data-term="note"]')).toHaveLength(1);
  });

  it('plays the Learn demo from the tap: the lesson’s first practice step', async () => {
    await mount(LESSON_AT);
    q<HTMLButtonElement>('[data-testid="learn-listen"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledWith({ kind: 'drill', levelId: LESSON_AT, step: 0 });
    const runner = runnerState.last as FakeRunner;
    expect(runner.listen).toHaveBeenCalledTimes(1);
    await act(() => {
      runner.phase.value = 'listening';
    });
    expect(q('[data-testid="learn-listen"]')?.textContent).toContain('Stop');
    // The bar's Listen is the same demo here (step 1 is the amber move): it reads Stop too, and stops it.
    expect(q('[data-testid="listen-button"]')?.textContent).toContain('Stop');
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledTimes(1);
    expect(runner.listen).toHaveBeenCalledTimes(2);
  });

  it('lists the practice steps with their good tries, step 1 next (Learn is now) and the rest still ahead', async () => {
    await mount(LESSON_AT);
    const steps = [...container.querySelectorAll<HTMLElement>('.pl-steps > li')];
    expect(steps).toHaveLength(LESSON.practice.length);
    expect(steps.map((s) => s.dataset.state)).toEqual(['now', 'ahead', 'ahead']);
    LESSON.practice.forEach((p, i) => {
      expect(steps[i].textContent).toContain(p.title);
      expect(steps[i].textContent).toContain(p.ask);
      expect(steps[i].querySelector('[data-testid="good-tries"]')?.textContent).toBe(`0 of ${p.goodTries} good tries`);
      expect(steps[i].querySelectorAll('.pl-tries__dot')).toHaveLength(p.goodTries);
      expect(steps[i].querySelectorAll('.pl-tries__dot--good')).toHaveLength(0);
    });
    // Learn is the part the singer is at, so the first step is what comes next (one "Now" on the screen, not two).
    expect(steps[0].querySelector('.pl-step__now')?.textContent).toBe('Next');
    expect([...container.querySelectorAll('.pl-part__now, .pl-step__now')].map((el) => el.textContent)).toEqual(['Now', 'Next']);
    // A step still ahead is not a control.
    expect(steps[1].querySelector('button')).toBeNull();
    expect(steps[2].querySelector('button')).toBeNull();
  });

  it('makes "Practise" the amber move: it opens the first step’s practice', async () => {
    await mount(LESSON_AT);
    const primary = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(primary.textContent).toContain('Practise');
    expect(container.querySelectorAll('.pl-bottombar__primary')).toHaveLength(1);
    primary.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '0' }));
  });

  it('keeps the check closed until every practice step is done: no way in, one plain line', async () => {
    await mount(LESSON_AT);
    const check = q('[data-testid="part-check"]')!;
    expect(check.textContent).toContain(defOf(LESSON_AT).goal);
    expect(q('[data-testid="skip-to-check"]')).toBeNull();
    expect(q('[data-testid="check-closed"]')?.textContent).toBe('The check opens when every practice step is done.');
  });

  it('lets the Range finder be measured any time: it measures, it does not grade', async () => {
    resetSession([], null);
    setLessons(fixtureLesson('foundations.01'));
    await mount('foundations.01');
    const measure = q<HTMLButtonElement>('[data-testid="skip-to-check"]')!;
    expect(measure.textContent).toBe('Measure your range now');
    measure.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: 'foundations.01' }));
  });

  it('says the in-tune zone in plain words, with the word to tap, and never cents, bpm or pass percentages', async () => {
    await mount(LESSON_AT);
    const chip = q('[data-testid="zone-chip"]')!;
    expect(chip.textContent).toBe(`In-tune zone: ${ZONE_WORDS[defOf(LESSON_AT).tolerance]}`);
    expect(chip.querySelector('[data-term="in-tune-zone"]')).not.toBeNull();
    for (const jargon of ['¢', 'cents', 'bpm', 'Score ≥', 'tolerance', 'semitone']) expect(text(), jargon).not.toContain(jargon);
  });

  it('shows the check as not taken yet, and the record line locked, never hidden', async () => {
    await mount(LESSON_AT);
    expect(q('[data-testid="check-status"]')?.textContent).toBe('Not taken yet');
    const locked = q('[data-testid="part-check"] .pl-locked')!;
    expect(locked.textContent).toContain('Chase a record');
    expect(q('[data-testid="chase-record"]')).toBeNull();
  });
});

describe('Lesson: part way through practice', () => {
  beforeEach(() => {
    currentAt(LESSON_AT);
    setLessons(LESSON);
    setProgress(progressOf(LESSON, [2, 1]));
  });

  it('folds Learn away under its heading, one tap from being read again', async () => {
    await mount(LESSON_AT);
    const toggle = q<HTMLButtonElement>('[data-testid="learn-toggle"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Read again');
    expect(q('[data-testid="learn-page"]')).toBeNull();
    await act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-testid="learn-page"]')).not.toBeNull();
  });

  it('puts the singer at Practise, with step 1 done, step 2 now (one good try of three) and step 3 ahead', async () => {
    await mount(LESSON_AT);
    const parts = [...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')];
    expect(parts.map((p) => p.dataset.state)).toEqual(['done', 'now', 'next']);
    const steps = [...container.querySelectorAll<HTMLElement>('.pl-steps > li')];
    expect(steps.map((s) => s.dataset.state)).toEqual(['done', 'now', 'ahead']);
    expect(steps[0].querySelector('[data-testid="good-tries"]')?.textContent).toBe('2 of 2 good tries');
    expect(steps[1].querySelector('[data-testid="good-tries"]')?.textContent).toBe('1 of 3 good tries');
    expect(steps[1].querySelectorAll('.pl-tries__dot--good')).toHaveLength(1);
    expect(steps[1].querySelectorAll('.pl-tries__dot')).toHaveLength(3);
    expect(steps[1].querySelector('.pl-step__now')?.textContent).toBe('Now');
  });

  it('practises the current step from the amber button, and a done step again from its row', async () => {
    await mount(LESSON_AT);
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Practise');
    q<HTMLButtonElement>('[data-testid="sing-button"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '1' }));
    resetRouterForTests([routeOf('home'), routeOf('level', { levelId: LESSON_AT })]);
    installRouteGuard(() => ({ ok: true }));
    const again = q<HTMLButtonElement>('[data-testid="step-0-practise"]')!;
    expect(again.textContent).toContain('Again');
    again.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '0' }));
  });

  it('plays the step the amber button practises from the bar’s Listen, and stops one demo before playing another', async () => {
    await mount(LESSON_AT);
    await act(() => {
      q<HTMLButtonElement>('[data-testid="learn-toggle"]')!.click();
    });
    q<HTMLButtonElement>('[data-testid="learn-listen"]')!.click();
    const learn = runnerState.last as FakeRunner;
    expect(learn.target).toEqual({ kind: 'drill', levelId: LESSON_AT, step: 0 });
    await act(() => {
      learn.phase.value = 'listening';
    });
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    const bar = runnerState.last as FakeRunner;
    expect(bar.target).toEqual({ kind: 'drill', levelId: LESSON_AT, step: 1 });
    expect(learn.listen).toHaveBeenCalledTimes(2); // stopped
    expect(bar.listen).toHaveBeenCalledTimes(1);
    await unmount();
    expect(learn.dispose).toHaveBeenCalledTimes(1);
    expect(bar.dispose).toHaveBeenCalledTimes(1);
    container = document.createElement('div');
  });

  it('Space practises from the keyboard', async () => {
    await mount(LESSON_AT);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '1' }));
  });
});

describe('Lesson: every practice step done', () => {
  beforeEach(() => {
    currentAt(LESSON_AT);
    setLessons(LESSON);
    setProgress(progressOf(LESSON, [2, 3, 2]));
  });

  it('turns the amber button into "Take the check", and says the singer is ready', async () => {
    await mount(LESSON_AT);
    const parts = [...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')];
    expect(parts.map((p) => p.dataset.state)).toEqual(['done', 'done', 'now']);
    expect(q('[data-testid="check-ready"]')?.textContent).toContain('ready for the check');
    expect(q('[data-testid="skip-to-check"]')).toBeNull();
    const primary = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(primary.textContent).toContain('Take the check');
    primary.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: LESSON_AT }));
  });

  it('plays the check’s demo from Listen, and keeps every step open to practise again', async () => {
    await mount(LESSON_AT);
    q<HTMLButtonElement>('[data-testid="listen-button"]')!.click();
    expect(createRunnerMock).toHaveBeenCalledWith({ kind: 'level', levelId: LESSON_AT });
    const steps = [...container.querySelectorAll<HTMLElement>('.pl-steps > li')];
    expect(steps.map((s) => s.dataset.state)).toEqual(['done', 'done', 'done']);
    for (const s of steps) expect(s.querySelector('button')?.textContent).toContain('Again');
  });

  it('after a missed check goes back to practice (review R4): the step that trains what it missed is Now and the amber move', async () => {
    const def = defOf(LESSON_AT);
    // In tune only a fifth of the time: the check's first gate, which every step of this lesson practises (the last of them).
    const missed = { 'accuracy.inTolerancePct': 20, 'accuracy.sdCents': 4, 'accuracy.absDriftCentsPerSec': 0.5 };
    session.attemptLog.value = [attempt({ profileId: 'singer-1', exerciseId: def.id, levelId: LESSON_AT, passed: false, score: 0.3, takeId: null, metrics: missed })];
    await mount(LESSON_AT);
    expect([...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')].map((p) => p.dataset.state)).toEqual(['done', 'now', 'next']);
    expect([...container.querySelectorAll<HTMLElement>('.pl-steps > li')].map((s) => s.dataset.state)).toEqual(['done', 'done', 'now']);
    expect(q('[data-testid="check-ready"]')).toBeNull();
    // The check stays one quiet tap away, never the amber move.
    const again = q<HTMLButtonElement>('[data-testid="skip-to-check"]')!;
    expect(again.textContent).toContain('Take the check again');
    expect(again.classList.contains('pl-btn--primary')).toBe(false);
    const primary = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(primary.textContent).toContain('Practise');
    primary.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '2' }));
    resetRouterForTests([routeOf('home'), routeOf('level', { levelId: LESSON_AT })]);
    installRouteGuard(() => ({ ok: true }));
    q<HTMLButtonElement>('[data-testid="skip-to-check"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: LESSON_AT }));
  });

  it('shows the best so far after a check that missed, with its coaching as "Last time"', async () => {
    const def = defOf(LESSON_AT);
    const snap = snapshotAfter(levelsBefore(LESSON_AT));
    snap.levels[LESSON_AT] = { ...snap.levels[LESSON_AT], attempts: 1, bestScore: 0.42 };
    session.snapshot.value = snap;
    session.appStorage.value = { takes: { get: vi.fn(async () => undefined) } } as unknown as AppStorage;
    const sharp = { 'accuracy.inTolerancePct': 0, 'accuracy.medianAbsCents': 200, 'accuracy.sdCents': 4, 'accuracy.absBiasCents': 200, 'accuracy.absDriftCentsPerSec': 0.5 };
    session.attemptLog.value = [attempt({ profileId: 'singer-1', exerciseId: def.id, levelId: LESSON_AT, passed: false, score: 0.42, takeId: null, metrics: sharp })];
    await mount(LESSON_AT);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(q('[data-testid="check-status"]')?.textContent).toBe('Best so far 42%');
    expect(q('[data-testid="part-check"] [data-testid="last-time"]')).not.toBeNull();
  });
});

describe('Lesson: passed', () => {
  beforeEach(() => {
    session.snapshot.value = snapshotAfter([...levelsBefore(LESSON_AT), LESSON_AT], { score: 0.86, mastery: 2 });
    setLessons(LESSON);
    setProgress(progressOf(LESSON, [2, 1], { passed: true }));
  });

  it('marks done what was done: the check passed, Learn read, Practise once every step is (review R2)', async () => {
    await mount(LESSON_AT);
    const states = (): Array<string | undefined> => [...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')].map((p) => p.dataset.state);
    // Step 2 still wants two good tries: practice is not done, whatever the check did.
    expect(states()).toEqual(['done', 'next', 'done']);
    await unmount();
    setProgress(progressOf(LESSON, [2, 3, 2], { passed: true }));
    await mount(LESSON_AT);
    expect(states()).toEqual(['done', 'done', 'done']);
    const primary = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(primary.textContent).toContain('Sing the check again');
    expect(q('[data-testid="check-status"]')?.textContent).toContain('Passed · best 86%');
    expect(q('[data-testid="check-status"] [role="img"][aria-label^="2 of 3"]')).not.toBeNull();
    primary.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: LESSON_AT }));
  });

  it('offers practice again on every step, and a record chase on the check', async () => {
    await mount(LESSON_AT);
    const steps = [...container.querySelectorAll<HTMLElement>('.pl-steps > li')];
    expect(steps.map((s) => s.dataset.state)).toEqual(['done', 'ahead', 'ahead']);
    expect(steps[0].querySelector('button')?.textContent).toContain('Again');
    expect(steps[1].querySelector('button')?.textContent).toContain('Practise');
    steps[2].querySelector<HTMLButtonElement>('button')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'drill', levelId: LESSON_AT, itemIndex: '2' }));
    resetRouterForTests([routeOf('home'), routeOf('level', { levelId: LESSON_AT })]);
    installRouteGuard(() => ({ ok: true }));
    q<HTMLButtonElement>('[data-testid="chase-record"]')!.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'record', levelId: LESSON_AT }));
  });

  it('a lesson passed without a try of its own (by audition, or before the rebuild) is not marked read or practised, and opens on Learn', async () => {
    setProgress(progressOf(LESSON, [], { passed: true }));
    // Sung on this place in the world before the rebuild: other material, not a try of this lesson.
    session.attemptLog.value = [attempt({ profileId: 'singer-1', exerciseId: 'foundations.sustain.2', levelId: 'foundations.04', passed: true, score: 0.9 })];
    await mount(LESSON_AT);
    const parts = [...container.querySelectorAll<HTMLElement>('.pl-lesson-set > li')];
    expect(parts.map((p) => p.dataset.state)).toEqual(['next', 'next', 'done']);
    expect(q('[data-testid="learn-toggle"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(q<HTMLButtonElement>('[data-testid="sing-button"]')!.textContent).toContain('Sing the check again');
  });

  it('keeps Learn folded (it was read before)', async () => {
    await mount(LESSON_AT);
    expect(q('[data-testid="learn-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Lesson: other lessons', () => {
  it('shows a lesson that is not open as its header and requirement only, with no way in', async () => {
    currentAt(LESSON_AT);
    setLessons(LESSON, fixtureLesson('foundations.06', { title: 'Two notes, a jump apart' }));
    await mount('foundations.06');
    expect(q('[data-testid="lesson-title"]')?.textContent).toBe('Two notes, a jump apart');
    expect(q('.pl-locked')?.textContent).toContain(levelRequirementHint('foundations.06', session.snapshot.value, WORLDS)!);
    expect(q('.pl-lesson-set')).toBeNull();
    expect(q('[data-testid="sing-button"]')).toBeNull();
    expect(q('[data-testid="listen-button"]')).toBeNull();
  });

  it('measures on the Range finder lesson: the saved range, no in-tune zone, no records', async () => {
    resetSession([]);
    setLessons(fixtureLesson('foundations.01', { title: 'Find your comfortable notes' }));
    await mount('foundations.01');
    expect(q('[data-testid="saved-range"]')?.textContent).toMatch(/^[A-G][♯♭]?\d–[A-G][♯♭]?\d$/);
    expect(q('[data-testid="zone-chip"]')).toBeNull();
    expect(text()).not.toContain('Chase a record');
    // It is the range that every exercise uses, so no default-range banner here.
    expect(text()).not.toContain('default range');
  });

  it('says a default range is in use on any other lesson until the Range finder is passed', async () => {
    resetSession(['foundations.01'], null);
    setLessons(fixtureLesson('foundations.02'));
    await mount('foundations.02');
    expect(text()).toContain('Using a default range until you pass the Range finder.');
  });

  it('gives a Boss Recital lesson its stage, and says it is the Boss Recital', async () => {
    currentAt('foundations.boss');
    setLessons(fixtureLesson('foundations.boss', { title: 'A short tune' }));
    await mount('foundations.boss');
    const n = lessonNumber(getWorld('foundations'), levelOf('foundations.boss'));
    expect(q('.pl-level__head--boss')).not.toBeNull();
    expect(q('[data-testid="level-label"]')?.textContent).toBe(`Lesson ${n} · Boss Recital`);
    expect(q('[data-testid="lesson-title"]')?.textContent).toBe('A short tune');
    await unmount();
    // A lesson titled just "Boss Recital" is named in full, as the classic screen names it.
    setLessons(fixtureLesson('foundations.boss', { title: 'Boss Recital' }));
    await mount('foundations.boss');
    expect(q('[data-testid="lesson-title"]')?.textContent).toBe('Foundations Boss Recital');
  });

  it('says a check’s tempo in plain words, never bpm: a click keeps the beat, or a ladder starts slow', async () => {
    currentAt('vibrato.03');
    expect(defOf('vibrato.03').metronome).toBe(true);
    setLessons(fixtureLesson('vibrato.03'));
    await mount('vibrato.03');
    const chip = q('[data-testid="tempo-chip"]')!;
    expect(chip.textContent).toBe('A click keeps the beat');
    expect(chip.querySelector('[data-term="beat"]')).not.toBeNull();
    expect(text()).not.toContain('bpm');
    await unmount();

    currentAt('runs.03');
    expect(defOf('runs.03').tempoLadder!.length).toBeGreaterThan(1);
    setLessons(fixtureLesson('runs.03'));
    await mount('runs.03');
    expect(q('[data-testid="tempo-chip"]')?.textContent).toBe('Starts slow, and speeds up each time you pass');
    expect(text()).not.toContain('bpm');
  });

  it('keeps Send to Claude in More, for the check’s exercise', async () => {
    currentAt(LESSON_AT);
    setLessons(LESSON);
    exportMock.build.mockResolvedValue({ level: { id: LESSON_AT }, exercise: defOf(LESSON_AT), exportedAt: '2026-10-22T14:05:00.000Z', takes: [] });
    await mount(LESSON_AT);
    await act(() => {
      q<HTMLButtonElement>('[data-testid="more-button"]')!.click();
    });
    const send = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="more-send"] button')].find((b) => b.textContent?.includes('Send to Claude'))!;
    await act(() => {
      send.click();
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(document.querySelector('[role="dialog"][aria-label="Send to Claude"]')).not.toBeNull();
    expect(exportMock.build).toHaveBeenCalledWith(defOf(LESSON_AT).id, { includeAudio: false });
  });

  it('reads as not started when the lesson’s progress cannot be read, rather than failing the screen', async () => {
    currentAt(LESSON_AT);
    setLessons(LESSON);
    const { lessonProgress } = await import('../../lessons/progress');
    vi.mocked(lessonProgress).mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    await mount(LESSON_AT);
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Practise');
    expect([...container.querySelectorAll<HTMLElement>('.pl-steps > li')].map((s) => s.dataset.state)).toEqual(['now', 'ahead', 'ahead']);
  });
});
