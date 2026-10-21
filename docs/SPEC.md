# Pitch Lab — Product Specification

Working name **Pitch Lab**. This is a free, open-source, mobile-first web app that trains singing technique with real-time feedback. It goes beyond "hold the note": it trains and scores what makes a singer sound polished.

> Source: the owner's brief (2026-10-21), transcribed from dictation and structured here. Items marked **[scoped]** were left for us to define and are proposals. Items marked **[open]** are still waiting on the owner.

## 1. What it trains

| Skill | What "good" means |
|---|---|
| Pitch accuracy & stability | Landing on the note and holding it there |
| Crispness | Clean onset that lands dead centre with no scoop |
| Transitions | Clean note-to-note changes |
| Vibrato | Measured rate, extent, regularity and centring. Exercises develop it and switch it on and off |
| Inflections | Intentional scoops, slides, falls, turns and register flips |
| Runs & riffs | Fast note sequences where every note is distinct, trained at increasing tempos |
| Dynamics | Getting louder or softer without the pitch drifting |
| Song mode | Load songs, sing along against the melody, get a phrase-by-phrase scored breakdown |

## 2. Users

- **Primary:** an adult male **tenor or high baritone** with choir experience who wants to sound impressive.
- **Secondary:** a **beginner** who also uses the app (on the same device, so local profiles are needed).
- One app serves both. Difficulty comes from **level progression** (§11), not from a mode the user picks.

## 3. Platforms & hosting

- Runs in the browser. **Primary target: Safari on iPhone, installed via Share → Add to Home Screen.**
- It must also work in **Chrome and Edge on a Windows laptop** (Chrome preferred).
- Hosted free on **GitHub Pages from a public repo**. There's no server. Vite `base` is set to the repo path (`/pitch-lab/`).
- **No accounts in v1. Accounts are planned for v2**, so keep data per-profile and exportable to make sync easy later.

## 4. Privacy

Voice audio **never leaves the device** unless the user explicitly exports it. There's no analytics, no third-party requests at runtime, and the fonts are self-hosted.

## 5. Tech stack

- **Vite + TypeScript**, kept lightweight: **Preact** for UI, and vanilla TypeScript on every hot path (audio, canvas).
- **Web Audio API** with an **AudioWorklet** for mic capture.
- **Pitch detection** uses a proven monophonic algorithm, the **McLeod pitch method (MPM)** or **YIN**. pitchy was evaluated: it's a correct MPM, but its last release was January 2024, it has no lag bounds, and it allocates on every call. Decision: an in-house MPM plus YIN, with pitchy kept as a test reference. A **hook for a CREPE-style ML model** comes later (`AsyncPitchDetector`, docs/ML-HOOK.md).
- **Reference tones and playback** use plain Web Audio (oscillators and samplers). **MIDI parsing** uses `@tonejs/midi`.
- **Canvas 2D** draws the live pitch display. It **must hold 60 fps on an iPhone**.
- **Vitest** for unit tests. A **GitHub Actions** workflow deploys to GitHub Pages.

## 6. iPhone / Safari gotchas (handled explicitly)

1. Mic access needs **HTTPS and a user tap**. **Create and resume the AudioContext inside the tap handler.**
2. Request the mic with **`echoCancellation: false, noiseSuppression: false, autoGainControl: false`**. All three distort pitch and dynamics measurements, especially while reference tones play during recording.
3. Set **`navigator.audioSession.type = 'play-and-record'`** where supported. **Test** that audio doesn't drop to the earpiece or duck in volume.
4. **Recommend wired headphones** so reference audio doesn't bleed into the mic.
5. **Warn that Bluetooth and AirPods add large latency**, and provide a **latency calibration step** (tap-along or loopback) for song mode.
6. Handle **44.1 kHz and 48 kHz** sample rates.
7. **PWA:** web manifest, icons, `apple-mobile-web-app-capable` meta, a **service worker for offline use**, and **`navigator.storage.persist()`**.

## 7. Audio engine

- The AudioWorklet captures audio. Analysis uses a window of about **2048 samples** with a **hop of about 512**, giving roughly **90+ pitch frames per second**. That's enough to resolve vibrato up to 8 Hz.
- Each frame outputs **`t`, `f0Hz`, `midi` (float), `centsFromNearest`, `confidence`, `rmsDb`**.
- Supported range: **at least E2 to C6**.
- **Light smoothing for display only.** Analyzers use the **raw pitch track**, because smoothing destroys vibrato and onset detail.
- **Ignore frames below a confidence or RMS threshold** (silence, breaths).
- Target: **the pitch line on screen is less than 50 ms behind the voice.**

