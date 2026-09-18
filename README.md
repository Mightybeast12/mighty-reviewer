# mighty-reviewer

An [opencode](https://opencode.ai) plugin that runs an **automatic background adversarial code review** whenever a turn actually writes code, and reports a terse **SHIP / NO-SHIP** verdict via toast.

Mechanical gates (typecheck, lint, debug-output scan) run first, then three critics are consulted in parallel:

| Critic | Focus |
| --- | --- |
| `adversarial-risk-critic` | Attacks risky surfaces: auth, data loss, concurrency, external I/O, error paths, gamed tests, weakened lint/typecheck configs |
| `design-principles-critic` | Enforces DRY, SOLID, separation of concerns, abstraction boundaries, size/complexity signals, systems-design choices |
| `security-checklist-critic` | Walks an OWASP-style checklist: secrets, injection, XSS, path traversal, authz, input validation, dependencies |

All agents are registered by the plugin itself, so the package is fully self-contained: no agent files to copy.

## Install

Add the plugin to your `opencode.json` (project or global at `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["mighty-reviewer"]
}
```

Restart opencode. That's it.

### Alternative: local file install

Clone this repo and drop `index.js` into your plugin directory; opencode auto-discovers it:

```bash
git clone https://github.com/Mightybeast12/mighty-reviewer.git
cp mighty-reviewer/index.js ~/.config/opencode/plugin/mighty-reviewer.js
```

Or reference the clone directly from `opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/mighty-reviewer/index.js"]
}
```

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
   - delegates to `adversarial-risk-critic`, `design-principles-critic`, and `security-checklist-critic` in parallel, passing the gate results as context,
   - injects language-specific guidance (TypeScript, Go, Python, Rust, Java/Kotlin, SQL, shell) based on the extensions of the changed files,
   - **adversarially verifies** every P0/P1 finding before accepting it (reads the full file, checks imports/declarations/callers, drops anything refutable; when uncertain, drops it), deduplicates findings across critics, and merges the survivors with the gate findings into one severity-ranked (P0-P3) list with file:line evidence,
   - runs diagnostics on every changed file,
   - outputs the **full findings report** (every finding with severity, file:line, what is wrong, and the suggested minimal fix),
   - issues a single verdict: **SHIP** or **NO-SHIP**. Any failed mechanical gate or verified P0/P1 finding forces NO-SHIP.

   Critics carry built-in false-positive controls: a confidence threshold (findings under 0.7 confidence are omitted), a "no failure scenario, no P0/P1" rule, and a CI-boundary rule so they never re-report what the mechanical gates already caught. They run at temperature 0.1 for consistent verdicts.

   The review is **read-only**: the three critic agents are registered with `edit`/`write`/`patch`/`bash`/`task` disabled (enforced by mechanism), and the orchestrating review session runs with `edit`/`write`/`patch` disabled. The orchestrator keeps `bash` for the mechanical gates, where read-only use is enforced by prompt instructions only, not by mechanism. It lists everything wrong; you decide what to act on.

   A watchdog aborts any review child still running after 10 minutes.

3. **Delivery**: toasts report when the review starts and the final verdict. Full findings live in the child session titled "Adversarial review". The coding agent (and you) can also query the verdict via the **`review_status` tool**, which returns running/done, the verdict, and the findings report.

4. **Feedback loop**: on **NO-SHIP**, the findings report is injected back into the parent session as a new prompt (fenced and marked as untrusted data), so the coding agent wakes up and fixes the P0/P1 findings. The fix turn triggers a fresh review. This is capped at **2 re-review cycles** per user message, plus an absolute cap of **10 injections** per session; if a cap is hit, the toast tells you to check the review session yourself. On SHIP nothing is injected.

5. **Loop guard**: spawned review sessions are tracked so they never review themselves, each finished turn produces exactly one review, and the re-review cycle cap keeps review -> fix -> re-review from looping forever.

## Configuration

All options go in the plugin tuple form in `opencode.json`:

```json
{
  "plugin": [["mighty-reviewer", {
    "model": "anthropic/claude-sonnet-4-5",
    "criticModel": "anthropic/claude-haiku-4-5",
    "maxDiffLines": 2000,
    "ignore": ["^docs/", "\\.stories\\.tsx$"],
    "idleDebounceMs": 1000,
    "enforceNoShip": false
  }]]
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `disabled` | `false` | Turn the plugin off |
| `model` | session default | `provider/model` used by the review orchestrator session |
| `criticModel` | agent default | `provider/model` for the three critic subagents (route them to a cheaper model) |
| `agent` | session default | Agent that orchestrates the review session. It needs the `task` tool. Set this if your default agent is pinned to a model your provider does not serve, or lacks `task` (common with agent packs) |
| `maxDiffLines` | `2000` | Skip review when more changed lines than this (lockfiles/generated excluded from the count) |
| `ignore` | `[]` | Extra regex patterns (strings) for files to exclude from review |
| `idleDebounceMs` | `1000` | Debounce for `session.idle` before triggering a review |
| `enforceNoShip` | `false` | Block `git commit` / `git push` in a session while a NO-SHIP verdict is unresolved (until a later review SHIPs, e.g. via `/mighty-review`) |
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

Use the tuple form in `opencode.json`:

```json
{
  "plugin": [["mighty-reviewer", { "disabled": true }]]
}
```

### Customize the critics

The plugin registers its agents only if you have not defined agents with the same names. To override a critic, define your own agent named `adversarial-risk-critic`, `design-principles-critic`, or `security-checklist-critic` (in `opencode.json` or as `~/.config/opencode/agent/<name>.md`) and it takes precedence.

## Requirements

- The project being reviewed must be a git repository (the trigger compares git diffs; outside a repo the plugin stays silent).
- opencode with plugin support (`plugin` array in `opencode.json`).

## License

MIT
