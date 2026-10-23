// @vitest-environment happy-dom
/**
 * The world map, a setlist path (docs/DESIGN.md 13.2): every world in order, locked worlds shown compactly with one
 * Locked line, only openable nodes as buttons, the audition and Song Stage rows, the scroll to where the singer is,
 * and the one-time power-on of nodes a take just opened. Session, song index, runner and scroll are doubles; the
 * unlock registry, the router and the route guard are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/session', async () => (await import('../worlds/test-support')).sessionDouble());
vi.mock('../../runtime/runner', async () => ({ lastOutcome: (await import('@preact/signals')).signal(null) }));
vi.mock('../../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new globalThis.Map()), songsLoaded: signal(true) };
});
vi.mock('../worlds/scroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worlds/scroll')>()),
  revealElement: vi.fn(),
}));

import { WORLDS, getLevel } from '../../exercises';
import { auditionRequirementHint, levelRequirementHint, worldRequirementHint } from '../../progress';
import { resetRouterForTests, route, routeOf } from '../../router';
import { lastOutcome } from '../../runtime/runner';
import { activeProfile, attemptLog, bootError, bootPhase, snapshot } from '../../state/session';
import { songIndex, songsLoaded } from '../../state/songs';
import { revealElement } from '../worlds/scroll';
import { resetPowerOnForTests } from '../worlds/power-on';
import {
  attempt,
  byTestId,
  fakeOutcome,
  flush,
  installGuardOver,
  mount,
  pass,
  passAudition,
  profileRecord,
  snapshotOf,
  songEntry,
  textOf,
  type Mounted,
} from '../worlds/test-support';
import { Map as MapScreen } from './Map';

const DOT = '·';
let view: Mounted | null = null;
/** Foundations in play order (its stored ids no longer run in order since the rebuild): the level at place `n` (1-based). */
const ORDER = [...WORLDS[0].levels].sort((a, b) => a.index - b.index).map((l) => l.id);
const at = (n: number): string => ORDER[n - 1];
const BEFORE_BOSS = ORDER[ORDER.length - 2];
/** The audition's tests today, a passed take of test `n` (1-based), and the last level any test covers (Sirens). */
const TESTS = WORLDS[0].audition!.exerciseIds;
const passTest = (n: number) => attempt({ kind: 'audition', exerciseId: TESTS[n - 1], levelId: null, passed: true });
const SIREN_END = WORLDS[0].audition!.unlockThrough[TESTS.length - 1];

async function showMap(): Promise<HTMLElement> {
  view = mount(<MapScreen />);
  await flush();
  return view.container;
}

const section = (c: HTMLElement, id: string): HTMLElement => byTestId(c, `world-${id}`)!;
const node = (c: HTMLElement, levelId: string): HTMLElement => byTestId(c, `node-${levelId}`)!;

beforeEach(() => {
  resetRouterForTests();
  resetPowerOnForTests();
  vi.mocked(revealElement).mockClear();
  bootPhase.value = 'ready';
  bootError.value = null;
  activeProfile.value = profileRecord('Daniel');
  snapshot.value = snapshotOf(null);
  attemptLog.value = [];
  lastOutcome.value = null;
  songIndex.value = new globalThis.Map();
  songsLoaded.value = true;
  installGuardOver(() => snapshot.peek());
});

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('Map: the setlist', () => {
  it('lists every world in catalog order with its number, title, summary and hue', async () => {
    const c = await showMap();
    const sections = [...c.querySelectorAll<HTMLElement>('section.wl-world')];
    expect(sections.map((s) => s.dataset.worldId)).toEqual(WORLDS.map((w) => w.id));
    sections.forEach((s, i) => {
      const w = WORLDS[i];
      expect(textOf(s.querySelector('.wl-world__num')), w.id).toBe(String(i + 1).padStart(2, '0'));
      expect(textOf(s.querySelector('.wl-world__title')), w.id).toContain(w.title);
      expect(textOf(s.querySelector('.wl-world__summary')), w.id).toBe(w.summary);
      expect(s.getAttribute('style'), w.id).toContain(`var(${w.accent})`);
      expect(s.querySelector('.wl-world__rule'), w.id).not.toBeNull();
    });
  });

  it('shows the profile chip in the app bar, titled World map', async () => {
    const c = await showMap();
    expect(textOf(c.querySelector('.pl-appbar__title'))).toBe('World map');
    expect(byTestId(c, 'profile-chip')).not.toBeNull();
    byTestId<HTMLButtonElement>(c, 'profile-chip')!.click();
    expect(route.value).toEqual(routeOf('profiles'));
  });

  it('has a back button only when there is somewhere to go back to', async () => {
    const c = await showMap();
    expect(c.querySelector('.pl-appbar__back')).toBeNull();
    view!.unmount();
    resetRouterForTests([routeOf('home'), routeOf('map')]);
    const again = await showMap();
    c.remove();
    again.querySelector<HTMLButtonElement>('.pl-appbar__back')!.click();
    expect(route.value).toEqual(routeOf('home'));
  });

  it('counts the passed levels of an open world', async () => {
    snapshot.value = snapshotOf('foundations.03');
    const c = await showMap();
    expect(textOf(section(c, 'foundations').querySelector('.wl-world__count'))).toBe(`3 of ${ORDER.length} levels passed`);
    expect(section(c, 'vibrato').querySelector('.wl-world__count')).toBeNull();
  });
});

