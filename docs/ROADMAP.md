# Roadmap: v2 and v3

Approved direction 2026-10-21. Source: a five-lens brainstorm (voice pedagogy, competitors, game design, accounts/social, platform/ML) plus a feasibility pass, reviewed by the orchestrator.

**Binding rule (SPEC §11.1):** every item below is gated by the unlock registry. Nothing opens before the singer has earned it, and locked items can't be opened, deep links and imports included. Each item lists its unlock requirement.

Effort: S = days, M = 1–2 weeks, L = 3–6 weeks, XL = months (human-scale estimates).

## Folded into v1 (done in the spec and phase plan)
- Sync-ready data model (Phase 3)
- Boss Recitals (Phase 3)
- Momentum instead of a hard-reset streak (Phase 7)
- Private real-voice test corpus (Phase 2)
- Standing never-do checklist (PHASES.md)

## v2: accounts and sync, plus "in tune → polished"

### Accounts & sync (must)
| Item | Effort | Unlock |
|---|---|---|
| Backend: Cloudflare Workers + D1 + R2. Free tier with no sleep trap; Supabase's free tier pauses after 7 days idle. | L | n/a (infrastructure) |
| Sync of progress and settings across devices. **Never audio**; a synced-fields allowlist enforces it. | M | Optional sign-in from Settings at any time; sync carries only what's already earned |
| Household account: one login, both local profiles, each with its **own** unlocks | M | Same |
| No-account mode stays the default. No sign-in wall, ever. | S | — |
| One-button export and full account deletion | S | Available whenever an account exists |
| *Fast-follow:* recording backup encrypted on the device; the server only stores ciphertext | L | Off by default |
| *Could:* friends-only leaderboards per drill | M | A drill appears only after both friends have unlocked it; no global rankings |
| *Could:* async duet (one take sent to one named friend, short expiry) | M | After Song Stage opens |

### Technique depth
| Item | Effort | Unlock |
|---|---|---|
| **Teacher-style "why" coaching** (a rules table of causes, reviewed by a real teacher) | M | Explains only skills already unlocked |
| **Breath dashboard**: pre-onset inhale noise, longest comfortable sustain, phrase length, all as trends | M | After Foundations *Sustain* |
| **"Sing it first" ear training**: sing an interval before hearing it; blind mode | M | After Foundations *Interval jumps* |
| **New world: Tone & Registers** (after Dynamics). Contents: brightness/"ring" meter (2.8–3.4 kHz energy, almost free from the existing FFT), register map (chest/mix/head band, coaching only, never pass/fail), flip-free passaggio drills, vowel-modification coach, tone-quality trends (breathy versus pressed), and its own audition and Boss Recital | L | Dynamics Boss Recital |
| Vocal-load and health trends (shrinking top range, load spikes against your own baseline; not medical) | M | Grows with each unlocked world |
| Style profiles: Classical vs CCM/Pop targets beyond vibrato (beta, pending a CCM teacher's review) | M | Vibrato world |
| *Could:* drone and just-intonation lab (tune to the chord, not the piano) | S | Dynamics Boss Recital |
| *Could:* opt-in AI coaching paragraph built from scores only (never audio); local model by default | M | Narrates only unlocked skills |

### Motivation
| Item | Effort | Unlock |
|---|---|---|
| **Spaced repetition** for weak skills (continuous scores, not flashcards) | L | Schedules only unlocked skills |
| **Adaptive warm-up**: cold-start warm-up, due skills, time slider | M | First level passed |
| **Personal-record attempts** (fastest clean riff, longest stable sustain, widest clean interval…) | S | Per exercise, once passed |
| **House records**: per-category records for the two profiles | M | A category appears only once **both** profiles have unlocked it. Neither sees the other's advanced material. |
| Mastery tiers (Developing → Mastered), with honest re-certification if a skill slips | M | Per passed level |
| Earned setlist: songs tagged by skill, unlocked by Boss Recitals | M | Per song's rated world |
| "Training journal" framing: worlds as chapters, auto-written session entries | S | — |

### Content & platform
| Item | Effort | Unlock |
|---|---|---|
| Open exercise hub: packs hosted on GitHub plus a curated index, no server | M | Every pack **must declare** the world/level it requires. The validator rejects packs without it, and imported exercises obey the registry. |
| Public-domain UltraStar starter pack (timing and lyrics only, no copyrighted audio) | M | Rated per song |
| SwiftF0 "robust mode" pitch detector (optional, checked against the in-house detector) | M | Utility (Diagnostics) |
| Live signal-quality warning (echo cancellation, clipping, noise) instead of confident wrong scores | M | Utility |
| OPFS asset/model store | S | Infrastructure |
| Screen-reader take summaries | M | Utility |
| *Could:* Android Play Store listing (Trusted Web Activity); MIDI keyboard input on Windows Chrome | S | Utility |

## v3: bigger bets
| Item | Effort | Unlock |
|---|---|---|
| **Choir part trainer (headline)**: SATB MusicXML, the other parts play while you sing yours, scored on just-intonation tuning against the chord. Could move into late v2. | L | New **Choir** world after Tone & Registers |
| Full vowel/formant tracker with a VoceVista-style "overlay your best take" (WebGPU) | L | Late tiers of Tone & Registers |
| Teacher mode: assign without surveilling; the student shares individual takes explicitly | L | Teachers can assign **only content the student has already unlocked**; they can recommend, never unlock |
| Auto-chart your own a cappella recording (Basic Pitch; clean solo voice only) | L | Song Stage |
| "New Game+" modifiers: no visual help, random key, double tempo, blind first pass | M | Per world, after its Boss Recital plus a mastery tier |
| Moderated community submission queue | M | Packs still declare requirements |

## Later or rejected
- **Later:** native iPhone wrapper (Capacitor) for full audio-session control (App Store 4.2 rejection risk, two codebases); Apple Watch app (needs the wrapper); live real-time duets (real-time servers needed, iOS mic bugs on both ends); seasonal content drops.
- **Rejected:**
  - a per-profile beginner/advanced preset with wider tolerances (breaks the no-difficulty-picker rule; plain-language wording is driven by the level instead)
  - on-phone vocal separation (~84 MB model)
  - a "you drifted onto another choir part" detector (unsolved research)
  - hard-reset streaks
- **Correction to the brainstorm:** vibration-based haptic pitch cues don't work in iPhone Safari (no Vibration API). Android only.

## Decisions (owner, 2026-10-21: agreed with all recommendations)
| Decision | Choice |
|---|---|
| Accounts backend | Cloudflare |
| Encrypted recording backup | Fast-follow after sync |
| Teacher mode | v3 |
| Native iPhone wrapper | Not now |
| Momentum vs streak | Momentum, in v1 |
| Choir part trainer | Headline of v3 (possibly late v2) |
