/**
 * The song player (DESIGN.md §13.9): the piano roll with the song's notes and the live trace, the lyric line with
 * the tally underline walking the syllables, the phrase scrubber, the transport (play/pause, loop, speed, key), and
 * the thumb-zone bar (Listen, Sing, More). After a take, a sheet with the phrase-by-phrase breakdown.
 *
 * The route guard opens this screen only for a song the singer has earned (SPEC §11.2); the screen checks again and
 * fails closed. One song session per visit (src/runtime/song-session.ts), disposed on leaving: the mic goes off and
 * an unfinished take is discarded. The singer's choices (phrase, speed, key, loop, guide, metronome, backing level)
 * are remembered per song for this page visit, so calibrating in Setup and coming back loses nothing.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { ListMusic, Mic, SlidersHorizontal, Square } from 'lucide-preact';
import { back, canGoBack, navigate, route } from '../../router';
import { WORLDS } from '../../exercises';
import { isSongUnlocked, songRequirementHint } from '../../progress';
import {
  NO_CALIBRATION_MESSAGE,
  createSongSession,
  nextScorablePhrase,
  type SongSelection,
  type SongSession,
  type SongSpeed,
} from '../../runtime/song-session';
import { engineState } from '../../state/engine-store';
import { snapshot } from '../../state/session';
import { getSong, songIndex, songsLoaded } from '../../state/songs';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Locked } from '../components/Locked';
import type { LyricCursor } from '../song/cursor';
import { formatPercent } from '../song/format';
import { LyricsStrip } from '../song/LyricsStrip';
import { PhraseScrubber } from '../song/PhraseScrubber';
import { SongBar, type SongBarPrimary } from '../song/SongBar';
import { SongCanvas } from '../song/SongCanvas';
import { SongMore } from '../song/SongMore';
import { TakeSheet } from '../song/TakeSheet';
import { Transport } from '../song/Transport';

interface Remembered {
  selection: SongSelection;
  speed: SongSpeed;
  shift: number;
  loop: boolean;
  guide: boolean;
  metronome: boolean;
  backingVolume: number;
}

/** Each song's player choices for this page visit (not stored: a new visit starts from the suggested key). */
const remembered = new Map<string, Remembered>();

function remember(session: SongSession): Remembered {
  return {
    selection: session.selection.value,
    speed: session.speed.value,
    shift: session.shift.value,
    loop: session.loop.value,
    guide: session.guide.value,
    metronome: session.metronome.value,
    backingVolume: session.backingVolume.value,
  };
}

function restore(session: SongSession, r: Remembered | undefined): void {
  if (!r) return;
  session.select(r.selection);
  session.setSpeed(r.speed);
  session.setShift(r.shift);
  session.setLoop(r.loop);
  session.setGuide(r.guide);
  session.setMetronome(r.metronome);
  session.setBackingVolume(r.backingVolume);
}

/** The backing track's state line. Its own component: a stretch reports progress per slice, and only this line redraws. */
function BackingStatus(props: { session: SongSession }): JSX.Element | null {
  const backing = props.session.backing.value;
  const stretching = props.session.stretching.value;
  if (backing.status === 'error') return <Banner kind="warn" message={backing.message} />;
  if (stretching) {
    return (
      <p class="pl-song-status pl-tabular" role="status">
        Preparing the backing at {Math.round(stretching.speed * 100)}% speed: {formatPercent(stretching.progress)}
      </p>
    );
  }
  if (backing.status === 'loading') {
    return (
      <p class="pl-song-status" role="status">
        Loading the backing track…
      </p>
    );
  }
  return null;
}