describe('Map: locked worlds are compact', () => {
  it('shows a closed world as a dimmed header, its level titles and ONE Locked line, with no nodes', async () => {
    const c = await showMap();
    for (const w of WORLDS.filter((x) => x.levels.length > 0 && x.id !== 'foundations')) {
      const s = section(c, w.id);
      expect(s.dataset.open, w.id).toBe('false');
      expect(s.classList.contains('wl-world--closed'), w.id).toBe(true);
      expect(s.querySelectorAll('.wl-node'), w.id).toHaveLength(0);
      expect(s.querySelector('ol.wl-cable'), w.id).toBeNull();
      expect(s.querySelector('button'), w.id).toBeNull();
      const titles = [...s.querySelectorAll('.wl-titles li')].map((li) => textOf(li));
      expect(titles, w.id).toEqual(w.levels.map((l) => l.title));
      const locked = s.querySelectorAll('.pl-locked');
      expect(locked, w.id).toHaveLength(1);
      expect(textOf(locked[0]), w.id).toContain(worldRequirementHint(w.id, snapshot.value, WORLDS)!);
    }
    expect(textOf(section(c, 'vibrato').querySelector('.pl-locked'))).toContain('Pass the Foundations Boss Recital to unlock Vibrato.');
  });

  it('opens the next world, with a cable of nodes, once its Boss Recital is passed', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    const c = await showMap();
    const s = section(c, 'vibrato');
    expect(s.dataset.open).toBe('true');
    expect(s.querySelector('.wl-titles')).toBeNull();
    expect(s.querySelectorAll('.wl-node')).toHaveLength(9);
    expect(node(c, 'vibrato.01').dataset.state).toBe('current');
    expect(section(c, 'inflections').dataset.open).toBe('false');
  });
});

