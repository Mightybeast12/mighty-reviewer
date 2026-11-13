/**
 * The branch review store (the tooling reviewer's backlog B15): one private
 * JSON file per reviewed range, so review_branch's results survive a plugin
 * reload (OpenCode 2 imports the module afresh, and its in-memory list goes
 * with it) and can be read by another process of the same user. It holds
 * what review_branch answers with (the range, the verdict, the report) and
 * what an adopting copy needs (the review's session id, the process that
 * runs it, its deadline). index.js decides what to store and when.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_VERSION = 1;

// The fields of a branch review entry that are stored; the rest (timers,
// the checkout's grant) only make sense inside the process that made them.
const STORED_FIELDS = [
  "key",
  "root",
  "baseRef",
  "headRef",
  "baseSha",
  "headSha",
  "files",
  "lines",
  "worktree",
  "status",
  "verdict",
  "report",
  "requestedBy",
  "reviewSessionID",
  "startedAt",
  "finishedAt",
  "deadline",
  "pid",
];

export function defaultBranchStoreDir() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(data, "mighty-reviewer", "branch-reviews");
}

/** The file the entry for `key` is stored in. */
export function branchStoreFile(dir, key) {
  return fileFor(dir, key);
}

function fileFor(dir, key) {
  return path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}

function readEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8"));
    if (entry?.version !== STORE_VERSION || typeof entry.key !== "string" || typeof entry.status !== "string") return null;
    return entry;
  } catch {
    return null;
  }
}

/** The stored entry for `key`, or null (none, unreadable, another version). */
export function loadBranchReview(dir, key) {
  const entry = readEntry(fileFor(dir, key));
  return entry && entry.key === key ? entry : null;
}

/** Every readable stored entry; a file the store cannot read is skipped. */
export function loadBranchReviews(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => readEntry(path.join(dir, name))).filter(Boolean);
}

/**
 * Writes `state` for `key` (private folder and file, written whole through
 * a temporary file and a rename), then keeps at most `max` finished
 * entries, the newest. Best-effort: a store that cannot be written costs
 * the reload safety, never the review. Returns whether the write landed.
 */
export function saveBranchReview(dir, key, state, max = 50) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = { version: STORE_VERSION };
    for (const field of STORED_FIELDS) if (state[field] !== undefined) entry[field] = state[field];
    entry.key = key;
    const file = fileFor(dir, key);
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    return false;
  }
  pruneBranchStore(dir, max);
  return true;
}

/** Removes the stored entry for `key`, if any. */
export function forgetBranchReview(dir, key) {
  try {
    fs.rmSync(fileFor(dir, key), { force: true });
  } catch {
    // Best-effort, as every store write.
  }
}

// A write in flight lives at most seconds as a .tmp file; one older than
// this was left by a write that crashed before its rename.
const STALE_TMP_MS = 3600 * 1000;

function pruneBranchStore(dir, max) {
  let all = [];
  try {
    all = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of all.filter((n) => n.endsWith(".tmp"))) {
    try {
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });
    } catch {
      // Gone already, or not ours to read: best-effort.
    }
  }
  const names = all.filter((name) => name.endsWith(".json"));
  const finished = names
    .map((name) => ({ name, entry: readEntry(path.join(dir, name)) }))
    .filter(({ entry }) => entry && entry.status !== "running")
    .sort((a, b) => (b.entry.finishedAt ?? b.entry.startedAt ?? 0) - (a.entry.finishedAt ?? a.entry.startedAt ?? 0));
  for (const { name } of finished.slice(max)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Best-effort.
    }
  }
}
