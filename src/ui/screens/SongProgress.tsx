/**
 * One song's progress (route 'song-progress' { songId }; owner, 2026-10-22: "I'd love to be able to practice on a song
 * and get better at it"), read from the log (song/practice.ts):
 *  - the next step of the learning path, and how many phrases are learned;
 *  - phrase by phrase: its words, best and latest full-speed score, how many takes, and learned (a glyph and the word);
 *  - the whole song's best and latest, and its takes;
 *  - "Then and now": the first take of the song against the best whole-song take, with their scores and their pitch
 *    lines drawn over the song's notes (ui/song/ThenAndNow), the takes' saved pitch lines read from this device;
 *  - "Send to Claude" for the song (ui/song/SongSendSheet: up to eight recent takes, audio only when ticked).
 *
 * The route guard opens it only for a song the singer has earned, like the player; the screen checks again and fails
 * closed. Nothing here is amber: the screen informs, and the player is one tap back.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Check, ListMusic, Mic, Send } from 'lucide-preact';
import { WORLDS } from '../../exercises';
import { isSongUnlocked, songRequirementHint } from '../../progress';
import { back, canGoBack, navigate, previousRoute, route } from '../../router';
import { pitchedPhraseTexts, songPractice, type PhraseProgress, type SongPractice } from '../../song/practice';
import type { Song } from '../../song/types';
import { decodeTrack } from '../../storage';
import type { AttemptRecord } from '../../storage/schema';
import { appStorage, attemptLog, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { getSong, songIndex, songsLoaded } from '../../state/songs';
import { AppBar } from '../components/AppBar';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Locked } from '../components/Locked';
import { count, formatPercent } from '../song/format';
import { SongSendSheet } from '../song/SongSendSheet';
import { ThenAndNow } from '../song/ThenAndNow';
import { songTakeView, type SongTakeView } from '../song/then-now';

/** "Best 82% · last 76% · 5 takes", or how far a phrase has come before a full-speed take. */
export function phraseFacts(p: Pick<PhraseProgress, 'best' | 'last' | 'takes'>): string {
  const takes = count(p.takes, 'take');
  if (p.best === null) return p.takes === 0 ? 'Not sung yet' : `Not sung at full speed yet · ${takes}`;
  return `Best ${formatPercent(p.best)} · last ${formatPercent(p.last ?? p.best)} · ${takes}`;
}

type Loaded = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; song: Song };

/**
 * A take of the song with its saved pitch line, read back for "then and now": `loading` until its recording was looked
 * up, then the view (null when there is no such take, or it cannot be read against the song).
 */
function useTakeView(song: Song, attempt: AttemptRecord | undefined): { view: SongTakeView | null; loading: boolean } {
  const [state, setState] = useState<{ view: SongTakeView | null; loading: boolean }>({ view: null, loading: attempt !== undefined });
  const vibratoStyle = settings.value.vibratoStyle;
  useEffect(() => {
    let live = true;
    if (!attempt) {
      setState({ view: null, loading: false });
      return undefined;
    }
    setState({ view: null, loading: true });
    const storage = appStorage.value;
    const takeId = attempt.takeId;
    const read = takeId && storage ? storage.takes.get(takeId).catch(() => undefined) : Promise.resolve(undefined);
    void read.then((record) => {
      if (!live) return;
      const track = record ? decodeTrack(record.track) : null;
      setState({ view: songTakeView(song, attempt, track, vibratoStyle), loading: false });
    });
    return () => {
      live = false;
    };
  }, [song, attempt, vibratoStyle]);
  return state;
}

