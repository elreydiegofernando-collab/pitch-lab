# Pitch Lab

**Pitch Lab** is a free, open-source, mobile-first web app that trains singing
technique with real-time feedback. It goes beyond "hold the note": it scores
the things that make a singer sound polished — crisp onsets, clean
transitions, measured vibrato, intentional inflections, fast riffs, and
controlled dynamics.

It runs entirely in your browser. **Your voice audio never leaves your
device** — there's no server, no account, no analytics, and no third-party
requests at runtime. The only way audio ever leaves the device is if you
explicitly export it: a take as a WAV file, or a coaching file with
**Include audio** turned on.

Primary target: **Safari on iPhone**, installed via *Share → Add to Home
Screen*. It also runs in Chrome and Edge on a Windows laptop.

## Features

- **A live pitch trace.** Your voice drawn over a piano-roll grid in real time:
  note name, a cents gauge, Hz and dB, about 90 readings a second. The trace is
  the hero of every screen that uses the microphone.
- **Training that works like a game, and is earned.** Five worlds in order:
  Foundations, Vibrato, Inflections, Runs & Riffs and Dynamics. Each has levels
  that tighten the tolerance, tempo and range, and ends in a Boss Recital: one
  continuous take that chains its hardest skills. Passing a level opens the next;
  three tally lights per level show how well you passed it. There is no difficulty
  picker, and nothing can be jumped to: a locked level, tool, song or setting is
  shown with the one line that says what opens it, and it cannot be opened, by
  tapping or by a link.
- **Placement auditions.** An experienced singer can sing a few short tests to
  skip ahead inside a world that is already open. An audition never opens a later
  world and never skips a Boss Recital, and failing one takes nothing away.
- **Your range, measured.** The Range finder finds the lowest and highest notes
  you hold cleanly and saves a comfortable and an extended range. Every exercise
  is placed inside it.
- **A report after every take.** A score ring, pass or "Not yet", two to four
  metric tiles against their targets, the trace replayed over the target notes
  (for runs, each note marked defined, smeared or missed), **coaching** aimed at
  the weakest thing, and playback of your take at normal or half speed. The
  coaching says where in the take it went wrong, in plain words, and gives more
  help each time you miss the same exercise in a row: why it happens, then a
  step-by-step, then an easier way in. **Send to Claude** saves a file of your
  last takes for a closer look in chat ([`docs/COACHING.md`](docs/COACHING.md)).
- **What it measures.** Pitch accuracy and stability, crisp onsets (settle time,
  scoop, overshoot), clean transitions, sirens and cracks, vibrato (rate, extent,
  regularity and centring, against a pop or a classical zone), intentional scoops,
  slides, falls, turns and flips, fast runs, and dynamics without the pitch
  drifting. Tools such as the Vibrato meter and the Live view's readouts appear only
  once the skill behind them is earned.
- **Progress without a streak to lose.** Momentum decays slowly, never resets to
  zero and treats rest days as healthy, because your voice needs them. A progress
  dashboard shows each unlocked skill's last 30 days, your range over time, personal
  bests and practice minutes. A **daily workout** of 5, 10 or 20 minutes is built
  from where you are: a warm-up, work from your current world, a review of your
  weakest skill, a cool-down.
- **Song Stage.** Sing real melodies phrase by phrase against a scrolling piano
  roll with the lyrics underlined as they come, loop a phrase, slow it to 75% or
  50%, move the key to fit your range, and get a score for each phrase. Public-domain
  songs ship with the app; you can [import your own](#importing-your-own-songs).
- **Several singers on one device.** Each profile has its own range, progress,
  history and settings, so a beginner never sees a tenor's unlocks. Latency
  calibration is shared, because it belongs to the phone and its headphones.
- **Your data stays yours.** Back everything up to one JSON file and restore it on
  another device, export a take as a WAV, or delete it all. It works fully
  offline once installed.
- **Voice care built in.** A short note on first run, a gentle break reminder after
  about 30 minutes of singing, and a reminder not to push through pain or
  hoarseness. It is not medical advice.

## Privacy

Your voice is analyzed **on your device and never leaves it**. There is no server,
no account, no analytics and no third-party request at runtime, and the fonts are
self-hosted. The end-to-end suite fails if any request the app makes goes anywhere
but its own origin.

- **What is stored, and where.** Profiles, your attempt history and your settings
  live in the browser's IndexedDB. A saved take (its pitch track, and its audio
  unless you turn **Keep take audio** off) lives in on-device storage, as do songs
  you import and their backing tracks. Pitch Lab asks the browser to keep that
  storage durable. None of it is sent anywhere.
