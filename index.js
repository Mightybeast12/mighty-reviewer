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
 * Review:     Two subagents are consulted in parallel:
 *               - adversarial-risk-critic: attacks risky surfaces (auth,
 *                 data loss, concurrency, external I/O, error paths).
 *               - design-principles-critic: enforces DRY, SOLID, separation
 *                 of concerns, and sound systems-design choices.
 *             Both subagents are registered by this plugin via the `config`
 *             hook, so the package is fully self-contained. Existing agents
 *             with the same names are never overwritten, which lets users
 *             customize either critic locally.
 * Delivery:   Spawned as a background CHILD session (session.create with
 *             parentID) that runs its own review turn, instead of being
 *             injected into the current session. This keeps the review's
 *             git-diff output, subagent critique, and verdict out of the
 *             conversation the user is reading. A toast reports progress and
 *             the terse SHIP / NO-SHIP verdict once the child session
 *             finishes.
 * Loop guard: spawned child (review) session IDs are tracked in
 *             `spawnedReviewSessions`, so their own idle events are
 *             recognized as review completions and never mistaken for a
 *             turn that itself needs reviewing.
 * Opt-out:    set MIGHTY_REVIEWER_DISABLE=1, or pass { disabled: true }
 *             via the plugin tuple form in opencode.json.
 */

const REVIEW_MARKER = "<!--adversarial-review-auto-->";

// Tool names that count as "wrote code" for the purpose of gating a review.
const CODE_WRITING_TOOLS = new Set(["edit", "write"]);

const RISK_AGENT = "adversarial-risk-critic";
const DESIGN_AGENT = "design-principles-critic";

const AGENT_DEFINITIONS = {
  [RISK_AGENT]: {
    description:
      "Adversarial risk critique of a code change. Attacks the most expensive and risky surfaces (auth, data loss, concurrency, external I/O, error paths) and reports only material findings with file:line evidence and P0-P3 severity.",
    mode: "subagent",
    prompt: [
      "You are an adversarial code reviewer. Your job is to BREAK confidence in a code change, not validate it. You review only the changed code you are given (diff plus enough surrounding context to judge behavior).",
      "",
      "Attack, in priority order:",
      "1. Authentication, authorization, and secrets handling.",
      "2. Data loss and corruption paths (destructive writes, migrations, partial failure).",
      "3. Concurrency: races, deadlocks, shared mutable state, missing atomicity.",
      "4. External I/O: network, filesystem, subprocess, third-party APIs, timeouts, retries.",
      "5. Error paths: swallowed errors, empty catch blocks, error states that leave the system inconsistent.",
      "6. Gamed changes: deleted or weakened tests, hardcoded values to satisfy tests, `as any` / `@ts-ignore` / lint suppressions, dead code left behind.",
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
    prompt: [
      "You are a design-principles enforcer. Your job is to hold code changes to a high structural standard: DRY, SOLID, clean separation of concerns, and sound systems design. You are not a general code reviewer; risk surfaces like auth, data loss, and error paths are another reviewer's job. You care about structure.",
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
};

const REVIEW_PROMPT = [
  REVIEW_MARKER,
  "You are reviewing, in the background, a coding turn that just finished in another session. Run an ADVERSARIAL self-review of that work before it is considered done.",
  "",
  "Do this:",
  "1. Run `git diff` (and include untracked files) to see exactly what changed.",
  "2. Delegate the critique to TWO subagents IN PARALLEL (fire both task calls in the same message, then wait for both):",
  `   a. \`${RISK_AGENT}\` - adversarial risk critique. Its job is to BREAK confidence, not validate:`,
  "      - Attack the most expensive/risky surfaces first (auth, data loss, concurrency, external I/O, error paths).",
  "      - Report ONLY material findings, each with concrete evidence (file:line) and a severity P0-P3.",
  "      - Check the change against what it was clearly trying to do: nothing gamed, no deleted tests, no `as any`/`@ts-ignore`.",
  `   b. \`${DESIGN_AGENT}\` - design and best-practice enforcement:`,
  "      - Enforce DRY, SOLID, separation of concerns, abstraction boundaries, and sound systems-design choices in the changed code.",
  "      - Report ONLY material findings, each with concrete evidence (file:line) and a severity P0-P3.",
  "      - Structural debt that will force rework or drift (copy-paste destined to diverge, god functions, tangled coupling, wrong abstraction boundaries) is P1, not P3.",
  "3. After BOTH subagents return, merge their findings into one severity-ranked list, then run diagnostics on every changed file and confirm they are clean.",
  "4. Give ONE terse verdict covering BOTH reviews, stated as exactly the single word SHIP or the single word NO-SHIP on its own line:",
  "   - If either reviewer produced a P0/P1 finding, the verdict is NO-SHIP: fix those findings now, then re-verify.",
  "   - If SHIP: say so and stop. Do NOT start unrelated new work.",
  "",
  "Keep it tight. This is a review pass, not a rewrite.",
].join("\n");

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

  function extractVerdict(text) {
    if (typeof text !== "string") return null;
    if (/\bNO-SHIP\b/i.test(text)) return "NO-SHIP";
    if (/\bSHIP\b/i.test(text)) return "SHIP";
    return null;
  }

  async function reportReviewCompletion(reviewSessionID) {
    let verdict = null;
    try {
      const res = await client.session.messages({ path: { id: reviewSessionID } });
      const messages = res?.data ?? res ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const entry = messages[i];
        if (entry?.info?.role !== "assistant") continue;
        const text = (entry.parts ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
        verdict = extractVerdict(text);
        break;
      }
    } catch {
      // Best-effort only.
    }

    try {
      await client.tui.showToast({
        body: {
          title: "mighty-reviewer",
          message:
            verdict === "NO-SHIP"
              ? "NO-SHIP: background review found issues, see session for details."
              : verdict === "SHIP"
                ? "SHIP: background review passed."
                : "Background review finished, see session for details.",
          variant: verdict === "NO-SHIP" ? "warning" : "success",
        },
      });
    } catch {
      // Toast is best-effort.
    }
  }

  return {
    config: (cfg) => {
      // Register the two critic subagents. Never overwrite an agent the user
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
      const isOwnInjection = parts.some(
        (p) => p?.type === "text" && typeof p.text === "string" && p.text.includes(REVIEW_MARKER),
      );
      if (isOwnInjection) return;
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
        await reportReviewCompletion(sessionID);
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
          const created = await client.session.create({
            body: { parentID: sessionID, title: "Adversarial review" },
          });
          reviewSessionID = created?.data?.id ?? created?.id;
          if (!reviewSessionID) throw new Error("session.create returned no id");
          spawnedReviewSessions.add(reviewSessionID);

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
              parts: [{ type: "text", text: REVIEW_PROMPT }],
            },
          });
        } catch (err) {
          // If spawning failed, release the guard so a later idle can retry.
          reviewedSessions.delete(sessionID);
          if (reviewSessionID) spawnedReviewSessions.delete(reviewSessionID);
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
