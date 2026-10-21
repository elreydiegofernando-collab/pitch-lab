# Pitch Lab

**Pitch Lab** is a free, open-source, mobile-first web app that trains singing
technique with real-time feedback. It goes beyond "hold the note": it scores
the things that make a singer sound polished — crisp onsets, clean
transitions, measured vibrato, intentional inflections, fast riffs, and
controlled dynamics.

It runs entirely in your browser. **Your voice audio never leaves your
device** — there's no server, no account, no analytics, and no third-party
requests at runtime. The only way audio ever leaves the device is if you
explicitly export a take as a WAV file.

Primary target: **Safari on iPhone**, installed via *Share → Add to Home
Screen*. It also runs in Chrome and Edge on a Windows laptop.

## Status

**Phase 1 — Platform & live pitch** (current). This phase proves the riskiest
part first: the iPhone audio path, real-time pitch detection, the live pitch
canvas, and offline/PWA support. See the full roadmap in
[`docs/PHASES.md`](docs/PHASES.md) — Phases 2–7 add the analyzer suite,
exercise/progression system, the Vibrato/Inflections/Runs & Riffs/Dynamics
worlds, Song mode, and coaching/progress features, in that order. One phase
ships, is tested, and gets owner sign-off before the next one starts.

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
| `npm run e2e` | End-to-end tests: builds the app, serves it, and drives it with a **real, desktop Chrome** instance fed a synthesized WAV as a fake microphone (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). Needs Chrome installed; not run in every CI environment. |
| `npm run icons` | Generates the PWA icon set from the source artwork. |
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

## Privacy

Voice audio is processed **entirely on-device** and is never sent anywhere.
There is no analytics, no third-party requests at runtime, and the fonts are
self-hosted rather than loaded from a font CDN. The only way audio leaves
your device is if you explicitly tap **Export** on a take to save it as a
WAV file. See [`docs/SPEC.md`](docs/SPEC.md) §4 for the full privacy stance.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product specification: what it trains, the
  analyzers, training modules, progression model.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — thread/data-flow, the
  iOS start-audio recipe, performance rules, module ownership.
- [`docs/DESIGN.md`](docs/DESIGN.md) — the design system: color, type, space,
  motion, and the live pitch canvas's visual spec.
- [`docs/PHASES.md`](docs/PHASES.md) — the phase-by-phase build plan.
- [`docs/MANUAL-TEST-CHECKLIST.md`](docs/MANUAL-TEST-CHECKLIST.md) — the
  exhaustive real-device checklist each phase must pass before sign-off.

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
