/**
 * mighty-reviewer
 *
 * Runs an adversarial code-quality review automatically, in the background,
 * whenever a turn actually wrote code.
 *
 * Trigger:    session.idle event, but only when BOTH are true for the turn
 *             that just finished:
 *               1. An editing tool (edit/write) actually ran this turn.
 *               2. The working tree's diff (unstaged + staged + untracked)
 *                  differs from the snapshot taken at the start of the turn.
 *             Pre-existing dirty files from before the turn started do not,
 *             by themselves, trigger a review, and neither does a turn that
 *             only read files / ran commands / chatted without writing code.
 * Review:     Mechanical gates run first (project typecheck/lint, debug-output
 *             scan, lint-config-weakening check); any failure is an automatic
 *             P1. Then three subagents are consulted in parallel:
 *               - adversarial-risk-critic: attacks risky surfaces (auth,
 *                 data loss, concurrency, external I/O, error paths,
 *                 weakened guardrails).
 *               - design-principles-critic: enforces DRY, SOLID, separation
 *                 of concerns, size/complexity signals, and sound
 *                 systems-design choices.
 *               - security-checklist-critic: walks an OWASP-style checklist
 *                 (secrets, injection, XSS, path traversal, authz,
 *                 dependencies) over the diff.
 *             Language-specific guidance (TS, Go, Python, Rust, etc.) is
 *             injected based on the extensions of the changed files.
 *             All subagents are registered by this plugin via the `config`
 *             hook, so the package is fully self-contained. Existing agents
 *             with the same names are never overwritten, which lets users
 *             customize any critic locally.
 *             The review is READ-ONLY: it reports every finding as a
 *             severity-ranked list (with file:line and a suggested fix).
 *             Critic agents are registered with edit/write/patch/bash/task
 *             disabled; the orchestrating session runs with edit/write/patch
 *             disabled via a per-prompt tools override (bash stays enabled
 *             for the mechanical gates, constrained by prompt text).
 * Delivery:   Spawned as a background CHILD session (session.create with
 *             parentID) that runs its own review turn, instead of being
 *             injected into the current session. This keeps the review's
 *             git-diff output, subagent critique, and verdict out of the
 *             conversation the user is reading. A toast reports progress and
 *             the terse SHIP / NO-SHIP verdict once the child session
 *             finishes.
 * Feedback:   On NO-SHIP, the findings report is injected back into the
 *             PARENT session as a new prompt, so the coding agent wakes up
 *             and fixes the findings. The fix turn is itself reviewed again,
 *             capped at MAX_REREVIEW_CYCLES injections per genuine user
 *             message so review -> fix -> re-review can never loop forever.
 * Loop guard: spawned child (review) session IDs are tracked in
 *             `spawnedReviewSessions`, so their own idle events are
 *             recognized as review completions and never mistaken for a
 *             turn that itself needs reviewing.
 * Opt-out:    set MIGHTY_REVIEWER_DISABLE=1, or pass { disabled: true }
 *             via the plugin tuple form in opencode.json.
 */

const REVIEW_MARKER = "<!--adversarial-review-auto-->";
const FEEDBACK_MARKER = "<!--adversarial-review-feedback-->";

const MAX_REREVIEW_CYCLES = 2;
const MAX_FEEDBACK_CHARS = 8000;

// Tool names that count as "wrote code" for the purpose of gating a review.
const CODE_WRITING_TOOLS = new Set(["edit", "write"]);

const RISK_AGENT = "adversarial-risk-critic";
const DESIGN_AGENT = "design-principles-critic";
const SECURITY_AGENT = "security-checklist-critic";

// Critic agents are review-only and never need a shell: deny the mutating
// tools AND bash/task, so the read-only contract is enforced by mechanism.
const CRITIC_TOOLS = { edit: false, write: false, patch: false, bash: false, task: false };

// The orchestrating review session must keep bash (git diff, tsc --noEmit,
// mechanical gates), so only the direct file-mutating tools are denied; its
// bash path is constrained by the HARD CONSTRAINT prompt text below.
const ORCHESTRATOR_TOOLS = { edit: false, write: false, patch: false };