describe('Map: only openable nodes are buttons', () => {
  beforeEach(() => {
    snapshot.value = snapshotOf('foundations.03');
  });

  it('makes passed and current nodes buttons, and locked nodes static text with their requirement', async () => {
    const c = await showMap();
    const cable = section(c, 'foundations').querySelector('ol.wl-cable')!;
    expect(cable.querySelectorAll('.wl-node')).toHaveLength(ORDER.length);
    expect(cable.querySelectorAll('button')).toHaveLength(4);
    expect(cable.querySelectorAll('li.wl-node--locked')).toHaveLength(ORDER.length - 4);
    for (const id of ORDER.slice(0, 4)) {
      expect(node(c, id).querySelector('button'), id).not.toBeNull();
    }
    expect(levelRequirementHint(at(5), snapshot.value, WORLDS)).toBe('Pass Hold it steady to unlock.');
    for (const id of ORDER.slice(4)) {
      const li = node(c, id);
      expect(li.querySelector('button'), id).toBeNull();
      expect(li.querySelector('[role="button"], a'), id).toBeNull();
      expect(textOf(li.querySelector('.pl-locked')), id).toContain(levelRequirementHint(id, snapshot.value, WORLDS)!);
    }
    // Each locked node names the level that opens it, not the same line all the way down.
    expect(textOf(node(c, at(6)).querySelector('.pl-locked'))).toContain('Pass Two notes, one step apart to unlock.');
  });

  it('opens a level from a passed node or the current node', async () => {
    const c = await showMap();
    node(c, 'foundations.02').querySelector('button')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: 'foundations.02' }));
    resetRouterForTests();
    installGuardOver(() => snapshot.peek());
    node(c, at(4)).querySelector('button')!.click();
    expect(route.value).toEqual(routeOf('level', { levelId: at(4) }));
  });

  it('does nothing when a locked node is tapped', async () => {
    const c = await showMap();
    node(c, at(7)).click();
    node(c, at(7)).querySelector('.wl-node__row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(route.value).toEqual(routeOf('home'));
  });

  it('keeps every node of a closed world out of the tab order: the only controls on the map are openable ones', async () => {
    const c = await showMap();
    const buttons = [...c.querySelectorAll('.pl-scroll button')];
    // 4 nodes + the Foundations audition row; the rest of the map has no controls.
    expect(buttons).toHaveLength(5);
  });

  it('names each button for a screen reader with its place and state, and marks the current step', async () => {
    const c = await showMap();
    expect(node(c, at(4)).querySelector('button')!.getAttribute('aria-label')).toBe('Lesson 4: Hold it steady. Up next. New lesson.');
    expect(node(c, 'foundations.01').querySelector('button')!.getAttribute('aria-label')).toBe('Lesson 1: Range finder. Range saved.');
    expect(node(c, at(4)).querySelector('button')!.getAttribute('aria-current')).toBe('step');
    expect(node(c, 'foundations.03').querySelector('button')!.hasAttribute('aria-current')).toBe(false);
  });
});

describe('Map: node status', () => {
  it('writes the best score and mastery tier of a passed level, with its tally lights, and "Up next" on the current one', async () => {
    snapshot.value = snapshotOf(null, [
      pass('foundations.01', { score: 0.93, mastery: 3 }),
      pass('foundations.02', { score: 0.93, mastery: 3 }),
      pass('foundations.03', { score: 0.88, mastery: 2 }),
      pass(at(4), { score: 0.71, mastery: 1 }),
    ]);
    const c = await showMap();
    // The Range finder measures the voice: it says so, with no score and no tally lights.
    expect(textOf(node(c, 'foundations.01').querySelector('.wl-node__status'))).toBe('Range saved');
    expect(node(c, 'foundations.01').querySelector('.pl-tally-lights')).toBeNull();
    expect(textOf(node(c, 'foundations.02').querySelector('.wl-node__status'))).toBe(`Best 93% ${DOT} Studio`);
    expect(textOf(node(c, 'foundations.03').querySelector('.wl-node__status'))).toBe(`Best 88% ${DOT} Solid`);
    expect(textOf(node(c, at(4)).querySelector('.wl-node__status'))).toBe(`Best 71% ${DOT} Passed`);
    expect(node(c, 'foundations.02').querySelector('.pl-tally-lights')!.getAttribute('aria-label')).toContain('3 of 3');
    expect(node(c, 'foundations.03').querySelector('.pl-tally-lights')!.getAttribute('aria-label')).toContain('2 of 3');
    expect(textOf(node(c, at(5)).querySelector('.wl-node__status'))).toContain('Up next');
    expect(node(c, at(5)).querySelector('.pl-tally-lights')).toBeNull();
  });

  it('says where the current lesson is, with its best on the check as an arc of its ring', async () => {
    const take = attempt({ levelId: at(4), exerciseId: getLevel(at(4))!.exerciseId, passed: false, score: 0.42 });
    snapshot.value = snapshotOf('foundations.03', [take]);
    attemptLog.value = [take];
    const c = await showMap();
    // A lesson says where its practice is (after a missed check: the step that trains what it missed); the ring the best.
    expect(textOf(node(c, at(4)).querySelector('.wl-node__status'))).toMatch(new RegExp(`^Up next ${DOT} Practice \\d of \\d$`));
    expect(node(c, at(4)).querySelector('.pl-score-ring__arc')).not.toBeNull();
    const arc = node(c, 'foundations.01').querySelector('.pl-score-ring__arc')!;
    expect(arc).not.toBeNull();
    expect(node(c, at(7)).querySelector('.pl-score-ring__arc')).toBeNull();
  });

  it('numbers the nodes in the ring', async () => {
    const c = await showMap();
    expect(textOf(node(c, 'foundations.01').querySelector('.wl-node__num'))).toBe('1');
    expect(textOf(node(c, 'foundations.boss').querySelector('.wl-node__num'))).toBe(String(ORDER.length));
  });

  it('says a level was passed by audition', async () => {
    snapshot.value = snapshotOf('foundations.01', [passAudition('foundations', 1)]);
    const c = await showMap();
    expect(textOf(node(c, 'foundations.03').querySelector('.wl-node__status'))).toBe('Passed by audition');
    expect(textOf(node(c, 'foundations.01').querySelector('.wl-node__status'))).toBe('Range saved');
  });

  it('lights the cable in the world hue up to the current node', async () => {
    snapshot.value = snapshotOf('foundations.03');
    const c = await showMap();
    const lit = (id: string) => [node(c, id).classList.contains('wl-node--lit-above'), node(c, id).classList.contains('wl-node--lit-below')];
    expect(lit('foundations.01')).toEqual([false, true]);
    expect(lit('foundations.03')).toEqual([true, true]);
    expect(lit(at(4))).toEqual([true, false]);
    expect(lit(at(5))).toEqual([false, false]);
  });

  it('gives the Boss Recital its own node: a larger ring under the label BOSS RECITAL, titled by its world', async () => {
    snapshot.value = snapshotOf(BEFORE_BOSS);
    const c = await showMap();
    const boss = node(c, 'foundations.boss');
    expect(boss.classList.contains('wl-node--boss')).toBe(true);
    expect(boss.classList.contains('wl-node--current')).toBe(true);
    expect(textOf(boss.querySelector('.wl-node__kicker'))).toBe('Boss Recital');
    expect(textOf(boss.querySelector('.wl-node__title'))).toBe('Foundations');
    expect(boss.querySelector('.pl-score-ring')!.getAttribute('style')).toContain('64px');
    expect(boss.querySelector('button')!.getAttribute('aria-label')).toBe(`Lesson ${ORDER.length}: Foundations Boss Recital. Up next. New lesson.`);
    expect(node(c, BEFORE_BOSS).querySelector('.pl-score-ring')!.getAttribute('style')).toContain('56px');
  });
});

