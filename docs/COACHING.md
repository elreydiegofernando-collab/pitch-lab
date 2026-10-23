# Coaching from the owner's takes ("Send to Claude")

On 2026-10-22 the owner, who is relearning to sing, asked for things the app cannot do alone:

> "I feel like the coaching tips should be where I'm messing up. And then each time I mess up or I need to improve or I'm just not getting it, it should have more and more advice to the point where it's hand walking me."

> "... in this chat, say, hey, this is the lesson that I'm at. Look at where my last progress is and ... analyze why I'm not able to get it."

> "I'd love to be able to practice on a song and get better at it." (and, about the first run: "the initial profile building should be like a singing, analyzing, like a test to see where you should start off ... if you can hold a note, but you have voice cracking and stuff, you should maybe practice voice cracking. Then you should have like assessment on where you've been and like how you've gotten better.")

The first is the app (the coaching card on the take report, `src/coaching/`). The rest is this page: the owner exports a file from the phone, and Claude, in chat, reads it with `scripts/coach.mjs` and says what is going wrong, what is getting better and what to try next. Four kinds of read: one **lesson** (a coaching file), one **song** (a song coaching file), the **voice check-ups** (from a backup), and the **whole log** (a backup).

Contents: [what the owner does](#1-what-the-owner-does-on-the-iphone) · [where the files land](#2-where-the-files-land-on-this-pc) · [the analyst's workflow](#3-the-analysts-workflow-claude) · [reading a lesson](#4-reading-a-lesson) · [reading a song](#5-reading-a-song) · [reading the check-ups](#6-reading-the-voice-check-ups) · [the singer or the app?](#7-the-singer-or-the-app) · [telling the owner](#8-telling-the-owner) · [privacy](#9-privacy) · [the script](#10-the-script) · [limits](#11-what-the-read-cannot-tell-you) · [maintaining it](#12-for-whoever-maintains-this)

## 1. What the owner does on the iPhone

**A coaching file** is the best thing to send about a lesson: the last five takes of one lesson, each with its pitch line, the notes it was sung against and what the app scored.

1. Open the lesson (its Level screen).
2. Tap **More**, then **Send to Claude**.
3. Leave **Include audio** off, unless Claude should re-run the audio itself (see "Audio" below). It is off every time the sheet opens.
4. Tap **Share**, then **Save to OneDrive** (or Files). The file is `pitch-lab-coach-<level>-<date>-<time>.json`, for example `pitch-lab-coach-foundations-05-2026-10-22-1405.json`.
5. Tell Claude in chat which lesson it is: "I'm on Sirens. Look at my last takes."

**A song coaching file** is the same for a song: the song as charted (notes, lyrics, phrases) and up to eight recent takes of it, each with the phrases it covered, its key and its speed, and its pitch line.

1. Open the song's progress screen and tap **Send to Claude** (the song player offers the same sheet after a few misses).
2. Leave **Include audio** off (it is off every time the sheet opens), tap **Share**, then **Save to OneDrive** (or Files). The file is `pitch-lab-coach-song-<title>-<date>-<time>.json`, for example `pitch-lab-coach-song-amazing-grace-2026-10-22-1900.json`.
3. Tell Claude which song: "Amazing Grace, I'm stuck on the third line."

Only takes that recorded their phrases are in the file (older song takes cannot say what they covered); they still count in the backup's tally.

**The voice check-ups** need no file of their own: every task of a check-up is an ordinary attempt tagged with the check-up's id, so they travel in the backup. The owner takes a check-up from Home (about four minutes, five short tasks), and again every few weeks.

More files answer other questions:

| File | How | What it holds |
|---|---|---|
| `pitch-lab-backup-YYYY-MM-DD.json` | Home, **Data & backup**, **Export backup** | Every attempt of every lesson and song as numbers (score, pass, each measure, and a song take's phrases, key and speed, and a check-up task's check-up id). No pitch lines, no audio. Shows where the singer is, how long a streak of misses really is, every voice check-up and its then-and-now, and the tally of every song. |
| `pitch-lab-take-YYYY-MM-DD.wav` | **Data & backup**, Recordings, **Export WAV** (Settings, **Keep take audio** must be on) | One take's audio. Claude rebuilds the pitch line from it. |

Audio: a coaching file holds pitch lines only. Ticking **Include audio** adds the WAV of each take that kept one; audio leaves the phone only on an export (SPEC §4). The pitch line is what the app judged, so the audio is for a cross-check (is the app hearing the voice right?), not for coaching.

## 2. Where the files land on this PC

OneDrive syncs the phone's "Save to OneDrive" into one of these (whichever account the owner saved to):

- `%USERPROFILE%\OneDrive\` (a personal account)
- `%USERPROFILE%\OneDrive - <organisation>\` (a work or school account)

The file is in the folder's root unless the owner picked a sub-folder in the share sheet. `node scripts/coach.mjs --list` looks in every folder of the home folder whose name starts with "OneDrive" (and the ones the OneDrive environment variables name), and in `%USERPROFILE%\Downloads` (where a file the owner mailed to themselves ends up), one folder level down in each, and prints the newest pitch-lab files first with their full paths, so there is nothing to hunt for. Each line says what the file is: `coach` (a lesson), `song` (a song), `backup` or `take`. It also takes folders to search: `--list "D:/somewhere"`. If OneDrive has not synced yet, the file is not there: wait a minute, or ask the owner to check that the upload finished.

## 3. The analyst's workflow (Claude)

1. **Find the files.** From the repo root:

   ```
   node scripts/coach.mjs --list
   ```

   Take the newest file whose kind, lesson or song and time match what the owner said: a `coach` file for a lesson, a `song` file for a song, a `backup` for "how am I doing overall" or "my check-up", a `take` WAV if the owner mentioned a recording.

2. **Run the script** on the path `--list` printed. Quote it: a work or school OneDrive folder has spaces.

   ```
   node scripts/coach.mjs "<the path --list printed>/pitch-lab-coach-foundations-05-2026-10-22-1405.json"
   ```

   `npm run coach -- <file>` is the same.

   Useful variations (more in [the script](#10-the-script)):

   ```
   node scripts/coach.mjs coach.json backup.json        # the backup supplies the whole log: true streak, passed levels
   node scripts/coach.mjs coach.json --take 2           # one take in detail (1 = the newest); the comparison still covers all
   node scripts/coach.mjs backup.json --exercise sirens # a backup, looking at one lesson
   node scripts/coach.mjs song.json backup.json         # a song, with its whole history and the true streak
   node scripts/coach.mjs song.json --take 2            # one take of a song in detail, with its graphs
   node scripts/coach.mjs song.json --phrase 3          # phrase 3 drawn in every take that covers it
   node scripts/coach.mjs backup.json --checkup         # the voice check-ups alone: skills, focus, then and now
   node scripts/coach.mjs take.wav backup.json          # a WAV, matched to the backup's attempt (by day and length)
   node scripts/coach.mjs take.wav --exercise foundations.05 --tonic A3   # a WAV alone, when nothing else names the lesson and key
   node scripts/coach.mjs coach.json --json             # the same, as JSON (every figure, every take)
   ```

3. **Read it** ([a lesson](#4-reading-a-lesson), [a song](#5-reading-a-song), [the check-ups](#6-reading-the-voice-check-ups)): the "In short" lines first, then the newest take, then "Across the takes".
4. **Decide: the singer, or the app being too strict** ([the singer or the app?](#7-the-singer-or-the-app)). A repeated miss that is a hair under a threshold is not the same news as one that is far off. A steady lateness on every note is not the singing at all.
5. **Answer the owner in plain words** ([telling the owner](#8-telling-the-owner)): where it goes wrong, why, and one thing to try on the next take. Never paste the script's output at the owner: it is full of units.
6. **Offer the next step**: another take (and a new file to look at it), an easier way in, or an earlier level to practise (only one the owner has passed).

If the script says a file is bad, it prints which and why and exits non-zero. A newer app than the script (a file version above what the script reads) means: pull the repo and try again.

## 4. Reading a lesson

The text is ASCII, in engineering units (cents, milliseconds, Hz), written for the analyst. Top to bottom:

- **Header.** The singer, the lesson and what it asks, the pass rule (score plus gates, and the in-tune band of the level), how many takes and where their numbers came from, the **streak** (misses in a row, and so the coaching depth the app was at, 1 to 4), and whether the coaching engine answered.
- **In short.** Five lines or fewer: the newest take's verdict and the gates it missed, the coach's pick, the streak, the trend over the takes, and the first singer-or-app read. Start here.
- **Take n.** Newest first. Each take has:
  - *Verdict*: score against the pass mark, which gates failed and by how much (a **near miss** is within a tenth of the score band), what cost the most score, and the level's own rules (a take stopped early, notes left unsung, a lower rung of a Runs ladder, an exercise folded into a narrow saved range). It also says whether the app's own record of the take agrees with this re-analysis; a difference is explained below the verdict. A take that was one task of a voice check-up says so on its "Sung:" line.
  - *Score and gates*, *score terms*: every number against its target, and how many points of the final score each term cost, costliest first.
  - *Located problem*: the coaching engine's answer (`src/coaching/coach.ts`): the tip it picked, one plain sentence with plain numbers, and where in the take it shows, worst first.
  - *What the app tells the singer*: the card as the singer read it at that depth (tip, why, steps, an easier way in), so you do not contradict it. Only the first take shown gets the full card.
  - *What the analysis noticed*: patterns across the notes ("sharp on 5 of 7 held notes", "came in late on 4 of 8", "the voice sagged during long holds", "stair steps on 6 of 6 slides").
  - *Figures*: one line for what each analyzer found (held notes, attacks, glides, cracks, runs, vibrato, ...). `!!` marks the ones that count against the take.
  - *Pitch graph*: time across, notes down, one row a half step. `=` is the target, `*` is what was sung (it hides the bar where the singer was on it), `x` is a crack. A bar with no `*` on it is where the singer was not.
- **Across the takes.** Oldest to newest: score, failed gates and the coach's pick per take; a table of every measure the level judges, take by take, with its gate and how often the gate was missed; what improves, what gets worse, what repeats (a gate missed again and again, the same tip, the same trouble spots); and the singer-or-app read.
- **A backup** adds *Where the singer is* (levels passed, the level up next, recent lessons with their streaks, the songs sung and a count of voice check-ups) and reads the numbers of the lesson in focus. It cannot place a problem in a take, since it has no pitch line: ask for a coaching file for that.

## 5. Reading a song

`node scripts/coach.mjs song.json [backup.json]` prints **PITCH LAB SONG READ**. The score of every take is re-computed from its pitch line exactly as the song player computed it (`analysis/phrases.ts` `scoreSongPhrases`, on the take's own clock with the notes slowed to the take's speed: `runtime/song-session.ts` `scoreSongSegment`), then taken apart note by note and syllable by syllable. The line "The app recorded: pass at 97% (the same as this analysis)" is the proof that the rebuild is the take the owner sang; when it says DIFFERS, read the explanation under it first (another build, another chart, a take stopped early, a pitch line that is not this take's).

Top to bottom:

- **Header.** The singer, the song (its phrases are counted from 1, as the app shows them; only scored phrases count: a spoken or rapped one has no number), the takes, the **streak** (misses in a row on exactly the newest take's phrases, speed and key not counted; with a backup it is the true count, else "at least" the file's takes) and whether the song coach (`src/coaching/song.ts`) answered.
- **In short.** The newest take with its phrases, speed and key; its worst syllables; the song coach's pick; the streak; the trend; the first singer-or-app read.
- **The phrases in these takes**, **the history** (with a backup: every take of the song in the log, the first, best and latest, by phrases, and the last twelve; a take logged before takes said what they covered is "an older take" with no speed or key) and **where the singer is** (the practice path of `src/song/practice.ts`: the next step, and each phrase's best and latest full-speed take; only takes of a phrase on its own count towards it).
- **Take n** (newest first):
  - `Sang:` the phrases, the speed, the key ("2 half steps up from the chart's key; the notes sit D4-A4 here") and the words of up to three phrases.
  - *Verdict*: the duration-weighted phrase score against the 70% pass mark (`SONG_PASS_SCORE`); the weakest phrase; whether the app agrees. A take stopped by hand is judged on the phrases that had ended, as the player judged it ("Judged: 2 of 3 phrases").
  - *Phrases*, one line each: the app's pitch score, the share of the phrase in tune, timing (the median of the notes' onsets in real milliseconds, + = late; the alignment looks 200 ms either side of each note), steadiness (the spread of long notes, measured from each note's written start: a singer who is late looks unsteady to it) and whether vibrato was heard.
  - *Worst syllables*, lowest score first, each with what was off, in plain engineering units ("flat by 38 cents, 180 ms late, wavered (spread 31 cents)"). A syllable on several notes (a melisma) is named by its first note and says which note was off.
  - *Located problem* and *What the app tells the singer*: the song coach's answer, as for a lesson, so you do not contradict it.
  - *What the analysis noticed*: patterns across the notes, each with the song tip id it would be (`src/coaching/song-tips.ts`): a steady lean flat or sharp (`song.flat`, `song.sharp`), the highest or lowest notes off (`song.high`, `song.low`), landings after big jumps (`song.leap`), lateness (`song.late`, `song.early`), notes left unsung (`song.unsung`), breaks in the voice (`song.cracks`), the sound dropping out inside a note (`song.breath`), long notes wavering or sinking (`song.unsteady`), and singing an octave away (not counted against the score: scoring ignores octaves on purpose).
  - *Pitch graph*, for the first take shown (the worst phrases of it that did not pass, at most three, and always the worst one): notes down in half steps, **song time** across (a slowed take is mapped back: song time = the start of the take's window + take time x speed, so a phrase reads the same at any speed), `=` the written note where nothing was sung, `*` the sung line, `x` a break. The syllables are written under the time axis, and under a syllable that went wrong a letter says how: **F** flat, **S** sharp, **W** wrong note, **L** late, **E** early, **U** unsung, **T** cut short, **V** wavered, **D** sank, **X** voice broke, **O** sound dropped out. `--take N` draws that take's graphs; `--phrase N` draws phrase N in every take that covers it.
- **Across the takes**: oldest to newest, with each take's phrases, speed and key; the app's scores; **phrase by phrase** from the pitch lines (`*` = a slowed take: a slowed take is easier, so full-speed takes are compared with each other when there are two); what improves, what gets worse, and the trouble spots that come back (the same syllable among a take's worst in two or more takes, with how it went wrong).

How a note is judged (PROVISIONAL, `SONG_READ` in `offline.ts`; the lines sit near the song coach's own, but it is a separate reading, so a disagreement between the two is itself information): left **unsung** under a quarter of its length sung, **cut short** under 60%, **a different note** 70 cents or more from the written one, **flat or sharp** past 25 cents, **late or early** 150 real milliseconds or more, **wavering** (a long note, 0.75 s or more, with a spread of 25 cents or more from 150 ms after it arrived, and no vibrato: a regular vibrato found by the app's own analyzer swings the pitch on purpose and is not wavering) or **sinking** (15 cents a second), **dropped** when the sound stops for 250 ms or more inside one note. A **break** is a jump of the pitch (over 200 cents within 30 ms) that the written melody does not explain: a jump that matches the written step between two notes within 0.35 s of it, whole octaves aside, is the melody; a flip that comes straight back is one break, with how long it stayed away ("+5 half steps for 150 ms, then back"). A pitch detector that locks onto a harmonic for a few frames looks the same as a break: when one is very short (under about 60 ms) and far (an octave or a twelfth), ask for the audio (Include audio) before telling the owner their voice cracked.

## 6. Reading the voice check-ups

`node scripts/coach.mjs backup.json --checkup` (or the same without the flag, after the lesson read) prints **PITCH LAB CHECK-UPS**. A check-up is the attempts that share a check-up id; it counts once its last task was sung, and a task sung twice counts by its latest take (`src/checkup/summary.ts`). Five tasks, in the order they are sung: the Range finder, then the four Foundations placement tests (match and hold a note, a siren, short notes that jump, a connected line).

- **In short.** How many check-ups are finished (and how many were started and left), the newest one's ratings, its focus, where it says to start, the then-and-now against the one before, and whether a re-check is due (suggested three weeks after the last).
- **Check-up n.** Each check-up, oldest first: its tasks (passed or missed with the score, or "not sung"), then each skill: **Range**, **Pitch**, **Steadiness**, **Slides**, **Note starts**, **Connected lines**, with the app's rating, the app's plain sentence about it and the numbers it is read from (for example "Breaks 5", "In tune 72%"). The ratings are never grades: **Solid**, **Getting there**, **Focus here**, or "not measured" (a task skipped, silent or stopped early). The range is measured, not graded: an octave or more is **Solid**, and only a span short of it is rated lower. Then the focus (one or two skills, the most basic first), the starting point (the first Foundations level still to pass, and the levels this check-up's placement tests opened: a test grants only when it was the placement audition's next test as it was sung, so in order, never past Foundations, and a test passed after a missed one grants nothing, then or later), and the range in note names when this check-up's Range finder saved the range the profile has now. A check-up that was left unfinished is not rated: it lists what its sung tasks measured.
- **Then and now.** Each finished check-up against the one before it (and, from three on, the first against the last): the app's own lines and headline, the ratings side by side, and every measure the battery reads, side by side with which way it moved. A move smaller than the usual noise (a half step of range, 5 points of in-tune time, one break, 40 ms of settling, and so on: `CHECKUP_MOVES` in `offline.ts`, the analyst's yardstick and not the app's) reads "same". A rating can flip on a small move at a band's edge: judge by the numbers, not only the label.

A backup holds only the number of breaks on the siren, never where in the slide they were. To see where the voice flips (the owner's own example is a crack around one note), ask for a coaching file of *Sirens* (foundations.05) or of a song, which carry pitch lines.

Foundations was rebuilt as lessons on 2026-10-23. Its rebuilt exercises have new ids (`foundations.range.1`, `foundations.match.1`, `foundations.hold.1`, `foundations.steady.1`, `foundations.jumps.1`, `foundations.jumps.2`, `foundations.five-notes.1`, `foundations.sirens.1`, `foundations.clean-starts.1`, `foundations.boss-tune`, and the audition tests `foundations.audition.5` to `.8`), and Hold it steady is level `foundations.13`. Takes sung before the rebuild keep their old exercise ids (`foundations.sustain.2`, `foundations.siren.1`, `foundations.audition.1` to `.4` and so on): those retired exercises stay in the catalog, so the tool reads old takes against what was actually sung. A level or a title flag (`--exercise foundations.05`, `--exercise sirens`) names the exercise the level plays today; pass an old exercise id to read takes from before the rebuild.

## 7. The singer or the app?

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
| A song take is within five points of 70% in several takes | **Maybe the app** | P14 (song scoring) and D4 (is 70% the right pass mark?). |
| Almost every syllable of a song take is late (or early) by the same amount, take after take | **The app (timing)** | The latency calibration: S2 and S3. Ask the owner to calibrate again in Setup before anything else. |
| A song take scores well but was sung an octave from the notes | **The app forgives it** | P14: scoring is octave-agnostic on purpose. Check the key suits the voice; say so if the singer did not know. |
| "Only 8% of the voiced frames fall near a note", or the app logged a longer take than the phrases take | **The file** | The pitch line is not this take of this chart (a re-imported or edited chart, another speed or phrases than the file says). Ask for the file again, right after a take. |
| A song take misses on speed and passes slowed (the hint says so) | **The singer, and it is good news** | The notes are within reach; the speed is what is missing. Step up gently. |
| A check-up skill sits at the edge between two ratings, and flips between check-ups on a small move | **Maybe the app** | Rating bands are PROVISIONAL (`NEAR_PASS` in `checkup/summary.ts`): read the numbers behind the rating. |

Which checklist row a metric touches (lessons):

| Metrics | Row | Where the numbers live |
|---|---|---|
| In tune, Typical miss, How steady, Off the middle by, Drift | P2 (late start), P1 (voicing) | `CONFIG.accuracy.lateStartAllowanceSec`, `CONFIG.audio` |
| Time to find the note, Scoop, Going past the note, Clean starts | P3 | `CONFIG.onset`, `analysis/onset.ts` |
| Vibrato heard, In the vibrato zone, Vibrato evenness, Vibrato off the note by | P4 | `CONFIG.vibrato`, `analysis/vibrato.ts` |
| Clean switches, Vibrato on cue | P5 | `analysis/switch.ts` |
| Pulse speed off by, Pulse evenness | P6 | `analysis/pulse.ts` |
| Breaks, Smoothness, Slide ending off by | P7 | `CONFIG.transitions`, `analysis/glide.ts` |
| Clean changes | P8 | `analysis/transitions.ts`, `analysis/dtw.ts` |
| Shape match, Landing | P9 | `analysis/inflections.ts` |
| Run score, Defined notes, Missed notes | P10 | `CONFIG.runs`, `analysis/runs.ts` |
| Soft to loud, Pitch as the loudness changed, Even swell | P11 | `CONFIG.dynamics`, `analysis/dynamics.ts` |
| Low to high (range) | P12 | `CONFIG.range` |
| Level far easier or harder than its tier | P13 | `exercises/catalog/scoring.ts` |
| Song scores, timing, the pass mark | P14, D4 | `SONG_PASS_SCORE`, `CONFIG.song`, `analysis/phrases.ts`, `analysis/dtw.ts` |
| Unsung notes | P17 | `REACH` in `exercises/analyze.ts`, `MIN_REACH_SHARE` |

When you do propose a change, say which constant, which way, and what the take showed that supports it (for example "Smoothness 24% against a 25% gate in all four takes, and the graph shows a clean slide").

## 8. Telling the owner

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
| song: `phrase 2 "stars" ... flat by 38 cents` | "the word 'stars' came out a little under the note" |
| song: `a different note: 2 half steps under the written one` | "on 'stars' you landed two notes down, on the note before it" |
| song: `180 ms late` on one word | "you came in a little after the beat on 'night'" |
| song: "almost every note is late by the same amount" | "everything is a hair behind the beat by the same amount: that looks like the phone's timing, not you, so let's set the timing again" |
| song: `the sound dropped out inside "now" (350 ms)` | "the sound stopped for a moment in the middle of 'now': a fuller breath just before it will carry you through" |
| song: `break near D4 at 0:06.6 (+5 half steps for 150 ms, then back)` | "your voice flipped up and came back on 'ly': that is normal where a voice changes gears, and it is something to practise slowly" |
| song: `left unsung: "bright", "ly"` | "a couple of words were left out: 'bright' and 'ly'. Try humming them once, then sing the words" |
| song: "sung an octave below the written note" | "you sang it an octave lower than written. The score does not mind, but check the key is comfortable" |
| check-up: `Slides  Focus here ... Breaks 5` | "your voice broke five times on the slide, which is common where a voice changes gears: sirens are the thing to practise" |
| check-up then and now: `Breaks 5 -> 1`, `Low to high 12 -> 17 half steps` | "your breaks are down from five to one, and your range is five notes wider" |

How to say a check-up (the owner's own words were "how you've gotten better"): the ratings are **Solid**, **Getting there** and **Focus here**; never a grade, a score out of anything or the word "fail". Cracking where the voice changes gears is normal for someone coming back to singing: it is something to focus on, never a failing. Say what is already solid first ("you hold a steady note"), then the one or two things to focus on, then the change since last time. The check-up only opens levels inside Foundations, in order; it never opens a later world, and everything past it is still earned.

Hand-walk it, as the owner asked: the located spot first ("the second slide up, near the middle", "the word 'stars' in the second line"), why it happens in one sentence, then three to five small steps for the next take. Use what the app already told the singer (its card at that depth) as the base, so the two never disagree. A passing take gets what to do next, not a lecture.

## 9. Privacy

The owner's exports are personal: pitch lines, scores and (if included) the voice itself. They are never committed and never leave this PC.

- `.gitignore` covers `pitch-lab-coach-*.json` (a lesson's and a song's), `pitch-lab-backup-*.json` and `pitch-lab-take-*.wav` wherever they are in the repo. Check with `git check-ignore -v <file>` if one was copied in. A song file also holds the song's chart (a bundled chart, or the owner's own import: his own files stay his).
- The script only reads files you name (or lists the OneDrive folders and Downloads). It makes no network request and writes nothing.
- Do not paste a file's contents (a pitch line is base64) or a WAV anywhere else. The text diagnosis is fine to read in chat.
- Samples for tests are synthesized (`src/coaching/offline*.test.ts`), never the owner's voice.

## 10. The script

```
node scripts/coach.mjs <file...> [--json] [--take N] [--phrase N] [--checkup]
node scripts/coach.mjs --list [folder...]
```

Each file is a coaching file, a song coaching file, a backup or a WAV; the content says which, not the name. The analysis is `src/coaching/offline.ts` (TypeScript on the app's own analyzers), loaded through Vite's SSR loader: nothing to build, no extra dependency, about a second to start.

| Option | Meaning |
|---|---|
| `--json` | Print the structured diagnosis instead of the text (all takes, all figures or syllables, the graph lines). |
| `--take N` | Show take N in detail (1 = newest). With `--json`, only that take. The comparison always covers all. For a song, the take shown gets its graphs. |
| `--phrase N` | A song file: draw phrase N (1 = the first phrase of the song) in every take that covers it, instead of the worst few. |
| `--checkup` | A backup: read only its voice check-ups (an error when it has none). Without it a backup prints its lesson read, and its check-ups after it when it holds any. |
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
- A song file alone: its takes are re-scored and taken apart from their saved pitch lines; the history and the streak are from the takes in the file.
- A song file with a backup: the whole history of the song, the practice path over every take of it, and the true streak. The backup is the song's log here, not a read of its own.
- A song file with a WAV: the WAV is checked against the newest take's saved pitch line (or `--take N`), or stands in for it when the take kept none.
- A backup alone: where the singer is, the last six attempts of one lesson from their saved numbers, the tally of each song, and the voice check-ups with their then-and-now.
- A backup with a WAV: the WAV is matched to one attempt (the day in its name, then its length, or `--attempt` / `--at`), analyzed from the audio, and compared with that lesson's earlier attempts.
- A WAV alone: needs `--exercise`.

Exit status: 0 read; 1 a file could not be used or the analysis refused (the message says which and why); 2 bad usage; 3 an unexpected failure (a bug, with a stack).

## 11. What the read cannot tell you

- **The detector.** The app can run MPM or YIN (Settings). A coaching file names the one the takes were sung with (`settings.detector`), and so do a song coaching file and a backup (per profile); the script rebuilds audio with it. A file from before that or a WAV given alone is rebuilt with MPM, the default, and the output says the file does not say. A saved pitch line is re-analyzed as it is: the detector only matters for audio.
- **A take sung folded into a narrow range.** The app rebuilds each take's target notes from the range saved now, moved to the key the take was sung in; nothing stored says the notes were folded by octaves when it was sung. If the Range finder was sung again since, a take that was folded (and so not judged) comes back unfolded, and the script judges it: it prints "Differs". Rare: the catalog keeps every exercise inside the narrowest range the Range finder saves.
- **The five takes, and the eight.** A coaching file holds the last five takes of a lesson, a song file the last eight of a song. A streak printed as "at least N" is cut off there: add the backup for the true count. The backup has the older takes' numbers but never their pitch lines.
- **A WAV starts at the downbeat.** The app trims it to start there (latency already allowed for), so a note sung before the beat is clipped, and the first attack of a WAV can read differently from the live take.
- **A backup has numbers only.** It says what the app measured, never where in the take it happened. That holds for the voice check-ups too: it has the number of breaks on the siren, not where they were.
- **The catalog moves.** A coaching file carries the exercise as it was when exported; a backup is re-scored against today's catalog, and the output says when that disagrees with the saved score (the thresholds changed since).
- **A song file carries the chart as it was exported.** The window a take was sung over (a second before the first note of its phrases, in the song as sung, which is the chart moved by the take's key) is rebuilt from that chart and the phrases the take names, and the pitch line is read against it. If the chart was edited or re-imported since, or the phrases, key or speed in the file are not the ones the take was sung with, the take scores low or "DIFFERS": the "Only N% of the voiced frames fall near a note" and "the app logged a longer take" checks say so. A pitch line saved already mapped onto the song's own clock (the form the song coach is handed) is recognised by where it ends and put back on the take's clock.
- **The per-note read is this tool's own.** The score of every note is the app's (the phrase scorer on the note alone, over the same alignment); *which way* it was off, how much of it was sung, breaks and dropouts are this tool's reading, with provisional lines. Two notes on the same pitch one after the other cannot be told apart by pitch, so the join between them is put at the written time and their timing reads as nothing.
- **What the app measures.** Pitch, loudness, timing and the shapes built from them. It cannot hear breath, tone colour, vowels or what the throat is doing; neither can this read. Say so when the owner asks about those.

## 12. For whoever maintains this

- `src/coaching/offline.ts` is pure (no file access) and exports what the script uses: `readCoachInput`, `analyzeReports` (everything: lessons, songs, check-ups) and `formatReport`; `analyzeInputs` and `formatDiagnosis` are the lesson reads on their own. The engines it reads from are called through small interfaces, so a test hands in fakes: `CoachEngine` (`src/coaching/coach.ts`: `locateProblem`, `coachTake`, `missesInARow`, and `coachFrom` for a take with no pitch line), `SongCoachEngine` (`coaching/song.ts`: `coachSongTake`, `songMissesInARow`; `song/practice.ts`: `songPractice`) and `CheckupEngine` (`checkup/summary.ts`: `checkupsOf`, `compareCheckups`, `recheckDue`). A missing or failing engine never takes a read down, it is named in the output.
- The words of the card are the content ladders (`src/coaching/content`): one per tip id, the rule table's, the general tips' and the song tips' (`song-tips.ts`), checked by `content/index.test.ts`. Reply in the same words so the app and the chat never disagree.
- A coaching file the app writes is `src/coaching/types.ts` `CoachingFile`, a song file `SongCoachingFile` (written by `coaching/song-export.ts`); both carry `COACHING_FILE_VERSION`, checked on reading. Change the shape, bump the version, teach `parseCoachingFile` and `parseSongCoachingFile` both.
- The song reads restate a few rules of `runtime/song-session.ts` (the window of a take, how its phrases are scored, the lead and tail): that module drags in the audio engine and the app's state, which a Node script cannot load. `offline.song.test.ts` holds each restatement to the player's own value, so a change in the player fails a test here; keep them in step. The pass mark is imported from `song/practice.ts`.
- `src/coaching/offline.test.ts` runs the tool on synthesized lessons (a clean Sirens take, one with a crack and stair-stepped slides, every exercise of the catalog, a WAV through the production framer, a backup, the file `export.ts` writes, and the CLI itself). `offline.song.test.ts` does the same for songs (a small hymn sung with a flat note, a break, a dropout, an unsung note, a steady lateness, an octave off; slowed and transposed; stopped early; with and without a backup; fake and real engines; the CLI), and `offline.checkup.test.ts` for check-ups (two finished and one unfinished, the engine built, not built and failing, the re-check, the CLI). To write sample files for a manual run (a lesson's coaching file, a song file, backups with songs and with check-ups, and a WAV, all synthesized): `COACH_SAMPLE_DIR=some/folder npx vitest run src/coaching/offline -t "writes a sample"`.
- The checklist rows named in the output are static text in `PROVISIONAL` in `offline.ts` (lessons) and in the hints of `compareSongTakes` (songs); keep them in step with docs/MANUAL-TEST-CHECKLIST.md. The lines a song note is judged by are `SONG_READ`, the yardstick for check-up moves `CHECKUP_MOVES`: all provisional, all in `offline.ts`.
