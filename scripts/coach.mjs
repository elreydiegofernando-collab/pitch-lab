#!/usr/bin/env node
/**
 * Pitch Lab coaching read: the diagnosis of the takes the owner sends from the phone, for Claude to read in chat.
 *
 *   node scripts/coach.mjs <file...> [--json] [--take N]
 *   node scripts/coach.mjs --list
 *
 * Each file is a coaching file ("Send to Claude": pitch-lab-coach-*.json), a backup (pitch-lab-backup-*.json) or a take WAV
 * (pitch-lab-take-*.wav); what it is is read from its content, not its name. docs/COACHING.md is the workflow.
 *
 * The analysis is src/coaching/offline.ts. It is TypeScript on the app's own modules, so it is loaded through Vite's SSR module
 * loader (a dev server in middleware mode that never listens on a port): the TypeScript and the bundler-style imports just
 * work, with nothing to build and no dependency beyond the repo's own.
 *
 * Exit status: 0 = read; 1 = a file could not be used (the message says which and why) or the analysis refused; 2 = bad usage;
 * 3 = an unexpected failure (a bug: the stack is printed).
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  node scripts/coach.mjs <file...> [options]
  node scripts/coach.mjs --list [folder...]

Files (any mix; the content says what each one is):
  pitch-lab-coach-*.json    coaching file ("Send to Claude"): up to 5 takes with their pitch lines
  pitch-lab-backup-*.json   backup: the numbers of every attempt, no pitch lines
  pitch-lab-take-*.wav      one take's audio (sample 0 is the downbeat)
With a coaching file, a backup given too supplies the whole log (streak, progress) and a WAV is matched to the newest take
(or --take N). With a backup, each WAV is matched to one of its attempts. A WAV alone needs --exercise.

Options:
  --json             print the structured diagnosis (JSON) instead of the text
  --take N           show take N in detail (1 = newest); the comparison still covers them all
  --exercise X       an exercise id (foundations.siren.1), a level id (foundations.05) or part of a title ("sirens")
  --attempt ID       with a backup and a WAV: the attempt this WAV is (an id prefix is enough)
  --at TIME          with a backup and a WAV: the attempt nearest this time, e.g. "2026-10-22 14:05"
  --profile NAME     with a backup: which profile (default: the one that sang most recently)
  --tonic NOTE       a WAV's tonic, as a note name (A3) or a MIDI number, when no attempt names it
  --bpm N            a WAV's tempo (a Runs ladder rung), when no attempt names it
  --width N          columns of the pitch graph (default 96)
  --list [folder...] list the newest pitch-lab files in the OneDrive folders and Downloads (or the folders given)
  --help             this text
`;

const VALUE_FLAGS = new Set(['take', 'exercise', 'attempt', 'at', 'tonic', 'bpm', 'profile', 'width']);
const BOOL_FLAGS = new Set(['json', 'list', 'help']);

/**
 * Where the share sheet's "Save to OneDrive" lands on this PC (docs/COACHING.md): every folder in the home folder whose
 * name starts with "OneDrive" (a personal "OneDrive" and a work or school "OneDrive - <organisation>"), and the folders
 * Windows names in the OneDrive environment variables; plus Downloads, for a file the singer mailed to themselves.
 */
async function defaultFolders() {
  const home = homedir();
  const folders = [];
  try {
    for (const entry of await readdir(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /^OneDrive/i.test(entry.name)) folders.push(path.join(home, entry.name));
    }
  } catch {
    // an unreadable home folder: the environment variables and Downloads still count
  }
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (process.env[name]) folders.push(process.env[name]);
  }
  folders.push(path.join(home, 'Downloads'));
  return [...new Set(folders.map((f) => path.resolve(f)))];
}

const WANTED = /^pitch-lab-(coach-.+\.json|backup-.+\.json|take-.+\.wav)$/i;

/** The pitch-lab files in `folder` and its immediate sub-folders (a share sheet may save into any of them). */
async function findFiles(folder) {
  const found = [];
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isFile() && WANTED.test(entry.name)) {
      found.push(full);
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      let inner = [];
      try {
        inner = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of inner) if (f.isFile() && WANTED.test(f.name)) found.push(path.join(full, f.name));
    }
  }
  return found;
}

