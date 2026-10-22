# Coaching from the owner's takes ("Send to Claude")

On 2026-10-22 the owner, who is relearning to sing, asked for two things the app cannot do alone:

> "I feel like the coaching tips should be where I'm messing up. And then each time I mess up or I need to improve or I'm just not getting it, it should have more and more advice to the point where it's hand walking me."

> "... in this chat, say, hey, this is the lesson that I'm at. Look at where my last progress is and ... analyze why I'm not able to get it."

The first is the app (the coaching card on the take report, `src/coaching/`). The second is this page: the owner exports a file from the phone, and Claude, in chat, reads it with `scripts/coach.mjs` and says what is going wrong and what to try next.

Contents: [what the owner does](#1-what-the-owner-does-on-the-iphone) · [where the files land](#2-where-the-files-land-on-this-pc) · [the analyst's workflow](#3-the-analysts-workflow-claude) · [reading the output](#4-reading-the-output) · [the singer or the app?](#5-the-singer-or-the-app) · [telling the owner](#6-telling-the-owner) · [privacy](#7-privacy) · [the script](#8-the-script) · [limits](#9-what-the-read-cannot-tell-you)

## 1. What the owner does on the iPhone

**A coaching file** is the best thing to send: the last five takes of one lesson, each with its pitch line, the notes it was sung against and what the app scored.

1. Open the lesson (its Level screen).
2. Tap **More**, then **Send to Claude**.
3. Leave **Include audio** off, unless Claude should re-run the audio itself (see "Audio" below). It is off every time the sheet opens.
4. Tap **Share**, then **Save to OneDrive** (or Files). The file is `pitch-lab-coach-<level>-<date>-<time>.json`, for example `pitch-lab-coach-foundations-05-2026-10-22-1405.json`.
5. Tell Claude in chat which lesson it is: "I'm on Sirens & glides. Look at my last takes."

Two more files answer other questions:

| File | How | What it holds |
|---|---|---|
| `pitch-lab-backup-YYYY-MM-DD.json` | Home, **Data & backup**, **Export backup** | Every attempt of every lesson as numbers (score, pass, each measure). No pitch lines, no audio. Shows where the singer is and how long a streak of misses really is. |
| `pitch-lab-take-YYYY-MM-DD.wav` | **Data & backup**, Recordings, **Export WAV** (Settings, **Keep take audio** must be on) | One take's audio. Claude rebuilds the pitch line from it. |

Audio: a coaching file holds pitch lines only. Ticking **Include audio** adds the WAV of each take that kept one; audio leaves the phone only on an export (SPEC §4). The pitch line is what the app judged, so the audio is for a cross-check (is the app hearing the voice right?), not for coaching.

## 2. Where the files land on this PC

OneDrive syncs the phone's "Save to OneDrive" into one of these (whichever account the owner saved to):

- `%USERPROFILE%\OneDrive\` (a personal account)
- `%USERPROFILE%\OneDrive - <organisation>\` (a work or school account)

The file is in the folder's root unless the owner picked a sub-folder in the share sheet. `node scripts/coach.mjs --list` looks in every folder of the home folder whose name starts with "OneDrive" (and the ones the OneDrive environment variables name), and in `%USERPROFILE%\Downloads` (where a file the owner mailed to themselves ends up), one folder level down in each, and prints the newest pitch-lab files first with their full paths, so there is nothing to hunt for. It also takes folders to search: `--list "D:/somewhere"`. If OneDrive has not synced yet, the file is not there: wait a minute, or ask the owner to check that the upload finished.

## 3. The analyst's workflow (Claude)

1. **Find the files.** From the repo root:

   ```
   node scripts/coach.mjs --list
   ```

   Take the newest `pitch-lab-coach-*.json` whose lesson and time match what the owner said. If the owner mentioned a recording, the newest `pitch-lab-take-*.wav`; for "where am I overall", the newest `pitch-lab-backup-*.json`.

2. **Run the script** on the path `--list` printed. Quote it: a work or school OneDrive folder has spaces.

   ```
   node scripts/coach.mjs "<the path --list printed>/pitch-lab-coach-foundations-05-2026-10-22-1405.json"
   ```

   `npm run coach -- <file>` is the same.

   Useful variations (more in [the script](#8-the-script)):

   ```
   node scripts/coach.mjs coach.json backup.json        # the backup supplies the whole log: true streak, passed levels
   node scripts/coach.mjs coach.json --take 2           # one take in detail (1 = the newest); the comparison still covers all
   node scripts/coach.mjs backup.json --exercise sirens # a backup, looking at one lesson
   node scripts/coach.mjs take.wav backup.json          # a WAV, matched to the backup's attempt (by day and length)
   node scripts/coach.mjs take.wav --exercise foundations.05 --tonic A3   # a WAV alone, when nothing else names the lesson and key
   node scripts/coach.mjs coach.json --json             # the same, as JSON (every figure, every take)
   ```

3. **Read it** ([reading the output](#4-reading-the-output)): the "In short" lines first, then the newest take, then "Across the takes".
4. **Decide: the singer, or the app being too strict** ([next section](#5-the-singer-or-the-app)). A repeated miss that is a hair under a threshold is not the same news as one that is far off.
5. **Answer the owner in plain words** ([telling the owner](#6-telling-the-owner)): where it goes wrong, why, and one thing to try on the next take. Never paste the script's output at the owner: it is full of units.
6. **Offer the next step**: another take (and a new file to look at it), an easier way in, or an earlier level to practise (only one the owner has passed).

If the script says a file is bad, it prints which and why and exits non-zero. A newer app than the script (a coaching file version above what the script reads) means: pull the repo and try again.

## 4. Reading the output

The text is ASCII, in engineering units (cents, milliseconds, Hz), written for the analyst. Top to bottom:

- **Header.** The singer, the lesson and what it asks, the pass rule (score plus gates, and the in-tune band of the level), how many takes and where their numbers came from, the **streak** (misses in a row, and so the coaching depth the app was at, 1 to 4), and whether the coaching engine answered.
- **In short.** Five lines or fewer: the newest take's verdict and the gates it missed, the coach's pick, the streak, the trend over the takes, and the first singer-or-app read. Start here.
- **Take n.** Newest first. Each take has:
  - *Verdict*: score against the pass mark, which gates failed and by how much (a **near miss** is within a tenth of the score band), what cost the most score, and the level's own rules (a take stopped early, notes left unsung, a lower rung of a Runs ladder, an exercise folded into a narrow saved range). It also says whether the app's own record of the take agrees with this re-analysis; a difference is explained below the verdict.
  - *Score and gates*, *score terms*: every number against its target, and how many points of the final score each term cost, costliest first.
  - *Located problem*: the coaching engine's answer (`src/coaching/coach.ts`): the tip it picked, one plain sentence with plain numbers, and where in the take it shows, worst first.
  - *What the app tells the singer*: the card as the singer read it at that depth (tip, why, steps, an easier way in), so you do not contradict it. Only the first take shown gets the full card.
  - *What the analysis noticed*: patterns across the notes ("sharp on 5 of 7 held notes", "came in late on 4 of 8", "the voice sagged during long holds", "stair steps on 6 of 6 slides").
  - *Figures*: one line for what each analyzer found (held notes, attacks, glides, cracks, runs, vibrato, ...). `!!` marks the ones that count against the take.
  - *Pitch graph*: time across, notes down, one row a half step. `=` is the target, `*` is what was sung (it hides the bar where the singer was on it), `x` is a crack. A bar with no `*` on it is where the singer was not.
- **Across the takes.** Oldest to newest: score, failed gates and the coach's pick per take; a table of every measure the level judges, take by take, with its gate and how often the gate was missed; what improves, what gets worse, what repeats (a gate missed again and again, the same tip, the same trouble spots); and the singer-or-app read.
- **A backup** adds *Where the singer is* (levels passed, the level up next, recent lessons with their streaks) and reads the numbers of the lesson in focus. It cannot place a problem in a take, since it has no pitch line: ask for a coaching file for that.

## 5. The singer or the app?

The analyzers' thresholds were tuned on synthesized voices and are marked PROVISIONAL (`src/config.ts`, and the rows P1 to P17 of docs/MANUAL-TEST-CHECKLIST.md). The owner is the first real voice. So a lesson that will not pass is either the singing or a threshold that is too strict for a real voice. The read that "Across the takes" prints is a first guess; confirm it:

| It looks like | Reads as | What to do |
|---|---|---|
| The gate is missed by a lot, the same notes keep failing, the numbers do not move over the takes | **The singer** | Coach: the located spots, the next depth of help, an easier way in. |
| Every miss is a near miss, on every take, at almost the same value, and the owner says it felt right | **The app (too strict)** | Find the checklist row below, compare with what the take shows, and propose the one-line change to the owner. A threshold is shared by every singer: the owner decides. |
| A metric is "not measured" in many takes, or the audio check shows the rebuilt pitch line differing from the saved one (octave disagreements, far fewer voiced frames) | **The app (hearing)** | P1 (the voicing gate), the mic and the room. |
| The score is within five points of the pass mark in several takes | **Maybe the app** | P13 (score bands): is this level far harder than its tier? |
| "Some notes went unsung", though the owner says they sang it all | **The app (reach)** | P17: short staccato notes and fast runs leave few voiced frames. |
| The app recorded a miss, the re-analysis passes | **A stopped take, or another app build** | The take was probably stopped early (practice only). A different build is named in the header. |
| The score is near the line and the app and the re-analysis split on pass or miss | **Float rounding** | The saved pitch line is 32-bit floats: a take this close can tip either way. |

Which checklist row a metric touches:

| Metrics | Row | Where the numbers live |
|---|---|---|
| In tune, Typical miss, Pitch spread, Off-centre, Drift | P2 (late start), P1 (voicing) | `CONFIG.accuracy.lateStartAllowanceSec`, `CONFIG.audio` |
| Settle, Scoop, Overshoot, Crisp onsets | P3 | `CONFIG.onset`, `analysis/onset.ts` |
| Vibrato heard, in the zone, evenness, centre | P4 | `CONFIG.vibrato`, `analysis/vibrato.ts` |
| Clean switches, Bloom on cue | P5 | `analysis/switch.ts` |
| Pulse rate off, Pulse evenness | P6 | `analysis/pulse.ts` |
| Breaks, Smoothness, Arrival | P7 | `CONFIG.transitions`, `analysis/glide.ts` |
| Clean changes | P8 | `analysis/transitions.ts`, `analysis/dtw.ts` |
| Shape match, Landing | P9 | `analysis/inflections.ts` |
| Run score, Defined notes, Missed notes | P10 | `CONFIG.runs`, `analysis/runs.ts` |
| Loudness range, Pitch per dB, Swell symmetry | P11 | `CONFIG.dynamics`, `analysis/dynamics.ts` |
| Low to high (range) | P12 | `CONFIG.range` |
| Level far easier or harder than its tier | P13 | `exercises/catalog/scoring.ts` |
| Unsung notes | P17 | `REACH` in `exercises/analyze.ts`, `MIN_REACH_SHARE` |

When you do propose a change, say which constant, which way, and what the take showed that supports it (for example "Smoothness 24% against a 25% gate in all four takes, and the graph shows a clean slide").

## 6. Telling the owner

The owner is relearning to sing and said: "assume that I am just relearning how to sing and get into music. So for some of the stuff you want to be a little bit more layman's terms." Every word the owner reads follows the rules the app's own coaching text follows (`src/coaching/types.ts`):

- Write to the singer as "you". Be warm, specific and brief. One thing to try next, not a list of everything.
- Never use units or jargon: no cents, Hz, semitones, bpm, passaggio, tessitura, formant, glottal, onset, melisma, portamento.
- Say instead: "a half step" (the next key on a piano) or "the next note up"; "about six wobbles a second"; "the place where your voice changes gears"; "the start of the note"; "a quick run of notes"; "a smooth slide".
- No exclamation marks. Never "push", "force" or "strain" as advice ("never strain" is fine).
- Voice care: stop if anything hurts, scratches or goes hoarse, and rest.
- Be true to what the app measures. Never promise a reading the app cannot make: it hears pitch and loudness, not tone colour, breath or the throat.

How the analyst's words turn into the owner's:

| The output says | Say |
|---|---|
| "sharp +34 cents" / "flat -20 cents" | "a bit above the note, less than half way to the next one" / "a little under the note" |
| "settled in 400 ms" | "it took you almost half a second to find the note" |
| "scoop 120 cents" | "you start below the note and slide up into it" |
| "drift -6 cents/s" | "the note slowly sinks while you hold it" |
| "stair steps 5" | "the slide stops and starts, like stairs, instead of one smooth line" |
| "crack at 0:08.5 near F#3" | "your voice flipped or cut out about eight seconds in, around the F sharp" |
| "vibrato rate 5.8 Hz" | "about six wobbles a second" |
| "covered 49%" | "you held the note for about half of its length" |
| "came in 1.0 s late" | "you started about a second after the note began" |
| "Run 2 note 5 smeared" | "the fifth note of the second run blurred into the one next to it" |

Hand-walk it, as the owner asked: the located spot first ("the second slide up, near the middle"), why it happens in one sentence, then three to five small steps for the next take. Use what the app already told the singer (its card at that depth) as the base, so the two never disagree. A passing take gets what to do next, not a lecture.

## 7. Privacy

The owner's exports are personal: pitch lines, scores and (if included) the voice itself. They are never committed and never leave this PC.

- `.gitignore` covers `pitch-lab-coach-*.json`, `pitch-lab-backup-*.json` and `pitch-lab-take-*.wav` wherever they are in the repo. Check with `git check-ignore -v <file>` if one was copied in.
- The script only reads files you name (or lists the OneDrive folders and Downloads). It makes no network request and writes nothing.
- Do not paste a file's contents (a pitch line is base64) or a WAV anywhere else. The text diagnosis is fine to read in chat.
- Samples for tests are synthesized (`src/coaching/offline.test.ts`), never the owner's voice.

## 8. The script

```
node scripts/coach.mjs <file...> [--json] [--take N]
node scripts/coach.mjs --list [folder...]
```

Each file is a coaching file, a backup or a WAV; the content says which, not the name. The analysis is `src/coaching/offline.ts` (TypeScript on the app's own analyzers), loaded through Vite's SSR loader: nothing to build, no extra dependency, about a second to start.

| Option | Meaning |
|---|---|
| `--json` | Print the structured diagnosis instead of the text (all takes, all figures, the graph lines). |
| `--take N` | Show take N in detail (1 = newest). With `--json`, only that take. The comparison always covers all. |
| `--exercise X` | A backup: which lesson to look at (default: the newest attempt's). A WAV: which exercise it is. `X` is an exercise id (`foundations.siren.1`), a level id (`foundations.05`) or part of a title (`sirens`). |
| `--attempt ID` | A WAV with a backup: the attempt it is (an id prefix is enough). |
| `--at TIME` | A WAV with a backup: the attempt nearest this time, for example `"2026-10-22 14:05"`. |
| `--profile NAME` | A backup: which profile (default: the one that sang most recently). |
| `--tonic NOTE` | A WAV: the key it was sung in (`A3` or a MIDI number), when no attempt names it. Without it the key is worked out from the audio, give or take a half step. |
| `--bpm N` | A WAV: the tempo, for a Runs ladder rung. Without it the rung is worked out from the WAV's length. |
| `--width N` | Columns of the pitch graph (default 96). |
| `--list [folder...]` | The newest pitch-lab files in the OneDrive folders and Downloads (or the folders given), newest first. |

What goes with what:

- A coaching file alone: its takes are re-analyzed from their saved pitch lines, exactly as the app did.
- A coaching file with a backup: the backup supplies the whole log, so the streak and the "Practise an earlier level" move are true past the five takes in the file.
- A coaching file with a WAV: the WAV is rebuilt into a pitch line with the app's own framer and detector and checked against the saved one (take 1, or `--take N`).
- A backup alone: where the singer is, and the last six attempts of one lesson from their saved numbers.
- A backup with a WAV: the WAV is matched to one attempt (the day in its name, then its length, or `--attempt` / `--at`), analyzed from the audio, and compared with that lesson's earlier attempts.
- A WAV alone: needs `--exercise`.

Exit status: 0 read; 1 a file could not be used or the analysis refused (the message says which and why); 2 bad usage; 3 an unexpected failure (a bug, with a stack).

## 9. What the read cannot tell you

- **The detector.** The app can run MPM or YIN (Settings). A coaching file names the one the takes were sung with (`settings.detector`), and so does a backup, per profile; the script rebuilds audio with it. A file from before that, or a WAV given alone, is rebuilt with MPM, the default, and the output says the file does not say. A saved pitch line is re-analyzed as it is: the detector only matters for audio.
- **A take sung folded into a narrow range.** The app rebuilds each take's target notes from the range saved now, moved to the key the take was sung in; nothing stored says the notes were folded by octaves when it was sung. If the Range finder was sung again since, a take that was folded (and so not judged) comes back unfolded, and the script judges it: it prints "Differs". Rare: the catalog keeps every exercise inside the narrowest range the Range finder saves.
- **The five takes.** A coaching file holds the last five. A streak printed as "at least N" is cut off there: add the backup for the true count.
- **A WAV starts at the downbeat.** The app trims it to start there (latency already allowed for), so a note sung before the beat is clipped, and the first attack of a WAV can read differently from the live take.
- **A backup has numbers only.** It says what the app measured, never where in the take it happened.
- **The catalog moves.** A coaching file carries the exercise as it was when exported; a backup is re-scored against today's catalog, and the output says when that disagrees with the saved score (the thresholds changed since).
- **What the app measures.** Pitch, loudness, timing and the shapes built from them. It cannot hear breath, tone colour, vowels or what the throat is doing; neither can this read. Say so when the owner asks about those.

## 10. For whoever maintains this

- `src/coaching/offline.ts` is pure (no file access) and exports what the script uses: `readCoachInput`, `analyzeInputs`, `formatDiagnosis`. The engine (`src/coaching/coach.ts`: `locateProblem`, `coachTake`, `missesInARow`, and `coachFrom` for a take with no pitch line) is called through `CoachEngine`, so a test can hand in a fake; a missing or failing engine never takes the diagnosis down, it is named in the output.
- The words of the card are the content ladders (`src/coaching/content`): one per tip id, the rule table's and the general tips' (no voice, stopped, unsung notes, not judged, a clean take, a miss no rule explains), checked by `content/index.test.ts`. Reply in the same words so the app and the chat never disagree.
- A coaching file the app writes is `src/coaching/types.ts` `CoachingFile`; its version (`COACHING_FILE_VERSION`) is checked on reading. Change the shape, bump the version, teach `parseCoachingFile` both.
- `src/coaching/offline.test.ts` runs the tool on synthesized takes (a clean Sirens take, one with a crack and stair-stepped slides, every exercise of the catalog, a WAV through the production framer, a backup, the file `export.ts` writes, and the CLI itself). To write sample files for a manual run: `COACH_SAMPLE_DIR=some/folder npx vitest run src/coaching/offline.test.ts -t "writes a sample"`.
- The checklist rows named in the output are static text in `PROVISIONAL` in `offline.ts`; keep them in step with docs/MANUAL-TEST-CHECKLIST.md.
