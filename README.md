# mighty-reviewer

An [opencode](https://opencode.ai) plugin that runs an **automatic background adversarial code review** whenever a turn actually writes code, and reports a terse **SHIP / NO-SHIP** verdict via toast.

Mechanical gates (typecheck, lint, debug-output scan) run first, then four critics are consulted in parallel:

| Critic | Focus |
| --- | --- |
| `adversarial-risk-critic` | Attacks risky surfaces: auth, data loss, concurrency, external I/O, error paths, gamed tests, weakened lint/typecheck configs |
| `design-principles-critic` | Enforces DRY, SOLID, separation of concerns, abstraction boundaries, size/complexity signals, systems-design choices |
| `security-checklist-critic` | Walks an OWASP-style checklist: secrets, injection, XSS, path traversal, authz, input validation, dependencies |
| `ai-slop-critic` | Hunts AI-authoring residue. In code: narrating comments, needless defensive checks, `any` casts, style drift, emoji. In prose (comments, docs, UI copy, messages): the tells from Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), such as AI vocabulary, puffery, negative parallelisms, bold inline-header lists, em dashes, chatbot leftovers, placeholder text, leaked citation markup, and documentation claims the code does not back |

All agents are registered by the plugin itself, so the package is fully self-contained: no agent files to copy.

## Install

Supports OpenCode 1.18.29+ and OpenCode 2.x from the same package.

Add the plugin to your `opencode.json` (project or global at `~/.config/opencode/opencode.json`). OpenCode 2 reads `plugins`; OpenCode 1 reads `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["mighty-reviewer"]
}
```

Restart opencode. That's it.

### Alternative: local checkout

Clone this repo and reference the checkout directory from `opencode.json`:

```bash
git clone https://github.com/Mightybeast12/mighty-reviewer.git
```

```json
{
  "plugins": ["/absolute/path/to/mighty-reviewer"]
}
```

OpenCode 2 requires a package directory here (it resolves `index.js` and the TUI companion `tui.js` from it); a bare path to `index.js` is rejected. On OpenCode 1 you can also copy `index.js`, `v2.js`, `tui.js`, and `internals.js` into `~/.config/opencode/plugin/`.

### OpenCode 2 notes