## 8. Analyzers

Analyzers are **pure functions over a pitch track plus a target**, and **each one is unit tested**. The thresholds below are starting defaults and live in **one config file** (`src/config.ts`) so they're easy to tune.

### 8.1 Accuracy & stability
- Median cents error versus the target, and the percentage of time within tolerance. **Default ±25¢, easy ±50¢, studio ±10¢.**
- Stability: standard deviation of cents. Also sharp/flat bias, and pitch drift over the hold.

### 8.2 Onset crispness
- **Settle time:** milliseconds from voice onset until the pitch stays within tolerance for **100 ms**.
- **Scoop:** the lowest deviation below the target in the **first 150 ms**.
- **Overshoot.**
- **Onset type**, estimated from the RMS rise time: breathy, balanced or hard.
- **Crisp** means a fast settle with little scoop and little overshoot, from a balanced onset.

### 8.3 Vibrato
- **Detrend** the pitch track over a sliding window of **0.5–1 s** to remove the slow centre line.
- **Rate** in Hz, from zero crossings or autocorrelation of the detrended track.
- **Extent** in cents: half the median peak-to-trough distance.
- **Regularity:** the variance of rate and extent.
- **Centring:** whether the oscillation is centred on the target or sags flat.
- Default target zones by style setting:
  - **Pop / R&B:** 5–7 Hz, extent ±20–60¢.
  - **Classical / musical theatre:** 5–7 Hz, extent ±40–100¢.
- Flags:
  - **Slow, wide wobble:** below 4.5 Hz or above ±120¢.
  - **Fast bleat / tremolo:** above 8 Hz.
  - **No vibrato / straight tone:** extent below about ±10¢. This is **flagged neutrally, not as an error.**

### 8.4 Transitions & slides
- Glide duration and start/end accuracy.
- Smoothness: monotonic versus stair-stepped.
- **Break / crack detection:** a sudden jump of more than **200¢ in under 30 ms**, or a **confidence dropout in the middle of a glide**.

### 8.5 Runs & riffs
- **Align the sung contour to the target note sequence with DTW** to tolerate small timing differences.
- Per note:
  - **Reached:** at least **40 ms within ±50¢**.
  - **Accuracy:** the median error.
  - **Definition:** the percentage of the note's window spent on pitch, versus smeared between notes.
- **Run score** combines all three plus **timing versus the metronome**.

### 8.6 Dynamics
- RMS over time.
- **Correlation between loudness and pitch drift**, to catch "goes sharp when loud" and "goes flat when soft".

### 8.7 Range
- The lowest and highest notes **held cleanly for at least 1 s at or above the confidence threshold**.

## 9. Training modules

**Every exercise is defined as data (JSON):** target notes and timings, tempo, which analyzers score it, tolerances, and pass thresholds.

- All exercises **auto-transpose to the user's saved range**.
- Every exercise has a **Listen button that plays a demo first**.
- The **vibrato demo** is a synthesized tone with vibrato at the target rate and extent, so the user hears the goal.

### 9.1 Foundations
- **Range finder:** guided low and high sirens. Saves a **comfortable** and an **extended** range.
- **Pitch match:** hear a note, sing it. Scores accuracy and settle time.
- **Sustain:** hold a note for **4–8 s**. Scores stability and drift.
- **Sirens & glides:** smooth slides across the range. Detects cracks and breaks and **marks them on the trace**.
- **Crispness / staccato landing:** short notes on a beat. Scores settle time, scoop and overshoot **per note**, aiming for dead-centre landings.
- **Interval jumps:** thirds, fifths and octaves, landing clean with no scoop.
- **Legato lines:** connected scale passages with clean arrivals.

### 9.2 Vibrato
- **Vibrato meter:** free singing with a live readout of rate, extent and centring, and **the target zone shaded on the trace**.
- **Pulse builder:** deliberate pitch pulses on one note. Starts with a "ha-ha-ha" feel at **3–4 Hz**, then **4–5 Hz**, speeding up toward natural vibrato. **Includes a metronome.**
- **Semitone & whole-tone oscillation drill:** alternate two notes, slowly narrowing toward a vibrato-like oscillation.
- **Straight to bloom:** hold a straight tone, then let vibrato bloom **on cue** (the classic pop/R&B delayed vibrato).
- **On/off switching:** alternate straight and vibrato on command. Scores **how cleanly the user switches**.

