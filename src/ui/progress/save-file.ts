/**
 * Hand a file to the singer. Exporting is the ONLY way backups or audio leave the device (SPEC §4, §12), and only
 * when they tap an Export button. On an iPhone or iPad that is the system share sheet (Save to Files, AirDrop,
 * Mail): a home-screen app has no download manager to rely on. Everywhere else it is an ordinary file download.
 * The share sheet needs a fresh tap, and a file made after a wait (a backup read from storage) is past the tap that
 * asked for it: the first attempt then reports 'needs-tap', the caller parks the file behind a Share button, and
 * the call made straight from that button (`fromTap`) either shares or, if the browser still refuses, downloads.
 */
import { isIOS } from '../../audio/platform';

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'needs-tap';

export interface SaveOptions {
  /** True when this call runs straight from a tap, so the share sheet has its fresh gesture: a refusal then downloads. */
  fromTap?: boolean;
}

export interface SaveEnv {
  /** Prefer the system share sheet over a download. */
  preferShare: boolean;
  canShare(file: File): boolean;
  share(file: File): Promise<void>;
  download(blob: Blob, fileName: string): void;
}

/** How long a download's object URL stays valid: long enough for the browser to start reading it. */
const REVOKE_AFTER_MS = 60_000;

export function defaultSaveEnv(): SaveEnv {
  return {
    preferShare: isIOS(),
    canShare: (file) => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }),
    share: (file) => navigator.share({ files: [file], title: file.name }),
    download: (blob, fileName) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    },
  };
}

/**
 * The file as the share sheet may take it. Some browsers only share a short list of file types and JSON is not on
 * it, so a JSON file is also offered as plain text under the same name (its bytes and its name do not change).
 */
function shareCandidates(file: File): File[] {
  return file.type === 'application/json' ? [file, new File([file], file.name, { type: 'text/plain' })] : [file];
}

function errorName(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
}

/**
 * Share or download `blob` as `fileName`. Resolves 'cancelled' when the singer dismissed the share sheet,
 * 'needs-tap' when the share sheet wants a fresh tap (see the module doc), and rejects only when the download throws.
 */
export async function saveFile(blob: Blob, fileName: string, env: SaveEnv = defaultSaveEnv(), opts: SaveOptions = {}): Promise<SaveOutcome> {
  if (env.preferShare) {
    const file = shareCandidates(new File([blob], fileName, { type: blob.type })).find((candidate) => env.canShare(candidate));
    if (file) {
      try {
        await env.share(file);
        return 'shared';
      } catch (err) {
        if (errorName(err) === 'AbortError') return 'cancelled';
        if (errorName(err) === 'NotAllowedError' && !opts.fromTap) return 'needs-tap';
        // Any other refusal (or a refusal even with a fresh tap): fall through to a plain download.
      }
    }
  }
  env.download(blob, fileName);
  return 'downloaded';
}