// NOTE: this critic rule is deliberately STRICTER than the orchestrator's
// HARD CONSTRAINT in buildReviewPrompt(), which carves out build-cache-only
// writes (`cargo check`, `tsc --noEmit`). Critics run no commands at all.
// Update the two together.
const READ_ONLY_RULE =
  "You are strictly READ-ONLY: never edit, write, create, or delete files, and never run commands that modify the working tree or git state. Your only deliverable is a report.";

const AGENT_DEFINITIONS = {
  [RISK_AGENT]: {
    description:
      "Adversarial risk critique of a code change. Attacks the most expensive and risky surfaces (auth, data loss, concurrency, external I/O, error paths) and reports only material findings with file:line evidence and P0-P3 severity.",
    mode: "subagent",
    tools: { ...CRITIC_TOOLS },
    prompt: [
      "You are an adversarial code reviewer. Your job is to BREAK confidence in a code change, not validate it. You review only the changed code you are given (diff plus enough surrounding context to judge behavior).",
      READ_ONLY_RULE,
      "",
      "Attack, in priority order:",
      "1. Authentication, authorization, and secrets handling.",
      "2. Data loss and corruption paths (destructive writes, migrations, partial failure).",
      "3. Concurrency: races, deadlocks, shared mutable state, missing atomicity.",
      "4. External I/O: network, filesystem, subprocess, third-party APIs, timeouts, retries.",
      "5. Error paths: swallowed errors, empty catch blocks, error states that leave the system inconsistent.",
      "6. Gamed changes: deleted or weakened tests, hardcoded values to satisfy tests, `as any` / `@ts-ignore` / lint suppressions, dead code left behind.",
      "7. Weakened guardrails: edits to linter/formatter/typechecker configs (.eslintrc, biome.json, tsconfig, .prettierrc, ruff.toml, clippy.toml) that disable or relax rules instead of fixing the offending code, new lint-disable comments, loosened compiler strictness.",
      "",
      "Check the change against what it was clearly trying to do. If the implementation diverges from its evident intent, that is a finding.",
      "",
      "For each finding provide:",
      "- Severity P0-P3 (P0 = exploitable or data-destroying now, P1 = will bite in production, P2 = meaningful but contained, P3 = judgment call).",
      "- Exact location (file:line).",
      "- The concrete failure scenario, not a vague concern.",
      "- The minimal fix.",
      "",
      "Report ONLY material findings. If the change is sound, say so in one sentence and stop. Do not pad the report with praise or restate the diff.",
    ].join("\n"),
  },
  [DESIGN_AGENT]: {
    description:
      "Design-principles enforcement for a code change. Checks DRY, SOLID, separation of concerns, abstraction boundaries, and systems-design choices, reporting severity-ranked findings with file:line evidence.",
    mode: "subagent",
    tools: { ...CRITIC_TOOLS },
    prompt: [
      "You are a design-principles enforcer. Your job is to hold code changes to a high structural standard: DRY, SOLID, clean separation of concerns, and sound systems design. You are not a general code reviewer; risk surfaces like auth, data loss, and error paths are another reviewer's job. You care about structure.",
      READ_ONLY_RULE,
      "",
      "Scope: review ONLY the changed code you are given (diff plus enough surrounding context to judge structure). Do not audit the whole repository.",
      "",
      "Evaluate, in priority order:",
      "1. DRY: duplicated logic, copy-pasted blocks, parallel implementations of the same rule. Flag duplication that will drift, not trivial repetition where an abstraction would cost more than it saves.",
      "2. SOLID:",
      "   - Single Responsibility: functions or modules doing unrelated jobs, god functions, grab-bag classes.",
      "   - Open/Closed: change-by-modification patterns where extension points already exist or clearly should.",
      "   - Liskov: subtypes or implementations that break the contract of what they replace.",
      "   - Interface Segregation: fat interfaces forcing consumers to depend on things they do not use.",
      "   - Dependency Inversion: high-level policy reaching into low-level detail, hardcoded concrete dependencies where the codebase already injects them.",
      "3. Separation of concerns and layering: business logic in UI or transport layers, I/O tangled with pure logic, wrong dependency direction, circular dependencies.",
      "4. Abstraction quality: wrong or leaky boundaries, premature abstraction for a single caller, missing abstraction where call sites already diverge, helpers that obscure rather than clarify.",
      "5. Systems-design choices: data ownership and flow, state placement, synchronous versus asynchronous boundaries, whether the change fights or follows the existing architecture.",
      "6. Size and complexity thresholds (treat as signals, not absolute rules): new or grown functions over ~50 lines, files over ~800 lines, nesting deeper than 4 levels. Flag only when the size reflects a real SRP or readability problem, and severity is at most P2 unless it compounds another finding.",
      "7. Comment noise: new comments that restate what the code already says, narrate obvious data structures or control flow, or label sections instead of extracting well-named functions. Flag each with the fix 'delete the comment' (or 'rename/extract so the code explains itself'). Severity P3, or P2 when the noise is pervasive across the diff. Comments that earn their keep are NOT findings: non-obvious invariants, security or concurrency constraints, tricky algorithms, regexes, and why-not-what explanations.",
      "",
      "Respect the codebase's own conventions. If the surrounding code deliberately favors duplication over coupling, or a simple procedural style, do not impose textbook patterns against the grain. A principle violation only counts when it creates real maintenance cost.",
      "",
      "For each finding provide:",
      "- Severity P0-P3, calibrated by structural cost:",
      "  - P0: structural damage that corrupts the architecture (circular dependency introduced, layering inverted, contract broken for existing consumers).",
      "  - P1: structural debt that will force rework or drift (copy-paste that will diverge, god function absorbing another responsibility, tangled coupling across modules, wrong abstraction boundary others will build on).",
      "  - P2: meaningful but contained violation (fat interface, minor SRP breach, missing extension point).",
      "  - P3: stylistic or judgment-call observation.",
      "- Exact location (file:line).",
      "- What principle is violated and the concrete maintenance cost.",
      "- The minimal structural fix. Prefer the smallest correct change; do not recommend rewrites when a targeted extraction or inversion suffices.",
      "",
      "Report ONLY material findings. If the change is structurally sound, say so in one sentence and stop. Do not pad the report with praise or restate the diff.",
    ].join("\n"),
  },
  [SECURITY_AGENT]: {
    description:
      "Checklist-driven security review of a code change. Walks a fixed OWASP-style checklist (secrets, injection, XSS, path traversal, authz, input validation, dependencies) over the diff and reports only material findings with file:line evidence and P0-P3 severity.",
    mode: "subagent",
    tools: { ...CRITIC_TOOLS },
    prompt: [
      "You are a security checklist reviewer. Unlike an adversarial reviewer who reasons about the worst attack, you mechanically walk a fixed checklist over the changed code. Review ONLY the diff plus enough surrounding context to judge exposure.",
      READ_ONLY_RULE,
      "",
      "Checklist, in order. For each item, actively look; do not assume absence:",
      "1. Secrets: hardcoded API keys, passwords, tokens, connection strings, private keys. Includes test files and config.",
      "2. Injection: SQL/NoSQL built by string concatenation or interpolation, shell commands from unsanitized input, eval/Function on dynamic strings.",
      "3. XSS: unescaped user input reaching HTML, innerHTML/dangerouslySetInnerHTML, missing output encoding.",
      "4. Path traversal: user-controlled paths in filesystem operations without normalization or allowlisting.",
      "5. AuthN/AuthZ: new routes or handlers missing authorization checks, authentication logic weakened, session/token validation bypassed.",
      "6. Input validation: external input (HTTP params, env, file contents, API responses) used without validation at the boundary.",
      "7. Dependencies: newly added packages that are obscure, unpinned, or shadow well-known names; downgrades of security-relevant packages.",
      "8. Unsafe deserialization or parsing of untrusted data.",
      "9. Sensitive data exposure: PII or credentials written to logs, error messages leaking internals, secrets in error paths.",
      "",
      "For each finding provide:",
      "- Severity P0-P3 (P0 = exploitable now, P1 = exploitable under realistic conditions, P2 = defense-in-depth gap, P3 = hardening suggestion).",
      "- Exact location (file:line).",
      "- The concrete attack or exposure scenario.",
      "- The minimal fix.",
      "",
      "Report ONLY material findings. If nothing on the checklist fires, say so in one sentence and stop. Do not pad the report.",
    ].join("\n"),
  },
};

