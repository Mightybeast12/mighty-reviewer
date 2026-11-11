/**
 * Branch review (the tooling reviewer's backlog B5, experiment E1): turning
 * a requested committed range of a repository into pinned commits and the
 * files and lines it changes, and (backlog B13, worktree: true) making and
 * removing the review's own checkout of the head. index.js owns the review
 * session itself; nothing here starts one.
 */

import fs from "node:fs";
import os from "node:os";
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

// ------------------------------------------------- review worktree (B13)
//
// review_branch({ worktree: true }) reviews inside a detached checkout of
// the head, made for that review and removed after it. Each checkout is a
// direct child of one private folder, named <pid>-<head sha 12>-<stamp>, so
// a later start can tell an orphan (its process is gone, or it is this
// process's and no review holds it) from a checkout still in use.

export const WORKTREE_DIR_NAME = "mighty-reviewer-worktrees";

const WORKTREE_NAME = /^(\d+)-[0-9a-f]{12}-[0-9a-z]+$/;

// The checkouts this process's reviews hold, from the moment their path is
// chosen until they are removed. Kept on globalThis because OpenCode 2
// imports the module afresh at a hot reload: module state does not survive
// it, and the new copy must not take the old copy's checkouts for orphans.
const LIVE_CHECKOUTS = (globalThis[Symbol.for("mighty-reviewer.reviewCheckouts")] ??= new Set());

export function defaultWorktreeParent() {
  return path.join(os.tmpdir(), WORKTREE_DIR_NAME);
}

function firstLine(err) {
  const text = String(err?.stderr ?? "").trim() || String(err?.message ?? err);
  return text.split("\n").find((line) => line.trim() && !line.startsWith("Command failed")) ?? text;
}

// The parent folder, made private to this user, by real path; or { error }.
// Another user could otherwise plant a symlink or files where the critics
// are allowed to read.
function privateParent(parent) {
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(parent);
    if (!info.isDirectory()) return { error: `${parent} is not a folder.` };
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      return { error: `${parent} belongs to another user.` };
    }
    if ((info.mode & 0o077) !== 0) {
      return { error: `${parent} is open to other users (mode ${(info.mode & 0o777).toString(8)}); give review_branch a private folder.` };
    }
    return { dir: fs.realpathSync(parent) };
  } catch (err) {
    return { error: `cannot prepare ${parent}: ${firstLine(err)}` };
  }
}