- **Toasts** come from a TUI companion module (`mighty-reviewer/tui`) that OpenCode 2 loads alongside the server plugin. Each notice is also queued as a `mighty-reviewer` entry in the session it concerns, where it enters the conversation on the next turn without waking the agent.
- **Sidebar panel**: the same TUI module adds a "Mighty Reviewer" box to the right sidebar, styled to sit next to the oh-my-opencode-slim agent panel. See [Sidebar panel](#sidebar-panel-opencode-2).
- **The review session is a root session**, not a child of the coding session. OpenCode 2 caps nested subagents at depth 1 (`experimental.subagent_depth`), and a nested review session could not spawn its four critics. The parent link is stored in the review session's metadata, and the toast offers to open the review session.
- **`enforceNoShip`** denies `git commit` / `git push` through the permission hook, so a blocked command shows up as a permission denial carrying the reviewer's message.
- Tool names differ between hosts (`bash` is `shell`, `task` is `subagent`); progress tracking and the critic permissions account for both.
- The self-update check only manages OpenCode 1's plugin cache. On OpenCode 2 use `opencode plugin update`.

## How it works

1. **Trigger**: after a turn finishes (`session.idle`, debounced against duplicate events), the plugin checks that BOTH are true:
   - an editing tool (`edit`, `write`, `patch`, `multiedit`, `apply_patch`) actually ran during that turn, and
   - the git diff (unstaged + staged + untracked) changed compared to a snapshot taken at the start of the turn.

   Pre-existing dirty files never trigger a review on their own, and neither do read-only or chat-only turns. You can also trigger a review on demand with the **`/mighty-review`** command.

   Only root sessions are reviewed. Child sessions (subagents spawned via the `task` tool, background sessions from other plugins) are never reviewed on their own; edits they make are credited to their root session, so a turn that delegates all its editing to subagents still gets exactly one review, for the parent turn.

   Noise never reaches the critics: lockfiles, generated/minified output, and vendored code are excluded, and diffs larger than `maxDiffLines` (default 2000 changed lines) skip review entirely with a toast.

2. **Review**: a background **child session** is spawned (so the review never clutters your conversation). It:
   - runs `git diff` including untracked files,
   - runs **mechanical gates** first: the project's own typecheck/lint (e.g. `tsc --noEmit`, `ruff check`, `go vet`, `cargo check`), a scan for leftover debug output, and a check for weakened linter/formatter/typechecker configs. Any failure is an automatic P1 finding,
   - delegates to `adversarial-risk-critic`, `design-principles-critic`, `security-checklist-critic`, and `ai-slop-critic` in parallel, passing the gate results as context,
   - injects language-specific guidance (TypeScript, Go, Python, Rust, Java/Kotlin, SQL, shell) based on the extensions of the changed files,
   - **adversarially verifies** every P0/P1 finding before accepting it (reads the full file, checks imports/declarations/callers, drops anything refutable; when uncertain, drops it), deduplicates findings across critics, and merges the survivors with the gate findings into one severity-ranked (P0-P3) list with file:line evidence,
   - runs diagnostics on every changed file,
   - outputs the **full findings report** (every finding with severity, file:line, what is wrong, and the suggested minimal fix),
   - issues a single verdict: **SHIP** or **NO-SHIP**. Any failed mechanical gate or verified P0/P1 finding forces NO-SHIP.

   Critics carry built-in false-positive controls: a confidence threshold (findings under 0.7 confidence are omitted), a "no failure scenario, no P0/P1" rule, and a CI-boundary rule so they never re-report what the mechanical gates already caught. They run at temperature 0.1 for consistent verdicts. The `ai-slop-critic` is further capped: it never issues P0, treats a lone tell as P3, and reserves P1 for chatbot residue or placeholder text in shipped prose and for documentation that is false about the code, so slop alone rarely blocks a SHIP.

   The review is **read-only**: the four critic agents are registered with `edit`/`write`/`patch`/`bash`/`task` disabled (enforced by mechanism), and the orchestrating review session runs with `edit`/`write`/`patch` disabled. The orchestrator keeps `bash` for the mechanical gates, where read-only use is enforced by prompt instructions only, not by mechanism. It lists everything wrong; you decide what to act on.

   A watchdog aborts any review child still running after 10 minutes.

3. **Delivery**: toasts report when the review starts and the final verdict. Full findings live in the child session titled "Adversarial review". The coding agent (and you) can also query the verdict via the **`review_status` tool**, which returns running/done, the verdict, and the findings report.

   **Progress tracking**: while the review runs, its phase is inferred from tool activity in the review session and surfaced three ways:
   - `review_status` reports the current phase and elapsed time (e.g. "waiting on critics (2/4 returned), elapsed 3m 40s") instead of a bare "in progress",
   - phase transitions emit toasts ("mechanical gates done, critics running", "critics done, verifying findings"); disable with `"progressToasts": false`,
   - the review child's session title is renamed live ("Adversarial review - critics 1/4", "... - verifying", and finally the verdict), so the session list itself shows where the review is.

4. **Feedback loop**: on **NO-SHIP**, the findings report is injected back into the parent session as a new prompt (fenced and marked as untrusted data), so the coding agent wakes up and fixes the P0/P1 findings. The fix turn triggers a fresh review. This is capped at **2 re-review cycles** per user message, plus an absolute cap of **10 injections** per session; if a cap is hit, the toast tells you to check the review session yourself. On SHIP nothing is injected.

5. **Loop guard**: spawned review sessions are tracked so they never review themselves, each finished turn produces exactly one review, and the re-review cycle cap keeps review -> fix -> re-review from looping forever.

6. **Stall guard**: if the review session goes idle **without** a SHIP/NO-SHIP verdict (e.g. the orchestrating agent launched the critics as background tasks and ended its turn early), the review is not finalized as a fizzle. The plugin re-prompts the review session to collect the critic results and emit the verdict, capped at 2 nudges, after which the review finalizes with whatever it has. Duplicate idle events never burn the nudge budget.

### Sidebar panel (OpenCode 2)

While you are in a session that has a review, the right sidebar shows a small panel:

```
┌───────────────────────────────────────────────────────┐
│ ▼ Mighty Reviewer v0.9.4                       NO-SHIP│
│ ✓ review        7 files +240/-31   1m42               │
│  ✓ risk                      1 P0    ·    · 2 P3   12k│
│  ✓ design                    clean                  8k│
│  ✓ security                     ·    · 3 P2    ·   11k│
│  ✓ slop                            no report          │
│                                                       │
│total 1 P0 · 3 P2 2 P3 · verified 4 of 6               │
│ cycle 1/2 · fixes sent to session                     │
└───────────────────────────────────────────────────────┘
```

- A spinner marks anything still running, `✓` marks a critic that has returned. Click the header to unfold the panel and see the per-critic rows again; it folds back to the header line with the verdict once the review finishes (`SHIP`, `NO-SHIP`, `done`, or `timed out`).
- The `review` row shows the diff scope (`<files> files +<added>/-<deleted>`), tried from the reviewed session's own summary first, then the review session's, then a per-file diff fetch, omitted (with a one-time `console.debug` of why) if none of the three has anything, and elapsed time, right-aligned: ticking while the review runs, fixed once it finishes (`42s`, `1m42`, `1h05`). The phase (`critics 2/4`, `verifying`, ...) is shown only while running, and only once it says something the row doesn't already (an early "starting"/"gates" phase is skipped).
- Each critic row's label is a short name (`risk`, `design`, `security`, `slop`, mapped from `adversarial-risk`, `design-principles`, `security-checklist`, and `ai-slop`; an unrecognized subagent falls back to its own id, cut from the end with an ellipsis if it's too long to fit, never from the middle). The detail block next to it is fixed-width, so one row's findings never squeeze a different row's label: a constant-position severity run across P0-P3 (a colored `<n> P<k>` where it found something: P0/P1 red, P2 amber, P3 muted; a faint `·` where it found nothing), `clean` in place of the whole run when every slot is zero, `no report` when the critic ended without any text, and `not run` for a critic the review never got to. The right-aligned number at the row's edge is that critic's token total.
- These are each critic's own findings, before the review session verifies and merges them. The `total` row (shown once at least one critic has reported) sums the same severity run across critics, raw; once the review itself finishes and its own report can be read, it appends `· verified N of M`, where N is what survived the review's adversarial verification and dedup (counted from the report's own Findings section only, never anything the review refuted, dropped, or listed as mechanical gates, and capped at M so it can never show more than the critics raised), and M is the raw total that preceded it.
- A `cycle N/max` line appears once the NO-SHIP -> fix -> re-review loop (`MAX_REREVIEW_CYCLES`) has run at least once for this session, with `· fixes sent to session` appended while the latest verdict is NO-SHIP.
- While there is no review yet for the session you are viewing, the panel stays folded with `idle` like the other sidebar panels, showing the latest queued notice for it underneath (e.g. "diff too large for review, skipped") instead of staying silent.
- Click the `review` row or a critic row to open that session. Clicking a critic row also opens a findings panel for it (P0/P1 lines plus the review's status); run the **`/review-findings`** command for the same panel over every critic at once. On a host without a panel system, clicking a critic row still just opens its session. In the findings panel, esc or q closes the panel, f toggles fullscreen.

The panel reads session titles, status, metadata, and critic reports from the TUI's own session data, so it needs no extra setup beyond the review-progress metadata the plugin writes on the review session itself (`parentID`, `cycle`, `maxCycles`, `startedAt`, `criticsDone`, `criticsTotal`, `verdict`), which the panel reads back for the `cycle` line and a sidebar that survived a restart. After a restart, when the TUI has not loaded past review sessions yet, it asks the server for recent sessions to find them. On a TUI without sidebar slots it is skipped and toasts keep working.

How findings are counted: a finding is a line that starts with a severity tag (`### [P1] ...`, `- **P2** ...`, `| P3 | file:line |`, `P1: ...`), a `Severity: P1` field, or a list item under a heading that is only a severity (`### P1`). Severity mentions inside sentences, ranges like `P0-P3`, tallies like `P1: 2`, and code blocks are ignored.

## Configuration

All options go in the plugin entry in `opencode.json` (OpenCode 2 object form shown; OpenCode 1 uses the tuple form `["mighty-reviewer", { ... }]` under `plugin`):

```json
{
  "plugins": [{ "package": "mighty-reviewer", "options": {
    "model": "anthropic/claude-sonnet-4-5",
    "criticModel": "anthropic/claude-haiku-4-5",
    "maxDiffLines": 2000,
    "ignore": ["^docs/", "\\.stories\\.tsx$"],
    "idleDebounceMs": 1000,
    "enforceNoShip": false
  } }]
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `disabled` | `false` | Turn the plugin off |
| `model` | session default | `provider/model` used by the review orchestrator session |
| `criticModel` | agent default | `provider/model` for the four critic subagents (route them to a cheaper model) |
| `agent` | session default | Agent that orchestrates the review session. It needs the `task` tool. Set this if your default agent is pinned to a model your provider does not serve, or lacks `task` (common with agent packs) |
| `maxDiffLines` | `2000` | Skip review when more changed lines than this (lockfiles/generated excluded from the count) |
| `ignore` | `[]` | Extra regex patterns (strings) for files to exclude from review |
| `idleDebounceMs` | `1000` | Debounce for `session.idle` before triggering a review |
| `timeoutMs` | `600000` | Review time budget. At half time a review still in its mechanical gates is steered straight to the critics; at the deadline a review whose critics are running gets one extension of half the budget, otherwise it is aborted. The review session is also denied access outside the project directory, so a headless permission prompt cannot stall it |
| `enforceNoShip` | `false` | Block `git commit` / `git push` in a session while a NO-SHIP verdict is unresolved (until a later review SHIPs, e.g. via `/mighty-review`). On OpenCode 2 this is a permission denial |
| `progressToasts` | `true` | Toast on review phase transitions (gates done / critics done); `review_status` and live session titles report progress regardless |
| `updateCheck` | `true` | Check npm for a newer version a few seconds after startup |
| `autoUpdate` | `true` | Install the newer version into opencode's plugin cache automatically (unpinned npm installs only); with `false` you get a notification toast instead |

### Project review rules (`.mighty-reviewer.md`)

Drop a `.mighty-reviewer.md` file in the project root to teach the reviewer your conventions. Its contents are injected into every review as authoritative rules: patterns you list as accepted conventions are never flagged. Use it to suppress recurring false positives, Bugbot-style:

```markdown
- `any` types are accepted in `src/legacy/` during the TypeScript migration.
- Repository methods return null for not-found; services decide whether to throw.
- Do not flag missing JSDoc on private helpers.
```

### On-demand review

Run `/mighty-review` in any session to review the current working-tree changes immediately, without waiting for a coding turn.

### Updates

opencode installs npm plugins into `~/.cache/opencode/packages/` once and never re-resolves `latest`, so an unpinned plugin would silently stay on whatever version was current at first install. To compensate, the plugin checks the npm registry a few seconds after startup:

- **Unpinned install** (`"mighty-reviewer"`): a newer version is installed into the cache automatically and a toast asks you to restart opencode. Set `"autoUpdate": false` to get a notification toast instead.
- **Pinned install** (`"mighty-reviewer@0.4.1"`, or any range spec like `"mighty-reviewer@^0.4.0"`): never auto-updated; a toast tells you a newer version exists.
- **Prerelease channel** (`"mighty-reviewer@beta"`): updates follow that dist-tag.
- **Local file install** (`file:` path or a copy in the plugin directory): the check is skipped entirely; you manage the checkout yourself.

The check is best-effort: no registry access, no toast, and it can never break the review flow. A lock file keeps concurrent opencode instances from updating the same cache at once, and a failed install restores the original manifest. Set `"updateCheck": false` to disable it completely.

### Disable temporarily

```bash
MIGHTY_REVIEWER_DISABLE=1 opencode```

### Disable via config

Pass the `disabled` option in `opencode.json`:

```json
{
  "plugins": [{ "package": "mighty-reviewer", "options": { "disabled": true } }]
}
```

### Customize the critics

The plugin registers its agents only if you have not defined agents with the same names. To override a critic, define your own agent named `adversarial-risk-critic`, `design-principles-critic`, `security-checklist-critic`, or `ai-slop-critic` (in `opencode.json` or as `~/.config/opencode/agent/<name>.md`) and it takes precedence.

## Requirements

- The project being reviewed must be a git repository (the trigger compares git diffs; outside a repo the plugin stays silent).
- OpenCode 1.18.29+ (`plugin` array) or OpenCode 2.x (`plugins` array) in `opencode.json`.

## License

MIT