function Player(props: { session: SongSession }): JSX.Element {
  const { session } = props;
  const cursor = useMemo(() => signal<LyricCursor | null>(null), [session]);
  const [moreOpen, setMoreOpen] = useState(false);
  const phase = session.phase.value;
  const error = session.error.value;
  const result = session.result.value;
  const selection = session.selection.value;
  const calibrated = session.latencyMs.value !== null;
  const busy = phase === 'starting' || phase === 'count-in' || phase === 'singing' || phase === 'scoring';
  const taking = phase === 'count-in' || phase === 'singing';
  const sheetOpen = moreOpen || phase === 'done';

  let primary: SongBarPrimary;
  if (taking) primary = { label: 'Stop', icon: Square, ariaLabel: 'Stop the take', onClick: () => session.stop(), stop: true };
  else if (phase === 'starting') primary = { label: 'Starting…', icon: Mic, ariaLabel: 'Starting the microphone', onClick: () => undefined, busy: true };
  else if (phase === 'scoring') primary = { label: 'Scoring…', icon: Mic, ariaLabel: 'Scoring the take', onClick: () => undefined, busy: true };
  else if (!calibrated) primary = { label: 'Calibrate', icon: SlidersHorizontal, ariaLabel: 'Calibrate latency in Setup', onClick: () => navigate('setup') };
  else {
    primary = {
      label: 'Sing',
      icon: Mic,
      ariaLabel: selection === null ? 'Sing the whole song' : `Sing phrase ${selection + 1}`,
      onClick: () => session.sing(),
    };
  }

  return (
    <div class="pl-screen pl-song-player" data-testid="song-player">
      <AppBar title={session.original.title} engineState={engineState.value} onBack={canGoBack.value ? () => back() : undefined} />
      <div class="pl-song-body">
        <div class="pl-song-body__head pl-safe-x">
          {!calibrated ? (
            <Banner kind="info" message={NO_CALIBRATION_MESSAGE}>
              <Button variant="secondary" icon={SlidersHorizontal} onClick={() => navigate('setup')}>
                Setup &amp; calibration
              </Button>
            </Banner>
          ) : null}
          {error && error.code !== 'no-calibration' ? (
            <Banner kind={error.code === 'stopped-early' || error.code === 'nothing-to-score' ? 'info' : 'error'} message={error.message} />
          ) : null}
          <BackingStatus session={session} />
          <Transport session={session} disabled={busy} />
        </div>
        <div class="pl-song-body__canvas">
          <SongCanvas session={session} cursor={cursor} />
        </div>
        <div class="pl-song-body__lyrics pl-safe-x">
          <LyricsStrip rows={session.phrases} cursor={cursor} selection={selection} />
        </div>
        <div class="pl-song-body__scrubber">
          <PhraseScrubber
            rows={session.phrases}
            selection={selection}
            lastScores={session.lastScores.value}
            cursor={cursor}
            disabled={busy}
            onSelect={(s) => session.select(s)}
          />
        </div>
        <div class="pl-song-body__bar">
          <SongBar
            listening={phase === 'listening'}
            listenDisabled={busy}
            onListen={() => session.listen()}
            primary={primary}
            onMore={() => setMoreOpen(true)}
            shortcuts={!sheetOpen}
          />
        </div>
      </div>

      <TakeSheet
        result={result}
        open={phase === 'done'}
        next={result === null || result.selection === null ? undefined : nextScorablePhrase(session.phrases, result.selection)}
        takePlaying={session.takePlaying.value}
        onClose={() => session.dismissResult()}
        onRetry={() => {
          session.dismissResult();
          session.sing();
        }}
        onNext={(next) => {
          session.dismissResult();
          session.select(next);
        }}
        onPlayTake={() => session.playTake()}
      />
      <SongMore session={session} open={moreOpen} onClose={() => setMoreOpen(false)} onDeleted={() => back()} />
    </div>
  );
}

type Loaded = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; session: SongSession };

export function SongPlayer(): JSX.Element {
  const r = route.value;
  const songId = r.name === 'song' ? r.params.songId : '';
  const entry = songIndex.value.get(songId);
  const snap = snapshot.value;
  const open = entry !== undefined && isSongUnlocked(entry.difficulty.requiredWorld, snap, WORLDS);
  const recordId = entry?.recordId ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let session: SongSession | null = null;
    setLoaded({ status: 'loading' });
    void getSong(songId).then((song) => {
      if (cancelled) return;
      if (!song) {
        setLoaded({ status: 'missing' });
        return;
      }
      session = createSongSession(song, { recordId });
      restore(session, remembered.get(songId));
      setLoaded({ status: 'ready', session });
    });
    return () => {
      cancelled = true;
      if (session) {
        remembered.set(songId, remember(session));
        session.dispose();
      }
    };
  }, [songId, open, recordId]);

  if (open && loaded.status === 'ready') return <Player session={loaded.session} />;

  const appBar = <AppBar title={entry?.title ?? 'Song'} onBack={canGoBack.value ? () => back() : undefined} />;
  let body: JSX.Element;
  if (entry && !open) {
    body = <Locked title={entry.title} hint={songRequirementHint(entry.difficulty.requiredWorld, snap, WORLDS) ?? 'Not available yet.'} />;
  } else if ((!entry && songsLoaded.value) || loaded.status === 'missing') {
    body = (
      <EmptyState icon={ListMusic} title="Song not found" message="It may have been deleted, or it belongs to another singer.">
        <Button variant="secondary" onClick={() => navigate('songs')}>
          Song Stage
        </Button>
      </EmptyState>
    );
  } else {
    body = <div class="pl-song-skeleton pl-song-skeleton--player" aria-busy="true" aria-label="Loading the song" />;
  }
  return (
    <div class="pl-screen">
      {appBar}
      <div class="pl-page">{body}</div>
    </div>
  );
}
