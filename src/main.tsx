/**
 * Entry point: loads the self-hosted fonts and global styles, mounts <App/>
 * into #app, and — only when the page was opened with `?debug` — installs
 * `window.__pitchlab`, the hook the e2e suite drives (docs/ARCHITECTURE.md).
 */
import { render } from 'preact';
import '@fontsource-variable/big-shoulders-display/wght.css';
import '@fontsource-variable/instrument-sans/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/practice.css';
import './styles/worlds.css';
import './styles/song.css';
import './styles/progress.css';
import './styles/checkup.css';
import './styles/lesson.css';
import { App } from './app';
import { getEngine } from './audio/engine';
import { activePitchView } from './state/pitch-view-registry';
import type { PitchFrame } from './core/types';
import type { AudioEngine, EngineInfo } from './audio/engine-types';

interface PitchLabDebugHook {
  engine: AudioEngine;
  /** Total frames received since load (not clamped to the retained ring). */
  frameCount(): number;
  /** The last `n` retained frames, oldest first (default: all retained, up to 3000). */
  frames(n?: number): PitchFrame[];
  renderFps(): number | null;
  info(): EngineInfo;
}

declare global {
  interface Window {
    __pitchlab?: PitchLabDebugHook;
  }
}

const DEBUG_RING_SIZE = 3000;

function installDebugHook(): void {
  const ring: (PitchFrame | undefined)[] = new Array(DEBUG_RING_SIZE);
  let writeIndex = 0;
  let totalFrames = 0;

  const engine = getEngine();
  engine.onFrame((frame) => {
    ring[writeIndex] = frame;
    writeIndex = (writeIndex + 1) % DEBUG_RING_SIZE;
    totalFrames += 1;
  });

  window.__pitchlab = {
    engine,
    frameCount: () => totalFrames,
    frames: (n) => {
      const retained = Math.min(totalFrames, DEBUG_RING_SIZE);
      const take = n === undefined ? retained : Math.min(n, retained);
      const start = (writeIndex - take + DEBUG_RING_SIZE) % DEBUG_RING_SIZE;
      const out: PitchFrame[] = [];
      for (let i = 0; i < take; i++) {
        const frame = ring[(start + i) % DEBUG_RING_SIZE];
        if (frame) out.push(frame);
      }
      return out;
    },
    renderFps: () => activePitchView.value?.fps ?? null,
    info: () => engine.info(),
  };
}

if (new URLSearchParams(location.search).has('debug')) {
  installDebugHook();
}

const container = document.getElementById('app');
if (!container) {
  throw new Error('#app not found: index.html must provide it (owned by the pwa agent).');
}
render(<App />, container);