- **What can leave, and only when you tap for it.** *Export backup* writes one
  JSON file with your profiles, attempts and settings. It carries **no audio**.
  *Export WAV* writes one take's audio. *Send to Claude* (a level's **More**)
  writes a coaching file: your last five takes of that exercise with their pitch
  lines and scores, and their audio only if you turn on **Include audio** (off
  each time). On an iPhone these go through the share sheet (Save to Files,
  OneDrive, AirDrop, Mail); on a computer they download. Nothing else in the app
  can export audio.
- **What you can delete.** One recording, one profile together with its
  recordings, or everything, from **Data & backup**. A delete that cannot finish
  says so and keeps the item; the app never reports a deletion that did not happen.
- **Songs and backing tracks you import** are parsed and played on your device and
  are never uploaded.

See [`docs/SPEC.md`](docs/SPEC.md) §4 for the full privacy stance.

## Importing your own songs

Importing is earned like everything else: it opens when you pass the **Foundations
Boss Recital**. Then, in **Song Stage**, tap **Import** (top right).

1. **Choose a file.** An **UltraStar** chart (`.txt`), or a **MIDI** file (`.mid`,
   `.midi` or `.kar`), up to 5 MB. An UltraStar chart carries the lyrics and the
   phrase breaks; a duet's second voice is ignored. A MIDI file carries lyrics only
   if it is a karaoke file, whose words Pitch Lab matches to the melody notes; karaoke
   files often hold several tracks.
2. **MIDI only: pick the melody track.** Each candidate shows its name, its number
   of notes and its range, with a 6 second preview. The most likely melody is
   preselected; choose another if it is the harmony, the bass or a drum track.
3. **Optionally add a backing track.** An MP3 or WAV of the song, up to 80 MB. Move
   **Offset** (±2 seconds, in 10 ms steps) until the backing lines up with the
   melody, and use **Preview 8 s**, with or without the click, to check. An UltraStar
   chart names the audio file it was made for.
4. **Read the rating, name it and Save.** The song is rated automatically from its
   range, tempo, interval sizes, long held notes and fast runs, and the rating names
   the world it needs and the reasons why.

The song joins the library marked **Yours**. Like every bundled song, it opens once
you have passed the Boss Recital of the world it needs: at once if that is
Foundations, otherwise it stays locked, with that requirement shown, until you
get there. Open it and sing; the first time on a route, run **Setup & calibration**
so your takes line up with the music. To remove an imported song and its backing
track, open it, then **More → Delete this song**.

Only import charts and recordings you have the right to use. The bundled songs are
public-domain melodies, charted by Pitch Lab.

## Status

**Phases 1–7 are built**, awaiting the owner's end-to-end test on a real iPhone
([`docs/MANUAL-TEST-CHECKLIST.md`](docs/MANUAL-TEST-CHECKLIST.md)). Phase 1 proved
the riskiest part first: the iPhone audio path, real-time pitch detection, the
live pitch canvas, and offline/PWA support. Phases 2–7 (see
[`docs/PHASES.md`](docs/PHASES.md)) added the analyzer suite, the exercise and
progression system, the Vibrato, Inflections, Runs & Riffs and Dynamics worlds,
Song mode, and coaching and progress features. The owner waived per-phase
sign-off on 2026-10-21: the end-to-end test happens once, at the end.

## Requirements

- **Node.js 22.12 or newer** (the 22 LTS line) **or Node 24**.
- A Chromium-based desktop browser (Chrome preferred) for `npm run e2e`.
- An iPhone running Safari for the manual checklist
  ([`docs/MANUAL-TEST-CHECKLIST.md`](docs/MANUAL-TEST-CHECKLIST.md)) — a
  simulator won't do, since the mic/audio-session behaviour it checks is real
  hardware/WebKit behaviour.

## Getting started

```bash
npm install
npm run dev
```

Opens the dev server on `localhost`. That's enough for most UI/DSP work, but
**`getUserMedia` needs a secure context**, and a plain `http://` URL on your
phone isn't one.