### 9.3 Inflections
- **Intentional scoop:** start below and ascend. Scores the **number of cents below** and the **arrival time**.
- **Falls & fall-offs:** release downward from a held note.
- **Slides / portamento:** glide between two notes **within a set duration**.
- **Turns & ornaments:** upper and lower neighbour notes.
- **Flips:** a quick register flip up an interval, yodel style. Scores the **landing note's accuracy**.

### 9.4 Runs & riffs
- **Pattern library:** pentatonic and blues fragments of **3, 5 and 7 notes**, descending and ascending.
- Practice starts at a **low tempo**. The **tempo auto-advances when the run score is 85% or higher.**
- **Note-by-note feedback on the trace:** green = defined, yellow = smeared, red = missed. These are color-blind-safe tints plus shapes; see DESIGN.md §3.
- **Slow-it-down playback** of the user's take, next to the target.

### 9.5 Dynamics
- **Swell / messa di voce:** grow louder and then softer on one note while keeping the pitch steady. Scores pitch, and drift versus loudness.

## 10. Song mode

- Load a **MIDI file** or an **UltraStar `.txt`** file. UltraStar files include lyrics.
- Optionally load an **MP3 or WAV backing track** with an **offset setting**.
- **Transpose to the user's range.**
- **Scrolling piano roll** with the target note bars, lyrics, and the user's live pitch line.
- **Loop any phrase**, **slow down**, **play back**, and **record takes**.
- **Phrase-by-phrase scored breakdown.**
- Song mode depends on latency calibration (§6.5).

## 11. Progression — game-like, earned, linear