describe('Map: placement audition row', () => {
  it('is a Locked line with its requirement until the Range finder has been sung', async () => {
    const c = await showMap();
    const row = byTestId(c, 'audition-row-foundations')!;
    expect(row.tagName).toBe('DIV');
    expect(row.querySelector('button')).toBeNull();
    expect(textOf(row)).toContain(auditionRequirementHint('foundations', snapshot.value, WORLDS)!);
    expect(textOf(row)).toContain('Pass Range finder to unlock the audition.');
    // A closed world has no audition row at all.
    expect(byTestId(c, 'audition-row-vibrato')).toBeNull();
  });

  it('is a button saying how many tests and how far they reach, and opens the audition', async () => {
    snapshot.value = snapshotOf('foundations.01');
    const c = await showMap();
    const row = byTestId<HTMLButtonElement>(c, 'audition-row-foundations')!;
    expect(row.tagName).toBe('BUTTON');
    expect(textOf(row)).toContain('Placement audition');
    expect(textOf(row)).toContain('Sing 4 short tests to skip ahead');
    expect(textOf(row)).toContain('Can open Match one note – Sirens');
    row.click();
    expect(route.value).toEqual(routeOf('audition', { worldId: 'foundations' }));
  });

  it('counts the tests that are left', async () => {
    snapshot.value = snapshotOf('foundations.01', [passTest(1), passTest(2)]);
    const c = await showMap();
    expect(textOf(byTestId(c, 'audition-row-foundations'))).toContain('Sing 2 short tests to skip ahead');
  });

  it('is hidden once nothing is left to open', async () => {
    snapshot.value = snapshotOf(SIREN_END);
    const c = await showMap();
    expect(byTestId(c, 'audition-row-foundations')).toBeNull();
  });

  it("offers the next world's audition when that world opens", async () => {
    snapshot.value = snapshotOf('foundations.boss');
    const c = await showMap();
    expect(byTestId(c, 'audition-row-vibrato')!.tagName).toBe('BUTTON');
    byTestId<HTMLButtonElement>(c, 'audition-row-vibrato')!.click();
    expect(route.value).toEqual(routeOf('audition', { worldId: 'vibrato' }));
  });
});

