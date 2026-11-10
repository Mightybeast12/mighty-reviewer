/**
 * Branch review (the tooling reviewer's backlog B5, experiment E1): turning
 * a requested committed range of a repository into pinned commits and the
 * files and lines it changes. index.js owns the review session itself;
 * nothing here starts one.
 */

import fs from "node:fs";
import path from "node:path";

// Title of a branch review session. Deliberately not REVIEW_TITLE
// (internals.js): the TUI toasts and the sidebar track sessions by that
// prefix, and a branch review is advisory, so it stays out of both.
export const BRANCH_TITLE = "Branch review";

// What a ref may look like: a branch, tag or remote name, a full or short
// sha, and the usual suffixes (HEAD~2, main^, v1.0@{u}). Never a leading
// dash (git would read an option) and never "..", which only a range uses.
const REF_PATTERN = /^[A-Za-z0-9._/@^~{}+-]+$/;

export function isValidRef(ref) {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= 200 &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    REF_PATTERN.test(ref)
  );
}

async function gitText(promise) {
  try {
    return String(await promise.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Resolves `{ repo, base, head }` with the host's shell tag `$`. Returns
 * `{ error }` (a sentence for the caller), `{ empty }` when the head adds
 * nothing, or the pinned range: `{ root, baseRef, headRef, baseSha,
 * headSha, files, lines }`, where `files` and `lines` leave out what
 * `isIgnoredFile` names (lockfiles, generated and vendored output).
 */
export async function resolveBranchRange($, args, { defaultRepo, isIgnoredFile }) {
  const repo = args?.repo ?? defaultRepo;
  if (typeof repo !== "string" || !path.isAbsolute(repo)) {
    return { error: `repo must be an absolute path to a git repository or worktree (got ${JSON.stringify(repo)}).` };
  }
  const baseRef = args?.base;
  const headRef = args?.head ?? "HEAD";
  for (const [name, ref] of [
    ["base", baseRef],
    ["head", headRef],
  ]) {
    if (!isValidRef(ref)) return { error: `${name} is not a valid git ref: ${JSON.stringify(ref)}.` };
  }

  const root = await gitText($`git -C ${repo} rev-parse --show-toplevel`);
  if (!root) return { error: `${repo} is not a git repository.` };

  const commitOf = (ref) => {
    const spec = `${ref}^{commit}`;
    return gitText($`git -C ${root} rev-parse --verify --quiet ${spec}`);
  };
  const baseSha = await commitOf(baseRef);
  if (!baseSha) return { error: `base ${baseRef} does not name a commit in ${root}.` };
  const headSha = await commitOf(headRef);
  if (!headSha) return { error: `head ${headRef} does not name a commit in ${root}.` };

  const mergeBase = await gitText($`git -C ${root} merge-base ${baseSha} ${headSha}`);
  if (headSha === baseSha || mergeBase === headSha) return { empty: true, root, baseRef, headRef, baseSha, headSha };

  const range = `${baseSha}...${headSha}`;
  const names = await gitText($`git -C ${root} diff --name-only ${range}`);
  const allFiles = names.split("\n").map((line) => line.trim()).filter(Boolean);
  const files = allFiles.filter((file) => !isIgnoredFile(file));
  let lines = 0;
  for (const row of (await gitText($`git -C ${root} diff --numstat ${range}`)).split("\n")) {
    const [added, deleted, file] = row.split("\t");
    if (!file || isIgnoredFile(file)) continue;
    lines += (parseInt(added, 10) || 0) + (parseInt(deleted, 10) || 0);
  }
  return { root, baseRef, headRef, baseSha, headSha, files, ignoredOnly: allFiles.length > 0 && files.length === 0, lines };
}

export function shortRange(range) {
  return `${range.baseSha.slice(0, 12)}...${range.headSha.slice(0, 12)}`;
}

export function branchKey(range) {
  return `${range.root}\u0000${range.baseSha}\u0000${range.headSha}`;
}

function realOrNull(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

function isWithin(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/**
 * The spelling under which the review session may read `root`, or null.
 * The session reads its project directory (`cwd`) and whatever the
 * external_directory rules allow (`resources`, v2.js
 * toExternalDirectoryResource of each externalDirectories entry; anything
 * else is denied). Both sides are compared by real path, so a project
 * reached through a symlink still contains its own repository, and the
 * answer is spelled under the allowing directory as configured, since the
 * host's permission check may compare paths as written.
 */
export function readableRepoPath(root, { cwd, resources = [] }) {
  const realRoot = realOrNull(root) ?? root;
  const plainBases = [cwd];
  const globs = [];
  for (const resource of resources) {
    if (typeof resource !== "string") continue;
    const base = resource.endsWith("/*") ? resource.slice(0, -2) : null;
    if (base && !/[*?[\]{}]/.test(base)) plainBases.push(base);
    else globs.push(resource);
  }
  for (const base of plainBases) {
    const realBase = typeof base === "string" ? realOrNull(base) : null;
    if (realBase && isWithin(realRoot, realBase)) return path.join(base, path.relative(realBase, realRoot));
  }
  for (const glob of globs) {
    const pattern = globToRegExp(glob);
    if (pattern.test(`${realRoot}/x`) || pattern.test(`${root}/x`)) return root;
  }
  return null;
}

export const MAX_BRANCH_REVIEWS = 50;

// Keeps `reviews` (range key -> entry) at most `max` entries by deleting
// the finished ones that finished first; a running entry is never evicted,
// so the map can exceed `max` only while more than `max` reviews run.
export function evictFinishedBranchReviews(reviews, max = MAX_BRANCH_REVIEWS) {
  if (reviews.size <= max) return;
  const finished = [...reviews.entries()]
    .filter(([, entry]) => entry.status !== "running")
    .sort(([, a], [, b]) => (a.finishedAt ?? a.startedAt ?? 0) - (b.finishedAt ?? b.startedAt ?? 0));
  for (const [key] of finished) {
    if (reviews.size <= max) break;
    reviews.delete(key);
  }
}