// Extension patterns mapped to language-specific review guidance, injected
// into the review prompt only when the diff actually touches that language.
const LANGUAGE_HINTS = [
  [
    /\.(ts|tsx|mts|cts)$/,
    "TypeScript: `as any` / `@ts-ignore` / `!` non-null assertions papering over real type errors, floating promises (missing await), and for .tsx: effects with missing dependencies, unstable references causing re-renders.",
  ],
  [
    /\.(js|jsx|mjs|cjs)$/,
    "JavaScript: implicit coercion bugs, callbacks with swallowed errors, prototype pollution via object merges.",
  ],
  [
    /\.go$/,
    "Go: unchecked error returns, goroutine leaks, data races on shared maps/slices, missing context propagation and cancellation.",
  ],
  [
    /\.py$/,
    "Python: mutable default arguments, bare or overly broad except clauses, subprocess or SQL built from f-strings, missing type hints on new public functions.",
  ],
  [
    /\.rs$/,
    "Rust: unwrap()/expect() on fallible paths, new unsafe blocks, blocking calls inside async fns.",
  ],
  [
    /\.(java|kt|kts)$/,
    "Java/Kotlin: nullability holes, JPA N+1 queries, thread and coroutine safety of shared state.",
  ],
  [
    /\.(sql|prisma)$/,
    "SQL/schema: destructive migrations (DROP/ALTER losing data), missing indexes for new query patterns, irreversible migrations without a backfill plan.",
  ],
  [
    /\.(sh|bash|zsh)$/,
    "Shell: unquoted variable expansion, missing `set -euo pipefail`, word-splitting on paths.",
  ],
];