describe('Map: Song Stage', () => {
  it('is a Locked line until Song Stage opens', async () => {
    const c = await showMap();
    const row = byTestId(c, 'song-stage-row')!;
    expect(row.tagName).toBe('DIV');
    expect(row.querySelector('button')).toBeNull();
    expect(textOf(row)).toContain('Pass the Foundations Boss Recital to open Song Stage.');
    expect(section(c, 'song-stage').querySelectorAll('.wl-node')).toHaveLength(0);
  });

  it('is a row to the library saying how many songs are open and how many are locked', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    songIndex.value = new globalThis.Map(
      [songEntry('twinkle', 'foundations'), songEntry('amazing-grace', 'vibrato'), songEntry('ave-maria', 'runs')].map((e) => [e.id, e]),
    );
    const c = await showMap();
    const row = byTestId<HTMLButtonElement>(c, 'song-stage-row')!;
    expect(row.tagName).toBe('BUTTON');
    expect(textOf(row)).toContain(`1 song open ${DOT} 2 locked`);
    row.click();
    expect(route.value).toEqual(routeOf('songs'));
  });

  it('says so while the library loads, and when it is empty', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    songsLoaded.value = false;
    const c = await showMap();
    expect(textOf(byTestId(c, 'song-stage-row'))).toContain('Loading the library');
    songsLoaded.value = true;
    await flush();
    expect(textOf(byTestId(c, 'song-stage-row'))).toContain('No songs yet');
  });
});

describe('Map: scrolling to where the singer is', () => {
  it('scrolls the current node into view', async () => {
    snapshot.value = snapshotOf('foundations.03');
    const c = await showMap();
    expect(revealElement).toHaveBeenCalledTimes(1);
    const [el, align] = vi.mocked(revealElement).mock.calls[0];
    expect(el).toBe(node(c, at(4)));
    expect(align).toBe('node');
  });

  it('scrolls to the world named in the route instead', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    resetRouterForTests([routeOf('home'), routeOf('map', { worldId: 'foundations' })]);
    const c = await showMap();
    expect(revealElement).toHaveBeenCalledTimes(1);
    const [el, align] = vi.mocked(revealElement).mock.calls[0];
    expect(el).toBe(section(c, 'foundations'));
    expect(align).toBe('top');
  });

  it('falls back to the current node for a world that does not exist', async () => {
    snapshot.value = snapshotOf('foundations.03');
    resetRouterForTests([routeOf('home'), routeOf('map', { worldId: 'nowhere' })]);
    const c = await showMap();
    expect(vi.mocked(revealElement).mock.calls[0][0]).toBe(node(c, at(4)));
  });

  it('scrolls once, not on every re-render', async () => {
    snapshot.value = snapshotOf('foundations.03');
    await showMap();
    snapshot.value = snapshotOf(at(4));
    await flush();
    expect(revealElement).toHaveBeenCalledTimes(1);
  });

  it('waits for the boot to finish before it scrolls', async () => {
    bootPhase.value = 'booting';
    activeProfile.value = null;
    const c = await showMap();
    expect(revealElement).not.toHaveBeenCalled();
    snapshot.value = snapshotOf('foundations.03');
    bootPhase.value = 'ready';
    await flush();
    expect(revealElement).toHaveBeenCalledTimes(1);
    expect(vi.mocked(revealElement).mock.calls[0][0]).toBe(node(c, at(4)));
  });

  it('does not scroll when every level is passed and no world is named', async () => {
    snapshot.value = snapshotOf('dynamics.boss');
    await showMap();
    expect(revealElement).not.toHaveBeenCalled();
  });
});

