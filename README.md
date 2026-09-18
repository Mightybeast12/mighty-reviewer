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

1. **Trigger**: after a turn finishes (`session.idle`), the plugin checks that BOTH are true:
   - an editing tool (`edit`/`write`) actually ran during that turn, and
   - the git diff (unstaged + staged + untracked) changed compared to a snapshot taken at the start of the turn.

   Pre-existing dirty files never trigger a review on their own, and neither do read-only or chat-only turns.

2. **Review**: a background **child session** is spawned (so the review never clutters your conversation). It:
   - runs `git diff` including untracked files,
   - runs **mechanical gates** first: the project's own typecheck/lint (e.g. `tsc --noEmit`, `ruff check`, `go vet`, `cargo check`), a scan for leftover debug output, and a check for weakened linter/formatter/typechecker configs. Any failure is an automatic P1 finding,
   - delegates to `adversarial-risk-critic`, `design-principles-critic`, and `security-checklist-critic` in parallel, passing the gate results as context,
   - injects language-specific guidance (TypeScript, Go, Python, Rust, Java/Kotlin, SQL, shell) based on the extensions of the changed files,
   - merges all reports into one severity-ranked (P0-P3) list with file:line evidence,
   - runs diagnostics on every changed file,
   - outputs the **full findings report** (every finding with severity, file:line, what is wrong, and the suggested minimal fix),
   - issues a single verdict: **SHIP** or **NO-SHIP**. Any failed mechanical gate or P0/P1 finding from any critic forces NO-SHIP.

   The review is **read-only**, enforced by mechanism: the three critic agents are registered with `edit`/`write`/`patch`/`bash`/`task` disabled, and the orchestrating review session runs with `edit`/`write`/`patch` disabled (it keeps `bash` for the mechanical gates, constrained to read-only commands). It lists everything wrong; you decide what to act on.

3. **Delivery**: toasts report when the review starts and the final verdict. Full findings live in the child session titled "Adversarial review".

4. **Feedback loop**: on **NO-SHIP**, the findings report is injected back into the parent session as a new prompt, so the coding agent wakes up and fixes the P0/P1 findings. The fix turn triggers a fresh review. This is capped at **2 re-review cycles** per user message; if the cap is hit, the toast tells you to check the review session yourself. On SHIP nothing is injected.

5. **Loop guard**: spawned review sessions are tracked so they never review themselves, each finished turn produces exactly one review, and the re-review cycle cap keeps review -> fix -> re-review from looping forever.

## Configuration

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
