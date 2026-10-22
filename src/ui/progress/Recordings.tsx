/**
 * Recordings (Data screen, DESIGN.md §13.13): the active profile's saved takes, newest first. Play a take here,
 * export its WAV (the only way audio leaves this device), or delete it. A delete that fails says so and keeps the
 * take; nothing is ever reported deleted that is still on the device.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Download, Mic, Play, Square, Trash2, Volume2, VolumeX } from 'lucide-preact';
import { getEngine } from '../../audio/engine';
import { settings } from '../../state/settings';
import { songIndex } from '../../state/songs';
import type { AppStorage } from '../../storage';
import type { TakeRecord } from '../../storage/schema';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Locked } from '../components/Locked';
import { errorText, formatClock, formatDateTime, plural } from './format';
import { HandoffView, useHandoff } from './handoff';
import { playWav, type Playback } from './playback';
import { takeFileName, takeSeconds, takeTitle } from './take-info';
import { useMounted } from './use-mounted';

interface RecordingsProps {
  storage: AppStorage | null;
  profileId: string | null;
  /** Called after a take is deleted, so the storage figures refresh. */
  onChanged: () => void;
  /** The registry's requirement line while Backup and export is locked (it is open from the start), else null. */
  exportHint: string | null;
}

export function Recordings(props: RecordingsProps): JSX.Element {
  const { storage, profileId, onChanged, exportHint } = props;
  const mounted = useMounted();
  const [takes, setTakes] = useState<TakeRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The take an action is running on: every row's buttons are off until it settles. */
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const handoff = useHandoff();
  const playback = useRef<Playback | null>(null);

  const setRowError = useCallback((id: string, message: string | null) => {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }, []);

  // Load (and reload on a profile switch). `live` drops an answer that arrives after the screen moved on.
  useEffect(() => {
    playback.current?.stop();
    setPlaying(null);
    setConfirming(null);
    setRowErrors({});
    handoff.reset();
    if (!storage || !profileId) {
      setTakes(null);
      return undefined;
    }
    let live = true;
    setTakes(null);
    setLoadError(null);
    storage.takes
      .listByProfile(profileId)
      .then((rows) => {
        if (live) setTakes([...rows].reverse());
      })
      .catch((err: unknown) => {
        if (live) setLoadError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [storage, profileId]);

  // Leaving the screen stops the sound.
  useEffect(
    () => () => {
      playback.current?.stop();
    },
    [],
  );

  function handlePlay(take: TakeRecord): void {
    if (!storage || pending !== null) return;
    if (playing === take.id) {
      playback.current?.stop();
      return;
    }
    playback.current?.stop();
    // Inside the tap, before any await: this is what lets iOS play audio that is read back from storage afterwards.
    let ctx: AudioContext;
    try {
      ctx = getEngine().ensureContext();
    } catch (err) {
      setRowError(take.id, `This browser cannot play audio here. ${errorText(err)}`);
      return;
    }
    setRowError(take.id, null);
    handoff.reset();
    setPending(take.id);
    void (async () => {
      try {
        const wav = await storage.takes.audio(take);
        if (!wav) throw new Error('The audio for this take is no longer saved.');
        const started = await playWav(ctx, wav, () => {
          if (mounted.current) setPlaying((id) => (id === take.id ? null : id));
        });
        playback.current = started;
        if (mounted.current) setPlaying(take.id);
        else started.stop();
      } catch (err) {
        if (mounted.current) setRowError(take.id, `Could not play this take. ${errorText(err)}`);
      } finally {
        if (mounted.current) setPending(null);
      }
    })();
  }

  async function handleExport(take: TakeRecord): Promise<void> {
    if (!storage || pending !== null) return;
    setRowError(take.id, null);
    handoff.reset();
    setPending(take.id);
    try {
      const audio = await storage.takes.audio(take);
      if (!audio) throw new Error('The audio for this take is no longer saved.');
      await handoff.offer(audio.type === 'audio/wav' ? audio : audio.slice(0, audio.size, 'audio/wav'), takeFileName(take));
    } catch (err) {
      if (mounted.current) setRowError(take.id, `Could not export this take. ${errorText(err)}`);
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function handleDelete(take: TakeRecord): Promise<void> {
    if (!storage || pending !== null) return;
    setRowError(take.id, null);
    handoff.reset();
    setPending(take.id);
    try {
      if (playing === take.id) playback.current?.stop();
      await storage.takes.delete(take.id);
      if (mounted.current) {
        setTakes((prev) => (prev ? prev.filter((t) => t.id !== take.id) : prev));
        setConfirming(null);
      }
      onChanged();
    } catch (err) {
      // Rejected: the record stays, and so does the take. Say so.
      if (mounted.current) setRowError(take.id, `This recording was not deleted. ${errorText(err)} It is still saved. Try again.`);
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  const retention = storage?.takes.retention.maxTakesPerProfile;
  const songTitleOf = (songId: string): string | undefined => songIndex.value.get(songId)?.title;

  return (
    <section class="pl-card pl-data-card" aria-labelledby="data-recordings">
      <h2 class="pl-label" id="data-recordings">
        Recordings
      </h2>
      <p class="pl-body-s pl-muted pl-prose">
        Exporting is the only way audio leaves this device.
        {retention !== undefined && Number.isFinite(retention) ? ` Pitch Lab keeps your newest ${retention} takes and removes older ones.` : ''}
      </p>
      {exportHint !== null ? <Locked compact title="Export WAV" hint={exportHint} /> : null}
      <HandoffView handoff={handoff} noun="WAV" />
      {loadError ? (
        <Banner kind="error" message={`Could not read your recordings. ${loadError}`} />
      ) : takes === null ? (
        <div class="pl-data-skeleton pl-data-skeleton--list" aria-hidden="true" data-testid="recordings-loading" />
      ) : takes.length === 0 ? (
        <EmptyState
          icon={Mic}
          title="No recordings yet"
          message={
            settings.value.keepTakeAudio
              ? 'Takes you sing are saved here, with their sound, so you can hear them again.'
              : 'Takes you sing are saved here. Turn on Keep take audio in Settings to hear them again.'
          }
        />
      ) : (
        <ul class="pl-data-takes" aria-label={plural(takes.length, 'recording')}>
          {takes.map((take) => {
            const hasAudio = take.audioRef !== null;
            const busyHere = pending === take.id;
            const error = rowErrors[take.id];
            return (
              <li key={take.id} class="pl-data-take" data-testid="recording-row">
                <div class="pl-data-take__head">
                  <span class="pl-data-take__title">{takeTitle(take.exerciseId, songTitleOf)}</span>
                  <span class="pl-data-take__len pl-tabular">{formatClock(takeSeconds(take.track))}</span>
                </div>
                <div class="pl-data-take__meta">
                  <span class="pl-body-s pl-muted">{formatDateTime(take.createdAt)}</span>
                  {hasAudio ? (
                    <span class="pl-data-chip">
                      <Volume2 size={14} strokeWidth={2} aria-hidden="true" />
                      Audio
                    </span>
                  ) : (
                    <span class="pl-data-chip pl-data-chip--off">
                      <VolumeX size={14} strokeWidth={2} aria-hidden="true" />
                      Pitch trace only
                    </span>
                  )}
                </div>
                {confirming === take.id ? (
                  <div class="pl-data-take__actions">
                    <Button variant="danger" class="pl-danger-solid" icon={Trash2} loading={busyHere} disabled={pending !== null} onClick={() => void handleDelete(take)}>
                      Delete this recording
                    </Button>
                    <Button variant="ghost" disabled={pending !== null} onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <div class="pl-data-take__actions">
                    <Button
                      variant="secondary"
                      icon={playing === take.id ? Square : Play}
                      loading={busyHere}
                      disabled={!hasAudio || (pending !== null && !busyHere)}
                      aria-label={`${playing === take.id ? 'Stop' : 'Play'} ${takeTitle(take.exerciseId, songTitleOf)}`}
                      onClick={() => handlePlay(take)}
                    >
                      {playing === take.id ? 'Stop' : 'Play'}
                    </Button>
                    {exportHint === null ? (
                      <Button
                        variant="secondary"
                        icon={Download}
                        disabled={!hasAudio || pending !== null}
                        aria-label={`Export WAV of ${takeTitle(take.exerciseId, songTitleOf)}`}
                        onClick={() => void handleExport(take)}
                      >
                        Export WAV
                      </Button>
                    ) : null}
                    <Button
                      variant="danger"
                      icon={Trash2}
                      class="pl-data-take__trash"
                      disabled={pending !== null}
                      aria-label={`Delete ${takeTitle(take.exerciseId, songTitleOf)}`}
                      onClick={() => setConfirming(take.id)}
                    />
                  </div>
                )}
                {error ? <Banner kind="error" message={error} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
