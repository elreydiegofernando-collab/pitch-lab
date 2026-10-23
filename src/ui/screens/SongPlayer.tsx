/**
 * The song player (DESIGN.md §13.9): the piano roll with the song's notes and the live trace, the lyric line with
 * the tally underline walking the syllables, the phrase scrubber (which is also the song's progress strip: each
 * phrase's best and a learned glyph), the transport (play/pause, loop, speed, key), and the thumb-zone bar (Listen,
 * Sing, More). Above the transport, "Learn this song" (ui/song/LearnPanel) walks the learning path (song/practice.ts):
 * the step to do now, set up and started in one tap, and a link to the song's progress. After a take, a sheet with the
 * phrase-by-phrase breakdown and the coaching for the take (coaching/song.ts, the report's CoachCard).
 *
 * The route guard opens this screen only for a song the singer has earned (SPEC §11.2); the screen checks again and
 * fails closed. One song session per visit (src/runtime/song-session.ts), disposed on leaving: the mic goes off and
 * an unfinished take is discarded. The singer's choices (phrase, speed, key, loop, guide, metronome, backing level, and
 * whether the song was listened to) are remembered per song for this page visit, so calibrating in Setup and coming back
 * loses nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { signal } from '@preact/signals';
import { ListMusic, Mic, SlidersHorizontal, Square } from 'lucide-preact';
import { phraseOfMove } from '../../coaching/song';
import type { CoachMove } from '../../coaching/types';
import { back, canGoBack, navigate, route } from '../../router';
import { WORLDS } from '../../exercises';
import { isSongUnlocked, songRequirementHint } from '../../progress';
import {
  NO_CALIBRATION_MESSAGE,
  createSongSession,
  nextScorablePhrase,
  onePhrase,
  sameSelection,
  selectionOfPitched,
  type PhraseRow,
  type SongSelection,
  type SongSession,
  type SongSpeed,
  type SongTakeResult,
} from '../../runtime/song-session';
import { nextStepAfter, songPractice, type PhraseProgress, type PracticeStep, type SongPractice } from '../../song/practice';
import { engineState } from '../../state/engine-store';
import { activeProfile, attemptLog, snapshot } from '../../state/session';
import { getSong, songIndex, songsLoaded } from '../../state/songs';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Locked } from '../components/Locked';
import type { LyricCursor } from '../song/cursor';
import { formatPercent } from '../song/format';
import { LearnPanel } from '../song/LearnPanel';
import { LyricsStrip } from '../song/LyricsStrip';
import { PhraseScrubber } from '../song/PhraseScrubber';
import { SongBar, type SongBarPrimary } from '../song/SongBar';
import { SongCanvas } from '../song/SongCanvas';
import { SongMore } from '../song/SongMore';
import { SongSendSheet } from '../song/SongSendSheet';
import { TakeSheet, selectionTitle, type TakeForward } from '../song/TakeSheet';
import { Transport } from '../song/Transport';

interface Remembered {
  selection: SongSelection;
  speed: SongSpeed;
  shift: number;
  loop: boolean;
  guide: boolean;
  metronome: boolean;
  backingVolume: number;
  /** The song was listened to through (the path's first step, which leaves nothing in the log). */
  heard: boolean;
}

/**
 * Each singer's player choices per song for this page visit (not stored: a new visit starts from the suggested key).
 * Keyed by profile and song: the key, phrase and speed one singer chose never open another singer's player (a profile
 * switch, a deleted profile and Delete all data, which makes a new profile id, all start from that singer's own key).
 */
const remembered = new Map<string, Remembered>();

/** The remembered map's key for the active singer and `songId`. */
export function rememberedKey(songId: string): string {
  return `${activeProfile.peek()?.id ?? ''}:${songId}`;
}