### Testing on a phone

```bash
npm run dev:host
```

Serves the dev server over **self-signed HTTPS**, bound to your LAN, so you
can open it from an iPhone on the same Wi-Fi (e.g.
`https://192.168.1.23:5173`). Safari will warn about the self-signed
certificate once — accept it to continue. This is the only practical way to
test mic capture on a real phone before deploying.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server (HTTP, for desktop work). |
| `npm run dev:host` | Dev server over self-signed HTTPS, exposed on the LAN, for testing on a phone. |
| `npm run build` | Production build to `dist/` (base path `/pitch-lab/`, see below). |
| `npm run preview` | Serves the production build locally, for a final check before deploying. |
| `npm run typecheck` | `tsc --noEmit` for both the app and the Node-side config/tooling. |
| `npm test` | Unit tests (Vitest, synthesized-signal tests for DSP/analyzers, pure-module tests elsewhere). |
| `npm run e2e` | End-to-end tests: builds the app (as `NODE_ENV=production`), serves it, and drives its real UI in a **real, desktop Chrome** fed a synthesized WAV as a fake microphone: a first session from the first-run sheets to a passed Range finder, locked deep links, persistence and offline use, backups and WAV export, profiles, Song Stage from a restored backup and a sung song phrase, and every screen's layout (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). Takes about four minutes. Needs Chrome installed; not run in every CI environment. |
| `npm run icons` | Generates the PWA icon set from the source artwork. |
| `npm run coach -- <file...>` | Reads a coaching file ("Send to Claude"), a backup or a take WAV and prints a diagnosis of the takes; `npm run coach -- --list` finds the newest ones (see [`docs/COACHING.md`](docs/COACHING.md)). |
| `npm run check` | `typecheck` + `test` + `build`, the quick "is this phase still green" command. |

## Deploying to GitHub Pages

Pitch Lab is meant to be hosted for free from a **public GitHub repo**:

1. Push this repo to GitHub as a **public** repo. If you name it `pitch-lab`,
   no changes are needed — `BASE` in [`vite.config.ts`](vite.config.ts) is
   already set to `/pitch-lab/`, matching GitHub Pages' default
   `https://<user>.github.io/pitch-lab/` URL. If you use a different repo
   name, change `BASE` to match it first.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The included workflow (`.github/workflows/`) builds and
   deploys automatically.

GitHub Pages is a static host with no server-side code and no way to set
`COOP`/`COEP` headers — which is why this app avoids `SharedArrayBuffer` and
does all of its audio work in a single AudioWorklet instead (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product specification: what it trains, the
  analyzers, training modules, progression model.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — thread/data-flow, the
  iOS start-audio recipe, performance rules, module ownership.
- [`docs/DESIGN.md`](docs/DESIGN.md) — the design system: color, type, space,
  motion, and the live pitch canvas's visual spec.
- [`docs/PHASES.md`](docs/PHASES.md) — the phase-by-phase build plan.
- [`docs/MANUAL-TEST-CHECKLIST.md`](docs/MANUAL-TEST-CHECKLIST.md) — the
  real-device checklist for the end-to-end test on an iPhone: what only a phone
  and a real voice can show, a real-voice check for every provisional threshold,
  the backup round trip, WAV export, song mode and profile switching.
- [`docs/COACHING.md`](docs/COACHING.md) — "Send to Claude": how a singer's
  coaching file is exported from the phone and read in chat with
  `scripts/coach.mjs`, and how to answer in plain words.

## License

[MIT](LICENSE) — free for anyone to use, study, modify, and redistribute.

## Credits

Built with [Preact](https://preactjs.com/), [Vite](https://vitejs.dev/) and
[Vitest](https://vitest.dev/), [lucide-preact](https://lucide.dev/) icons,
[@tonejs/midi](https://github.com/Tonejs/Midi) for song-mode MIDI parsing,
offline support via [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) and
[Workbox](https://developer.chrome.com/docs/workbox/), and the
[Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display)
and [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans)
typefaces (self-hosted via Fontsource). [Pitchy](https://github.com/ianprime0509/pitchy)
is kept as a cross-check reference for the in-house pitch detectors, not a
runtime dependency of the shipped app. End-to-end tests run against the
**real, installed Google Chrome** via
[`playwright-core`](https://playwright.dev/).
