// @vitest-environment happy-dom
/**
 * The Song Stage library gates through the registry (SPEC §11.1): a locked song is shown with its requirement line
 * and is never a control; the import button exists only once importing is earned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { WORLDS, levelsOf } from '../../exercises';
import { computeSnapshot, requirementHint } from '../../progress';
import type { AttemptRecord } from '../../storage/schema';
import type { SongEntry } from '../../state/songs';

vi.mock('../../state/session', async () => {
  const { signal } = await import('@preact/signals');
  const { computeSnapshot: compute, isFeatureUnlocked } = await import('../../progress');
  const { WORLDS: worlds } = await import('../../exercises');
  const snapshot = signal(compute('p1', worlds, [], Date.parse('2026-10-22T12:00:00Z')));
  return { snapshot, isUnlocked: (id: never) => isFeatureUnlocked(id, snapshot.value), appStorage: signal(null), activeProfile: signal(null) };
});
vi.mock('../../state/settings', async () => {
  const { signal } = await import('@preact/signals');
  const { DEFAULT_SETTINGS } = await import('../../state/settings-types');
  return { settings: signal(DEFAULT_SETTINGS) };
});

import { snapshot } from '../../state/session';
import { songIndex, songLoadErrors, songsLoaded } from '../../state/songs';
import { Songs } from './Songs';

const NOW = Date.parse('2026-10-22T12:00:00Z');

/** Every Foundations level passed in order, Boss Recital last: Song Stage and importing open, Vibrato open. */
function foundationsPassed(): AttemptRecord[] {
  return [...levelsOf('foundations')].sort((a, b) => a.index - b.index).map((level, i) => {
    const at = new Date(NOW - (100 - i) * 60_000).toISOString();
    return {
      id: `a${i}`,
      profileId: 'p1',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      exerciseId: level.exerciseId,
      levelId: level.id,
      kind: level.kind === 'boss' ? 'boss' : 'practice',
      score: 0.9,
      passed: true,
      mastery: 1,
      metrics: {},
      durationSec: 30,
      tonicMidi: null,
      tempoBpm: null,
      takeId: null,
    };
  });
}

function entry(id: string, title: string, requiredWorld: SongEntry['difficulty']['requiredWorld'], bundled = true): SongEntry {
  return {
    id,
    title,
    artist: 'Traditional',
    source: bundled ? 'bundled' : 'ultrastar',
    bundled,
    licence: bundled ? 'Public domain melody.' : null,
    difficulty: { lowestMidi: 55, highestMidi: 67, rangeSemitones: 12, maxLeapSemitones: 5, notesPerSec: 1, melismaRate: 0, longNoteRatio: 0, requiredWorld },
    recordId: bundled ? null : `rec-${id}`,
    durationSec: 100,
    caption: requiredWorld === 'runs' ? 'a 16-note melisma near 0:05' : null,
  };
}

function show(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  render(<Songs />, container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Song Stage library', () => {
  it('lists open songs as buttons and locked songs as static rows with their requirement', () => {
    snapshot.value = computeSnapshot('p1', WORLDS, foundationsPassed(), NOW);
    songIndex.value = new Map([
      ['ave', entry('ave', 'Ave Maria', 'runs')],
      ['twinkle', entry('twinkle', 'Twinkle, Twinkle', 'foundations')],
      ['mine', entry('mine', 'My Song', 'foundations', false)],
    ]);
    songLoadErrors.value = [];
    songsLoaded.value = true;
    const c = show();

    const open = [...c.querySelectorAll('[data-testid="song-row"]')];
    expect(open.map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(open[0].textContent).toContain('Twinkle, Twinkle');
    expect(open[0].textContent).toContain('Public domain');
    expect(open[1].textContent).toContain('Yours');

    const locked = [...c.querySelectorAll('[data-testid="song-row-locked"]')];
    expect(locked).toHaveLength(1);
    expect(locked[0].tagName).toBe('DIV');
    expect(locked[0].querySelector('button, a, [role="button"]')).toBeNull();
    expect(locked[0].textContent).toContain('Ave Maria');
    expect(locked[0].textContent).toContain('Pass the Runs & Riffs Boss Recital to unlock this song.');
    expect(locked[0].textContent).toContain('a 16-note melisma near 0:05');
    // Open first, then locked, numbered as one setlist.
    expect([...c.querySelectorAll('.pl-song-row__num')].map((n) => n.textContent)).toEqual(['01', '02', '03']);
  });

  it('shows the import button only once importing is earned', () => {
    snapshot.value = computeSnapshot('p1', WORLDS, [], NOW);
    songIndex.value = new Map([['twinkle', entry('twinkle', 'Twinkle, Twinkle', 'foundations')]]);
    songsLoaded.value = true;
    let c = show();
    expect(c.querySelector('[data-testid="song-import-button"]')).toBeNull();
    expect(c.textContent).toContain(requirementHint('song.import'));
    render(null, c);

    snapshot.value = computeSnapshot('p1', WORLDS, foundationsPassed(), NOW);
    c = show();
    expect(c.querySelector('[data-testid="song-import-button"]')?.tagName).toBe('BUTTON');
    expect(c.textContent).not.toContain(requirementHint('song.import'));
  });

  it('says plainly which charts failed to load', () => {
    snapshot.value = computeSnapshot('p1', WORLDS, foundationsPassed(), NOW);
    songIndex.value = new Map();
    songLoadErrors.value = [{ id: 'danny-boy', message: 'Line 12: Expected a note line' }];
    songsLoaded.value = true;
    const c = show();
    expect(c.textContent).toContain('One song could not load.');
    expect(c.textContent).toContain('danny-boy: Line 12: Expected a note line');
    expect(c.textContent).toContain('Try again');
  });
});