function remember(session: SongSession, heard: boolean): Remembered {
  return {
    selection: session.selection.value,
    speed: session.speed.value,
    shift: session.shift.value,
    loop: session.loop.value,
    guide: session.guide.value,
    metronome: session.metronome.value,
    backingVolume: session.backingVolume.value,
    heard,
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

/** Each phrase's progress by its Song.phrases index (the scrubber's pills). */
function progressByRow(rows: readonly PhraseRow[], practice: SongPractice): Map<number, PhraseProgress> {
  const out = new Map<number, PhraseProgress>();
  for (const row of rows) {
    const p = row.pitchedIndex === null ? undefined : practice.phrases[row.pitchedIndex];
    if (p) out.set(row.index, p);
  }
  return out;
}

/** The step to show: the path's current one, or the one after it once the song was heard on this visit. */
export function shownStep(practice: SongPractice, heard: boolean): { step: PracticeStep | null; index: number } {
  let index = practice.current;
  if (heard && practice.steps[index]?.kind === 'listen') index += 1;
  return { step: practice.steps[index] ?? null, index };
}

/** The forward button's words for the step after a pass: "Full speed", "Next phrase", "Phrases 3 and 4", "Whole song". */
function forwardLabel(step: PracticeStep, taken: SongSelection, target: SongSelection): string {
  if (step.kind === 'whole') return 'Whole song';
  if (step.kind === 'listen') return 'Listen';
  if (sameSelection(taken, target)) return 'Full speed';
  if (step.kind === 'join') return selectionTitle(target);
  if (taken !== null && target !== null && target.from >= taken.to && target.from - taken.to <= 1) return 'Next phrase';
  return selectionTitle(target);
}

/** The phrase (Song.phrases index) a take's coaching points at: its first spot's, else its lowest-scoring phrase. */
function coachedPhrase(result: SongTakeResult): number | null {
  const t = result.coaching?.problem.spots[0]?.t;
  if (t !== undefined) {
    const hit = result.phrases.find((p) => t >= p.score.start - 0.5 && t <= p.score.end + 0.5);
    if (hit) return hit.phraseIndex;
  }
  let lowest = result.phrases[0];
  for (const p of result.phrases) if (p.score.pitchScore < lowest.score.pitchScore) lowest = p;
  return lowest?.phraseIndex ?? null;
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

function Player(props: { session: SongSession; heard: boolean; onHeard(): void }): JSX.Element {
  const { session, heard, onHeard } = props;
  const cursor = useMemo(() => signal<LyricCursor | null>(null), [session]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  /** The result whose sheet was closed: the sheet shows each new result until it is closed (Listen slowly keeps it open). */
  const [closedFor, setClosedFor] = useState<SongTakeResult | null>(null);
  const phase = session.phase.value;
  const error = session.error.value;
  const result = session.result.value;
  const selection = session.selection.value;
  const calibrated = session.latencyMs.value !== null;
  const busy = phase === 'starting' || phase === 'count-in' || phase === 'singing' || phase === 'scoring';
  const taking = phase === 'count-in' || phase === 'singing';
  const rows = session.phrases;

  const log = attemptLog.value;
  const practice = useMemo(() => songPractice(session.original, log), [session.original, log]);
  const progress = useMemo(() => progressByRow(rows, practice), [rows, practice]);
  const { step, index: stepIndex } = shownStep(practice, heard);

  const resultOpen = result !== null && closedFor !== result && !busy;
  const sheetOpen = moreOpen || sendOpen || resultOpen;
  const closeResult = (): void => {
    setClosedFor(result);
    session.dismissResult();
  };

  /** Set a learning-path step up (its phrases, speed and loop); `start` also starts it (straight from the tap). */
  const setUp = (s: PracticeStep, start: boolean): void => {
    const sel = selectionOfPitched(rows, s.phrase);
    if (sel === undefined) return;
    session.select(sel);
    session.setSpeed(s.speed);
    session.setLoop(s.kind === 'phrase' || s.kind === 'phrase-slow');
    if (!start) return;
    if (s.kind === 'listen') {
      onHeard();
      session.listen();
    } else session.sing();
  };

  let primary: SongBarPrimary;
  if (taking) primary = { label: 'Stop', icon: Square, ariaLabel: 'Stop the take', onClick: () => session.stop(), stop: true };
  else if (phase === 'starting') primary = { label: 'Starting…', icon: Mic, ariaLabel: 'Starting the microphone', onClick: () => undefined, busy: true };
  else if (phase === 'scoring') primary = { label: 'Scoring…', icon: Mic, ariaLabel: 'Scoring the take', onClick: () => undefined, busy: true };
  else if (!calibrated) primary = { label: 'Calibrate', icon: SlidersHorizontal, ariaLabel: 'Calibrate latency in Setup', onClick: () => navigate('setup') };
  else {
    primary = {
      label: 'Sing',
      icon: Mic,
      ariaLabel: selection === null ? 'Sing the whole song' : `Sing ${selectionTitle(selection).toLowerCase()}`,
      onClick: () => session.sing(),
    };
  }

  // The sheet's way on: after a pass, the step after it (the coaching card names the same one); after a miss, the next
  // phrase as before; nothing after a whole-song or joined miss.
  let forward: TakeForward | null = null;
  if (result) {
    if (result.passed) {
      const after = nextStepAfter(practice, result.phrase, result.speed);
      const target = after ? selectionOfPitched(rows, after.phrase) : undefined;
      if (after && target !== undefined) {
        const label = forwardLabel(after, result.selection, target);
        forward = {
          label,
          // The visible words first, so the accessible name contains them; then what it sets up.
          ariaLabel: label === after.title ? undefined : `${label} (${after.title})`,
          onClick: () => {
            closeResult();
            setUp(after, false);
          },
        };
      }
    } else if (result.selection !== null && result.selection.to - result.selection.from === 1) {
      const next = nextScorablePhrase(rows, result.selection.from);
      forward = {
        label: next === null ? 'Whole song' : 'Next phrase',
        onClick: () => {
          closeResult();
          session.select(next === null ? null : onePhrase(next));
        },
      };
    }
  }

  const focus = result ? coachedPhrase(result) : null;
  const listen =
    result && focus !== null
      ? { slow: true, playing: phase === 'listening', onClick: () => session.listenTo(onePhrase(focus), result.speed === 1 ? 0.75 : 0.5) }
      : null;
  const onMove = (move: CoachMove): void => {
    const pitched = phraseOfMove(move);
    if (pitched !== null) {
      const row = rows.find((r) => r.pitchedIndex === pitched);
      closeResult();
      if (row) {
        session.select(onePhrase(row.index));
        session.setLoop(true);
      }
    } else if (move.kind === 'practise-level') {
      closeResult();
      navigate('level', { levelId: move.levelId });
    } else if (move.kind === 'send-to-claude') {
      closeResult();
      setSendOpen(true);
    }
  };

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
          {/* A chart with nothing to sing (every line spoken) has no path to learn. */}
          {practice.phrases.length > 0 ? (
            <LearnPanel
              practice={practice}
              step={step}
              index={stepIndex}
              busy={busy}
              canSing={calibrated}
              onStart={(s) => setUp(s, true)}
              onProgress={() => navigate('song-progress', { songId: session.original.id })}
            />
          ) : null}
          <Transport session={session} disabled={busy} />
        </div>
        <div class="pl-song-body__canvas">
          <SongCanvas session={session} cursor={cursor} />
        </div>
        <div class="pl-song-body__lyrics pl-safe-x">
          <LyricsStrip rows={rows} cursor={cursor} selection={selection} />
        </div>
        <div class="pl-song-body__scrubber">
          <PhraseScrubber rows={rows} selection={selection} progress={progress} cursor={cursor} disabled={busy} onSelect={(s) => session.select(s)} />
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
        open={resultOpen}
        forward={forward}
        takePlaying={session.takePlaying.value}
        onClose={closeResult}
        onRetry={() => {
          closeResult();
          session.sing();
        }}
        onPlayTake={() => session.playTake()}
        listen={listen}
        onMove={onMove}
      />
      <SongMore session={session} open={moreOpen} onClose={() => setMoreOpen(false)} onDeleted={() => back()} />
      <SongSendSheet open={sendOpen} onClose={() => setSendOpen(false)} song={session.original} />
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
  // Whether this visit's song was listened to (remembered with the other choices on leaving).
  const heardRef = useRef(false);
  const [heard, setHeard] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let session: SongSession | null = null;
    // Whose choices these are: fixed when the player opens, so leaving after a profile switch files them correctly.
    const key = rememberedKey(songId);
    const before = remembered.get(key);
    heardRef.current = before?.heard ?? false;
    setHeard(heardRef.current);
    setLoaded({ status: 'loading' });
    void getSong(songId).then((song) => {
      if (cancelled) return;
      if (!song) {
        setLoaded({ status: 'missing' });
        return;
      }
      session = createSongSession(song, { recordId });
      restore(session, before);
      setLoaded({ status: 'ready', session });
    });
    return () => {
      cancelled = true;
      if (session) {
        remembered.set(key, remember(session, heardRef.current));
        session.dispose();
      }
    };
  }, [songId, open, recordId]);

  const markHeard = (): void => {
    heardRef.current = true;
    setHeard(true);
  };

  if (open && loaded.status === 'ready') return <Player session={loaded.session} heard={heard} onHeard={markHeard} />;

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