async function worktreePaths($, root) {
  const listing = await gitText($`git -C ${root} worktree list --porcelain`);
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function isOwnCheckout(dir, parentDir) {
  return path.dirname(dir) === parentDir && WORKTREE_NAME.test(path.basename(dir));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Removes one checkout this module made (`dir`, a direct child of the real
 * `parentDir`) and its entry in `root`'s worktree list, and nothing else:
 * never `git worktree prune`, which would drop every stale entry of the
 * repository. Returns true when neither the entry nor the folder is left.
 */
export async function removeReviewWorktree($, root, dir, parentDir) {
  if (!isOwnCheckout(dir, parentDir)) return false;
  try {
    try {
      await $`git -C ${root} worktree remove --force ${dir}`.quiet();
    } catch {
      // Older git refuses an entry whose folder is gone: handled below.
    }
    if ((await worktreePaths($, root)).includes(dir)) {
      const common = await gitText($`git -C ${root} rev-parse --path-format=absolute --git-common-dir`);
      const admin = common ? path.join(common, "worktrees") : null;
      for (const name of admin && fs.existsSync(admin) ? fs.readdirSync(admin) : []) {
        let gitdir = "";
        try {
          gitdir = fs.readFileSync(path.join(admin, name, "gitdir"), "utf8").trim();
        } catch {
          continue;
        }
        // worktree.useRelativePaths writes it relative to the entry.
        if (path.resolve(admin, name, gitdir) === path.join(dir, ".git")) fs.rmSync(path.join(admin, name), { recursive: true, force: true });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return !fs.existsSync(dir) && !(await worktreePaths($, root)).includes(dir);
  } finally {
    // Let go even when the removal throws, so a later sweep can take it.
    LIVE_CHECKOUTS.delete(dir);
  }
}

function isOrphan(dir) {
  const pid = Number(WORKTREE_NAME.exec(path.basename(dir))[1]);
  return pid === process.pid ? !LIVE_CHECKOUTS.has(dir) : !processAlive(pid);
}

// Whether the repository whose common git folder is `common` lists `dir`
// as one of its worktrees (an entry whose gitdir file names `<dir>/.git`).
function listsCheckout(common, dir) {
  const admin = path.join(common, "worktrees");
  let names = [];
  try {
    names = fs.readdirSync(admin);
  } catch {
    return false;
  }
  return names.some((name) => {
    try {
      // worktree.useRelativePaths writes it relative to the entry.
      return path.resolve(admin, name, fs.readFileSync(path.join(admin, name, "gitdir"), "utf8").trim()) === path.join(dir, ".git");
    } catch {
      return false;
    }
  });
}

// The common git folder of the repository a checkout belongs to, read from
// the checkout's own `.git` file; null when it has none, or when the
// repository it names does not list the checkout: the file is the
// checkout's own and a review's shell could rewrite it, so no git command
// is run in a repository on its word alone.
function commonDirOf(dir) {
  try {
    const line = fs.readFileSync(path.join(dir, ".git"), "utf8").trim();
    if (!line.startsWith("gitdir: ")) return null;
    const gitdir = path.resolve(dir, line.slice("gitdir: ".length));
    let common = path.resolve(gitdir, "..", "..");
    try {
      common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // No commondir file: the layout <common>/worktrees/<name> stands.
    }
    return listsCheckout(common, dir) ? common : null;
  } catch {
    return null;
  }
}

/**
 * Removes the orphaned review checkouts in `parentDir`: those whose process
 * is gone, and this process's that no review holds. First `root`'s entries
 * (also one whose folder a temp cleaner deleted), then every own-named
 * folder left in `parentDir`, whatever repository it belongs to (found
 * through its `.git` file; a folder without one is removed as it is).
 * Another live process's checkouts and every entry outside the folder are
 * left alone, and `git worktree prune` is never run.
 */
export async function sweepOrphanWorktrees($, root, parentDir) {
  for (const dir of await worktreePaths($, root)) {
    if (isOwnCheckout(dir, parentDir) && isOrphan(dir)) await removeReviewWorktree($, root, dir, parentDir);
  }
  let names = [];
  try {
    names = fs.readdirSync(parentDir);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(parentDir, name);
    if (!isOwnCheckout(dir, parentDir) || !isOrphan(dir)) continue;
    const common = commonDirOf(dir);
    if (common) await removeReviewWorktree($, common, dir, parentDir).catch(() => false);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GLOB_CHARACTER = /[*?[\]{}]/;

// The real path `dir` has or would have once made: the real path of its
// nearest existing ancestor joined with the rest.
function realPathAhead(dir) {
  const rest = [];
  let probe = path.resolve(dir);
  for (;;) {
    const real = realOrNull(probe);
    if (real) return path.join(real, ...rest.reverse());
    const up = path.dirname(probe);
    if (up === probe) return path.resolve(dir);
    rest.push(path.basename(probe));
    probe = up;
  }
}

/**
 * Checks and makes the folder review checkouts of `root` go in (`parent`,
 * default: the system's temporary folder): absolute, never inside any work
 * tree of the repository (checked before anything is made), and private to
 * this user. Returns `{ dir }` (its real path) or `{ error }`.
 */
export async function prepareWorktreeParent($, root, parent = defaultWorktreeParent()) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    return { error: `branchWorktreeDir must be an absolute path (got ${JSON.stringify(parent)}).` };
  }
  const ahead = realPathAhead(parent);
  // The review's allow is the glob `<checkout>/*`: a glob character in the
  // folder's path would make it match more than the checkout.
  if (GLOB_CHARACTER.test(parent) || GLOB_CHARACTER.test(ahead)) {
    return { error: `the worktree folder ${parent} (real path ${ahead}) holds a glob character (* ? [ ] { }), which would widen the review's read allow; pick another folder.` };
  }
  const trees = (await worktreePaths($, root)).map((tree) => realOrNull(tree) ?? tree);
  const inside = trees.find((tree) => isWithin(ahead, tree));
  if (inside) return { error: `the worktree folder ${parent} is inside a work tree of the reviewed repository (${inside}).` };
  return privateParent(parent);
}

/**
 * Removes from the fresh checkout `dir` every symlink of `headSha` whose
 * target, followed to its end, lies outside the checkout (dangling ones
 * judged by where they point). The review may read `<dir>/*`, and the host
 * matches a path as written, so a read through such a link would leave the
 * checkout. Every link is judged before any is removed, so a link to a link
 * that leaves goes too. Only the links go, never their targets. Returns
 * `{ removed }` (paths relative to the checkout, sorted) or `{ error }`:
 * a head whose links cannot be listed is never handed to a review.
 */
async function unlinkEscapingLinks($, dir, headSha) {
  let listing;
  try {
    listing = String(await $`git -C ${dir} ls-tree -r -z --full-tree ${headSha}`.quiet().text());
  } catch (err) {
    return { error: `cannot list the head's symlinks: ${firstLine(err)}` };
  }
  const escaping = [];
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1 || !entry.startsWith("120000 ")) continue;
    const rel = entry.slice(tab + 1);
    const at = path.join(dir, rel);
    let target = realOrNull(at);
    if (target === null) {
      try {
        target = realPathAhead(path.resolve(path.dirname(at), fs.readlinkSync(at)));
      } catch {
        target = null;
      }
    }
    if (target === null || !isWithin(target, dir)) escaping.push(rel);
  }
  try {
    for (const rel of escaping) fs.unlinkSync(path.join(dir, rel));
  } catch (err) {
    return { error: `cannot remove a symlink that leaves the checkout: ${firstLine(err)}` };
  }
  return { removed: escaping.sort() };
}

/**
 * Makes a detached checkout of `headSha` for one review in `parentDir` (a
 * real path from prepareWorktreeParent), without running the repository's
 * hooks and without the head's symlinks that leave it, after removing the
 * orphans there. Returns `{ dir, unlinked }` (a real path, held until
 * removeReviewWorktree, and the symlinks removed) or `{ error }`.
 */
export async function addReviewWorktree($, { root, headSha }, parentDir) {
  await sweepOrphanWorktrees($, root, parentDir);
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(parentDir, `${process.pid}-${headSha.slice(0, 12)}-${stamp}`);
  // Held before git lists it, so a parallel start's sweep leaves it alone.
  LIVE_CHECKOUTS.add(dir);
  try {
    await $`git -C ${root} -c core.hooksPath=/dev/null worktree add --detach ${dir} ${headSha}`.quiet();
  } catch (err) {
    await removeReviewWorktree($, root, dir, parentDir);
    return { error: `git worktree add failed: ${firstLine(err)}` };
  }
  if ((await gitText($`git -C ${dir} rev-parse HEAD`)) !== headSha) {
    await removeReviewWorktree($, root, dir, parentDir);
    return { error: `the checkout at ${dir} is not at ${headSha}.` };
  }
  const links = await unlinkEscapingLinks($, dir, headSha);
  if (links.error) {
    await removeReviewWorktree($, root, dir, parentDir);
    return { error: links.error };
  }
  return { dir, unlinked: links.removed };
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

