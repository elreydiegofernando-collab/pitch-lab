/**
 * "Send to Claude" for a song (owner, 2026-10-22: "I'd love to be able to practice on a song and get better at it"): a
 * sheet that saves the song's coaching file through the share sheet (coaching/song-export.ts): its last takes with the
 * phrases each covered, its key, speed, pitch line and score. Like the exercise sheet (ui/practice/SendToClaudeSheet),
 * the file is built when the sheet opens and again when Include audio changes (off every time it opens), so the Share
 * tap hands it over straight away: iOS opens the share sheet only from a fresh tap, so the save is called synchronously
 * in it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Share } from 'lucide-preact';
import { buildSongCoachingFile, songCoachingBlob, songCoachingFileName } from '../../coaching/song-export';
import type { SongCoachingFile } from '../../coaching/types';
import type { Song } from '../../song/types';
import { Banner, type BannerKind } from '../components/Banner';
import { Button } from '../components/Button';
import { Sheet } from '../components/Sheet';
import { Toggle } from '../components/Toggle';
import { errorText } from '../progress/format';
import { saveFile, type SaveOptions, type SaveOutcome } from '../progress/save-file';
import { useMounted } from '../progress/use-mounted';

/** What the sheet says, word for word. */
export const SEND_SONG_TEXT =
  'This saves a file with your last takes of this song: which phrases each one covered, its key and speed, the pitch line and the score, so Claude can look at what is happening. No audio unless you tick Include audio. Save it to OneDrive (or Files), then tell Claude in chat which song it is.';

export interface SongSendSheetProps {
  open: boolean;
  onClose: () => void;
  song: Song;
  /** Builds the file (default: the active profile's takes, coaching/song-export.ts). */
  build?: (song: Song, opts: { includeAudio: boolean }) => Promise<SongCoachingFile>;
  /** Hands the file over (default: the share sheet on an iPhone, else a download; ui/progress/save-file.ts). */
  save?: (blob: Blob, fileName: string, opts: SaveOptions) => Promise<SaveOutcome>;
}

interface Ready {
  blob: Blob;
  fileName: string;
  takes: number;
}

const defaultSave = (blob: Blob, fileName: string, opts: SaveOptions): Promise<SaveOutcome> => saveFile(blob, fileName, undefined, opts);

export function SongSendSheet(props: SongSendSheetProps): JSX.Element {
  const { open, onClose, song, build = buildSongCoachingFile, save = defaultSave } = props;
  const [includeAudio, setIncludeAudio] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);
  const [building, setBuilding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: BannerKind; text: string } | null>(null);
  const token = useRef(0);
  const mounted = useMounted();

  // Build the file when the sheet opens and whenever Include audio changes; an answer that arrives late is dropped.
  // Closing forgets the file and turns Include audio back off, so every opening starts without audio.
  useEffect(() => {
    const mine = ++token.current;
    setReady(null);
    setProblem(null);
    setNotice(null);
    if (!open) {
      setBuilding(false);
      setIncludeAudio(false);
      return;
    }
    setBuilding(true);
    build(song, { includeAudio }).then(
      (file) => {
        if (!mounted.current || mine !== token.current) return;
        setReady({ blob: songCoachingBlob(file), fileName: songCoachingFileName(file), takes: file.takes.length });
        setBuilding(false);
      },
      (err: unknown) => {
        if (!mounted.current || mine !== token.current) return;
        setProblem(`The file could not be made. ${errorText(err)}`);
        setBuilding(false);
      },
    );
  }, [open, includeAudio, song, build]);

  function share(): void {
    if (!ready || ready.takes === 0) return;
    const file = ready;
    setNotice(null);
    // Straight from the tap: saveFile reaches the share sheet before its first await (iOS needs the gesture).
    save(file.blob, file.fileName, { fromTap: true }).then(
      (outcome) => {
        if (!mounted.current) return;
        if (outcome === 'shared') setNotice({ kind: 'info', text: `Shared ${file.fileName}. Now tell Claude in chat which song it is.` });
        else if (outcome === 'downloaded') {
          setNotice({ kind: 'info', text: `Started the download of ${file.fileName}. Look in your Downloads, then tell Claude in chat which song it is.` });
        } else if (outcome === 'needs-tap') setNotice({ kind: 'info', text: 'Tap Share once more to open the share sheet.' });
      },
      (err: unknown) => {
        if (mounted.current) setNotice({ kind: 'error', text: `Could not hand over ${file.fileName}. ${errorText(err)}` });
      },
    );
  }

  const empty = ready !== null && ready.takes === 0;
  const status = building
    ? 'Getting your takes ready…'
    : empty
      ? 'There are no takes of this song yet. Sing a phrase of it once, then come back here.'
      : ready
        ? `${ready.takes} ${ready.takes === 1 ? 'take' : 'takes'} ready${includeAudio ? ', with audio' : ''}.`
        : '';

  return (
    <Sheet open={open} title="Send to Claude" onClose={onClose} class="pl-send">
      <p class="pl-body pl-prose" data-testid="send-text">
        {SEND_SONG_TEXT}
      </p>
      <div class="pl-row-flex pl-send__audio">
        <span class="pl-stack pl-send__audio-label">
          <span class="pl-data">Include audio</span>
          <span class="pl-body-s pl-muted">Adds the sound of each take. The file gets much bigger.</span>
        </span>
        <Toggle checked={includeAudio} onChange={setIncludeAudio} aria-label="Include audio" />
      </div>
      <p class="pl-body-s pl-muted" role="status" data-testid="send-status">
        {status}
      </p>
      {problem ? <Banner kind="error" message={problem} /> : null}
      <Button variant="secondary" icon={Share} block loading={building} disabled={!ready || empty} onClick={share} data-testid="send-share">
        Share
      </Button>
      {notice ? <Banner kind={notice.kind} message={notice.text} /> : null}
    </Sheet>
  );
}
