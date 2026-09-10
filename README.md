# mighty-reviewer

An [opencode](https://opencode.ai) plugin that runs an **automatic background adversarial code review** whenever a turn actually writes code, and reports a terse **SHIP / NO-SHIP** verdict via toast.

Two critics are consulted in parallel:

| Critic | Focus |
| --- | --- |
| `adversarial-risk-critic` | Attacks risky surfaces: auth, data loss, concurrency, external I/O, error paths, gamed tests |
| `design-principles-critic` | Enforces DRY, SOLID, separation of concerns, abstraction boundaries, systems-design choices |

Both agents are registered by the plugin itself, so the package is fully self-contained: no agent files to copy.

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
   - delegates to `adversarial-risk-critic` and `design-principles-critic` in parallel,
   - merges both reports into one severity-ranked (P0-P3) list with file:line evidence,
   - runs diagnostics on every changed file,
   - issues a single verdict: **SHIP** or **NO-SHIP**. Any P0/P1 finding from either critic forces NO-SHIP, and the review session fixes those findings and re-verifies.

3. **Delivery**: toasts report when the review starts and the final verdict. Full findings live in the child session titled "Adversarial review".

4. **Loop guard**: spawned review sessions are tracked so they never review themselves, and each finished turn produces exactly one review.

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

The plugin registers its agents only if you have not defined agents with the same names. To override a critic, define your own agent named `adversarial-risk-critic` or `design-principles-critic` (in `opencode.json` or as `~/.config/opencode/agent/<name>.md`) and it takes precedence.

## Requirements

- The project being reviewed must be a git repository (the trigger compares git diffs; outside a repo the plugin stays silent).
- opencode with plugin support (`plugin` array in `opencode.json`).

## License

MIT
