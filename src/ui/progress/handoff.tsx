/**
 * Handing an exported file (a backup, a take's WAV) to the singer, and telling them truthfully what happened.
 * `offer` shares or downloads it (save-file.ts); when the share sheet wants a fresh tap (an iPhone, after the file
 * was read back from storage) the file is parked behind a Share button, whose handler hands it over straight from
 * the tap. A download cannot be confirmed from inside the page, so its notice says it was started, not saved.
 */
import { useCallback, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Download, Share } from 'lucide-preact';
import { Banner, type BannerKind } from '../components/Banner';
import { Button } from '../components/Button';
import { errorText } from './format';
import { defaultSaveEnv, saveFile, type SaveOutcome } from './save-file';
import { useMounted } from './use-mounted';

interface ReadyFile {
  blob: Blob;
  fileName: string;
}

export interface Handoff {
  /** A file waiting for a fresh tap on the share sheet, or null. */
  ready: ReadyFile | null;
  notice: { kind: BannerKind; text: string } | null;
  /** Share or download a freshly made file, or park it for a tap. Rejects only when a download itself throws. */
  offer(blob: Blob, fileName: string): Promise<void>;
  /** The Share button's handler: it must run straight from the tap. */
  shareReady(): void;
  downloadReady(): void;
  /** Forget the last notice and any parked file (a new action starts). */
  reset(): void;
}

function startedText(outcome: 'shared' | 'downloaded', fileName: string): string {
  return outcome === 'shared' ? `Shared ${fileName}.` : `Started the download of ${fileName}. Look in your Downloads.`;
}

export function useHandoff(): Handoff {
  const mounted = useMounted();
  const [ready, setReady] = useState<ReadyFile | null>(null);
  const [notice, setNotice] = useState<Handoff['notice']>(null);

  const reset = useCallback(() => {
    setReady(null);
    setNotice(null);
  }, []);

  async function offer(blob: Blob, fileName: string): Promise<void> {
    reset();
    const outcome = await saveFile(blob, fileName);
    if (!mounted.current) return;
    if (outcome === 'needs-tap') setReady({ blob, fileName });
    else if (outcome !== 'cancelled') setNotice({ kind: 'info', text: startedText(outcome, fileName) });
  }

  function finish(file: ReadyFile, pending: Promise<SaveOutcome>): void {
    pending.then(
      (outcome) => {
        if (!mounted.current || outcome === 'cancelled') return; // a dismissed sheet keeps the Share button for another try
        setReady(null);
        if (outcome !== 'needs-tap') setNotice({ kind: 'info', text: startedText(outcome, file.fileName) });
      },
      (err: unknown) => {
        if (mounted.current) setNotice({ kind: 'error', text: `Could not hand over ${file.fileName}. ${errorText(err)}` });
      },
    );
  }

  function shareReady(): void {
    if (!ready) return;
    // Called synchronously: saveFile reaches navigator.share before its first await, inside this tap.
    finish(ready, saveFile(ready.blob, ready.fileName, undefined, { fromTap: true }));
  }

  function downloadReady(): void {
    if (!ready) return;
    finish(ready, saveFile(ready.blob, ready.fileName, { ...defaultSaveEnv(), preferShare: false }));
  }

  return { ready, notice, offer, shareReady, downloadReady, reset };
}

/** The parked file's Share and Download buttons, and the last hand-over's notice. `noun` is "backup" or "WAV". */
export function HandoffView(props: { handoff: Handoff; noun: string }): JSX.Element {
  const { handoff, noun } = props;
  return (
    <>
      {handoff.ready ? (
        <Banner kind="info" message={`Your ${noun} is ready. Tap Share to save it to Files, or send it by AirDrop or Mail.`}>
          <div class="pl-share-ready">
            <Button variant="secondary" icon={Share} onClick={() => handoff.shareReady()}>
              Share {noun}
            </Button>
            <Button variant="ghost" icon={Download} onClick={() => handoff.downloadReady()}>
              Download instead
            </Button>
          </div>
        </Banner>
      ) : null}
      {handoff.notice ? <Banner kind={handoff.notice.kind} message={handoff.notice.text} /> : null}
    </>
  );
}
