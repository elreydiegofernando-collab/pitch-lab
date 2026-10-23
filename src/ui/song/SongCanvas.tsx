/**
 * The song player's piano roll (DESIGN.md §13.9): the PitchView with the song's notes as target bars, the live
 * trace, the count-in and a progress hairline.
 *
 * One animation-frame loop drives it without Preact state (ARCHITECTURE "Performance rules"):
 *  - while something plays, the target bars sit on the session's timeline: take time 0 at `startAt` plus the route's
 *    round trip when the mic is on (frames arrive on the input timeline), or plus the output latency when it is off;
 *  - when nothing plays, the selected phrase waits just right of the now line, at the chosen speed;
 *  - with the mic off the PitchView gets no frames, and its clock only moves on frames, so the loop feeds it one
 *    silent (unvoiced) frame per animation frame on the AudioContext clock: the roll scrolls, no trace is drawn;
 *  - the lyric cursor is published only when the phrase or the syllable changes.
 */
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Signal } from '@preact/signals';
import { getEngine } from '../../audio/engine';
import { CONFIG } from '../../config';
import type { PitchFrame, TargetNote } from '../../core/types';
import { selectionWindow, songTimeAt, toTakeTime, windowNotes, type SongSession, type SongTimeline } from '../../runtime/song-session';
import { activePitchView } from '../../state/pitch-view-registry';
import { settings } from '../../state/settings';
import { PitchViewHost } from '../pitch-view/PitchViewHost';
import type { PitchView } from '../pitch-view/types';
import { lyricCursor, sameCursor, type LyricCursor } from './cursor';

/** How far right of the now line the waiting phrase's first note sits, seconds. */
const PREVIEW_LEAD_SEC = 0.35;
/** Semitones of room above and below the song's notes, and the narrowest span shown. */
const RANGE_MARGIN = 2;
const MIN_SPAN = 12;

function outputLatencyOf(ctx: AudioContext | null): number {
  if (!ctx) return 0;
  const latency = (ctx.outputLatency || 0) || (ctx.baseLatency || 0);
  return Number.isFinite(latency) && latency > 0 ? latency : 0;
}

/** The bars of a timeline's pass (and its neighbours in a loop), in take time relative to that pass's start. */
function passTargets(tl: SongTimeline, pass: number): TargetNote[] {
  const one = toTakeTime(tl.notes, tl.window.start, tl.speed);
  if (!tl.repeat) return one;
  const shifted = (k: number): TargetNote[] => one.map((n) => ({ ...n, start: n.start + k * tl.passSec, end: n.end + k * tl.passSec }));
  return [...(pass > 0 ? shifted(-1) : []), ...one, ...shifted(1)];
}

export interface SongCanvasProps {
  session: SongSession;
  /** Written by this component; read by the lyrics strip and the phrase scrubber. */
  cursor: Signal<LyricCursor | null>;
}

export function SongCanvas(props: SongCanvasProps): JSX.Element {
  const { session, cursor } = props;
  const engine = getEngine();
  const viewRef = useRef<PitchView | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const difficulty = session.song.value.difficulty;
  const prefs = settings.value;
  const countIn = session.countIn.value;

  const options = useMemo(() => {
    let low = difficulty.lowestMidi - RANGE_MARGIN;
    let high = difficulty.highestMidi + RANGE_MARGIN;
    if (high - low < MIN_SPAN) {
      const centre = (low + high) / 2;
      low = centre - MIN_SPAN / 2;
      high = centre + MIN_SPAN / 2;
    }
    return {
      lowMidi: low,
      highMidi: high,
      autoRange: false,
      notation: prefs.notation,
      reducedMotion: prefs.reducedMotion === 'on',
      showNoteNames: prefs.showNoteNames,
    };
  }, [difficulty.lowestMidi, difficulty.highestMidi, prefs.notation, prefs.reducedMotion, prefs.showNoteNames]);

  useEffect(() => {
    const silent: PitchFrame = { t: 0, f0Hz: NaN, midi: NaN, centsFromNearest: NaN, confidence: 0, rmsDb: CONFIG.audio.rmsFloorDb, voiced: false };
    let raf = 0;
    let clock: AudioContext | null | undefined;
    let lastNow = -Infinity;
    // The bars are rebuilt only when what they show changes (a new timeline or pass, or a new waiting phrase).
    let targets: TargetNote[] = [];
    let builtFor: SongTimeline | null = null;
    let builtPass = -1;
    let builtPreview: string | null = null;

    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const view = viewRef.current;
      if (!view) return;
      const ctx = engine.context;
      const now = ctx ? ctx.currentTime : performance.now() / 1000;
      if (ctx !== clock || now < lastNow) view.clear(); // a new clock: the old trace is on another timeline
      clock = ctx;
      lastNow = now;
      const micOn = engine.state === 'running';
      if (!micOn) {
        silent.t = now;
        view.pushFrame(silent);
      }

      const tl = session.timeline.value;
      const bar = progressRef.current;
      if (tl) {
        const latency = micOn ? (session.latencyMs.value ?? 0) / 1000 : outputLatencyOf(ctx);
        const elapsed = now - tl.startAt - latency;
        const pass = tl.repeat ? Math.max(0, Math.floor(elapsed / tl.passSec)) : 0;
        if (tl !== builtFor || pass !== builtPass) {
          builtFor = tl;
          builtPass = pass;
          builtPreview = null;
          targets = passTargets(tl, pass);
        }
        view.setTargets(targets, tl.startAt + pass * tl.passSec + latency);
        if (bar) {
          const fraction = Math.min(1, Math.max(0, (elapsed - pass * tl.passSec) / tl.passSec));
          bar.style.opacity = '1';
          bar.style.transform = `scaleX(${fraction})`;
        }
        const t = songTimeAt(tl, now, latency);
        const next = t === null ? null : lyricCursor(session.phrases, session.song.value, t);
        if (!sameCursor(cursor.value, next)) cursor.value = next;
      } else {
        const selection = session.selection.value;
        const speed = session.speed.value;
        const song = session.song.value;
        const key = `${selection === null ? 'all' : `${selection.from}-${selection.to}`}|${speed}|${session.shift.value}`;
        if (key !== builtPreview) {
          builtPreview = key;
          builtFor = null;
          const w = selectionWindow(song, selection);
          targets = w ? toTakeTime(windowNotes(song, w), w.firstNote, speed) : [];
        }
        view.setTargets(targets, now + PREVIEW_LEAD_SEC);
        if (bar) bar.style.opacity = '0';
        if (cursor.value !== null) cursor.value = null;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, cursor, engine]);

  return (
    <div class="pl-song-canvas">
      <PitchViewHost
        engine={engine}
        toleranceCents={CONFIG.tolerance.default}
        options={options}
        onView={(v) => {
          viewRef.current = v;
          activePitchView.value = v;
        }}
      />
      <div ref={progressRef} class="pl-song-canvas__progress" aria-hidden="true" />
      {countIn !== null ? (
        <div class="pl-song-canvas__countin" role="status" aria-label={`Count-in: ${countIn}`}>
          <span class="pl-readout-xl pl-tabular">{countIn}</span>
        </div>
      ) : null}
    </div>
  );
}
