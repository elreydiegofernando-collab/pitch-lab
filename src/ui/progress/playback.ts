/**
 * Play a saved take's WAV on this device (Data screen). Plays through Web Audio rather than an <audio> element:
 * the AudioContext is created and resumed inside the tap (`engine.ensureContext()`), which is what lets iOS play
 * after the file has been read back from storage. The audio goes nowhere but the speaker.
 */
import { parseWav } from '../../audio/wav';

export interface Playback {
  stop(): void;
}

/**
 * Decode `wav` (the bytes `storage.takes.audio` returns) and start it on `ctx`. `onEnded` runs when it finishes
 * or is stopped. Throws when the bytes are not a usable WAV.
 */
export async function playWav(ctx: AudioContext, wav: Blob, onEnded: () => void): Promise<Playback> {
  const parsed = parseWav(await wav.arrayBuffer());
  const buffer = ctx.createBuffer(1, parsed.samples.length, parsed.sampleRate);
  // Re-wrap into a fresh, concretely typed Float32Array: the parsed samples may sit on a larger shared buffer.
  buffer.copyToChannel(new Float32Array(parsed.samples), 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = onEnded;
  source.start();
  return {
    stop: () => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    },
  };
}