function PhraseList(props: { practice: SongPractice }): JSX.Element {
  return (
    <ol class="pl-song-prog__phrases" data-testid="progress-phrases">
      {props.practice.phrases.map((p) => (
        <li key={p.index} class="pl-song-prog__phrase" data-testid="progress-phrase">
          <span class="pl-song-prog__num pl-tabular" aria-hidden="true">
            {p.index + 1}
          </span>
          <span class="pl-song-prog__main">
            <span class="pl-song-prog__words">
              <span class="pl-visually-hidden">Phrase {p.index + 1}: </span>
              {p.text || `Phrase ${p.index + 1}`}
            </span>
            <span class="pl-body-s pl-muted pl-tabular">{phraseFacts(p)}</span>
          </span>
          {p.learned ? (
            <span class="pl-song-prog__learned">
              <Check size={18} strokeWidth={2.5} aria-hidden="true" />
              Learned
            </span>
          ) : (
            <span class="pl-song-prog__notyet">Not yet</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Progress(props: { song: Song }): JSX.Element {
  const { song } = props;
  const log = attemptLog.value;
  const practice = useMemo(() => songPractice(song, log), [song, log]);
  const texts = useMemo(() => pitchedPhraseTexts(song), [song]);
  const byId = (id: string | null): AttemptRecord | undefined => (id === null ? undefined : log.find((a) => a.id === id));
  const first = useMemo(() => byId(practice.firstAttemptId), [log, practice.firstAttemptId]);
  const best = useMemo(() => byId(practice.bestWholeAttemptId), [log, practice.bestWholeAttemptId]);
  const then = useTakeView(song, first);
  const now = useTakeView(song, best);
  const loadingTakes = then.loading || now.loading;
  const [sendOpen, setSendOpen] = useState(false);
  const learned = practice.phrases.filter((p) => p.learned).length;
  const step = practice.steps[practice.current];
  const notation = settings.value.notation;

  // Back to the player when it is the screen beneath; otherwise (a deep link) open it.
  const toPlayer = (): void => {
    const beneath = previousRoute.peek();
    if (beneath && beneath.name === 'song' && beneath.params.songId === song.id) back();
    else navigate('song', { songId: song.id });
  };

  return (
    <main class="pl-page pl-song-prog" data-testid="song-progress">
      <header class="pl-song-prog__head">
        <h2 class="pl-display-l">{song.title}</h2>
        {song.artist ? <p class="pl-body-s pl-muted">{song.artist}</p> : null}
      </header>

      <section class="pl-card pl-song-prog__next" aria-labelledby="prog-next">
        <h3 id="prog-next" class="pl-label">
          {step ? 'Next on your path' : 'Learned'}
        </h3>
        <p class="pl-body" data-testid="progress-next">
          {step ? step.title : 'You have learned the whole song. Sing it through again any time to keep it.'}
        </p>
        <p class="pl-body-s pl-muted pl-tabular" data-testid="progress-learned">
          {learned} of {practice.phrases.length} phrases learned
        </p>
        {/* The player's "Learn this song" sets the step up in one tap; this only takes the singer there. */}
        <Button variant="secondary" icon={Mic} onClick={toPlayer} data-testid="progress-practise">
          {step ? 'Practise in the player' : 'Open the song'}
        </Button>
      </section>

      <section class="pl-stack" aria-labelledby="prog-phrases">
        <h3 id="prog-phrases" class="pl-label">
          Phrase by phrase
        </h3>
        <PhraseList practice={practice} />
      </section>

      <section class="pl-stack" aria-labelledby="prog-whole">
        <h3 id="prog-whole" class="pl-label">
          Whole song
        </h3>
        <p class="pl-body pl-tabular" data-testid="progress-whole">
          {practice.whole.best === null
            ? practice.whole.takes === 0
              ? 'Not sung through yet.'
              : `Not sung through at full speed yet · ${count(practice.whole.takes, 'take')}`
            : phraseFacts(practice.whole)}
        </p>
      </section>

      <section class="pl-stack" aria-labelledby="prog-then">
        <h3 id="prog-then" class="pl-label">
          Then and now
        </h3>
        {loadingTakes ? (
          <div class="pl-song-skeleton pl-song-then__skeleton" aria-busy="true" aria-label="Loading your takes" />
        ) : (
          <ThenAndNow then={then.view} now={now.view} texts={texts} notation={notation} />
        )}
      </section>

      <Button variant="ghost" icon={Send} onClick={() => setSendOpen(true)} data-testid="progress-send">
        Send to Claude
      </Button>
      <SongSendSheet open={sendOpen} onClose={() => setSendOpen(false)} song={song} />
    </main>
  );
}

export function SongProgress(): JSX.Element {
  const r = route.value;
  const songId = r.name === 'song-progress' ? r.params.songId : '';
  const entry = songIndex.value.get(songId);
  const snap = snapshot.value;
  const open = entry !== undefined && isSongUnlocked(entry.difficulty.requiredWorld, snap, WORLDS);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoaded({ status: 'loading' });
    void getSong(songId).then((song) => {
      if (!cancelled) setLoaded(song ? { status: 'ready', song } : { status: 'missing' });
    });
    return () => {
      cancelled = true;
    };
  }, [songId, open]);

  let body: JSX.Element;
  if (open && loaded.status === 'ready') {
    body = <Progress song={loaded.song} />;
  } else if (entry && !open) {
    body = (
      <main class="pl-page">
        <Locked title={entry.title} hint={songRequirementHint(entry.difficulty.requiredWorld, snap, WORLDS) ?? 'Not available yet.'} />
      </main>
    );
  } else if ((!entry && songsLoaded.value) || loaded.status === 'missing') {
    body = (
      <main class="pl-page">
        <EmptyState icon={ListMusic} title="Song not found" message="It may have been deleted, or it belongs to another singer.">
          <Button variant="secondary" onClick={() => navigate('songs')}>
            Song Stage
          </Button>
        </EmptyState>
      </main>
    );
  } else {
    body = (
      <main class="pl-page">
        <div class="pl-song-skeleton pl-song-skeleton--player" aria-busy="true" aria-label="Loading the song" />
      </main>
    );
  }
  return (
    <div class="pl-screen">
      <AppBar title="Song progress" onBack={canGoBack.value ? () => back() : undefined} />
      <div class="pl-scroll">{body}</div>
    </div>
  );
}
