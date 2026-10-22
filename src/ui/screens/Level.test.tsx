// @vitest-environment happy-dom
/** Level on the real catalog and the real progression engine, with a fake runner for Listen. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../audio/engine', async () => (await import('../practice/test-fakes')).engineModule());
vi.mock('../../runtime/runner', async () => (await import('../practice/test-fakes')).runnerModule());
vi.mock('../../state/session', async () => (await import('../practice/test-fakes')).sessionModule());
vi.mock('../../state/settings', async () => (await import('../practice/test-fakes')).settingsModule());
vi.mock('../../state/audio', async () => (await import('../practice/test-fakes')).audioModule());
const exportMock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../../coaching/export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../coaching/export')>()), buildCoachingFile: exportMock.build }));

import { getExercise, getLevel, realize } from '../../exercises';
import { GOOD_SINGER, singTake } from '../../exercises/test-singer';
import { attempt } from '../../progress/test-fixtures';
import { bindDesktopBackKey, installRouteGuard, resetRouterForTests, route, routeOf } from '../../router';
import type { AppStorage } from '../../storage';
import type { AttemptRecord, TakeRecord } from '../../storage/schema';
import { encodeTrack } from '../../storage/track-codec';
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

const q = <T extends Element = HTMLElement>(sel: string): T | null => container.querySelector<T>(sel);
const text = (): string => container.textContent ?? '';
const buttonNamed = (name: string): HTMLButtonElement | undefined => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(name));

beforeEach(() => {
  resetSession(['foundations.01', 'foundations.02']);
  resetRunner();
  exportMock.build.mockReset();
  bindDesktopBackKey();
});

afterEach(async () => {
  await act(() => {
    render(null, container);
  });
  container.remove();
});

describe('Level: the current level', () => {
  it('shows the number, the title, the goal, the pass lines and the tolerance', async () => {
    await mount('foundations.03');
    const def = getExercise(getLevel('foundations.03')!.exerciseId)!;
    expect(q('[data-testid="level-label"]')?.textContent).toBe('Level 03');
    expect(text()).toContain('Sustain I');
    expect(text()).toContain(def.goal);
    // The pass lines are the exercise's own (exercises/evaluate.ts passRequirements).
    expect(text()).toContain(`Score ≥ ${Math.round(def.pass.score * 100)}%`);
    expect(text()).toContain('In tune ≥');
    expect(text()).toContain('±50¢');
    // A held note has no tempo worth showing.
    expect(text()).not.toContain('bpm');
  });

  it('has not been sung yet: no best score, and the tally says where each light comes', async () => {
    await mount('foundations.03');
    const def = getExercise(getLevel('foundations.03')!.exerciseId)!;
    expect(q('[data-testid="best-score"]')?.textContent).toBe('Not sung yet');
    expect(text()).toContain(`Lights at ${Math.round(def.pass.score * 100)}%, ${Math.round(def.tiers.solid * 100)}% and ${Math.round(def.tiers.studio * 100)}%.`);
    expect(container.querySelector('[role="img"][aria-label^="0 of 3"]')).not.toBeNull();
  });

  it('opens the Sing screen for this level from the Sing button', async () => {
    await mount('foundations.03');
    const sing = q<HTMLButtonElement>('[data-testid="sing-button"]')!;
    expect(sing.textContent).toContain('Sing');
    expect(sing.textContent).not.toContain('again');
    sing.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'level', levelId: 'foundations.03' }));
  });

  it('shows the personal-record line locked, never hidden, until the level is passed', async () => {
    await mount('foundations.03');
    const locked = container.querySelector('.pl-locked');
    expect(locked).not.toBeNull();
    expect(locked!.textContent).toContain('Locked.');
    expect(locked!.textContent).toContain('Chase a record');
    expect(locked!.textContent).toContain('Pass Sustain I to chase personal records on it.');
    expect(buttonNamed('Chase a record')).toBeUndefined();
  });

  it('offers no personal records on the Range finder at all, passed or not (it measures; a wider span is a strained one)', async () => {
    resetSession([]);
    await mount('foundations.01');
    expect(text()).not.toContain('Chase a record');
    expect(q('[data-testid="chase-record"]')).toBeNull();
    await act(() => {
      render(null, container);
    });
    container.remove();
    resetSession(['foundations.01', 'foundations.02']);
    await mount('foundations.01');
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing again');
    expect(text()).not.toContain('Chase a record');
    expect(text()).not.toContain('Personal bests');
  });
});

describe('Level: a level that is not open', () => {
  it('shows what unlocks it and offers no way in', async () => {
    await mount('foundations.06');
    const locked = container.querySelector('.pl-locked');
    expect(locked).not.toBeNull();
    expect(locked!.textContent).toContain('Pass Sirens & glides to unlock.');
    expect(q('[data-testid="sing-button"]')).toBeNull();
    expect(q('[data-testid="listen-button"]')).toBeNull();
    expect(text()).not.toContain('To pass');
  });

  it('says so for a level that does not exist', async () => {
    await mount('nonsense.99');
    expect(q('[data-testid="unavailable"]')).not.toBeNull();
  });
});

describe('Level: a passed level', () => {
  beforeEach(() => {
    session.snapshot.value = snapshotAfter(['foundations.01', 'foundations.02', 'foundations.03'], { score: 0.86, mastery: 2 });
  });

  it('offers "Sing again", shows the best score and its tally, and lets you chase a record', async () => {
    await mount('foundations.03');
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing again');
    expect(q('[data-testid="best-score"]')?.textContent).toBe('86%');
    expect(container.querySelector('[role="img"][aria-label^="2 of 3"]')).not.toBeNull();
    const chase = buttonNamed('Chase a record')!;
    expect(chase).toBeDefined();
    expect(container.querySelector('.pl-locked')).toBeNull();
    chase.click();
    expect(route.value).toEqual(routeOf('sing', { target: 'record', levelId: 'foundations.03' }));
  });

  it('lists the personal bests of the exercise', async () => {
    session.snapshot.value = {
      ...session.snapshot.value,
      records: {
        'foundations.sustain.1:accuracy.inTolerancePct': { value: 96, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
        'foundations.sustain.1:accuracy.sdCents': { value: 8, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
        'foundations.sustain.1:not.a.metric': { value: 1, attemptId: 'a1', at: '2026-10-21T10:00:00.000Z' },
      },
    };
    await mount('foundations.03');
    expect(text()).toContain('Personal bests');
    expect(text()).toContain('In tune');
    expect(text()).toContain('96%');
    expect(text()).toContain('8¢');
    expect(text()).not.toContain('not.a.metric');
  });

  it('never shows a lower rung\'s score as the level\'s best: a Runs level sung only on its lower rungs is not sung at its tempo yet', async () => {
    const snap = snapshotAfter(['foundations.01', 'foundations.02', 'foundations.03']);
    // What the engine reports for a Runs level with takes on its lower rungs only: attempts, but no best at its tempo.
    snap.levels['runs.03'] = { ...snap.levels['runs.03'], status: 'current', attempts: 2, bestScore: 0, mastery: 0 };
    session.snapshot.value = snap;
    await mount('runs.03');
    const tempo = getExercise(getLevel('runs.03')!.exerciseId)!.tempoBpm;
    expect(q('[data-testid="best-score"]')?.textContent).toBe(`Not sung at ${tempo} bpm yet`);
  });

  it('says a level passed by audition has no score yet', async () => {
    const snap = snapshotAfter(['foundations.01', 'foundations.02', 'foundations.03']);
    snap.levels['foundations.03'] = { ...snap.levels['foundations.03'], attempts: 0, bestScore: 0, mastery: 1, viaAudition: true };
    session.snapshot.value = snap;
    await mount('foundations.03');
    expect(q('[data-testid="best-score"]')?.textContent).toBe('Not sung yet');
    expect(text()).toContain('Passed by audition');
  });
});

describe('Level: the saved range', () => {
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

describe('Level: Boss Recital and Runs ladder', () => {
  it('gives the Boss Recital a stage and lists the sections of its one take', async () => {
    session.snapshot.value = snapshotAfter(levelsBefore('foundations.boss'));
    await mount('foundations.boss');
    expect(q('.pl-level__head--boss')).not.toBeNull();
    expect(q('[data-testid="level-label"]')?.textContent).toBe('Boss Recital · one continuous take');
    expect(text()).toContain('Foundations Boss Recital');
    const steps = [...container.querySelectorAll('.pl-level__chain li')].map((li) => li.textContent);
    expect(steps).toEqual(['1Hold it steady and straight', '2Attack the octave dead centre', '3Legato down the scale']);
    expect(q('[data-testid="sing-button"]')!.textContent).toContain('Sing');
  });

  it('says where a Runs ladder is headed, and shows the metronome tempo of other levels', async () => {
    session.snapshot.value = snapshotAfter(levelsBefore('runs.03'));
    await mount('runs.03');
    const def = getExercise(getLevel('runs.03')!.exerciseId)!;
    const rungs = def.tempoLadder!;
    expect(text()).toContain(`Tempo climbs ${rungs[0]} → ${rungs[rungs.length - 1]} bpm as you pass`);
    await act(() => {
      render(null, container);
    });
    container.remove();

    session.snapshot.value = snapshotAfter(levelsBefore('foundations.06'));
    await mount('foundations.06');
    expect(text()).toContain('84 bpm');
  });
});

describe('Level: Listen and More', () => {
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

  it('Space sings from the keyboard, and Back returns to the map', async () => {
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

describe('Level: the Range finder, in plain words', () => {
  it('lists the steps, says what passing means without jargon, and shows no tolerance chip or score', async () => {
    await mount('foundations.01');
    const def = getExercise(getLevel('foundations.01')!.exerciseId)!;
    const steps = q('[data-testid="level-steps"]');
    expect(steps?.querySelectorAll('li')).toHaveLength(def.steps!.length);
    expect(text()).toContain(def.passPlain!);
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
    await mount('foundations.03');
    expect(q('[data-testid="level-steps"]')).toBeNull();
    expect(text()).toContain('±50¢');
  });
});

describe('Level: "Last time", before the next try', () => {
  const def = getExercise(getLevel('foundations.03')!.exerciseId)!;
  const realized = realize(def, TENOR_RANGE, 'tenor');
  /** A take of Sustain I sung a whole step sharp: it misses. */
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
    expect(q('[data-testid="coach-what"]')?.textContent).toMatch(/sharp/);
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
    await act(() => {
      render(null, container);
    });
    container.remove();
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