function languageHintsFor(files) {
  const hints = [];
  for (const [pattern, hint] of LANGUAGE_HINTS) {
    if (files.some((f) => pattern.test(f)) && !hints.includes(hint)) hints.push(hint);
  }
  return hints;
}

function buildReviewPrompt(languageHints) {
  return [
    REVIEW_MARKER,
    "You are reviewing, in the background, a coding turn that just finished in another session. Run an ADVERSARIAL self-review of that work before it is considered done.",
    "",
    "HARD CONSTRAINT: this review is strictly READ-ONLY. You must NEVER edit, write, create, delete, or fix any source file, and never run commands that modify source files or git state (no formatters with --write, no git add/commit/stash). Read-only checks that only write to build caches (e.g. `cargo check`, `tsc --noEmit`) are allowed. Your ONLY deliverable is a report.",
    "",
    "Do this:",
    "1. Run `git diff` (and include untracked files) to see exactly what changed.",
    "2. MECHANICAL GATES - run these BEFORE consulting any critic:",
    "   - Detect the project's own typecheck/lint commands (package.json scripts, tsconfig.json, Makefile, pyproject.toml, go.mod, Cargo.toml) and run the cheapest applicable check (e.g. `tsc --noEmit`, `ruff check`, `go vet`, `cargo check`), scoped to changed files where the tool allows.",
    "   - Scan the changed files for leftover debug output (console.log, print-debugging, debugger statements) and commented-out code blocks.",
    "   - Check whether the diff touches linter/formatter/typechecker config (.eslintrc*, biome.json*, tsconfig*, .prettierrc*, ruff.toml, clippy.toml) in a way that WEAKENS rules.",
    "   Every mechanical failure is an automatic P1 finding. Record them; never fix anything.",
    "3. Delegate the critique to THREE subagents IN PARALLEL (fire all three task calls in the same message, then wait for all). Give each the mechanical-gate results as context, and tell each that it is strictly read-only and must not modify files:",
    `   a. \`${RISK_AGENT}\` - adversarial risk critique. Its job is to BREAK confidence, not validate:`,
    "      - Attack the most expensive/risky surfaces first (auth, data loss, concurrency, external I/O, error paths).",
    "      - Report ONLY material findings, each with concrete evidence (file:line) and a severity P0-P3.",
    "      - Check the change against what it was clearly trying to do: nothing gamed, no deleted tests, no `as any`/`@ts-ignore`, no weakened lint/typecheck config.",
    `   b. \`${DESIGN_AGENT}\` - design and best-practice enforcement:`,
    "      - Enforce DRY, SOLID, separation of concerns, abstraction boundaries, and sound systems-design choices in the changed code.",
    "      - Report ONLY material findings, each with concrete evidence (file:line) and a severity P0-P3.",
    "      - Structural debt that will force rework or drift (copy-paste destined to diverge, god functions, tangled coupling, wrong abstraction boundaries) is P1, not P3.",
    `   c. \`${SECURITY_AGENT}\` - checklist-driven security review:`,
    "      - Walk the OWASP-style checklist (secrets, injection, XSS, path traversal, authz, input validation, dependencies) over the diff.",
    "      - Report ONLY material findings, each with concrete evidence (file:line) and a severity P0-P3.",
    ...(languageHints.length
      ? [
          "4. Language-specific attention for this diff (pass these to the relevant critics):",
          ...languageHints.map((hint) => `   - ${hint}`),
        ]
      : ["4. Language-specific attention: none for this diff."]),
    "5. After ALL subagents return, merge mechanical-gate findings and critic findings into one severity-ranked list, then run diagnostics on every changed file and record any that are not clean as findings.",
    "6. Output the FULL findings report: every finding, severity-ranked (P0 first), each with:",
    "   - Severity (P0-P3).",
    "   - Exact location (file:line).",
    "   - What is wrong, concretely.",
    "   - The suggested minimal fix (described, NOT applied).",
    "   If there are no findings, say so in one line.",
    "7. End with ONE terse verdict covering ALL reviews, stated as exactly the single word SHIP or the single word NO-SHIP on its own line:",
    "   - If any mechanical gate failed, or any reviewer produced a P0/P1 finding, the verdict is NO-SHIP. Do NOT fix anything yourself; the findings list above is the fix list.",
    "   - If SHIP: say so and stop. Do NOT start unrelated new work.",
    "",
    "Keep it tight. This is a review pass that reports problems; it never rewrites code.",
  ].join("\n");
};

