/**
 * Import a song (DESIGN.md §13.8): one screen in steps, laid out like the setlist. 01 choose an UltraStar .txt or a
 * MIDI file; 02 (MIDI only) pick the melody track, the best one preselected; then an optional MP3/WAV backing track
 * with its offset; then the rating, and Save. Parsing, previews and storage all happen on this device: "Your files
 * stay on this device." Importing is earned (SPEC §11.2: the Foundations Boss Recital) and the route guard holds
 * the door; the screen checks again and fails closed.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import { FileMusic, Music, Play, Square, Trash2 } from 'lucide-preact';
import { back, canGoBack } from '../../router';
import { requirementHint } from '../../progress';
import { activeProfile, appStorage, isUnlocked, snapshot } from '../../state/session';
import { settings } from '../../state/settings';
import { loadSongs } from '../../state/songs';
import { showToast } from '../../state/toast';
import { importMidi } from '../../song/midi';
import { songDurationSec } from '../../song/timing';
import { OFFSET_RANGE_MS } from '../../runtime/song-session';
import { AppBar } from '../components/AppBar';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Locked } from '../components/Locked';
import { Slider } from '../components/Slider';
import { Toggle } from '../components/Toggle';
import { count, factLine, formatClock, setlistNumber } from '../song/format';
import {
  MAX_BACKING_BYTES,
  baseName,
  chooseMidiTrack,
  pickedSong,
  pickedWarnings,
  readSongFile,
  songToSave,
  type PickedSong,
} from '../song/import-file';
import { previewBacking, previewMelody, type PreviewHandle } from '../song/preview';
import { RatingCard } from '../song/RatingCard';
import { TrackPicker } from '../song/TrackPicker';

const TRACK_PREVIEW_SEC = 6;
const BACKING_PREVIEW_SEC = 8;
const CHART_ACCEPT = '.txt,.mid,.midi,.kar,text/plain,audio/midi,audio/x-midi';
const AUDIO_ACCEPT = '.mp3,.wav,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave';

type Preview = { kind: 'track'; index: number } | { kind: 'backing' };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "+40 ms", "0 ms", "−120 ms" */
function formatOffset(ms: number): string {
  return ms === 0 ? '0 ms' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`;
}

/** Decodes a backing file without a gesture (an offline context), so a bad file is caught at once. */
async function decodeBacking(file: File): Promise<AudioBuffer> {
  if (file.size === 0) throw new Error('That audio file is empty.');
  if (file.size > MAX_BACKING_BYTES) throw new Error('That audio file is too big. Use an MP3, or a shorter WAV.');
  try {
    return await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("That audio file can't be read. Use an MP3 or WAV file.");
  }
}

function Step(props: { n: number; title: string; optional?: boolean; children: ComponentChildren }): JSX.Element {
  return (
    <li class="pl-song-step">
      <span class="pl-song-step__num pl-tabular" aria-hidden="true">
        {setlistNumber(props.n)}
      </span>
      <div class="pl-song-step__body">
        <h2 class="pl-song-step__title">
          {props.title}
          {props.optional ? <span class="pl-label"> Optional</span> : null}
        </h2>
        {props.children}
      </div>
    </li>
  );
}

export function SongImport(): JSX.Element {
  const importOpen = isUnlocked('song.import');
  const notation = settings.value.notation;
  const [picked, setPicked] = useState<PickedSong | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [backing, setBacking] = useState<{ file: File; buffer: AudioBuffer } | null>(null);
  const [backingError, setBackingError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [offsetAdjust, setOffsetAdjust] = useState(0);
  const [withClick, setWithClick] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const chartInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const previewHandle = useRef<PreviewHandle | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPreview(): void {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    previewHandle.current?.stop();
    previewHandle.current = null;
    setPreview(null);
  }

  useEffect(() => () => stopPreview(), []);

  /** Start a preview (straight from the click: it may create the AudioContext) and clear it when it ends. */
  function runPreview(which: Preview, start: () => PreviewHandle | null): void {
    stopPreview();
    let handle: PreviewHandle | null;
    try {
      handle = start();
    } catch (err) {
      setPickError(`The preview could not play: ${messageOf(err)}`);
      return;
    }
    if (!handle) return;
    previewHandle.current = handle;
    setPreview(which);
    previewTimer.current = setTimeout(stopPreview, (which.kind === 'track' ? TRACK_PREVIEW_SEC : BACKING_PREVIEW_SEC) * 1000 + 300);
  }

  function onChart(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again after a fix
    if (!file) return;
    stopPreview();
    setReading(true);
    setPickError(null);
    setSaveError(null);
    readSongFile(file)
      .then((p) => {
        const song = pickedSong(p);
        setPicked(p);
        setTitle(song.title || baseName(p.fileName));
        setArtist(song.artist);
        setOffsetAdjust(0);
      })
      .catch((err: unknown) => setPickError(messageOf(err)))
      .finally(() => setReading(false));
  }

  function onTrack(index: number): void {
    if (picked?.kind !== 'midi') return;
    stopPreview();
    try {
      setPicked(chooseMidiTrack(picked, index));
      setPickError(null);
    } catch (err) {
      setPickError(messageOf(err));
    }
  }

  function onPreviewTrack(index: number): void {
    if (picked?.kind !== 'midi') return;
    if (preview?.kind === 'track' && preview.index === index) {
      stopPreview();
      return;
    }
    runPreview({ kind: 'track', index }, () => {
      const notes = index === picked.result.selectedTrackIndex ? picked.result.song.notes : importMidi(picked.bytes, { trackIndex: index }).song.notes;
      return previewMelody(notes, TRACK_PREVIEW_SEC);
    });
  }

  function onAudio(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    stopPreview();
    setDecoding(true);
    setBackingError(null);
    decodeBacking(file)
      .then((buffer) => setBacking({ file, buffer }))
      .catch((err: unknown) => setBackingError(messageOf(err)))
      .finally(() => setDecoding(false));
  }

  function onPreviewBacking(): void {
    if (!picked || !backing) return;
    if (preview?.kind === 'backing') {
      stopPreview();
      return;
    }
    const song = songToSave(pickedSong(picked), { title, artist, offsetAdjustMs: offsetAdjust }, picked.fileName);
    runPreview({ kind: 'backing' }, () => previewBacking(song, backing.buffer, BACKING_PREVIEW_SEC, withClick));
  }

  function onSave(): void {
    if (!picked || saving) return;
    const profile = activeProfile.value;
    const storage = appStorage.value;
    if (!profile || !storage) {
      setSaveError('Your data is still loading. Try Save again in a moment.');
      return;
    }
    stopPreview();
    setSaving(true);
    setSaveError(null);
    const song = songToSave(pickedSong(picked), { title, artist, offsetAdjustMs: offsetAdjust }, picked.fileName);
    storage.songs
      .import(profile.id, song, backing?.file ?? null)
      .then(async () => {
        await loadSongs();
        showToast(`“${song.title}” is in your Song Stage.`, { durationMs: 4000 });
        back();
      })
      .catch((err: unknown) => {
        setSaveError(`The song could not be saved (${messageOf(err)}). Nothing was changed.`);
        setSaving(false);
      });
  }

  const appBar = <AppBar title="Import a song" onBack={canGoBack.value ? () => back() : undefined} />;
  if (!importOpen) {
    return (
      <div class="pl-screen">
        {appBar}
        <div class="pl-page">
          <Locked title="Import your own songs" hint={requirementHint('song.import')} />
        </div>
      </div>
    );
  }

  const song = picked ? pickedSong(picked) : null;
  const warnings = picked ? pickedWarnings(picked) : [];
  let step = 1;

  return (
    <div class="pl-screen" data-testid="song-import-screen">
      {appBar}
      <div class="pl-scroll">
        <div class="pl-page">
          <ol class={picked ? 'pl-song-steps' : 'pl-song-steps pl-song-steps--single'}>
            <Step n={step++} title="Choose a file">
              <p class="pl-body-s pl-muted">An UltraStar chart (.txt) or a MIDI file (.mid).</p>
              <input ref={chartInput} type="file" accept={CHART_ACCEPT} class="pl-visually-hidden" tabIndex={-1} aria-hidden="true" onChange={onChart} data-testid="song-file-input" />
              <Button variant={picked ? 'secondary' : 'primary'} icon={FileMusic} loading={reading} onClick={() => chartInput.current?.click()}>
                {picked ? 'Choose another file' : 'Choose a file'}
              </Button>
              {pickError ? <Banner kind="error" message={pickError} /> : null}
              <p class="pl-body-s pl-muted">Your files stay on this device.</p>
              {picked && song ? (
                <div class="pl-song-file">
                  <span class="pl-song-file__name">{picked.fileName}</span>
                  <span class="pl-body-s pl-muted pl-tabular">
                    {factLine([picked.kind === 'midi' ? 'MIDI' : 'UltraStar', count(song.notes.length, 'note'), count(song.phrases.length, 'phrase'), formatClock(songDurationSec(song))])}
                  </span>
                </div>
              ) : null}
              {warnings.length > 0 ? (
                <ul class="pl-song-warnings">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </Step>

            {picked?.kind === 'midi' ? (
              <Step n={step++} title="Melody track">
                <p class="pl-body-s pl-muted">Pick the track the singer sings. Listen to a few seconds of each if you're not sure.</p>
                <TrackPicker
                  candidates={picked.result.candidates}
                  selected={picked.result.selectedTrackIndex}
                  best={picked.result.candidates[0]?.index ?? picked.result.selectedTrackIndex}
                  notation={notation}
                  previewing={preview?.kind === 'track' ? preview.index : null}
                  onSelect={onTrack}
                  onPreview={onPreviewTrack}
                />
              </Step>
            ) : null}

            {picked && song ? (
              <Step n={step++} title="Backing track" optional>
                <input ref={audioInput} type="file" accept={AUDIO_ACCEPT} class="pl-visually-hidden" tabIndex={-1} aria-hidden="true" onChange={onAudio} />
                {picked.kind === 'ultrastar' && picked.audioFile ? (
                  <p class="pl-body-s pl-muted">This chart was made for “{picked.audioFile}”. Add that file to sing along with it.</p>
                ) : null}
                {backing ? (
                  <div class="pl-song-file">
                    <span class="pl-song-file__name">{backing.file.name}</span>
                    <span class="pl-body-s pl-muted pl-tabular">{formatClock(backing.buffer.duration)}</span>
                    <Button
                      variant="ghost"
                      icon={Trash2}
                      onClick={() => {
                        stopPreview();
                        setBacking(null);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" icon={Music} loading={decoding} onClick={() => audioInput.current?.click()}>
                    Add an MP3 or WAV
                  </Button>
                )}
                {backingError ? <Banner kind="error" message={backingError} /> : null}
                {backing ? (
                  <div class="pl-song-offset">
                    <div class="pl-row-flex">
                      <label class="pl-label" for="song-offset">
                        Offset
                      </label>
                      <output class="pl-data pl-tabular pl-song-offset__value" for="song-offset">
                        {formatOffset(offsetAdjust)}
                      </output>
                    </div>
                    <Slider value={offsetAdjust} min={-OFFSET_RANGE_MS} max={OFFSET_RANGE_MS} step={10} onChange={setOffsetAdjust} aria-label="Backing offset in milliseconds" />
                    <p class="pl-body-s pl-muted">Raise it if the backing sounds late against the melody, lower it if early.</p>
                    <div class="pl-row-flex">
                      <span class="pl-body-s">Play with click</span>
                      <Toggle checked={withClick} onChange={setWithClick} aria-label="Play with click" />
                    </div>
                    <Button variant="secondary" icon={preview?.kind === 'backing' ? Square : Play} onClick={onPreviewBacking}>
                      {preview?.kind === 'backing' ? 'Stop' : `Preview ${BACKING_PREVIEW_SEC} s`}
                    </Button>
                  </div>
                ) : null}
              </Step>
            ) : null}

            {picked && song ? (
              <Step n={step++} title="Rating">
                <RatingCard song={song} snapshot={snapshot.value} />
                <div class="pl-song-field">
                  <label class="pl-label" for="song-title">
                    Title
                  </label>
                  <input id="song-title" class="pl-song-input" type="text" value={title} maxLength={120} onInput={(e) => setTitle(e.currentTarget.value)} />
                </div>
                <div class="pl-song-field">
                  <label class="pl-label" for="song-artist">
                    Artist
                  </label>
                  <input id="song-artist" class="pl-song-input" type="text" value={artist} maxLength={120} onInput={(e) => setArtist(e.currentTarget.value)} />
                </div>
              </Step>
            ) : null}
          </ol>
          <p class="pl-body-s pl-muted pl-prose">Import songs you own. They stay on this device and are never uploaded or shared.</p>
        </div>
      </div>
      {picked ? (
        <div class="pl-song-footer">
          {saveError ? <Banner kind="error" message={saveError} /> : null}
          <Button variant="primary" block loading={saving} onClick={onSave} data-testid="song-save">
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
