/** Builds the fake-mic WAV fixtures the e2e suite feeds to Chrome. */
import fs from 'node:fs';
import { ARTIFACTS_DIR, RANGE_WAV_PATH, TONE_WAV_PATH, VIBRATO_WAV_PATH } from './config';
import { buildRangeFinderLoop } from './range-signal';
import { encodeWavPCM16Mono, generateHarmonicTone } from './wav-writer';

const SAMPLE_RATE = 48000;
const DURATION_SEC = 10;

/** (Re)writes every fixture. Cheap (a few hundred-thousand samples each), so always regenerated — never trust a stale .artifacts/ file from a previous run. */
export function writeFixtures(): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const tone = generateHarmonicTone({ f0Hz: 220, durationSec: DURATION_SEC, sampleRate: SAMPLE_RATE });
  fs.writeFileSync(TONE_WAV_PATH, encodeWavPCM16Mono(tone, SAMPLE_RATE));

  const vibrato = generateHarmonicTone({
    f0Hz: 330,
    durationSec: DURATION_SEC,
    sampleRate: SAMPLE_RATE,
    vibrato: { rateHz: 5.5, depthCents: 50 },
  });
  fs.writeFileSync(VIBRATO_WAV_PATH, encodeWavPCM16Mono(vibrato, SAMPLE_RATE));

  const range = buildRangeFinderLoop();
  fs.writeFileSync(RANGE_WAV_PATH, encodeWavPCM16Mono(range.samples, range.sampleRate));
}