// The prompt requires the verdict as the single word SHIP or NO-SHIP on
// its own line, so take the last such line, tolerating markdown wrappers
// (**SHIP**, ## SHIP, - SHIP), a "Verdict:" prefix, and trailing
// punctuation. No substring fallback: the report body legitimately
// contains phrases like "forces NO-SHIP" that must never win; with no
// verdict line the caller shows a neutral toast instead of guessing.
export function extractVerdict(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
      .replace(/[*_`]/g, "")
      .replace(/^\s*(?:#{1,6}|[->]|\d+\.)?\s*(?:verdict\s*:)?\s*/i, "")
      .replace(/[.:!\s]+$/, "");
    if (/^NO-SHIP$/i.test(line)) return "NO-SHIP";
    if (/^SHIP$/i.test(line)) return "SHIP";
  }
  return null;
}

// Sessions we have already spawned a review for since they last did new
// work, so a single finished turn produces exactly one review.
const reviewedSessions = new Set();

// Per-session diff snapshot captured at the start of the current (not yet
// reviewed) turn. Compared against the diff at idle time so we only trigger
// on changes made THIS turn, not on unrelated dirty files that were already
// sitting in the repo before the turn started.
const sessionBaselines = new Map();

// Per-session flag: did an editing tool run during the current turn?
const sessionWroteCode = new Map();

// Child session IDs we spawned for a background review, so we can recognize
// their own idle events and report a completion toast instead of treating
// them as a new turn to review.
const spawnedReviewSessions = new Set();

const reviewParents = new Map();

const feedbackCycles = new Map();

export const MightyReviewer = async ({ client, directory, worktree, $ }, options = {}) => {
  if (options.disabled || process.env.MIGHTY_REVIEWER_DISABLE === "1") {
    return {};
  }

  const cwd = worktree || directory;

  async function snapshotDiff() {
    try {
      // Full diff text (not --stat) so a content-only change to a file that
      // was already dirty still shows up as a difference from the baseline.
      const unstaged = await $`git -C ${cwd} diff`.text().catch(() => "");
      const staged = await $`git -C ${cwd} diff --cached`.text().catch(() => "");
      const untracked = await $`git -C ${cwd} ls-files --others --exclude-standard`
        .text()
        .catch(() => "");
      return `${unstaged}\u0000${staged}\u0000${untracked}`;
    } catch {
      // Not a git repo, or git unavailable -> no signal either way.
      return null;
    }
  }

  async function changedFileNames() {
    try {
      const tracked = await $`git -C ${cwd} diff --name-only HEAD`.text().catch(() => "");
      const untracked = await $`git -C ${cwd} ls-files --others --exclude-standard`
        .text()
        .catch(() => "");
      return `${tracked}\n${untracked}`
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function lastAssistantText(reviewSessionID) {
    try {
      const res = await client.session.messages({ path: { id: reviewSessionID } });
      const messages = res?.data ?? res ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const entry = messages[i];
        if (entry?.info?.role !== "assistant") continue;
        return (entry.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
      }
    } catch {
      // Best-effort only.
    }
    return null;
  }

  async function sendPrompt(sessionIDToPrompt, text) {
    const body = { parts: [{ type: "text", text }] };
    if (typeof client.session.promptAsync === "function") {
      await client.session.promptAsync({ path: { id: sessionIDToPrompt }, body });
    } else {
      await client.session.prompt({ path: { id: sessionIDToPrompt }, body });
    }
  }

  async function injectFindings(parentSessionID, report) {
    const cycles = feedbackCycles.get(parentSessionID) ?? 0;
    if (cycles >= MAX_REREVIEW_CYCLES) return "cycle-cap";
    const trimmed =
      report.length > MAX_FEEDBACK_CHARS
        ? `${report.slice(0, MAX_FEEDBACK_CHARS)}\n[report truncated]`
        : report;
    const feedback = [
      FEEDBACK_MARKER,
      "A background adversarial review of your last coding turn returned NO-SHIP. Findings:",
      "",
      trimmed,
      "",
      "Address the P0/P1 findings with minimal fixes. Do not start unrelated work. Do not weaken tests or lint/typecheck configs to make findings go away.",
    ].join("\n");
    try {
      await sendPrompt(parentSessionID, feedback);
      feedbackCycles.set(parentSessionID, cycles + 1);
      return "injected";
    } catch {
      return "failed";
    }
  }

  async function reportReviewCompletion(reviewSessionID, parentSessionID) {
    const report = await lastAssistantText(reviewSessionID);
    const verdict = extractVerdict(report);

    let message;
    let variant;
    if (verdict === "NO-SHIP") {
      const outcome =
        parentSessionID && report ? await injectFindings(parentSessionID, report) : "failed";
      message =
        outcome === "injected"
          ? `NO-SHIP: findings sent back to the session for fixes (cycle ${feedbackCycles.get(parentSessionID)}/${MAX_REREVIEW_CYCLES}).`
          : outcome === "cycle-cap"
            ? `NO-SHIP: re-review cycle cap (${MAX_REREVIEW_CYCLES}) reached, see review session for remaining findings.`
            : "NO-SHIP: background review found issues, see session for details.";
      variant = "warning";
    } else if (verdict === "SHIP") {
      message = "SHIP: background review passed.";
      variant = "success";
    } else {
      message = "Background review finished, see session for details.";
      variant = "success";
    }

    try {
      await client.tui.showToast({
        body: { title: "mighty-reviewer", message, variant },
      });
    } catch {
      // Toast is best-effort.
    }
  }

  return {
    config: (cfg) => {
      // Register the critic subagents. Never overwrite an agent the user
      // already defined under the same name, so local customization wins.
      cfg.agent = cfg.agent ?? {};
      for (const [name, definition] of Object.entries(AGENT_DEFINITIONS)) {
        if (!cfg.agent[name]) {
          cfg.agent[name] = definition;
        }
      }
    },
    "tool.execute.after": async (input) => {
      const sessionID = input?.sessionID;
      const toolName = input?.tool;
      if (!sessionID || !toolName) return;
      if (CODE_WRITING_TOOLS.has(toolName)) {
        sessionWroteCode.set(sessionID, true);
      }
    },
    "chat.message": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return;
      // The review prompt we inject arrives as a synthetic user message in
      // the CHILD session, never in the original one -- but guard anyway in
      // case the marker text ever ends up echoed back into a real session.
      const parts = output?.parts ?? [];
      const textOf = (p) => (p?.type === "text" && typeof p.text === "string" ? p.text : "");
      const isOwnInjection = parts.some((p) => textOf(p).includes(REVIEW_MARKER));
      if (isOwnInjection) return;
      const isFeedback = parts.some((p) => textOf(p).includes(FEEDBACK_MARKER));
      if (!isFeedback) feedbackCycles.delete(sessionID);
      // A genuine new message means fresh work -> allow it to be reviewed.
      reviewedSessions.delete(sessionID);
      // Snapshot the pre-turn diff and reset the "wrote code" flag exactly
      // once per turn (guarded by `has` so later chat.message events for the
      // same turn, e.g. streamed assistant parts, don't clobber them).
      if (!sessionBaselines.has(sessionID)) {
        sessionBaselines.set(sessionID, await snapshotDiff());
        sessionWroteCode.set(sessionID, false);
      }
    },
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;

      const sessionID = event?.properties?.sessionID;
      if (!sessionID) return;

      // This is one of our own background review sessions finishing, not a
      // user turn -> report the verdict via toast and stop, do not recurse.
      if (spawnedReviewSessions.has(sessionID)) {
        spawnedReviewSessions.delete(sessionID);
        sessionBaselines.delete(sessionID);
        sessionWroteCode.delete(sessionID);
        const parentSessionID = reviewParents.get(sessionID);
        reviewParents.delete(sessionID);
        await reportReviewCompletion(sessionID, parentSessionID);
        return;
      }

      // Already spawned a review for this session's current batch of work.
      if (reviewedSessions.has(sessionID)) return;

      // Only review turns that actually wrote code, not turns that were
      // pure investigation/chat (read, grep, bash without edits, etc.).
      if (!sessionWroteCode.get(sessionID)) return;

      // ...AND only when the diff actually changed since this turn started,
      // not just because the repo happens to have unrelated pre-existing
      // dirty files sitting around.
      const hasBaseline = sessionBaselines.has(sessionID);
      const baseline = hasBaseline ? sessionBaselines.get(sessionID) : undefined;
      const current = await snapshotDiff();

      if (current === null) return; // not a git repo, or git unavailable

      if (hasBaseline) {
        if (baseline === current) return; // nothing changed since this turn started
      } else if (!current) {
        return; // no baseline on record and nothing dirty either
      }

      reviewedSessions.add(sessionID);
      sessionBaselines.delete(sessionID);
      sessionWroteCode.delete(sessionID);

      // Fire-and-forget: spawn the review in a background child session and
      // return immediately, so this hook never blocks on the review's
      // (potentially long) run time.
      let reviewSessionID;
      (async () => {
        try {
          const files = await changedFileNames();
          const reviewPrompt = buildReviewPrompt(languageHintsFor(files));

          const created = await client.session.create({
            body: { parentID: sessionID, title: "Adversarial review" },
          });
          reviewSessionID = created?.data?.id ?? created?.id;
          if (!reviewSessionID) throw new Error("session.create returned no id");
          spawnedReviewSessions.add(reviewSessionID);
          reviewParents.set(reviewSessionID, sessionID);

          try {
            await client.tui.showToast({
              body: {
                title: "mighty-reviewer",
                message: "Code changed, running background review...",
                variant: "info",
              },
            });
          } catch {
            // Toast is best-effort.
          }

          await client.session.prompt({
            path: { id: reviewSessionID },
            body: {
              tools: { ...ORCHESTRATOR_TOOLS },
              parts: [{ type: "text", text: reviewPrompt }],
            },
          });
        } catch (err) {
          // If spawning failed, release the guard so a later idle can retry.
          reviewedSessions.delete(sessionID);
          if (reviewSessionID) {
            spawnedReviewSessions.delete(reviewSessionID);
            reviewParents.delete(reviewSessionID);
          }
          try {
            await client.app.log({
              body: {
                service: "mighty-reviewer",
                level: "error",
                message: "failed to spawn background review session",
                extra: { sessionID, error: String(err) },
              },
            });
          } catch {
            // Logging is best-effort.
          }
        }
      })();
    },
  };
};

export default MightyReviewer;