> "Once you get past a certain level and you've hit that progress, then you're able to progress on to more difficult things. Don't give options on being able to … jump around from beginner to advanced and intermediate. … This is like a video game. You are going by this level, …" (The message was cut off here. The owner doesn't remember the rest, so the model below stands. Confirmed 2026-10-21.)

Model:

- **Worlds** (skill areas) contain **levels** (an exercise at a difficulty). Difficulty rises inside a world through **tolerance** (±50 → ±25 → ±10¢), **tempo**, **length**, **interval size** and **range**.
- **Passing level N unlocks level N+1.** Each world ends with a **Boss Recital**: one continuous take chaining that world's 2–3 hardest skills, scored as a whole. Passing it unlocks the next world. Order: **Foundations → Vibrato → Inflections → Runs & Riffs → Dynamics**. **Song Stage** opens song by song as worlds are earned (see the unlock map).
- **Tolerance is set by the level, not by the user.** There's no beginner/intermediate/advanced picker, and no per-profile difficulty preset.
- **Mastery tiers** per level (pass, solid, studio) are shown as three tally lights. Replaying for mastery is optional; passing is enough to advance.
- **Placement auditions (decided 2026-10-21: yes).** Each world has one **audition**: a short sung test drawn from that world's levels at their pass thresholds. Passing it unlocks the world's levels up to the demonstrated tier, so an experienced singer can *sing* past early material. **An audition only skips levels inside a world that is already unlocked. It can never open a later world.** The Boss Recital is always required to leave a world. Auditions can be retaken, and failing never re-locks anything already earned.

### 11.1 The gating rule: everything is earned (owner directive 2026-10-21)

> "It can only be unlocked once you get to a certain level. I shouldn't be able to do advanced stuff … while I'm still in the beginner stuff. It shouldn't even open up."

- **Every** trainable feature, readout, exercise, song, setting and tool has an unlock requirement in a single **unlock registry** (`src/progress/unlocks.ts`, Phase 3). Nothing bypasses it, including deep links, the debug hook, imported exercise packs and future v2/v3 features. A locked item **cannot be opened**. The router refuses it and redirects to the item's requirement.
- **Locked items are shown as locked**, not hidden. They appear dimmed with a lock glyph and one line stating the requirement ("Pass *Sustain II* to unlock"), because seeing what's ahead motivates, as in a game. Their content, controls and settings stay inaccessible. (A one-line change can hide them entirely if the owner prefers.)
- **Progressive disclosure everywhere.** Readouts and settings appear only when the skill behind them is earned:
  - the Live view starts with note, cents, Hz and dB;
  - crack markers appear after *Sirens & glides*;
  - onset/settle readouts appear after *Crispness*;
  - vibrato rate, extent and centring, the vibrato zone and the **vibrato style setting** appear only once the **Vibrato** world is unlocked.
- **Always available, because they're utilities rather than training:** Home, Setup & calibration, Diagnostics, About & voice care, and Settings limited to non-skill preferences (theme, reference sound, notation, motion). The **Live** monitor is available from the start with Foundations-level readouts only.
- **Per profile:** unlocks belong to the singer, not the device. The beginner's profile never sees the tenor's unlocks.

### 11.2 Unlock map (v1)

| Unlocks | Requirement |
|---|---|
| Foundations L1 (Range finder), Live monitor (basic readouts), utilities | Start |
| Foundations levels in order: Pitch match → Sustain → Sirens & glides → Crispness → Interval jumps → Legato lines → **Boss Recital** | Previous level passed (or Foundations audition) |
| Progress dashboard, daily workout | First level passed (they show only unlocked skills) |
| **Song Stage** with public-domain starter songs rated *Foundations*; importing your own MIDI/UltraStar songs | Foundations Boss Recital |
| **Vibrato** world, Vibrato meter tool, vibrato readouts and style setting | Foundations Boss Recital |
| **Inflections** world | Vibrato Boss Recital |
| **Runs & Riffs** world | Inflections Boss Recital |
| **Dynamics** world | Runs & Riffs Boss Recital |
| Each song (bundled or imported) | The world matching its **auto-rated difficulty**: range, tempo, interval size, melisma density, vibrato demands. An imported song stays locked until its world is passed. |
| Personal-record attempts on an exercise | That exercise passed |

## 12. Feedback, progress & coaching **[scoped]**

- **Live view:** the canvas plus a readout cluster (note, cents gauge, Hz, dB). Exercise-specific overlays (target bars, tolerance band, vibrato zone, markers). Live status chips such as "settling…" or "vibrato 5.8 Hz ±38¢".
- **Take report:** an overall score, pass/fail, and 2–4 metric tiles (value versus pass threshold). It includes a trace replay with markers and a per-note breakdown (runs) or per-phrase breakdown (songs). It gives **one** coaching tip, aimed at the weakest metric. Actions are Retry and Next, plus playback of the take at normal or slowed speed.
- **Progress dashboard:** level-map completion, a per-skill trend (Accuracy, Stability, Crispness, Transitions, Vibrato, Inflections, Runs, Dynamics) as 30-day sparklines, and a range-over-time chart (lowest and highest clean notes). It also shows personal bests, practice minutes and **Momentum**. Only unlocked skills appear.
- **Momentum (replaces a daily streak, decided 2026-10-21):** a score that decays slowly and **never resets to zero**. It treats scheduled rest days as healthy and gives a small recovery bonus after 1–3 rest days. A hard-reset streak would push people to sing on days their voice should rest, contradicting the app's own voice-care advice.
- **Daily workout:** an auto-built 5/10/20-minute session. Warm-up (gentle sirens in the comfortable range) → 2–3 items from the current world → 1 review of the weakest *unlocked* skill → cool-down glides. Completing it builds Momentum.
- **Profiles:** several local profiles on one device (for example the tenor and the beginner). Each has its own range, progress, history and settings. Latency calibration is **per device and route**, shared across profiles. Accounts and sync are v2.
- **Export / import:**
  - A JSON backup of a profile (versioned schema) to restore it or move it to a new device.
  - A take's audio as WAV. This is the **only** way audio leaves the device, and only when the user taps Export.
  - Diagnostics JSON for bug reports.
- **Voice-health note:** shown at first run and in Help. It covers warming up, hydrating, never pushing through pain or hoarseness, resting, and not straining for range. After about 30 minutes of active singing, a gentle break reminder appears. A clear "not medical advice" line is included.
- **Coaching tips:** a rule table mapping analyzer findings to short, specific tips. For example, a scoop above 40¢ gets "start the note on the pitch — hear it before you sing", and sharp-when-loud gets "keep the breath steady as you crescendo; don't push".

## 13. Testing requirements

- **Unit tests on synthesized signals** for the detector and every analyzer: sines and harmonic-rich tones at 44.1/48 kHz across E2–C6, plus vibrato, glides, cracks, scoops, runs and dynamics swells.
- **End-to-end** test: headless Chrome fed a synthesized WAV as a fake mic, run against the production build. It checks the detected pitch, frame rate, and offline relaunch.
- **Manual test checklist on a real iPhone** (docs/MANUAL-TEST-CHECKLIST.md): mic permission, headphones, Add to Home Screen, offline launch, latency calibration, data survives an app restart.

## 14. Build phases

**Build one phase at a time.** See docs/PHASES.md. Each phase ends with typecheck, unit tests and e2e passing, a manual iPhone check, and owner sign-off before the next phase starts.