async function listFiles(folders) {
  const rows = [];
  for (const folder of folders) {
    for (const file of await findFiles(folder)) {
      try {
        const s = await stat(file);
        rows.push({ file, mtime: s.mtime, size: s.size });
      } catch {
        // gone since the listing: skip it
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  if (rows.length === 0) {
    const where = folders.map((f) => `  ${f.replace(/\\/g, '/')}`).join('\n');
    process.stdout.write(`No pitch-lab-coach-*.json, pitch-lab-backup-*.json or pitch-lab-take-*.wav found in:\n${where}\n`);
    return;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const kind = (f) => (/coach-/i.test(path.basename(f)) ? 'coach ' : /backup-/i.test(path.basename(f)) ? 'backup' : 'take  ');
  const lines = rows.map((r) => `  ${stamp(r.mtime)}  ${kind(r.file)}  ${String(Math.max(1, Math.round(r.size / 1024))).padStart(6)} KB  ${r.file.replace(/\\/g, '/')}`);
  process.stdout.write(`Newest first (by the time each file was saved):\n${lines.join('\n')}\n`);
}

/** Splits argv into the files and the options; throws a usage error for anything it does not know. */
function parseArgs(argv) {
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      opts.help = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = (eq < 0 ? arg.slice(2) : arg.slice(2, eq)).trim();
      if (BOOL_FLAGS.has(name)) {
        opts[name] = true;
      } else if (VALUE_FLAGS.has(name)) {
        const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        opts[name] = value;
      } else {
        throw new UsageError(`unknown option --${name}`);
      }
    } else {
      files.push(arg);
    }
  }
  return { files, opts };
}

class UsageError extends Error {}

function positiveNumber(opts, name) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} needs a positive number, not "${opts[name]}"`);
  return n;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`coach: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  const { files, opts } = parsed;
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.list) {
    await listFiles(files.length > 0 ? files.map((f) => path.resolve(f)) : await defaultFolders());
    return 0;
  }
  if (files.length === 0) {
    process.stderr.write(`coach: no file given\n\n${USAGE}`);
    return 2;
  }
  let take;
  let bpm;
  let width;
  try {
    take = positiveNumber(opts, 'take');
    bpm = positiveNumber(opts, 'bpm');
    width = positiveNumber(opts, 'width');
  } catch (e) {
    process.stderr.write(`coach: ${e.message}\n`);
    return 2;
  }

  let status = 0;
  const server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    clearScreen: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    let offline;
    try {
      offline = await server.ssrLoadModule('/src/coaching/offline.ts');
    } catch (e) {
      process.stderr.write(`coach: could not load the analysis (src/coaching/offline.ts): ${e?.message ?? e}\n`);
      return 3;
    }
    const inputs = [];
    for (const file of files) {
      let bytes;
      try {
        bytes = await readFile(file);
      } catch (e) {
        process.stderr.write(`coach: ${file}: cannot read the file (${e?.code ?? e?.message ?? e})\n`);
        status = 1;
        continue;
      }
      try {
        inputs.push(offline.readCoachInput(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), path.basename(file)));
      } catch (e) {
        process.stderr.write(`coach: ${e?.message ?? e}\n`);
        status = 1;
      }
    }
    if (inputs.length === 0) return status || 1;

    const runOpts = { take, bpm, width, exercise: opts.exercise, attempt: opts.attempt, at: opts.at, tonic: opts.tonic, profile: opts.profile };
    const results = offline.analyzeInputs(inputs, runOpts);
    if (opts.json) {
      const shaped = results.map((d) => (take === undefined ? d : { ...d, takes: d.takes.filter((t) => t.index === take) }));
      process.stdout.write(`${JSON.stringify(shaped, null, 2)}\n`);
    } else {
      process.stdout.write(results.map((d) => offline.formatDiagnosis(d, { take })).join('\n'));
    }
    return status;
  } catch (e) {
    if (e?.name === 'CoachInputError') {
      process.stderr.write(`coach: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`coach: unexpected failure, a bug in the tool:\n${e?.stack ?? e}\n`);
    return 3;
  } finally {
    await server.close();
  }
}

process.exitCode = await main();