describe('Map: power-on', () => {
  const opened = (id: string, levelId: string, title: string) =>
    fakeOutcome({ id, unlocked: [{ kind: 'level-opened', levelId, title }] });

  it('powers on a node the last take opened, once', async () => {
    snapshot.value = snapshotOf('foundations.01');
    lastOutcome.value = opened('take-1', 'foundations.02', 'Pitch match');
    const c = await showMap();
    expect(node(c, 'foundations.02').classList.contains('wl-node--power-on')).toBe(true);
    expect(node(c, 'foundations.02').querySelector('.wl-node__glow')).not.toBeNull();
    expect(c.querySelectorAll('.wl-node--power-on')).toHaveLength(1);

    // Coming back to the map later does not light it again.
    view!.unmount();
    const again = await showMap();
    expect(again.querySelectorAll('.wl-node--power-on')).toHaveLength(0);
  });

  it('keeps the class while the same map re-renders, so the glow is not restarted', async () => {
    snapshot.value = snapshotOf('foundations.01');
    lastOutcome.value = opened('take-1', 'foundations.02', 'Pitch match');
    const c = await showMap();
    snapshot.value = snapshotOf('foundations.01', [attempt({ levelId: 'foundations.02', passed: false, score: 0.2 })]);
    await flush();
    expect(node(c, 'foundations.02').classList.contains('wl-node--power-on')).toBe(true);
  });

  it('powers on every level an audition test opened', async () => {
    snapshot.value = snapshotOf('foundations.01', [passTest(1)]);
    lastOutcome.value = fakeOutcome({
      id: 'take-2',
      unlocked: [
        { kind: 'level-opened', levelId: 'foundations.02', title: 'Match one note' },
        { kind: 'level-opened', levelId: 'foundations.03', title: 'Hold it' },
        { kind: 'level-opened', levelId: at(4), title: 'Hold it steady' },
      ],
    });
    const c = await showMap();
    expect([...c.querySelectorAll('.wl-node--power-on')].map((el) => (el as HTMLElement).dataset.testid)).toEqual([
      'node-foundations.02',
      'node-foundations.03',
      `node-${at(4)}`,
    ]);
  });

  it('powers on the first level of a world that just opened', async () => {
    snapshot.value = snapshotOf('foundations.boss');
    lastOutcome.value = fakeOutcome({ id: 'take-3', unlocked: [{ kind: 'world-opened', worldId: 'vibrato', title: 'Vibrato' }] });
    const c = await showMap();
    expect([...c.querySelectorAll('.wl-node--power-on')].map((el) => (el as HTMLElement).dataset.testid)).toEqual(['node-vibrato.01']);
  });

  it('powers nothing on when the last take opened nothing', async () => {
    snapshot.value = snapshotOf('foundations.01');
    lastOutcome.value = fakeOutcome({ id: 'take-4', unlocked: [] });
    const c = await showMap();
    expect(c.querySelectorAll('.wl-node--power-on')).toHaveLength(0);
  });

  it('does not use up the take while the session is still booting', async () => {
    bootPhase.value = 'booting';
    activeProfile.value = null;
    snapshot.value = snapshotOf('foundations.01');
    lastOutcome.value = opened('take-5', 'foundations.02', 'Pitch match');
    const c = await showMap();
    bootPhase.value = 'ready';
    activeProfile.value = profileRecord('Daniel');
    await flush();
    expect(node(c, 'foundations.02').classList.contains('wl-node--power-on')).toBe(true);
  });
});

describe('Map: boot states', () => {
  it('shows a skeleton while the session boots', async () => {
    bootPhase.value = 'booting';
    activeProfile.value = null;
    const c = await showMap();
    expect(byTestId(c, 'boot-skeleton')).not.toBeNull();
    expect(c.querySelectorAll('section.wl-world')).toHaveLength(0);
    expect(byTestId(c, 'profile-chip')).toBeNull();
  });

  it('shows a plain error and a Reload button when the boot failed', async () => {
    bootPhase.value = 'failed';
    bootError.value = 'Saved data could not be opened in this browser.';
    const c = await showMap();
    expect(textOf(byTestId(c, 'boot-failed'))).toContain('Saved data could not be opened in this browser.');
    expect([...c.querySelectorAll('button')].some((b) => textOf(b) === 'Reload')).toBe(true);
    expect(c.querySelectorAll('section.wl-world')).toHaveLength(0);
  });
});
