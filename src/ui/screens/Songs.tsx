/**
 * Song Stage: the library (DESIGN.md §13.7). A setlist: the open songs first, then the locked ones, dimmed, each
 * with the Boss Recital that opens it (SPEC §11.2: a song opens with the world its rated difficulty needs). The
 * import button appears in the app bar once importing is earned; before that the list ends with its locked line.
 */
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { FilePlus2, ListMusic } from 'lucide-preact';
import { back, canGoBack, navigate } from '../../router';
import { WORLDS } from '../../exercises';
import { isSongUnlocked, requirementHint, songRequirementHint } from '../../progress';
import { isUnlocked, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { loadSongs, songIndex, songLoadErrors, songsLoaded, type SongEntry } from '../../state/songs';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Locked } from '../components/Locked';
import { worldRank } from '../song/format';
import { SongRow } from '../song/SongRow';

const SKELETON_ROWS = 4;

interface Listed {
  entry: SongEntry;
  /** Null when open. */
  hint: string | null;
}

export function Songs(): JSX.Element {
  const loaded = songsLoaded.value;
  const errors = songLoadErrors.value;
  const snap = snapshot.value;
  const importOpen = isUnlocked('song.import');
  const notation = settings.value.notation;

  useEffect(() => {
    // The session loads the index at boot; a deep link that beats it here starts the load itself.
    if (!songsLoaded.value) void loadSongs();
  }, []);

  // Stable order: the world each song needs, then the library's own order (bundled charts, then imports).
  const listed: Listed[] = [...songIndex.value.values()]
    .map((entry, order) => ({ entry, order, rank: worldRank(entry.difficulty.requiredWorld) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ entry }) => {
      const world = entry.difficulty.requiredWorld;
      const open = isSongUnlocked(world, snap, WORLDS);
      return { entry, hint: open ? null : (songRequirementHint(world, snap, WORLDS) ?? 'Not available yet.') };
    });
  const open = listed.filter((l) => l.hint === null);
  const locked = listed.filter((l) => l.hint !== null);

  const row = (l: Listed, n: number): JSX.Element => (
    <li key={l.entry.id}>
      <SongRow entry={l.entry} number={n} lockedHint={l.hint} notation={notation} onOpen={() => navigate('song', { songId: l.entry.id })} />
    </li>
  );

  return (
    <div class="pl-screen" data-testid="songs-screen">
      <AppBar
        title="Song Stage"
        onBack={canGoBack.value ? () => back() : undefined}
        trailing={
          importOpen ? (
            <button type="button" class="pl-song-appbar-action" onClick={() => navigate('song-import')} data-testid="song-import-button">
              <FilePlus2 size={20} strokeWidth={2} aria-hidden="true" />
              Import
            </button>
          ) : null
        }
      />
      <div class="pl-scroll">
        <div class="pl-page">
          {errors.length > 0 ? (
            <Banner kind="warn" message={errors.length === 1 ? 'One song could not load.' : `${errors.length} songs could not load.`}>
              <ul class="pl-song-errors">
                {errors.map((e) => (
                  <li key={e.id}>
                    <span class="pl-song-errors__id">{e.id}</span>: {e.message}
                  </li>
                ))}
              </ul>
              <Button variant="secondary" onClick={() => void loadSongs()}>
                Try again
              </Button>
            </Banner>
          ) : null}

          {!loaded ? (
            <ol class="pl-song-list" aria-busy="true" aria-label="Loading songs">
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <li key={i} class="pl-song-skeleton" aria-hidden="true" />
              ))}
            </ol>
          ) : listed.length === 0 ? (
            <EmptyState
              icon={ListMusic}
              title="No songs yet"
              message={importOpen ? 'Import an UltraStar or MIDI file to sing it here.' : 'The song library could not load.'}
            />
          ) : (
            <>
              {open.length > 0 ? (
                <section class="pl-stack" aria-labelledby="songs-open">
                  <h2 id="songs-open" class="pl-label">
                    Open · {open.length}
                  </h2>
                  <ol class="pl-song-list">{open.map((l, i) => row(l, i + 1))}</ol>
                </section>
              ) : null}
              {locked.length > 0 ? (
                <section class="pl-stack" aria-labelledby="songs-locked">
                  <h2 id="songs-locked" class="pl-label">
                    Locked · {locked.length}
                  </h2>
                  <ol class="pl-song-list" start={open.length + 1}>
                    {locked.map((l, i) => row(l, open.length + i + 1))}
                  </ol>
                </section>
              ) : null}
            </>
          )}

          {!importOpen ? <Locked title="Import your own songs" hint={requirementHint('song.import')} /> : null}
          <p class="pl-body-s pl-muted pl-prose">The bundled songs are public domain. Songs you import stay on this device.</p>
        </div>
      </div>
    </div>
  );
}
