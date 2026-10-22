/**
 * The song player's More sheet (DESIGN.md §13.9): the melody guide during takes, the metronome, the backing track's
 * level and offset (imports), Setup & calibration, Reset audio, and deleting an imported song. A delete reports the
 * real result: a file that will not go keeps the song, and the sheet says so (DESIGN.md §13.0).
 */
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-preact';
import { navigate } from '../../router';
import { OFFSET_RANGE_MS, metronomeBpm, type SongSession } from '../../runtime/song-session';
import { resetAudio } from '../../state/audio';
import { appStorage } from '../../state/session';
import { loadSongs } from '../../state/songs';
import { showToast } from '../../state/toast';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { ListRow } from '../components/ListRow';
import { Sheet } from '../components/Sheet';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { formatPercent } from './format';

export interface SongMoreProps {
  session: SongSession;
  open: boolean;
  onClose(): void;
  /** The song was deleted (leave the player). */
  onDeleted(): void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function BackingControls(props: { session: SongSession }): JSX.Element {
  const { session } = props;
  const backing = session.backing.value;
  const stretching = session.stretching.value;
  const imported = session.recordId !== null;
  if (backing.status === 'none') {
    return (
      <p class="pl-body-s pl-muted">
        {imported ? 'No backing track. Import the song again with an MP3 or WAV to add one.' : 'Bundled songs have no backing track: the melody guide is the reference.'}
      </p>
    );
  }
  if (backing.status === 'loading') return <p class="pl-body-s pl-muted">Loading the backing track…</p>;
  if (backing.status === 'error') return <Banner kind="warn" message={backing.message} />;
  const offset = session.offsetMs.value;
  const base = session.original.offsetMs;
  return (
    <div class="pl-stack">
      <div class="pl-row-flex">
        <label class="pl-label" for="backing-volume">
          Backing volume
        </label>
        <output class="pl-data pl-tabular" for="backing-volume">
          {formatPercent(session.backingVolume.value)}
        </output>
      </div>
      <Slider value={session.backingVolume.value} onChange={(v) => session.setBackingVolume(v)} aria-label="Backing volume" />
      {!session.headphones.value ? <p class="pl-body-s pl-muted">On the speaker the mic hears the backing too: keep it low, or sing in headphones.</p> : null}
      {imported ? (
        <>
          <div class="pl-row-flex">
            <label class="pl-label" for="backing-offset">
              Offset
            </label>
            <output class="pl-data pl-tabular" for="backing-offset">
              {offset} ms
            </output>
          </div>
          <Slider
            value={offset}
            min={base - OFFSET_RANGE_MS}
            max={base + OFFSET_RANGE_MS}
            step={10}
            onChange={(v) => session.setOffsetMs(v)}
            aria-label="Backing offset in milliseconds"
          />
          <p class="pl-body-s pl-muted">Raise it if the backing sounds late against the melody, lower it if early. It is saved with the song.</p>
        </>
      ) : null}
      {stretching ? (
        <p class="pl-body-s pl-muted pl-tabular" role="status">
          Preparing the backing at {Math.round(stretching.speed * 100)}% speed: {formatPercent(stretching.progress)}
        </p>
      ) : null}
    </div>
  );
}

export function SongMore(props: SongMoreProps): JSX.Element | null {
  const { session, open, onClose, onDeleted } = props;
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const notice = session.notice.value;

  function onReset(): void {
    // Straight from the tap: resetAudio() rebuilds the AudioContext inside the gesture.
    const pending = resetAudio();
    setResetting(true);
    pending.catch(() => undefined).finally(() => setResetting(false));
  }

  function onDelete(): void {
    const recordId = session.recordId;
    const storage = appStorage.value;
    if (recordId === null || !storage || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    storage.songs
      .delete(recordId)
      .then(async () => {
        await loadSongs();
        showToast(`Deleted “${session.original.title}”.`, { durationMs: 4000 });
        onDeleted();
      })
      .catch((err: unknown) => {
        setDeleteError(`The song could not be deleted (${messageOf(err)}). It is still here; try again.`);
        setDeleting(false);
      });
  }

  return (
    <Sheet open={open} title="More" onClose={onClose}>
      <div class="pl-list">
        <ListRow
          title="Melody guide while singing"
          subtitle={
            session.headphones.value
              ? 'Listen and Play always play it.'
              : 'In headphones only: on the speaker the mic would hear it and score it as you. Listen and Play always play it.'
          }
          trailing={<Toggle checked={session.guide.value} onChange={(on) => session.setGuide(on)} aria-label="Melody guide while singing" />}
        />
        <ListRow
          title="Metronome"
          subtitle={`Clicks on the chart's beat, ${Math.round(metronomeBpm(session.original))} bpm at full speed.`}
          trailing={<Toggle checked={session.metronome.value} onChange={(on) => session.setMetronome(on)} aria-label="Metronome" />}
        />
      </div>

      <section class="pl-stack" aria-labelledby="song-backing">
        <h3 id="song-backing" class="pl-label">
          Backing track
        </h3>
        <BackingControls session={session} />
        {notice ? <Banner kind="warn" message={notice} /> : null}
      </section>

      <Button
        variant="secondary"
        icon={SlidersHorizontal}
        onClick={() => {
          onClose();
          navigate('setup');
        }}
      >
        Setup &amp; calibration
      </Button>
      <Button variant="ghost" icon={RotateCcw} loading={resetting} onClick={onReset}>
        Reset audio
      </Button>

      {session.recordId !== null ? (
        confirming ? (
          <div class="pl-song-delete" role="group" aria-label="Delete this song">
            <p class="pl-body-s">Delete “{session.original.title}” and its backing track from this device? This can't be undone.</p>
            {deleteError ? <Banner kind="error" message={deleteError} /> : null}
            <div class="pl-row-flex">
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
                Keep it
              </Button>
              <Button variant="danger" icon={Trash2} loading={deleting} onClick={onDelete}>
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
            Delete this song
          </Button>
        )
      ) : null}
    </Sheet>
  );
}
