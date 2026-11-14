import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import module, { MightyReviewer } from "./index.js";
import tuiPlugin from "./tui.js";
import { buildExternalDirectoryPermissions, makeShell } from "./v2.js";
import { evictFinishedBranchReviews } from "./branch.js";
import {
  extractVerdict,
  compareSemver,
  REVIEW_TITLE,
  describeInstall,
  countFindings,
  countVerifiedFindings,
  topVerifiedFinding,
  clipFindingTitle,
  formatNoShipSummary,
  formatFindingsDigest,
  criticLabel,
  formatCompactElapsed,
  formatTokenCount,
  severityTokens,
} from "./internals.js";

// Dual-host entry: OpenCode 1.18.29+ reads `server`, OpenCode 2 reads
// `id` + `setup`. The v1 factory stays the sole implementation.
assert.equal(module.id, "mighty-reviewer", "v2 plugin id matches the package name");
assert.equal(module.server, MightyReviewer, "v1 entry is the named factory");
assert.equal(typeof module.setup, "function", "v2 setup function exported");
assert.equal(tuiPlugin.id, "mighty-reviewer", "tui companion shares the plugin id");
assert.equal(typeof tuiPlugin.setup, "function", "tui companion exports setup");
const plugin = MightyReviewer;

// Branch reviews persist to the plugin's store under XDG_DATA_HOME (section
// 35): every review this file starts writes to a scratch store, never the
// real one.
{
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const pathMod = await import("node:path");
  const base = pathMod.join(os.tmpdir(), "opencode", "reviewer-test");
  mkdirSync(base, { recursive: true });
  const xdg = mkdtempSync(pathMod.join(base, "xdg-"));
  process.env.XDG_DATA_HOME = xdg;
  // Gone when the run ends, passed or failed.
  process.on("exit", () => rmSync(xdg, { recursive: true, force: true }));
}

// opencode v1 calls EVERY function export of the plugin entry point as a
// plugin factory, so any extra export (helpers returning null) bricks
// opencode at bootstrap.
const entryExports = Object.keys(await import("./index.js")).sort();
assert.deepEqual(entryExports, ["MightyReviewer", "default"], "index.js exposes only the plugin factory");

// Stub $ template tag (never called at init time).
const $ = () => ({ text: async () => "" });
const client = {};

// 1. Normal init returns all hooks.
const hooks = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ });
for (const key of ["config", "tool.execute.after", "tool.execute.before", "chat.message", "command.execute.before", "event", "dispose"]) {
  assert.ok(typeof hooks[key] === "function", `hook ${key} registered`);
}
assert.ok(typeof hooks.tool?.review_status?.execute === "function", "review_status tool registered");

// 2. config hook injects all agents without clobbering existing ones.
const cfg = { agent: { "design-principles-critic": { description: "user override", mode: "subagent", prompt: "mine" } } };
hooks.config(cfg);
assert.ok(cfg.agent["adversarial-risk-critic"], "risk critic injected");
assert.equal(cfg.agent["adversarial-risk-critic"].mode, "subagent");
assert.ok(cfg.agent["adversarial-risk-critic"].prompt.length > 100, "risk critic has prompt");
assert.ok(cfg.agent["adversarial-risk-critic"].prompt.includes("Weakened guardrails"), "risk critic checks weakened guardrails");
assert.ok(cfg.agent["security-checklist-critic"], "security critic injected");
assert.ok(cfg.agent["security-checklist-critic"].prompt.includes("Path traversal"), "security critic has checklist");
assert.ok(cfg.agent["ai-slop-critic"], "slop critic injected");
assert.ok(cfg.agent["ai-slop-critic"].prompt.includes("Negative parallelisms"), "slop critic carries the AI-writing tells");
assert.ok(cfg.agent["ai-slop-critic"].prompt.includes("Needless defensive code"), "slop critic carries the code-slop rules");
assert.ok(cfg.agent["ai-slop-critic"].prompt.includes("never issues P0"), "slop critic cannot issue P0");
assert.equal(cfg.agent["design-principles-critic"].prompt, "mine", "user override preserved");

// 3. config hook works when cfg.agent is absent, and registers the command.
const cfg2 = {};
hooks.config(cfg2);
const CRITICS = ["adversarial-risk-critic", "design-principles-critic", "security-checklist-critic", "ai-slop-critic"];
assert.ok(
  CRITICS.every((name) => cfg2.agent[name]),
  "agents injected into empty config",
);
assert.ok(cfg2.command["mighty-review"], "mighty-review command registered");
assert.ok(cfg2.command["mighty-review"].template.length > 0, "command has template");

// 3b. False-positive controls baked into every critic.
for (const name of CRITICS) {
  assert.ok(cfg2.agent[name].prompt.includes("Confidence 0.0-1.0"), `${name} has confidence rule`);
  assert.ok(cfg2.agent[name].prompt.includes("deterministic tooling"), `${name} has CI-boundary rule`);
  assert.equal(cfg2.agent[name].temperature, 0.1, `${name} pins temperature`);
}

// 3c. criticModel option routes critics to a cheaper model.
{
  const routed = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ }, { criticModel: "cheap/model" });
  const cfg3 = {};
  routed.config(cfg3);
  assert.equal(cfg3.agent["adversarial-risk-critic"].model, "cheap/model", "critic model routed");
}

// 4. Options-based disable returns empty hooks.
const disabled = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ }, { disabled: true });
assert.deepEqual(Object.keys(disabled), [], "disabled via options returns no hooks");

// 5. Critic agents are mechanically read-only (no mutation tools, no shell, no delegation).
for (const name of CRITICS) {
  const tools = cfg2.agent[name].tools;
  for (const denied of ["edit", "write", "patch", "bash", "task"]) {
    assert.equal(tools[denied], false, `${name} denies ${denied}`);
  }
}
assert.notEqual(
  cfg2.agent["adversarial-risk-critic"].tools,
  cfg2.agent["security-checklist-critic"].tools,
  "critic tools objects are not aliased",
);

// 6. Verdict extraction: last standalone verdict line wins, body mentions never do.
assert.equal(extractVerdict("findings...\n\nSHIP"), "SHIP");
assert.equal(extractVerdict("any P0/P1 finding forces NO-SHIP.\n\nSHIP"), "SHIP");
assert.equal(extractVerdict("report body\n\n**NO-SHIP**"), "NO-SHIP");
assert.equal(extractVerdict("report body\n\n## NO-SHIP"), "NO-SHIP");
assert.equal(extractVerdict("report body\n\n- SHIP"), "SHIP");
assert.equal(extractVerdict("report body\n\nVerdict: SHIP"), "SHIP");
assert.equal(extractVerdict("report body\n\nSHIP."), "SHIP");
assert.equal(extractVerdict("NO-SHIP\nquoted rule says SHIP is required"), "NO-SHIP");
assert.equal(extractVerdict("we are ready to ship this feature"), null, "prose 'ship' is not a verdict");
assert.equal(extractVerdict("review died mid-report, forces NO-SHIP eventually"), null, "body mention alone is not a verdict");
assert.equal(extractVerdict(undefined), null);

// Fake-client harness driving the hook choreography of one parent session.
const makeHarness = async (report, { promptAsyncResult, options, clientV2 } = {}) => {
  let currentReport = report;
  const promptCalls = [];
  const toasts = [];
  const logs = [];
  const aborted = [];
  const titles = [];
  let childN = 0;
  const sessionInfo = {};
  const fclient = {
    ...(clientV2 ? { v2: true } : {}),
    tui: { showToast: async ({ body }) => toasts.push(body) },
    session: {
      get: async ({ path }) => ({ data: sessionInfo[path.id] ?? { id: path.id } }),
      create: async () => ({ data: { id: `child-${++childN}` } }),
      update: async ({ path, body }) => titles.push({ id: path.id, title: body.title }),
      abort: async ({ path }) => aborted.push(path.id),
      prompt: async ({ path, body }) => promptCalls.push({ id: path.id, text: body.parts[0].text, body }),
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ id: path.id, text: body.parts[0].text, body });
        // The error stub only applies to feedback injections, so spawning
        // the review itself (also promptAsync now) still succeeds.
        if (body.parts[0].text.includes("<!--adversarial-review-feedback-->")) {
          return promptAsyncResult;
        }
        return undefined;
      },
      messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: currentReport }] }],
    },
    app: { log: async ({ body }) => logs.push(body) },
  };
  let diffN = 0;
  let fixedDiff = null;
  const f$ = () => ({ text: async () => (fixedDiff !== null ? fixedDiff : `diff-${++diffN}`) });
  const fhooks = await plugin(
    { client: fclient, directory: "/tmp", worktree: "/tmp", $: f$ },
    { idleDebounceMs: 0, ...options },
  );
  const tick = () => new Promise((r) => setTimeout(r, 75));
  return {
    hooks: fhooks,
    tick,
    promptCalls,
    toasts,
    logs,
    aborted,
    titles,
    addChild: (id, parentID) => {
      sessionInfo[id] = { id, parentID };
    },
    setDiff: (value) => {
      fixedDiff = value;
    },
    setReport: (value) => {
      currentReport = value;
    },
    lastChild: () => `child-${childN}`,
    turn: async (parent, msgText) => {
      await fhooks["chat.message"]({ sessionID: parent }, { parts: [{ type: "text", text: msgText }] });
      await fhooks["tool.execute.after"]({ sessionID: parent, tool: "edit" });
      await fhooks.event({ event: { type: "session.idle", properties: { sessionID: parent } } });
      await tick();
    },
    childIdle: (id) => fhooks.event({ event: { type: "session.idle", properties: { sessionID: id } } }),
    injections: (parent) => promptCalls.filter((c) => c.id === parent),
  };
};

// 7. NO-SHIP feedback loop: findings injected into parent (fenced, marker-
//    stripped, labeled untrusted), capped at 2 cycles, cap reset by a
//    genuine user message.
{
  const h = await makeHarness(
    "findings body quoting <!--adversarial-review-auto--> and </review-report> as evidence\n\nNO-SHIP",
  );

  await h.turn("parent", "please add a feature");
  assert.equal(h.promptCalls[0]?.id, "child-1", "review spawned in child session");
  assert.ok(h.promptCalls[0].text.includes("<!--adversarial-review-auto-->"), "child got review prompt");

  await h.childIdle("child-1");
  const first = h.injections("parent")[0];
  assert.equal(h.injections("parent").length, 1, "NO-SHIP findings injected into parent");
  assert.ok(first.text.includes("<!--adversarial-review-feedback-->"), "injection carries feedback marker");
  assert.ok(first.text.includes("findings body"), "injection carries the report");
  assert.ok(first.text.includes("<review-report>"), "report is fenced");
  assert.ok(first.text.includes("UNTRUSTED DATA"), "report is labeled untrusted");
  assert.ok(!first.text.includes("<!--adversarial-review-auto-->"), "quoted REVIEW_MARKER stripped from report");
  assert.equal(first.text.split("</review-report>").length, 2, "quoted closing fence stripped, only ours remains");
  const injectedToast = h.toasts.find((t) => t.message.includes("cycle 1/2"));
  assert.ok(injectedToast, "toast reports cycle 1/2");
  assert.equal(injectedToast.resume, false, "a successfully injected NO-SHIP notice stays quiet (real prompt already started the fix cycle)");
  assert.equal(injectedToast.detail, undefined, "no duplicate report when the real injection already carried it");

  await h.turn("parent", first.text);
  await h.childIdle("child-2");
  assert.equal(h.injections("parent").length, 2, "second NO-SHIP injected");
  assert.ok(h.toasts.some((t) => t.message.includes("cycle 2/2")), "toast reports cycle 2/2");

  await h.turn("parent", h.injections("parent")[1].text);
  await h.childIdle("child-3");
  assert.equal(h.injections("parent").length, 2, "third NO-SHIP hits cycle cap, no injection");
  const cycleCapToast = h.toasts.find((t) => t.message.includes("cycle cap"));
  assert.ok(cycleCapToast, "toast reports cycle cap");
  assert.equal(cycleCapToast.resume, true, "cycle-cap NO-SHIP notice starts the fix cycle itself, nothing else will");
  assert.ok(typeof cycleCapToast.detail === "string" && cycleCapToast.detail.includes("findings body"), "cycle-cap notice carries the full report as detail");

  await h.turn("parent", "a brand new user request");
  await h.childIdle("child-4");
  assert.equal(h.injections("parent").length, 3, "genuine user message resets the cycle budget");
}

// 8. Absolute injection cap: even endless genuine-message resets (which mimic
//    synthetic user-role messages like compaction) cannot exceed
//    MAX_TOTAL_INJECTIONS per parent session.
{
  const h = await makeHarness("findings\n\nNO-SHIP");
  for (let round = 1; round <= 11; round++) {
    await h.turn("parent8", `genuine message ${round}`);
    await h.childIdle(h.lastChild());
  }
  assert.equal(h.injections("parent8").length, 10, "total injection cap holds at 10");
  assert.ok(h.toasts.some((t) => t.message.includes("cycle cap")), "total cap reported via cap toast");
}

// 9. SDK clients resolve with { error } on HTTP failures instead of throwing:
//    a rejected injection must not burn the cycle budget, and must be logged
//    and reported as a plain failure toast carrying the NO-SHIP summary.
{
  const h = await makeHarness("findings\n\nNO-SHIP", {
    promptAsyncResult: { error: { name: "NotFoundError" } },
  });
  await h.turn("parent9", "please add a feature");
  await h.childIdle("child-1");
  assert.ok(
    h.toasts.some((t) => t.message.startsWith("NO-SHIP:") && t.message.includes("see session for details")),
    "failed injection falls back to a NO-SHIP toast with the summary line",
  );
  assert.ok(!h.toasts.some((t) => t.message.includes("cycle 1/2")), "failed injection does not count a cycle");
  assert.ok(
    h.logs.some((l) => l.message.includes("failed to inject")),
    "failed injection is logged",
  );
}

// 10. /mighty-review command triggers an on-demand review spawn.
{
  const h = await makeHarness("clean\n\nSHIP");
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "cmd-parent" }, { parts: [] });
  await h.tick();
  assert.equal(h.promptCalls[0]?.id, "child-1", "command spawned review child");
  assert.ok(h.promptCalls[0].text.includes("<!--adversarial-review-auto-->"), "child got review prompt");
  assert.ok(h.toasts.some((t) => t.message.includes("Review requested")), "command toast shown");
  await h.hooks["command.execute.before"]({ command: "other-command", sessionID: "cmd-parent" }, { parts: [] });
  await h.tick();
  assert.equal(h.promptCalls.length, 1, "unrelated commands do not spawn reviews");
}

// 11. review_status tool reports running then done with verdict + report.
//     Every answer opens with the version this process is running, in the
//     spec form opencode.json pins (backlog B1), so the orchestrator can
//     tell a stale session from the pin without the TUI sidebar. The idle
//     answer used to be the bare sentence; it now follows that line. The
//     label is "plugin:", never a word the review states use: "running"
//     there read as a review in progress on a done answer.
const RUNNING_LINE = `plugin: mighty-reviewer@${JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version}`;
const noRunningWord = (answer, label) =>
  assert.ok(!/\brunning\b/i.test(answer), `${label} carries no 'running' word, so it never reads as a review in progress: ${answer.slice(0, 120)}`);
{
  const h = await makeHarness("some findings\n\nNO-SHIP");
  const status = h.hooks.tool.review_status;
  assert.equal(
    await status.execute({}, { sessionID: "status-parent" }),
    `${RUNNING_LINE}\nNo review has run for this session yet.`,
  );
  noRunningWord(await status.execute({}, { sessionID: "status-parent" }), "the idle answer");
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "status-parent" }, { parts: [] });
  await h.tick();
  const running = await status.execute({}, { sessionID: "status-parent" });
  assert.equal(running.split("\n")[0], RUNNING_LINE, "running state names the running version first");
  assert.ok(running.includes("in progress"), "running state reported");
  await h.childIdle("child-1");
  const done = await status.execute({}, { sessionID: "status-parent" });
  assert.equal(done.split("\n")[0], RUNNING_LINE, "done state names the running version first");
  noRunningWord(done, "the done answer");
  assert.ok(done.includes("verdict: NO-SHIP"), "verdict reported");
  assert.ok(done.includes("some findings"), "report included");
}

// 12. enforceNoShip blocks git commit/push while a NO-SHIP verdict is
//     unresolved, and unblocks after a SHIP verdict.
{
  const h = await makeHarness("bad\n\nNO-SHIP", { options: { enforceNoShip: true } });
  await h.turn("enforce-parent", "please add a feature");
  await h.childIdle("child-1");
  await assert.rejects(
    h.hooks["tool.execute.before"](
      { tool: "bash", sessionID: "enforce-parent" },
      { args: { command: "git commit -m 'x'" } },
    ),
    /NO-SHIP verdict is unresolved/,
    "git commit blocked under NO-SHIP",
  );
  await h.hooks["tool.execute.before"](
    { tool: "bash", sessionID: "enforce-parent" },
    { args: { command: "ls -la" } },
  );
  await h.hooks["tool.execute.before"](
    { tool: "bash", sessionID: "other-session" },
    { args: { command: "git push" } },
  );

  const h2 = await makeHarness("all good\n\nSHIP", { options: { enforceNoShip: true } });
  await h2.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "enforce-parent" }, { parts: [] });
  await h2.tick();
  await h2.childIdle("child-1");
  await h2.hooks["tool.execute.before"](
    { tool: "bash", sessionID: "enforce-parent" },
    { args: { command: "git push" } },
  );
}

// 13. Semver comparison used by the update checker.
assert.ok(compareSemver("0.4.2", "0.4.1") > 0);
assert.ok(compareSemver("0.4.1", "0.10.0") < 0, "numeric compare, not lexicographic");
assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
assert.ok(compareSemver("1.0.0-beta.1", "1.0.0") < 0, "prerelease sorts below release");
assert.ok(compareSemver("1.0.0", "1.0.0-beta.1") > 0);
assert.ok(compareSemver("1.0.0-beta.10", "1.0.0-beta.9") > 0, "numeric prerelease identifiers, not lexicographic");
assert.ok(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0, "fewer prerelease identifiers sort first");
assert.ok(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0, "numeric identifiers sort below alphanumeric");

// 14. Install-location detection drives pin/channel/auto-update decisions.
{
  const cache = "file:///home/u/.cache/opencode/packages";
  const unpinned = describeInstall(`${cache}/mighty-reviewer/node_modules/mighty-reviewer/index.js`);
  assert.equal(unpinned.pinned, false, "bare spec is unpinned");
  assert.equal(unpinned.channel, "latest");
  assert.ok(unpinned.workspaceDir.endsWith("packages/mighty-reviewer"), "workspace is the spec dir");

  const latestTag = describeInstall(`${cache}/mighty-reviewer@latest/node_modules/mighty-reviewer/index.js`);
  assert.equal(latestTag.pinned, false, "@latest is unpinned");
  assert.equal(latestTag.channel, "latest");

  const pinned = describeInstall(`${cache}/mighty-reviewer@0.4.1/node_modules/mighty-reviewer/index.js`);
  assert.equal(pinned.pinned, true, "exact version spec is pinned");

  const beta = describeInstall(`${cache}/mighty-reviewer@beta/node_modules/mighty-reviewer/index.js`);
  assert.equal(beta.pinned, false, "dist-tag spec is unpinned");
  assert.equal(beta.channel, "beta", "dist-tag spec sets the channel");

  const range = describeInstall(`${cache}/mighty-reviewer@%5E0.4.0/node_modules/mighty-reviewer/index.js`);
  assert.equal(range.pinned, true, "range spec is treated as pinned, never retargeted to latest");
  assert.equal(range.channel, "latest");

  assert.equal(
    describeInstall(`${cache}/other-plugin/node_modules/mighty-reviewer/index.js`),
    null,
    "nested install under another package is not managed",
  );

  assert.equal(describeInstall("file:///home/u/dev/mighty-reviewer/index.js"), null, "dev checkout is not managed");
  assert.equal(
    describeInstall("file:///home/u/.config/opencode/plugin/mighty-reviewer.js"),
    null,
    "plugin-dir file copy is not managed",
  );
  assert.equal(describeInstall("not a url"), null, "malformed url is not managed");
}

// 15. Child sessions (subagents) are never reviewed on their own, but their
//     edits count toward the root session's turn; edits by our own review
//     sessions count toward nothing.
{
  const h = await makeHarness("clean\n\nSHIP");
  h.addChild("sub", "parent15");
  h.addChild("subsub", "sub");
  h.setDiff("clean-tree");

  await h.hooks["chat.message"]({ sessionID: "parent15" }, { parts: [{ type: "text", text: "go" }] });
  await h.hooks["chat.message"]({ sessionID: "sub" }, { parts: [{ type: "text", text: "delegated" }] });
  await h.hooks["tool.execute.after"]({ sessionID: "subsub", tool: "edit" });
  h.setDiff("clean-tree\n+ subagent wrote this");

  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "subsub" } } });
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "sub" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 0, "child sessions did not trigger a review");

  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent15" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 1, "root turn reviewed once, credited with the subagent's edit");
  assert.equal(h.promptCalls[0].id, "child-1");

  await h.hooks["chat.message"]({ sessionID: "parent15" }, { parts: [{ type: "text", text: "next" }] });
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "edit" });
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent15" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 1, "review-session edits did not trigger another review");
}

// 16. Turns that do not trigger a review leave no stale baseline behind: the
//     next turn compares against its own start, not a previous turn's.
{
  const h = await makeHarness("clean\n\nSHIP");
  h.setDiff("");

  await h.hooks["chat.message"]({ sessionID: "root16" }, { parts: [{ type: "text", text: "just chat" }] });
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root16" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 0, "read-only turn not reviewed");

  h.setDiff("+ manual edit between turns");
  await h.hooks["chat.message"]({ sessionID: "root16" }, { parts: [{ type: "text", text: "turn B" }] });
  await h.hooks["tool.execute.after"]({ sessionID: "root16", tool: "edit" });
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root16" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 0, "no review when this turn's diff matches its own fresh baseline");

  await h.hooks["chat.message"]({ sessionID: "root16" }, { parts: [{ type: "text", text: "turn C" }] });
  await h.hooks["tool.execute.after"]({ sessionID: "root16", tool: "apply_patch" });
  h.setDiff("+ manual edit between turns\n+ agent edit");
  await h.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root16" } } });
  await h.tick();
  assert.equal(h.promptCalls.length, 1, "review fires once the diff actually moves, apply_patch counts as writing");
}

// 17. agent option routes the review session's orchestrating agent.
{
  const h = await makeHarness("clean\n\nSHIP", { options: { agent: "build" } });
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "cmd17" }, { parts: [] });
  await h.tick();
  assert.equal(h.promptCalls[0].body.agent, "build", "review agent forwarded to prompt");

  const h2 = await makeHarness("clean\n\nSHIP");
  await h2.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "cmd17b" }, { parts: [] });
  await h2.tick();
  assert.equal(h2.promptCalls[0].body.agent, undefined, "no agent forced by default");
}

// 18. Review prompt forbids substituting other agents for the critics, and
//     dispatches every registered critic by its exact name.
{
  const h = await makeHarness("clean\n\nSHIP");
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "cmd18" }, { parts: [] });
  await h.tick();
  assert.match(h.promptCalls[0].text, /NEVER substitute a different agent/, "anti-substitution rule present");
  assert.match(h.promptCalls[0].text, /FOUR subagents IN PARALLEL/, "orchestrator told to dispatch four critics");
  for (const name of CRITICS) {
    assert.ok(h.promptCalls[0].text.includes(`\`${name}\``), `review prompt dispatches ${name}`);
  }
}

// 19. Progress tracking: phases inferred from tool activity in the review
//     session surface via review_status, phase-transition toasts, and live
//     session titles; the verdict lands in the title on completion.
{
  const h = await makeHarness("clean\n\nSHIP");
  const status = h.hooks.tool.review_status;
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "prog-parent" }, { parts: [] });
  await h.tick();
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("starting up"), "initial phase reported");

  await h.hooks["tool.execute.before"]({ sessionID: "child-1", tool: "bash" }, { args: { command: "git diff" } });
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("mechanical gates"), "gates phase reported");
  assert.ok(h.titles.some((t) => t.id === "child-1" && t.title.includes("gates")), "gates title set");

  for (let i = 0; i < CRITICS.length; i++) {
    await h.hooks["tool.execute.before"]({ sessionID: "child-1", tool: "task" }, { args: {} });
  }
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("0/4"), "critic dispatch counted");
  assert.ok(h.toasts.some((t) => t.message.includes("critics running")), "critic dispatch toast shown once");
  assert.equal(h.toasts.filter((t) => t.message.includes("critics running")).length, 1, "dispatch toast not repeated");

  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("1/4"), "critic completion counted");
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("3/4"), "phase stays on critics until the last one returns");
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("verifying"), "verifying phase reported");
  assert.ok(h.toasts.some((t) => t.message.includes("verifying findings")), "verifying toast shown");

  await h.hooks["tool.execute.before"]({ sessionID: "not-a-review", tool: "task" }, { args: {} });
  assert.ok((await status.execute({}, { sessionID: "prog-parent" })).includes("verifying"), "foreign sessions do not disturb phase");

  await h.childIdle("child-1");
  assert.ok(h.titles.at(-1).title.includes("SHIP"), "verdict lands in the title");
  const done = await status.execute({}, { sessionID: "prog-parent" });
  assert.ok(done.includes("verdict: SHIP"), "completion still reports the verdict");
}

// 20. progressToasts: false suppresses phase toasts but keeps phase state.
{
  const h = await makeHarness("clean\n\nSHIP", { options: { progressToasts: false } });
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "quiet-parent" }, { parts: [] });
  await h.tick();
  await h.hooks["tool.execute.before"]({ sessionID: "child-1", tool: "task" }, { args: {} });
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.ok(!h.toasts.some((t) => t.message.includes("Review progress")), "no progress toasts when disabled");
  assert.ok(
    (await h.hooks.tool.review_status.execute({}, { sessionID: "quiet-parent" })).includes("verifying"),
    "phase still tracked for review_status",
  );
}

// 21. A review session that idles WITHOUT a verdict (orchestrator launched
//     critics as background tasks and ended its turn) is nudged back to
//     collect results instead of being finalized with the launch
//     acknowledgment as the report.
{
  const h = await makeHarness("All four critics launched. Waiting for their completion notifications.");
  const status = h.hooks.tool.review_status;
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "nudge-parent" }, { parts: [] });
  await h.tick();
  assert.equal(h.promptCalls.length, 1, "review spawned");

  await h.childIdle("child-1");
  assert.equal(h.promptCalls.length, 2, "verdict-less idle triggers a nudge prompt");
  assert.equal(h.promptCalls[1].id, "child-1", "nudge goes to the review session");
  assert.match(h.promptCalls[1].text, /WITHOUT the required verdict/, "nudge demands the verdict");
  assert.ok(
    (await status.execute({}, { sessionID: "nudge-parent" })).includes("still in progress"),
    "review stays running after a nudge",
  );
  assert.ok((await status.execute({}, { sessionID: "nudge-parent" })).includes("collecting"), "collecting phase reported");
  assert.ok(h.toasts.some((t) => t.message.includes("nudged")), "nudge toast shown");

  await h.childIdle("child-1");
  assert.equal(h.promptCalls.length, 2, "duplicate idle with unchanged output absorbs, no double nudge");

  h.setReport("full findings collected\n\nSHIP");
  await h.childIdle("child-1");
  const done = await status.execute({}, { sessionID: "nudge-parent" });
  assert.ok(done.includes("verdict: SHIP"), "nudged review finalizes with the real verdict");
  assert.ok(h.titles.at(-1).title.includes("SHIP"), "verdict title set after nudge cycle");
}

// 22. The nudge budget is capped: a review that never produces a verdict is
//     finalized as-is instead of being nudged forever.
{
  const h = await makeHarness("launch ack, attempt 1");
  await h.hooks["command.execute.before"]({ command: "mighty-review", sessionID: "cap-parent" }, { parts: [] });
  await h.tick();
  await h.childIdle("child-1");
  h.setReport("still waiting, attempt 2");
  await h.childIdle("child-1");
  h.setReport("still waiting, attempt 3");
  await h.childIdle("child-1");
  assert.equal(h.promptCalls.filter((c) => c.id === "child-1").length, 3, "spawn plus exactly 2 nudges");
  const done = await h.hooks.tool.review_status.execute({}, { sessionID: "cap-parent" });
  assert.ok(done.includes("unknown"), "finalized without a verdict once the cap is hit");
  assert.ok(done.includes("still waiting, attempt 3"), "last report still captured");
  assert.ok(h.toasts.some((t) => t.message.includes("Background review finished")), "generic completion toast shown");
}



// 23. OpenCode 2 bridge: setup(ctx) registers the critics, command, tool and
//     hooks through the v2 context, and routes the review lifecycle through
//     v2 session calls (create carries agent/model/permissions, notices land
//     as synthetic messages in the parent session, idle arrives as
//     session.execution.succeeded).
{
  const calls = [];
  const agents = new Map([["build", { id: "build", request: { body: {} }, permissions: [] }]]);
  const commands = [];
  const tools = [];
  const hookCallbacks = {};
  let eventQueue = [];
  let resolveNext = null;
  const events = {
    async *subscribe({ signal }) {
      while (!signal.aborted) {
        if (eventQueue.length) {
          yield eventQueue.shift();
          continue;
        }
        await new Promise((resolve) => {
          resolveNext = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
  const push = (event) => {
    eventQueue.push(event);
    resolveNext?.();
    resolveNext = null;
  };
  const registration = { dispose: async () => {} };
  const transform = (callback) => async (fn) => {
    fn(callback);
    return registration;
  };
  let report = "- **P1** report body\n\nNO-SHIP";
  const ctx = {
    options: { model: "prov/model-x", agent: "reviewer", idleDebounceMs: 0, enforceNoShip: true },
    location: { directory: "/tmp/v2-project", project: { directory: "/tmp/v2-project" } },
    agent: {
      transform: transform({
        get: (id) => agents.get(id),
        update: (id, fn) => {
          const agent = agents.get(id) ?? { id, request: { settings: {}, headers: {}, body: {} }, permissions: [], mode: "primary" };
          agents.set(id, agent);
          fn(agent);
        },
      }),
    },
    command: {
      list: async () => ({ data: [{ name: "existing" }] }),
      transform: transform({ add: (definition) => commands.push(definition) }),
    },
    tool: {
      transform: transform({ add: (definition) => tools.push(definition) }),
      hook: async (name, callback) => {
        hookCallbacks[`tool.${name}`] = callback;
        return registration;
      },
    },
    permission: {
      hook: async (name, callback) => {
        hookCallbacks[`permission.${name}`] = callback;
        return registration;
      },
    },
    session: {
      hook: async (name, callback) => {
        hookCallbacks[`session.${name}`] = callback;
        return registration;
      },
      get: async ({ sessionID }) => ({
        id: sessionID,
        parentID: sessionID.startsWith("child") ? "parent-v2" : undefined,
        location: { directory: "/tmp/v2-project" },
      }),
      context: async () => [
        { type: "user", text: "review this" },
        { type: "assistant", content: [{ type: "text", text: report }] },
      ],
      create: async (input) => {
        calls.push(["create", input]);
        return { id: "child-v2" };
      },
      prompt: async (input) => {
        calls.push(["prompt", input]);
        return {};
      },
      synthetic: async (input) => {
        calls.push(["synthetic", input]);
        return {};
      },
      update: async (input) => {
        calls.push(["update", input]);
      },
      interrupt: async () => ({ interrupted: true }),
    },
    event: events,
  };

  const cleanup = await module.setup(ctx);
  assert.equal(typeof cleanup, "function", "v2 setup returns a cleanup");

  const critic = agents.get("adversarial-risk-critic");
  assert.ok(critic, "critic registered through agent.transform");
  assert.equal(critic.mode, "subagent");
  assert.equal(critic.request.body.temperature, 0.1, "temperature lands in request.body");
  assert.ok(critic.system.includes("Weakened guardrails"), "prompt becomes system");
  const denied = critic.permissions.filter((rule) => rule.effect === "deny").map((rule) => rule.action).sort();
  assert.deepEqual(denied, ["edit", "external_directory", "shell", "subagent"], "critic tools map to v2 permission actions, plus out-of-project access denied");
  assert.equal(agents.get("build").system, undefined, "existing agents untouched");

  assert.equal(commands.length, 1, "mighty-review command registered");
  assert.equal(commands[0].name, "mighty-review");
  // Two tools since review_branch (section 33); its JSON input schema
  // reaches the host, while review_status keeps the empty one.
  assert.equal(tools.length, 2, "review_status and review_branch registered");
  assert.equal(tools[0].name, "review_status");
  assert.deepEqual(tools[0].input.properties, {}, "review_status takes no input");
  assert.equal(tools[1].name, "review_branch");
  assert.deepEqual(tools[1].input.required, ["base"], "review_branch's input schema reaches the v2 host");
  const idle = await tools[0].execute({}, { sessionID: "parent-v2" });
  assert.ok(idle.content.includes("No review"), "review_status answers through v2 tool result");
  assert.equal(idle.content.split("\n")[0], RUNNING_LINE, "v2 review_status names the running version first");

  // The reviewer snapshots real git state through $ (Bun's tag, or the Node
  // fallback), so give it a clean repo before the turn and dirty it after
  // the edit so the before/after snapshots differ.
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  rmSync("/tmp/v2-project", { recursive: true, force: true });
  mkdirSync("/tmp/v2-project", { recursive: true });
  execFileSync("git", ["-C", "/tmp/v2-project", "init", "-q"]);

  // A user turn that edits a file, then goes idle, spawns a review.
  await hookCallbacks["session.prompt"]({ sessionID: "parent-v2", prompt: { text: "please fix" } });
  await hookCallbacks["tool.execute.after"]({ sessionID: "parent-v2", tool: "edit" });
  writeFileSync("/tmp/v2-project/a.txt", "changed\n");
  push({ type: "session.execution.succeeded", location: { directory: "/tmp/v2-project" }, data: { sessionID: "parent-v2" } });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const create = calls.find(([kind]) => kind === "create");
  assert.ok(create, "review child session created through ctx.session.create");
  assert.equal(create[1].parentID, undefined, "review session is a root session so critics clear the subagent depth cap");
  assert.equal(create[1].metadata.mightyReviewer.parentID, "parent-v2", "parent link kept in metadata");
  assert.equal(create[1].agent, "reviewer", "options.agent applied at create time");
  assert.deepEqual(create[1].model, { providerID: "prov", id: "model-x" }, "options.model applied at create time");
  assert.deepEqual(
    create[1].permissions,
    [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ],
    "orchestrator edit tools and out-of-project access denied by permission",
  );
  const reviewPrompt = calls.find(([kind, input]) => kind === "prompt" && input.sessionID === "child-v2");
  assert.ok(reviewPrompt, "review prompt sent to the child");
  assert.ok(reviewPrompt[1].text.includes("ADVERSARIAL"), "review prompt body preserved");
  assert.equal(reviewPrompt[1].delivery, "queue");
  const started = calls.find(([kind, input]) => kind === "synthetic" && input.text.includes("running background review"));
  assert.ok(started, "start notice delivered into the parent session");
  assert.equal(started[1].sessionID, "parent-v2");
  assert.equal(started[1].metadata.mightyReviewer.variant, "info");
  assert.equal(started[1].resume, false, "notices never wake the agent");
  assert.equal(
    started[1].description,
    "mighty-reviewer \u00b7 Code changed, running background review...",
    "a progress notice's description is just 'mighty-reviewer . message', no digest to show yet",
  );

  // Review progress tracking sees v1 tool names for v2 tools.
  await hookCallbacks["tool.execute.before"]({ sessionID: "child-v2", tool: "shell", input: { command: "git diff" } });
  await hookCallbacks["tool.execute.before"]({ sessionID: "child-v2", tool: "subagent", input: {} });
  const progress = await tools[0].execute({}, { sessionID: "parent-v2" });
  assert.ok(progress.content.includes("waiting on critics (0/1"), `v2 tool names drive phase tracking: ${progress.content}`);

  // Child idle with NO-SHIP: findings injected into the parent, notice posted.
  push({ type: "session.execution.succeeded", location: { directory: "/tmp/v2-project" }, data: { sessionID: "child-v2" } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const feedback = calls.find(([kind, input]) => kind === "prompt" && input.sessionID === "parent-v2");
  assert.ok(feedback, "NO-SHIP findings injected into the parent session");
  assert.ok(feedback[1].text.includes("report body"), "report body forwarded");
  const verdictNotice = calls.find(([kind, input]) => kind === "synthetic" && input.text.includes("NO-SHIP"));
  assert.ok(verdictNotice, "verdict notice delivered into the parent session");
  assert.equal(verdictNotice[1].metadata.mightyReviewer.variant, "warning");
  assert.ok(
    verdictNotice[1].description.startsWith("mighty-reviewer \u00b7 NO-SHIP"),
    `the chat row's description leads with the verdict: ${verdictNotice[1].description}`,
  );
  assert.ok(
    verdictNotice[1].description.includes("  P"),
    `the chat row's description carries the findings digest: ${verdictNotice[1].description}`,
  );
  assert.ok(
    verdictNotice[1].text.startsWith("mighty-reviewer: NO-SHIP"),
    `the model-facing text is unchanged by the digest: ${verdictNotice[1].text}`,
  );
  const status = await tools[0].execute({}, { sessionID: "parent-v2" });
  assert.ok(status.content.includes("verdict: NO-SHIP"), "review_status reports the verdict");

  // Events from other locations are ignored.
  const before = calls.length;
  push({ type: "session.execution.succeeded", location: { directory: "/elsewhere" }, data: { sessionID: "parent-v2" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, before, "foreign-location events ignored");

  // The tui companion turns the synthetic notice event into a toast.
  const toasts = [];
  let tuiPush;
  const tuiCleanup = await tuiPlugin.setup({
    client: {
      event: {
        async *subscribe({ signal }) {
          while (!signal.aborted) {
            const next = await new Promise((resolve) => {
              tuiPush = resolve;
              signal.addEventListener("abort", () => resolve(null), { once: true });
            });
            if (next) yield next;
          }
        },
      },
    },
    ui: { toast: { show: (toast) => toasts.push(toast) } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  tuiPush({ type: "session.inbox.enqueued", data: { sessionID: "parent-v2", inboxID: "msg_1", item: { type: "synthetic", payload: { text: "x", metadata: { mightyReviewer: { message: "SHIP: ok", variant: "success" } } } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  tuiPush({ type: "session.inbox.enqueued", data: { sessionID: "parent-v2", inboxID: "msg_2", item: { type: "user", payload: { text: "unrelated" } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  tuiPush({ type: "session.synthetic", data: { sessionID: "parent-v2", text: "delivered later", metadata: { mightyReviewer: { message: "dup", variant: "info" } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(toasts, [{ title: "mighty-reviewer", message: "SHIP: ok", variant: "success", sessionID: "parent-v2" }], "only tagged notices become toasts");
  await tuiCleanup();

  // enforceNoShip: with a NO-SHIP verdict outstanding, git commit/push is
  // refused through the permission hook (clean deny, not a thrown defect).
  const blocked = { sessionID: "parent-v2", action: "shell", resources: ["git push origin main"], effect: "allow" };
  await hookCallbacks["permission.evaluate"](blocked);
  assert.equal(blocked.effect, "deny", "unresolved NO-SHIP denies git push");
  assert.ok(blocked.message.includes("NO-SHIP"), "denial carries the reviewer message");
  const harmless = { sessionID: "parent-v2", action: "shell", resources: ["git status"], effect: "allow" };
  await hookCallbacks["permission.evaluate"](harmless);
  assert.equal(harmless.effect, "allow", "non-commit git commands stay allowed");
  const other = { sessionID: "other-session", action: "shell", resources: ["git push"], effect: "allow" };
  await hookCallbacks["permission.evaluate"](other);
  assert.equal(other.effect, "allow", "sessions without a NO-SHIP are unaffected");

  // Cleanup cancels this instance's timers (debounce, watchdog) so a hot
  // reload cannot fire a stale "timed out" notice from the old instance.
  await hookCallbacks["session.prompt"]({ sessionID: "parent-v2", prompt: { text: "another turn" } });
  await hookCallbacks["tool.execute.after"]({ sessionID: "parent-v2", tool: "edit" });
  writeFileSync("/tmp/v2-project/b.txt", "new file\n");
  const createsBefore = calls.filter(([kind]) => kind === "create").length;
  push({ type: "session.execution.succeeded", location: { directory: "/tmp/v2-project" }, data: { sessionID: "parent-v2" } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls.filter(([kind]) => kind === "create").length, createsBefore + 1, "second review spawned (watchdog armed)");
  await cleanup();
  assert.equal(typeof hooks.dispose, "function", "v1 hooks expose dispose for host teardown");
  rmSync("/tmp/v2-project", { recursive: true, force: true });
}

// Watchdog (timeoutMs): a review still in its gates at half time is steered
// to the critics; a review whose critics are running at the deadline gets one
// extension of half the budget, then is aborted; a review still in setup at
// the deadline is aborted without an extension.
{
  const h = await makeHarness("no verdict yet", { options: { timeoutMs: 400 } });
  await h.turn("parent", "please add a feature");
  const child = h.lastChild();
  await h.hooks["tool.execute.before"]({ sessionID: child, tool: "bash" }, { args: { command: "git diff" } });
  await new Promise((r) => setTimeout(r, 260));
  const steer = h.promptCalls.find((c) => c.id === child && c.text.includes("Half of the review time budget"));
  assert.ok(steer, "half-time nudge sent while still in gates");
  assert.equal(steer.body.delivery, undefined, "delivery field never reaches the V1 prompt body");
  await h.hooks["tool.execute.before"]({ sessionID: child, tool: "task" }, { args: {} });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(h.toasts.some((t) => t.message.includes("extended once")), "deadline with critics running extends instead of aborting");
  assert.deepEqual(h.aborted, [], "no abort while extended");
  await new Promise((r) => setTimeout(r, 260));
  assert.deepEqual(h.aborted, [child], "hard abort after the extension");
  assert.ok(h.toasts.some((t) => t.message.includes("timed out")), "timeout reported after the extension");

  const g = await makeHarness("no verdict yet", { options: { timeoutMs: 200 } });
  await g.turn("parent", "please add a feature");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(g.aborted, [g.lastChild()], "review still in setup at the deadline is aborted");
  assert.ok(!g.toasts.some((t) => t.message.includes("extended once")), "no extension without critics running");
  h.hooks.dispose?.();
  g.hooks.dispose?.();
}

// 24. Sidebar pure helpers (internals.js, so they're testable without
//     @opentui/solid / solid-js): countFindings keeps the raw line behind
//     each counted finding, split by whichever shape matched (heading tag,
//     bold-inline tag, group heading, bracketed table cell, or a Severity
//     field); the compact elapsed and token formatters; and the
//     constant-position severity run the sidebar's rows and totals line
//     share.
{
  const report = [
    "### [P1] SQL injection in query builder",
    "- file: db.js:42",
    "- Severity: P1",
    "",
    "- **P2** Missing input validation",
    "  - file: api.js:10",
    "",
    "### P3",
    "- Unused import in utils.js",
    "- Another nit in helpers.js",
    "",
    "| P0 | auth.js:5 | hardcoded secret |",
  ].join("\n");
  const { counts, lines } = countFindings(report);
  assert.deepEqual(counts, { P0: 1, P1: 1, P2: 1, P3: 2 }, "counts unchanged by the move into internals.js");
  assert.deepEqual(lines.P0, ["| P0 | auth.js:5 | hardcoded secret |"], "bracketed-tag finding line captured");
  assert.deepEqual(lines.P1, ["### [P1] SQL injection in query builder"], "tagged-heading finding line captured");
  assert.deepEqual(lines.P2, ["- **P2** Missing input validation"], "bold-inline-tag finding line captured");
  assert.deepEqual(
    lines.P3,
    ["- Unused import in utils.js", "- Another nit in helpers.js"],
    "group-heading finding lines captured in order",
  );

  // A Severity field repeating a heading tag must still count once, and the
  // winning shape's lines (not the loser's) are the ones returned.
  const fieldOnly = countFindings("- Severity: P2\n- Severity: P2\n- note");
  assert.deepEqual(fieldOnly.counts, { P0: 0, P1: 0, P2: 2, P3: 0 }, "field-only report counted via Severity lines");
  assert.deepEqual(fieldOnly.lines.P2, ["- Severity: P2", "- Severity: P2"], "field lines are the raw Severity lines");

  assert.deepEqual(countFindings("The change is clean.").counts, { P0: 0, P1: 0, P2: 0, P3: 0 }, "no findings, all zero");
  assert.deepEqual(countFindings("").lines, { P0: [], P1: [], P2: [], P3: [] }, "empty report has no lines anywhere");
}

{
  assert.equal(formatCompactElapsed(5000), "5s", "under a minute");
  assert.equal(formatCompactElapsed(42000), "42s");
  assert.equal(formatCompactElapsed(102000), "1m42", "minutes and zero-padded seconds, no unit letters");
  assert.equal(formatCompactElapsed(3600000), "1h00", "exactly an hour");
  assert.equal(formatCompactElapsed(3900000), "1h05", "hours and zero-padded minutes");
  assert.equal(formatCompactElapsed(-10), "0s", "never negative");
}

{
  assert.equal(formatTokenCount(0), null, "zero tokens is nothing to show");
  assert.equal(formatTokenCount(-5), null, "negative is nothing to show");
  assert.equal(formatTokenCount(Number.NaN), null, "NaN is nothing to show");
  assert.equal(formatTokenCount(500), "500", "bare digits under a thousand");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1000), "1k", "thousand rounds up to the k suffix");
  assert.equal(formatTokenCount(12345), "12k", "rounded to the nearest thousand");
}

{
  const run = severityTokens({ P0: 0, P1: 2, P2: 0, P3: 5 });
  assert.deepEqual(
    run.map((token) => token.severity),
    ["P0", "P1", "P2", "P3"],
    "severity run is always four slots, in P0-P3 order",
  );
  assert.deepEqual(
    run.map((token) => token.label),
    ["\u00b7", "2 P1", "\u00b7", "5 P3"],
    "zero slots are a bare dot, counted slots are '<n> P<k>'",
  );
  assert.deepEqual(
    severityTokens({}).map((token) => token.label),
    ["\u00b7", "\u00b7", "\u00b7", "\u00b7"],
    "a missing counts object reads as all zero, not a crash",
  );
}

// 25. countVerifiedFindings (internals.js): the review session's own merged
//     report, unlike a critic's, can carry extra sections (what the
//     adversarial-verification step refuted or dropped, a mechanical-gates
//     summary) that must never be counted as findings, and its detail
//     sub-bullets must never be counted as findings of their own. This is
//     the fix for the sidebar showing "verified 7 of 4": a review report
//     that lists 2 real findings plus a "Refuted / dropped" aside and a
//     "Mechanical gates" aside used to count all of it.
{
  const report = [
    "## Findings",
    "",
    "### P1 - auth.js:12",
    "Hardcoded secret in the connection string.",
    "- file: auth.js:12",
    "- Severity: P1",
    "",
    "- **P2** Missing input validation",
    "  - file: api.js:10",
    "  - fix: validate before use",
    "",
    "## Refuted / dropped",
    "",
    "- P2 - false positive: already validated upstream, not reachable",
    "- P3 - speculative, dropped",
    "",
    "## Mechanical gates",
    "",
    "- lint: clean",
    "",
    "NO-SHIP",
  ].join("\n");
  assert.equal(
    countVerifiedFindings(report, 4),
    2,
    "only the Findings section's top-level tags count; refuted/mechanical sections and sub-bullets are excluded",
  );
  assert.equal(countVerifiedFindings(report, 1), 1, "verified count is capped at the critics' raw total");
  assert.equal(countVerifiedFindings(report, 0), 0, "capped at zero when the critics raised nothing at all");

  const noHeading = ["Looks fine overall.", "- P1 auth.js:5 hardcoded secret", "NO-SHIP"].join("\n");
  assert.equal(countVerifiedFindings(noHeading, 4), 1, "a report with no explicit Findings heading still counts from the top");

  assert.equal(countVerifiedFindings(null, 4), null, "a non-string report omits the suffix instead of showing a number");
  assert.equal(countVerifiedFindings(42, 4), null, "a non-string report omits the suffix instead of showing a number");
  assert.equal(countVerifiedFindings("clean, no findings.", 4), 0, "a clean report counts zero, not null");
}

// 26. topVerifiedFinding / clipFindingTitle / formatNoShipSummary
//     (internals.js): the NO-SHIP one-liner leads with the top finding
//     (first P0, else first P1) clipped to 80 chars, plus the verified
//     P0/P1/P2 counts, reusing countVerifiedFindings' Findings-section
//     scoping.
{
  const report = [
    "## Findings",
    "",
    "### [P0] Hardcoded secret in connection string",
    "- file: db.js:10",
    "",
    "- **P1** Missing auth check on admin route",
    "  - file: routes.js:22",
    "",
    "- **P2** Unused import",
    "",
    "NO-SHIP",
  ].join("\n");
  const detail = topVerifiedFinding(report);
  assert.deepEqual(detail.counts, { P0: 1, P1: 1, P2: 1, P3: 0 }, "per-severity counts match countVerifiedFindings' total");
  assert.equal(detail.topLine, "### [P0] Hardcoded secret in connection string", "top finding is the first P0 line");
  assert.equal(countVerifiedFindings(report, 3), 3, "countVerifiedFindings still returns the same total as before");

  assert.equal(
    clipFindingTitle(detail.topLine),
    "Hardcoded secret in connection string",
    "clipFindingTitle strips markdown decoration and the leading severity tag",
  );
  const longLine = `### [P1] ${"x".repeat(100)}`;
  assert.equal(clipFindingTitle(longLine).length, 80, "clipFindingTitle clips to 80 chars");
  assert.ok(clipFindingTitle(longLine).endsWith("\u2026"), "clipping ends in an ellipsis, never cut from the middle");
  assert.equal(clipFindingTitle(null), "", "a non-string line clips to an empty title instead of throwing");

  assert.equal(
    formatNoShipSummary(report),
    "NO-SHIP: Hardcoded secret in connection string (1 P0, 1 P1, 1 P2) \u00b7 fixes requested",
    "formatNoShipSummary composes the one-liner from the top finding and the counts",
  );

  const p1Only = "- **P1** Only a P1 finding\n\nNO-SHIP";
  assert.equal(topVerifiedFinding(p1Only).topLine, "- **P1** Only a P1 finding", "falls back to the first P1 when there is no P0");

  const noFindings = "Nothing to report.\n\nNO-SHIP";
  assert.equal(topVerifiedFinding(noFindings).topLine, null, "no top finding when the report has no tagged findings");
  assert.equal(
    formatNoShipSummary(noFindings),
    "NO-SHIP: no finding details captured (0 P0, 0 P1, 0 P2) \u00b7 fixes requested",
    "formatNoShipSummary falls back to a neutral title instead of a blank one",
  );

  assert.equal(topVerifiedFinding(null), null, "a non-string report yields no finding detail");
  assert.equal(formatNoShipSummary(42), null, "a non-string report omits the summary instead of showing 'undefined'");
}

// 26b. formatFindingsDigest (internals.js): the human-facing findings
//      digest v2.js puts into the synthetic notice's description (the
//      only field the OpenCode 2 TUI renders), one line per verified
//      finding in severity order P0/P1/P2/P3, capped at `max` with a
//      trailing "+N more" line, same Findings-section scoping as
//      countVerifiedFindings (Refuted etc. excluded, sub-bullets never
//      counted).
{
  const report = [
    "## Findings",
    "",
    "### [P0] Hardcoded secret in connection string",
    "- file: db.js:10",
    "",
    "- **P1** Missing auth check on admin route",
    "  - file: routes.js:22",
    "",
    "- **P2** Unused import",
    "",
    "NO-SHIP",
  ].join("\n");

  assert.equal(
    formatFindingsDigest(report),
    "  P0: Hardcoded secret in connection string\n  P1: Missing auth check on admin route\n  P2: Unused import",
    "formatFindingsDigest lists every verified finding, severity order preserved",
  );

  assert.equal(
    formatFindingsDigest(report, 2),
    "  P0: Hardcoded secret in connection string\n  P1: Missing auth check on admin route\n  +1 more",
    "max caps the digest and collapses the rest into a '+N more' line",
  );

  const noFindings = "Nothing to report.\n\nNO-SHIP";
  assert.equal(formatFindingsDigest(noFindings), null, "a report with zero verified findings digests to null");

  assert.equal(formatFindingsDigest(42), null, "a non-string report digests to null instead of throwing");
  assert.equal(formatFindingsDigest(null), null, "a null report digests to null instead of throwing");

  const withRefuted = [
    "## Findings",
    "",
    "### [P0] Hardcoded secret in connection string",
    "- file: db.js:10",
    "",
    "- **P1** Missing auth check on admin route",
    "  - file: routes.js:22",
    "",
    "- **P2** Unused import",
    "",
    "## Refuted",
    "- **P0** not real",
    "",
    "NO-SHIP",
  ].join("\n");
  assert.equal(
    formatFindingsDigest(withRefuted),
    "  P0: Hardcoded secret in connection string\n  P1: Missing auth check on admin route\n  P2: Unused import",
    "a Refuted section's lines never make it into the digest",
  );
}

// 26c. verifiedFindingsDetail (internals.js): the review model's real report
//      shape, caught in production. A bold "**Mechanical gates**" aside
//      inside the Findings section used to be read as the END of the whole
//      report (VERIFIED_STOP_HEADING stopped the scan instead of just
//      skipping its own section), dropping every finding that followed.
//      Findings grouped under a bare severity label ("**P1**", "### P2",
//      "P1:") as numbered or bulleted items carried no per-line severity
//      tag, so they were never recognized either. Together these made the
//      NO-SHIP summary read "no finding details captured" and the
//      chat-row digest come back null.
{
  const grouped = [
    "## Findings",
    "",
    "Verdict is NO-SHIP because the smoke test fails. No P0 findings.",
    "",
    "**Mechanical gates**",
    "- `scripts/check.sh --only syntax,smoke,dashes`: syntax passes, smoke fails.",
    "- No project typecheck or linter is configured.",
    "",
    "**P1**",
    "1. **Smoke failure.** `smoke-test.mjs:3352` asserts the old reply text.",
    "   - The new dispatcher says something else (`lib/evolve-command.js:462`).",
    "   - Fix: update the assertion.",
    "2. **README documents `/evolve` behaviour that no longer exists.** `README.md` is not in the diff.",
    "   - Fix: rewrite the README table.",
    "",
    "**P2**",
    "3. **Observer run gate copied in two places.** `lib/board.js:263-287` re-implements `thresholdsMet()`.",
    "   - Fix: extract one pure gate function.",
    "",
    "NO-SHIP",
  ].join("\n");
  assert.deepEqual(
    topVerifiedFinding(grouped).counts,
    { P0: 0, P1: 2, P2: 1, P3: 0 },
    "findings grouped under a bare severity label count under that severity, and a mechanical-gates aside is skipped, not treated as end-of-report",
  );
  assert.equal(countVerifiedFindings(grouped, 10), 3, "the two P1s and the one P2 all count");
  assert.equal(
    formatNoShipSummary(grouped),
    "NO-SHIP: Smoke failure. `smoke-test.mjs:3352` asserts the old reply text. (0 P0, 2 P1, 1 P2) \u00b7 fixes requested",
    "the top finding's title has its closing ** stripped, not left dangling",
  );
  assert.equal(
    formatFindingsDigest(grouped),
    "  P1: Smoke failure. `smoke-test.mjs:3352` asserts the old reply text.\n  P1: README documents `/evolve` behaviour that no longer exists. `README.md` is not\u2026\n  P2: Observer run gate copied in two places. `lib/board.js:263-287` re-implements `t\u2026",
    "the digest lists all three grouped findings in severity order, each clipped to 80 chars",
  );

  const atxGrouped = [
    "## Findings",
    "### Mechanical gates",
    "- lint: clean",
    "### P1",
    "- First grouped finding",
    "- Second grouped finding",
    "### Refuted",
    "- P0 not real",
    "### P3",
    "- A nit",
    "NO-SHIP",
  ].join("\n");
  assert.deepEqual(
    topVerifiedFinding(atxGrouped).counts,
    { P0: 0, P1: 2, P2: 0, P3: 1 },
    "ATX group headings work the same as bold ones; a Refuted section is skipped, and the P3 group after it still counts",
  );

  const cleared = "## Findings\n\n**P1**: none\n- not a finding\n\n- **P2** Real one\n\nNO-SHIP";
  assert.deepEqual(
    topVerifiedFinding(cleared).counts,
    { P0: 0, P1: 0, P2: 1, P3: 0 },
    "'**P1**: none' clears the group so the following item counts under nothing",
  );

  assert.equal(
    clipFindingTitle("1. **Smoke failure.** `x.js:1` asserts"),
    "Smoke failure. `x.js:1` asserts",
    "clipFindingTitle strips ** left over from a grouped numbered item's bold title",
  );
}

// 27. quiet: true suppresses every notice except NO-SHIP's.
{
  const h = await makeHarness("findings\n\nNO-SHIP", { options: { quiet: true } });
  await h.turn("quiet-parent", "please add a feature");
  assert.equal(h.toasts.length, 0, "quiet suppresses the 'review started' notice");
  await h.hooks["tool.execute.before"]({ sessionID: "child-1", tool: "task" }, { args: {} });
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.equal(h.toasts.length, 0, "quiet suppresses progress notices too");
  await h.childIdle("child-1");
  assert.ok(h.toasts.some((t) => t.message.startsWith("NO-SHIP:")), "quiet still delivers the NO-SHIP notice");
  assert.equal(h.toasts.length, 1, "quiet delivers NO-SHIP and nothing else");
}

// 28. SHIP verdict notice stays quiet (resume: false) and carries no detail.
{
  const h = await makeHarness("all good\n\nSHIP");
  await h.turn("ship-parent", "please add a feature");
  await h.childIdle("child-1");
  const shipToast = h.toasts.find((t) => t.message.startsWith("SHIP:"));
  assert.ok(shipToast, "SHIP toast shown");
  assert.equal(shipToast.resume, false, "SHIP notice never wakes the agent");
  assert.equal(shipToast.detail, undefined, "SHIP notice carries no extra detail");
}

// 29. On v2 (client.v2), progress notices are skipped outright: the TUI's
//     phase toaster (tui.js) covers the same transitions straight off the
//     review session's title, so index.js makes no redundant call at all.
//     Lifecycle notices (started, verdict) are unaffected.
{
  const h = await makeHarness("clean\n\nSHIP", { clientV2: true });
  await h.turn("v2-progress-parent", "please add a feature");
  await h.hooks["tool.execute.before"]({ sessionID: "child-1", tool: "task" }, { args: {} });
  await h.hooks["tool.execute.after"]({ sessionID: "child-1", tool: "task" });
  assert.ok(!h.toasts.some((t) => t.message.includes("critics running")), "no progress notice call on v2 (gates done)");
  assert.ok(!h.toasts.some((t) => t.message.includes("verifying findings")), "no progress notice call on v2 (critics done)");
  assert.ok(
    h.toasts.some((t) => t.message.includes("Code changed, running background review")),
    "the 'started' notice is still posted on v2",
  );
}

// 30. criticLabel (internals.js): the four known critics get fixed short
//     row labels so their row width never depends on the real agent id;
//     an unmapped id is cut from the END with an ellipsis, never the
//     middle, so the row never shows something like "secur...ecklist".
{
  assert.equal(criticLabel("adversarial-risk"), "risk");
  assert.equal(criticLabel("design-principles"), "design");
  assert.equal(criticLabel("security-checklist"), "security");
  assert.equal(criticLabel("ai-slop"), "slop");
  assert.equal(criticLabel("subagent"), "subagent", "a short unknown id passes through unchanged");
  assert.equal(
    criticLabel("some-very-long-ad-hoc-verification-subagent-name"),
    "some-very-l\u2026",
    "a long unknown id is cut from the end with an ellipsis, never the middle",
  );
}

// 31. tui.js phase toaster: toasts fire off the review session's title
//     (session.created / session.renamed), independent of any synthetic
//     notice, at: started, gates done / critics running, critics 2/4 and
//     4/4 done (not 1/4 or 3/4), and the terminal NO-SHIP phase (with live
//     P0/P1 counts fetched from the review session's own report). An old-
//     bridge notice for a phase already toasted is dropped as a duplicate;
//     one for an unrelated session or phase is never deduped.
{
  const toasts = [];
  const reportFor = new Map();
  let pushEvent;
  const ctx = {
    client: {
      event: {
        async *subscribe({ signal }) {
          while (!signal.aborted) {
            const next = await new Promise((resolve) => {
              pushEvent = resolve;
              signal.addEventListener("abort", () => resolve(null), { once: true });
            });
            if (next) yield next;
          }
        },
      },
      message: {
        list: async ({ sessionID }) => {
          const text = reportFor.get(sessionID);
          return text ? [{ type: "assistant", content: [{ type: "text", text }] }] : [];
        },
      },
    },
    ui: { toast: { show: (toast) => toasts.push(toast) } },
  };
  const cleanup = await tuiPlugin.setup(ctx);
  const send = async (event) => {
    pushEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  await send({
    type: "session.created",
    data: { sessionID: "review-1", title: "Adversarial review", metadata: { mightyReviewer: { parentID: "parent-x" } } },
  });
  assert.deepEqual(toasts.map((t) => t.message), ["Review started."], "review started toast fires off session.created");
  assert.equal(toasts[0].sessionID, "parent-x", "toast targets the parent session, not the review session");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - gates" } });
  assert.equal(toasts.length, 1, "no toast yet for the gates phase by itself");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - critics 0/4" } });
  assert.ok(toasts.some((t) => t.message === "Gates done, critics running."), "gates-done toast fires on the first critics-phase title");
  assert.equal(toasts.filter((t) => t.message === "Gates done, critics running.").length, 1, "gates-done toast only once");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - critics 1/4" } });
  assert.ok(!toasts.some((t) => t.message.includes("1/4")), "no toast at 1/4, only at 2/4 and 4/4");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - critics 2/4" } });
  assert.ok(toasts.some((t) => t.message === "Critics 2/4 done."), "critics-half toast fires at 2/4");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - critics 3/4" } });
  assert.equal(toasts.filter((t) => t.message === "Critics 2/4 done.").length, 1, "critics-half toast never repeats, e.g. at 3/4");

  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - verifying" } });
  assert.ok(toasts.some((t) => t.message === "Critics 4/4 done."), "critics-done toast fires on entering verifying");

  reportFor.set("review-1", "### [P0] Hardcoded secret\n\n- **P1** another finding\n\nNO-SHIP");
  await send({ type: "session.renamed", data: { sessionID: "review-1", title: "Adversarial review - NO-SHIP" } });
  const noShipToast = toasts.find((t) => t.message.startsWith("NO-SHIP:"));
  assert.ok(noShipToast, "NO-SHIP phase toast fires");
  assert.equal(noShipToast.variant, "error");
  assert.ok(noShipToast.message.includes("1 P0, 1 P1"), "NO-SHIP toast carries live P0/P1 counts from the review's own report");

  // Dedup: an old-bridge notice for the SAME phase of the SAME review must
  // not produce a second toast.
  const beforeDedup = toasts.length;
  await send({
    type: "session.inbox.enqueued",
    data: {
      sessionID: "parent-x",
      item: {
        type: "synthetic",
        payload: { metadata: { mightyReviewer: { message: "NO-SHIP: findings sent back to the session for fixes (cycle 1/2).", variant: "warning" } } },
      },
    },
  });
  assert.equal(toasts.length, beforeDedup, "an old-bridge notice duplicating an already-shown phase toast is dropped");

  // A notice for an unrelated session (never toasted via the phase toaster)
  // is never deduped.
  await send({
    type: "session.inbox.enqueued",
    data: {
      sessionID: "some-other-session",
      item: { type: "synthetic", payload: { metadata: { mightyReviewer: { message: "SHIP: background review passed.", variant: "success" } } } },
    },
  });
  assert.equal(toasts.length, beforeDedup + 1, "a notice for an unrelated session is never deduped");

  await cleanup();
}

// External-directory permissions (v2.js): default stays deny-everything
// (backward compatible with the old hardcoded EXTERNAL_DIRECTORY_DENY), and
// the fallback rule is built FIRST with the per-directory allows AFTER it,
// since OpenCode 2 resolves permission rulesets last-match-wins.
{
  const defaultRules = buildExternalDirectoryPermissions({});
  assert.deepEqual(
    defaultRules,
    [{ action: "external_directory", resource: "*", effect: "deny" }],
    "no externalDirectories/externalFallback set: single deny-all rule, same as the old hardcoded default",
  );

  const home = os.homedir();
  const rules = buildExternalDirectoryPermissions({
    externalDirectories: ["~/dev", "/srv/shared/*-logs"],
    externalFallback: "ask",
  });
  assert.equal(rules.length, 3, "two directories plus the fallback produce three rules");
  assert.deepEqual(
    rules[0],
    { action: "external_directory", resource: "*", effect: "ask" },
    "fallback rule is listed first so the more specific allows (higher array index) win under last-match-wins",
  );
  assert.deepEqual(
    rules[1],
    { action: "external_directory", resource: `${home}/dev/*`, effect: "allow" },
    "~ expands to the home directory and gets a trailing /* glob appended",
  );
  assert.deepEqual(
    rules[2],
    { action: "external_directory", resource: "/srv/shared/*-logs", effect: "allow" },
    "an entry that already has a glob is kept as-is, not given another /* suffix",
  );

  assert.deepEqual(
    buildExternalDirectoryPermissions({ externalDirectories: ["~/dev"] })[0],
    { action: "external_directory", resource: "*", effect: "deny" },
    "externalFallback defaults to deny even when externalDirectories is set",
  );
  assert.deepEqual(
    buildExternalDirectoryPermissions({ externalFallback: "nonsense" })[0],
    { action: "external_directory", resource: "*", effect: "deny" },
    "an unrecognized externalFallback value falls back to deny, not ask",
  );
}

// 32. scripts/release.sh's CI gate reads the run of the commit it pushed.
// It read `gh run list --limit 1`, which right after a push is still the
// previous commit's run (the sibling mighty-instincts 0.9.2 release, on
// 2026-11-02, reported the previous run's success while its own run had
// failed). A fake `gh` answers the unfiltered call with an older passing
// run and the pushed sha's call with a failure; the gate must fail.
// Control: the same sha passing, the gate passes. The script's last line
// (`main "$@"`) is stripped so its functions can be sourced.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const scratch = path.join(os.tmpdir(), "opencode", "reviewer-test");
  fs.mkdirSync(scratch, { recursive: true });
  const ghDir = fs.mkdtempSync(path.join(scratch, "release-gh-"));
  try {
    const pushedSha = "0a9fc7dcca506e3bc7d7fbab9aaebaa765419d7b";
    const fakeGh = [
      "#!/usr/bin/env bash",
      'args="$*"',
      `if [[ "$args" == *"--commit ${pushedSha}"* ]]; then`,
      '  echo "[{\\"status\\":\\"completed\\",\\"conclusion\\":\\"${FAKE_PUSHED_CONCLUSION}\\",\\"url\\":\\"https://ci/pushed\\"}]"',
      "else",
      '  echo "[{\\"status\\":\\"completed\\",\\"conclusion\\":\\"success\\",\\"url\\":\\"https://ci/previous\\"}]"',
      "fi",
    ].join("\n");
    fs.writeFileSync(path.join(ghDir, "gh"), `${fakeGh}\n`, { mode: 0o755 });
    const releaseScript = path.join(path.dirname(new URL(import.meta.url).pathname), "scripts", "release.sh");
    const runGate = (conclusion) =>
      spawnSync("bash", ["-c", `source <(sed '$d' "$1"); NODE_BIN="$2"; gate_wait_for_ci "$3"`, "gate", releaseScript, process.execPath, pushedSha], {
        env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, FAKE_PUSHED_CONCLUSION: conclusion },
        encoding: "utf8",
      });
    const failing = runGate("failure");
    assert.notEqual(failing.status, 0, `the CI gate fails when the pushed commit's own run failed (gate said: ${failing.stdout}${failing.stderr})`);
    assert.ok(`${failing.stdout}${failing.stderr}`.includes("https://ci/pushed"), "the gate reports the pushed commit's run, not the previous one");
    const passing = runGate("success");
    assert.equal(passing.status, 0, `control: the gate passes when the pushed commit's run passed (gate said: ${passing.stdout}${passing.stderr})`);
  } finally {
    fs.rmSync(ghDir, { recursive: true, force: true });
  }
}

// 33. Branch review (backlog B5, experiment E1, shadow): review_branch
//     reviews a committed range of a given repository in the background,
//     with the session's own review machinery but advisory only: it never
//     injects findings, never blocks a commit, never posts a notice, and
//     its session title is not the review title the TUI toasts on. Its
//     verdict and report are read back through review_branch (same
//     arguments) and listed by review_status. Runs with a real git repo
//     and the shell the v2 adapter gives the factory under Node.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const scratch = path.join(os.tmpdir(), "opencode", "reviewer-test");
  fs.mkdirSync(scratch, { recursive: true });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "branch-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "branch-outside-")));
  const link = `${repo}-link`;
  let hooks;
  let reloaded;
  let extHooks;
  let linkHooks;
  let limitHooks;
  let fastHooks;
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "smoke@example.invalid");
    git("config", "user.name", "smoke");
    fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
    git("add", "a.js");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "lane/x");
    fs.writeFileSync(path.join(repo, "b.py"), "def b():\n    return 2\n");
    fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
    git("add", "b.py", "package-lock.json");
    git("commit", "-q", "-m", "lane work");
    const headSha = git("rev-parse", "HEAD");

    let report = "- P1 b.py:2 returns a constant\n\nNO-SHIP";
    const promptCalls = [];
    const toasts = [];
    const created = [];
    const titles = [];
    const aborted = [];
    let n = 0;
    let failPrompt = false;
    let createGate = null;
    const client = {
      v2: true,
      tui: { showToast: async ({ body }) => toasts.push(body) },
      session: {
        get: async ({ path: p }) => ({ data: { id: p.id } }),
        create: async ({ body }) => {
          created.push(body);
          const id = `branch-review-${++n}`;
          if (createGate) await createGate;
          return { data: { id } };
        },
        update: async ({ path: p, body }) => titles.push({ id: p.id, title: body.title }),
        abort: async ({ path: p }) => aborted.push(p.id),
        promptAsync: async ({ path: p, body }) => {
          promptCalls.push({ id: p.id, text: body.parts[0].text });
          if (failPrompt) throw new Error("prompt refused by the host");
        },
        messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: report }] }],
      },
      app: { log: async () => {} },
    };
    hooks = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, enforceNoShip: true });
    const branch = hooks.tool?.review_branch;
    assert.ok(branch && typeof branch.execute === "function", "review_branch is registered on OpenCode 2");
    assert.deepEqual(branch.inputSchema?.required, ["base"], "review_branch takes a base (repo and head are optional)");
    const v1Hooks = await plugin({ client: { ...client, v2: undefined }, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false });
    assert.equal(v1Hooks.tool.review_branch, undefined, "not on OpenCode 1: its tool args need the host's zod schemas");

    const call = (args, sessionID = "orch-1") => branch.execute(args, { sessionID });
    assert.ok((await call({ repo, base: "--output" })).includes("not a valid git ref"), "an option-shaped ref is refused before git sees it");
    assert.ok((await call({ repo, base: "main\nHEAD" })).includes("not a valid git ref"), "a ref with a newline is refused");
    assert.ok((await call({ repo, base: "main;id" })).includes("not a valid git ref"), "a ref with a ';' is refused");
    assert.ok((await call({ repo: "relative/dir", base: "main" })).includes("absolute path"), "a relative repo path is refused");
    assert.ok((await call({ repo: scratch, base: "HEAD" })).includes("not a git repository"), "a folder outside any repository is refused");
    assert.ok((await call({ repo, base: "no-such-ref" })).includes("does not name a commit"), "an unknown ref is refused");
    assert.ok((await call({ repo, base: headSha, head: headSha })).includes("nothing to review"), "an empty range starts nothing");
    // A repository the review session may not read (outside the project and
    // every externalDirectories entry) would come back SHIP having read
    // nothing, so it is refused up front.
    const gitOut = (...args) => execFileSync("git", ["-C", outside, ...args], { encoding: "utf8" }).trim();
    gitOut("init", "-q");
    gitOut("config", "user.email", "smoke@example.invalid");
    gitOut("config", "user.name", "smoke");
    fs.writeFileSync(path.join(outside, "o.js"), "export const o = 1;\n");
    gitOut("add", "o.js");
    gitOut("commit", "-q", "-m", "outside base");
    const outsideBase = gitOut("rev-parse", "HEAD");
    fs.writeFileSync(path.join(outside, "o.js"), "export const o = 2;\n");
    gitOut("commit", "-q", "-am", "outside change");
    assert.ok(
      (await call({ repo: outside, base: outsideBase })).includes("repo is outside the directories the review session may read"),
      "a repository outside the readable directories is refused",
    );
    assert.equal(created.length, 0, "no refused request created a session");

    // Two identical calls in parallel start one review; the second reads it.
    // session.create is held open until either call has answered or both
    // have reached it, so the race is decided by the code, not the clock.
    let releaseCreate;
    createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    const pending = [1, 2].map(() => call({ repo, base: baseSha.slice(0, 12), head: "lane/x" }));
    const bothCreating = (async () => {
      for (let i = 0; i < 500 && created.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    })();
    await Promise.race([Promise.race(pending), bothCreating]);
    createGate = null;
    releaseCreate();
    const parallel = await Promise.all(pending);
    assert.equal(parallel.filter((r) => r.includes("Branch review started")).length, 1, `two parallel calls for one range start one review: ${parallel.join(" | ")}`);
    assert.ok(parallel.some((r) => r.includes("still running")), "the other call reads the running review");
    const started = parallel.find((r) => r.includes("Branch review started")) ?? "";
    assert.ok(started.includes(`${baseSha.slice(0, 12)}...${headSha.slice(0, 12)}`), "the reply pins the range to commits");
    assert.equal(created.length, 1, "one review session");
    assert.ok(!created[0].title.startsWith(REVIEW_TITLE), `its title is not the automatic review's, so the TUI never toasts it: ${created[0].title}`);
    assert.equal(created[0].parentID, undefined, "created as a root session, so it can dispatch the critics");
    const prompt = promptCalls.find((c) => c.id === "branch-review-1")?.text ?? "";
    assert.ok(prompt.includes("<!--adversarial-review-auto-->"), "the prompt carries the review marker (never reviewed as a coding turn)");
    assert.ok(prompt.includes(`git -C ${repo} diff ${baseSha}...${headSha}`), "the prompt names the exact committed range");
    assert.ok(prompt.includes("never the working tree"), "and tells the review not to read the working tree's own changes");
    assert.ok(prompt.includes("Python"), "language hints come from the range's files");
    assert.ok(prompt.includes("cannot read the range") && prompt.includes("never SHIP"), "a review that cannot read its range ends NO-SHIP, never SHIP");
    assert.ok(started.includes("1 file, 2 changed lines"), `the lockfile in the range is not counted: ${started}`);

    const again = await call({ repo, base: baseSha, head: headSha });
    assert.ok(again.includes("still running"), `the same range asked again reads its state instead of starting a second review: ${again}`);
    assert.equal(created.length, 1, "no second session for the same range");
    const statusRunning = await hooks.tool.review_status.execute({}, { sessionID: "orch-1" });
    assert.ok(statusRunning.includes("Branch reviews (advisory)") && statusRunning.includes("lane/x"), `review_status lists the session's branch reviews: ${statusRunning}`);

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "branch-review-1" } } });
    await new Promise((r) => setTimeout(r, 50));
    const done = await call({ repo, base: baseSha, head: headSha });
    assert.ok(done.includes("verdict: NO-SHIP") && done.includes("b.py:2 returns a constant"), `done: verdict and report read back: ${done}`);
    assert.equal(promptCalls.filter((c) => c.id === "orch-1").length, 0, "a NO-SHIP branch review sends nothing back into the requesting session");
    assert.equal(toasts.length, 0, "and posts no notice at all");
    assert.ok(titles.every((t) => !String(t.title).startsWith(REVIEW_TITLE)), "and never takes the automatic review's title");
    const statusDone = await hooks.tool.review_status.execute({}, { sessionID: "orch-1" });
    assert.ok(statusDone.includes("NO-SHIP"), "review_status shows the branch verdict");
    assert.ok(statusDone.startsWith("plugin: mighty-reviewer@"), "after the version line");
    await hooks["tool.execute.before"]({ sessionID: "orch-1", tool: "bash" }, { args: { command: "git commit -m x" } });
    // (no throw: under enforceNoShip a branch NO-SHIP blocks no commit)

    // A verdict-less idle is nudged once more, quietly; rerun starts afresh.
    const rerun = await call({ repo, base: baseSha, head: headSha, rerun: true });
    assert.ok(rerun.includes("Branch review started"), "rerun: true starts a new review of the same range");
    report = "I launched the critics in the background.";
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "branch-review-2" } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(promptCalls.some((c) => c.id === "branch-review-2" && c.text.includes("verdict")), "a verdict-less branch idle is nudged for its verdict");
    assert.equal(toasts.length, 0, "the nudge is silent too");
    assert.ok((await call({ repo, base: baseSha, head: headSha })).includes("still running"), "and the review stays running");
    report = "- P2 b.py:1 naming\n\nSHIP";
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "branch-review-2" } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok((await call({ repo, base: baseSha, head: headSha })).includes("verdict: SHIP"), "the nudged review finishes with its verdict");

    // A start that fails after its session exists aborts that session and
    // leaves no entry behind, so the next call starts cleanly.
    fs.writeFileSync(path.join(repo, "c.py"), "def c():\n    return 3\n");
    git("add", "c.py");
    git("commit", "-q", "-m", "more lane work");
    const sessionsBefore = created.length;
    failPrompt = true;
    const failed = await call({ repo, base: baseSha, head: "lane/x" });
    failPrompt = false;
    assert.ok(failed.includes("Branch review not started: prompt refused by the host"), `a failed start says so: ${failed}`);
    assert.ok(aborted.includes(`branch-review-${sessionsBefore + 1}`), `the session it created is aborted: ${aborted.join(",")}`);
    const retried = await call({ repo, base: baseSha, head: "lane/x" });
    assert.ok(retried.includes("Branch review started"), `no entry is left behind by the failed start: ${retried}`);

    // A reload disposes the instance that started a review, and its end may
    // never reach the next one: the entry reads as stale, and rerun: true
    // replaces it (aborting the old session) instead of being refused.
    const orphanID = `branch-review-${created.length}`;
    hooks.dispose();
    reloaded = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false });
    const readStale = await reloaded.tool.review_branch.execute({ repo, base: baseSha, head: "lane/x" }, { sessionID: "orch-1" });
    assert.ok(readStale.includes("stale") && readStale.includes("rerun: true"), `an orphaned running review reads as stale: ${readStale}`);
    const listStale = await reloaded.tool.review_status.execute({}, { sessionID: "orch-1" });
    assert.ok(/: stale \(started .* ago\), rerun: true restarts it/.test(listStale), `review_status lists it as stale: ${listStale}`);
    const restarted = await reloaded.tool.review_branch.execute({ repo, base: baseSha, head: "lane/x", rerun: true }, { sessionID: "orch-1" });
    assert.ok(restarted.includes("Branch review started"), `rerun: true replaces a stale review: ${restarted}`);
    assert.ok(aborted.includes(orphanID), `and aborts its session: ${aborted.join(",")}`);

    // externalDirectories opens the outside repository; a project reached
    // through a symlink is compared by real path and handed to the review
    // in the project's own spelling, the one its permission check knows.
    extHooks = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, externalDirectories: [scratch] });
    const extStarted = await extHooks.tool.review_branch.execute({ repo: outside, base: outsideBase }, { sessionID: "orch-2" });
    assert.ok(extStarted.includes("Branch review started"), `an externalDirectories entry makes the outside repo reviewable: ${extStarted}`);
    fs.symlinkSync(repo, link);
    linkHooks = await plugin({ client, directory: link, worktree: link, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false });
    const linkStarted = await linkHooks.tool.review_branch.execute({ repo, base: baseSha, head: headSha }, { sessionID: "orch-3" });
    assert.ok(linkStarted.includes("Branch review started"), `the real path of a symlinked project is inside it: ${linkStarted}`);
    const linkPrompt = promptCalls.at(-1)?.text ?? "";
    assert.ok(linkPrompt.includes(`git -C ${link} diff ${baseSha}...${headSha}`), "and the review reads it under the project's own spelling");

    // Ranges a review is not started for, and the deadline.
    git("checkout", "-q", "-b", "lock-only", baseSha);
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
    git("add", "package-lock.json");
    git("commit", "-q", "-m", "lockfile only");
    git("checkout", "-q", "-b", "lane/y", baseSha);
    fs.writeFileSync(path.join(repo, "y.js"), "export const y = 1;\nexport const z = 2;\n");
    git("add", "y.js");
    git("commit", "-q", "-m", "y");
    const ignoredOnly = await call({ repo, base: baseSha, head: "lock-only" });
    assert.ok(ignoredOnly.includes("only ignored files"), `a range of ignored files only starts nothing: ${ignoredOnly}`);
    limitHooks = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, branchMaxDiffLines: 1 });
    const tooLarge = await limitHooks.tool.review_branch.execute({ repo, base: baseSha, head: "lane/y" }, { sessionID: "orch-4" });
    assert.ok(tooLarge.includes("changes 2 lines, over branchMaxDiffLines (1)"), `a range over branchMaxDiffLines starts nothing: ${tooLarge}`);
    fastHooks = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, branchTimeoutMs: 80 });
    const fastStarted = await fastHooks.tool.review_branch.execute({ repo, base: baseSha, head: "lane/y" }, { sessionID: "orch-5" });
    assert.ok(fastStarted.includes("Branch review started"), fastStarted);
    const fastID = `branch-review-${created.length}`;
    await new Promise((r) => setTimeout(r, 250));
    const timedOut = await fastHooks.tool.review_branch.execute({ repo, base: baseSha, head: "lane/y" }, { sessionID: "orch-5" });
    assert.ok(timedOut.includes("timed out") && timedOut.includes("verdict: unknown"), `past branchTimeoutMs the review reads as timed out: ${timedOut}`);
    assert.ok(aborted.includes(fastID), "and its session is aborted");

    // At most 50 entries: the oldest finished ones go first, a running one never.
    const entries = new Map();
    entries.set("running-old", { status: "running", startedAt: 0 });
    for (let i = 1; i <= 51; i++) entries.set(`done-${i}`, { status: "done", startedAt: i, finishedAt: i });
    evictFinishedBranchReviews(entries, 50);
    assert.equal(entries.size, 50, "the map is cut back to 50");
    assert.ok(entries.has("running-old"), "a running entry is never evicted");
    assert.ok(!entries.has("done-1") && !entries.has("done-2") && entries.has("done-3"), "the two oldest finished entries go");
  } finally {
    fastHooks?.dispose();
    limitHooks?.dispose();
    linkHooks?.dispose();
    extHooks?.dispose();
    reloaded?.dispose();
    hooks?.dispose();
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// 34. Branch review in a worktree (backlog B13): review_branch({ worktree:
//     true }) reviews a detached checkout of the head made for it under
//     branchWorktreeDir (default: the system's temporary folder), never
//     inside a work tree of the repository, and removes it after SHIP,
//     NO-SHIP, a failed start, the deadline and a reload. The review
//     session may read that checkout (its critics' sessions inherit its
//     rules), and the gates and 5c's diagnostics run there. Without the
//     option a branch start is byte for byte the recorded plain one
//     (test/branch-plain.json, made by test/branch-capture.mjs: on 0.12.0
//     first, recorded again for B16's three prompt lines, the critic's
//     tightened wording and B21's unrun-gate rule, each diff checked to be
//     those lines).
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { captureBranchStart } = await import("./test/branch-capture.mjs");
  const { createV2Setup } = await import("./v2.js");
  const { defaultWorktreeParent, removeReviewWorktree } = await import("./branch.js");
  const scratch = path.join(os.tmpdir(), "opencode", "reviewer-test");
  fs.mkdirSync(scratch, { recursive: true });

  const recorded = JSON.parse(readFileSync(new URL("./test/branch-plain.json", import.meta.url), "utf8"));
  const offPath = await captureBranchStart({ plugin, makeShell, scratch });
  assert.deepEqual(offPath, recorded, "without worktree a branch start sends, creates and runs exactly the recorded plain start");
  const offFalse = await captureBranchStart({ plugin, makeShell, scratch, args: { worktree: false } });
  assert.deepEqual(offFalse, recorded, "and so does worktree: false");
  assert.equal(defaultWorktreeParent(), path.join(os.tmpdir(), "mighty-reviewer-worktrees"), "the default checkout folder is in the system's temporary folder");

  // The v2 adapter: the review session's own allow comes after the
  // fallback deny (OpenCode 2 rules are last-match-wins).
  {
    let legacy;
    const v2Created = [];
    const ctx = {
      options: { externalDirectories: ["/x/dev"] },
      location: { directory: "/x/project" },
      session: { create: async (input) => (v2Created.push(input), { id: "v2-review" }) },
    };
    await createV2Setup(async ({ client: legacyClient }) => {
      legacy = legacyClient;
      return {};
    })(ctx);
    await legacy.session.create({ body: { title: "t" } });
    await legacy.session.create({ body: { title: "t", externalAllow: ["/w/checkout"] } });
    assert.deepEqual(v2Created[0].permissions, [
      ...[{ action: "edit", resource: "*", effect: "deny" }],
      ...buildExternalDirectoryPermissions(ctx.options),
    ], "a session created without externalAllow keeps 0.12.0's permissions");
    assert.deepEqual(v2Created[1].permissions, [
      ...v2Created[0].permissions,
      { action: "external_directory", resource: "/w/checkout/*", effect: "allow" },
    ], "externalAllow appends the checkout's allow after the fallback deny");
  }

  const box = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "worktree-")));
  const repo = path.join(box, "repo");
  const parent = path.join(box, "checkouts");
  const instances = [];
  try {
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "smoke@example.invalid");
    git("config", "user.name", "smoke");
    fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
    git("add", "a.js");
    git("commit", "-q", "-m", "base");
    git("branch", "base-x");
    git("checkout", "-q", "-b", "lane/x");
    fs.writeFileSync(path.join(repo, "b.js"), "export const b = 2;\n");
    git("add", "b.js");
    git("commit", "-q", "-m", "lane work");
    const headSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "lane/y", "base-x");
    fs.writeFileSync(path.join(repo, "y.js"), "export const y = 1;\n");
    git("add", "y.js");
    git("commit", "-q", "-m", "y");
    git("checkout", "-q", "lane/x");
    // A post-checkout hook the review's `git worktree add` must not run.
    const hookMark = path.join(box, "hook-ran");
    fs.mkdirSync(path.join(repo, ".test-hooks"));
    fs.writeFileSync(path.join(repo, ".test-hooks", "post-checkout"), `#!/bin/sh\ntouch '${hookMark}'\n`, { mode: 0o755 });
    git("config", "core.hooksPath", ".test-hooks");
    const before = git("worktree", "list", "--porcelain");
    const listed = () => git("worktree", "list", "--porcelain");

    let report = "SHIP";
    let failPrompt = false;
    let n = 0;
    const created = [];
    const prompts = [];
    const aborted = [];
    const client = {
      v2: true,
      tui: { showToast: async () => {} },
      app: { log: async () => {} },
      session: {
        get: async ({ path: p }) => ({ data: { id: p.id } }),
        create: async ({ body }) => {
          created.push(body);
          return { data: { id: `wt-review-${++n}` } };
        },
        update: async () => {},
        abort: async ({ path: p }) => aborted.push(p.id),
        promptAsync: async ({ path: p, body }) => {
          prompts.push({ id: p.id, text: body.parts[0].text });
          if (failPrompt) throw new Error("prompt refused by the host");
        },
        messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: report }] }],
      },
    };
    // Every git command the plugin runs, as one line each.
    const commands = [];
    const shell = makeShell();
    const recording = (strings, ...values) => {
      commands.push(String.raw({ raw: strings }, ...values));
      return shell(strings, ...values);
    };
    const make = async (extra = {}) => {
      const h = await plugin({ client, directory: repo, worktree: repo, $: recording }, { idleDebounceMs: 0, updateCheck: false, branchWorktreeDir: parent, ...extra });
      instances.push(h);
      return h;
    };
    const hooks = await make();
    assert.equal(hooks.tool.review_branch.inputSchema.properties.worktree?.type, "boolean", "review_branch takes worktree: true");
    const warning = "It runs the head's own lint and build commands with your rights: use it only for branches you would run yourself.";
    assert.ok(hooks.tool.review_branch.inputSchema.properties.worktree.description.includes(warning), "the option says it runs the head's own commands");
    assert.ok(readFileSync(new URL("./README.md", import.meta.url), "utf8").includes(warning), "and so does the README");
    const call = (args, h = hooks) => h.tool.review_branch.execute(args, { sessionID: "orch-wt" });
    const idle = (id, h = hooks) => h.event({ event: { type: "session.idle", properties: { sessionID: id } } });

    // During the review: a clean, detached checkout of the head, outside the
    // repository, readable by the review session.
    const allowOf = () => created.at(-1)?.externalAllow?.[0] ?? "";
    const started = await call({ repo, base: "base-x", head: "lane/x", worktree: true });
    assert.ok(started.includes("Branch review started"), started);
    const dir = allowOf();
    assert.equal(path.dirname(dir), fs.realpathSync(parent), `the checkout is a direct child of branchWorktreeDir: ${dir}`);
    assert.ok(!dir.startsWith(`${repo}${path.sep}`), "never inside the reviewed repository's work tree");
    assert.equal(fs.statSync(parent).mode & 0o777, 0o700, "branchWorktreeDir is made private to this user");
    assert.ok(listed().includes(`worktree ${dir}\nHEAD ${headSha}\ndetached`), `listed as a detached worktree at the head: ${listed()}`);
    assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }), "", "and clean");
    assert.ok(fs.existsSync(path.join(dir, "b.js")), "with the head's files");
    assert.equal(fs.existsSync(hookMark), false, "made without running the repository's hooks");
    assert.ok(started.includes(dir), `the reply names the checkout: ${started}`);
    assert.deepEqual(created.at(-1).externalAllow, [dir], "the review session may read the checkout, and no other folder is opened");
    const prompt = prompts.at(-1).text;
    assert.ok(prompt.includes(`Run them in the review checkout ${dir}`), "the gates run in the checkout");
    assert.ok(prompt.includes("Run each check tool directly (for example `tsc --noEmit`, `cargo check`), never a package script (`npm run`, `make` and the like)."), "the gates call the check tools, not the head's scripts");
    assert.ok(!prompt.includes("not run (the working tree is not the reviewed head)"), "instead of being skipped for the working tree");
    assert.ok(
      prompt.includes("'not run (dependencies not installed in the review checkout: <its first error line, quoted>)' only when it fails because a package the head's manifest or lockfile declares is absent from disk"),
      "a gate reads as not run only for a declared package missing from disk, with its first error line",
    );
    assert.ok(
      prompt.includes("A missing relative path, a package the head does not declare, and any error that is not a bare missing-install error are failures."),
      "a missing file, an undeclared package or any other error stays a failure",
    );
    assert.ok(prompt.includes(`Read a changed file as of the head at ${dir}/<path>`), "the review reads the head's files there");
    assert.ok(prompt.includes(`Tell every critic that the head is checked out at ${dir}`), "and tells the critics to");
    assert.ok(prompt.includes(`run diagnostics on every changed file as checked out in ${dir}`), "5c runs diagnostics on the head's files");
    assert.ok(prompt.includes(`its review checkout (${dir})`), "HARD SCOPE names the checkout");

    // A start without the option is another review, never the worktree's.
    const plain = await call({ repo, base: "base-x", head: "lane/x" });
    assert.ok(plain.includes("Branch review started") && !plain.includes(dir), `the same range without worktree starts its own review: ${plain}`);
    assert.equal(created.at(-1).externalAllow, undefined, "and opens no folder");
    const status = await hooks.tool.review_status.execute({}, { sessionID: "orch-wt" });
    assert.equal((status.match(/\[worktree\]/g) ?? []).length, 1, `review_status tells the two apart: ${status}`);

    // SHIP: removed, git's worktree list as before.
    await idle("wt-review-1");
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true })).includes("verdict: SHIP"), "the worktree review reads SHIP");
    assert.ok(!fs.existsSync(dir) && !listed().includes(dir), "after SHIP the checkout is gone");
    await idle("wt-review-2");
    assert.equal(listed(), before, "git worktree list is back to what it was");

    // NO-SHIP.
    report = "- P1 b.js:1 constant\n\nNO-SHIP";
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true })).includes("Branch review started"), "rerun starts a new checkout");
    const dir2 = allowOf();
    assert.ok(dir2 !== dir && fs.existsSync(dir2), "a fresh checkout per review");
    await idle(`wt-review-${n}`);
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true })).includes("verdict: NO-SHIP"), "the worktree review reads NO-SHIP");
    assert.ok(!fs.existsSync(dir2) && listed() === before, "after NO-SHIP the checkout is gone");

    // A failed start: the session is aborted and the checkout removed.
    failPrompt = true;
    const failed = await call({ repo, base: "base-x", head: "lane/y", worktree: true });
    failPrompt = false;
    assert.ok(failed.includes("Branch review not started: prompt refused by the host"), failed);
    assert.ok(aborted.includes(`wt-review-${n}`), "the failed start's session is aborted");
    assert.equal(listed(), before, "and no checkout is left");

    // The deadline.
    const fast = await make({ branchTimeoutMs: 80 });
    assert.ok((await call({ repo, base: "base-x", head: "lane/y", worktree: true }, fast)).includes("Branch review started"));
    const fastID = `wt-review-${n}`;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await call({ repo, base: "base-x", head: "lane/y", worktree: true }, fast)).includes("timed out"), "past branchTimeoutMs it reads as timed out");
    assert.ok(aborted.includes(fastID), "its session is aborted");
    assert.equal(listed(), before, "and its checkout removed");

    // A reload ends the instance's worktree reviews: a checkout must not
    // outlive the instance that would remove it.
    const doomed = await make();
    assert.ok((await call({ repo, base: "base-x", head: "lane/y", worktree: true, rerun: true }, doomed)).includes("Branch review started"));
    const doomedID = `wt-review-${n}`;
    assert.notEqual(listed(), before, "running: listed");
    await doomed.dispose();
    assert.equal(listed(), before, "after a reload the checkout is gone");
    assert.ok(aborted.includes(doomedID), "and the review's session aborted");
    const afterReload = await call({ repo, base: "base-x", head: "lane/y", worktree: true });
    assert.ok(afterReload.includes("ended by a plugin reload") && !afterReload.includes("stale"), `it reads as ended, not stale: ${afterReload}`);

    // Orphans: a start removes the checkouts in its folder whose process is
    // gone (also one whose folder a temp cleaner deleted) and this
    // process's that no review holds, and only those entries (never `git
    // worktree prune`): a live process's checkout, one this process holds
    // (a copy of the module imported at a hot reload shares the registry)
    // and a stale entry outside the folder stay.
    const realParent = fs.realpathSync(parent);
    const head12 = headSha.slice(0, 12);
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const orphan = path.join(realParent, `${deadPid}-${head12}-a1`);
    const gone = path.join(realParent, `${deadPid}-${head12}-a2`);
    const alive = path.join(realParent, `${process.ppid}-${head12}-a3`);
    const held = path.join(realParent, `${process.pid}-${head12}-a4`);
    const unheld = path.join(realParent, `${process.pid}-${head12}-a5`);
    const foreign = path.join(box, "someone-elses");
    const registry = globalThis[Symbol.for("mighty-reviewer.reviewCheckouts")];
    assert.ok(registry instanceof Set, "the held checkouts live on globalThis, shared across module copies");
    registry.add(held);
    for (const d of [orphan, gone, alive, held, unheld, foreign]) git("worktree", "add", "-q", "--detach", d, headSha);
    fs.rmSync(gone, { recursive: true, force: true });
    fs.rmSync(foreign, { recursive: true, force: true });
    // The same rule over the whole folder, whatever repository a checkout
    // belongs to: another repository's checkouts of a dead process and this
    // process's unheld one go, a live process's stays, and an own-named
    // folder that is no checkout at all goes too.
    const other = path.join(box, "other");
    fs.mkdirSync(other);
    const gitOther = (...args) => execFileSync("git", ["-C", other, ...args], { encoding: "utf8" }).trim();
    gitOther("init", "-q");
    gitOther("-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", "commit", "-q", "--allow-empty", "-m", "other");
    const otherSha = gitOther("rev-parse", "HEAD");
    const other12 = otherSha.slice(0, 12);
    const otherBefore = gitOther("worktree", "list", "--porcelain");
    const otherDead = path.join(realParent, `${deadPid}-${other12}-o1`);
    const otherAlive = path.join(realParent, `${process.ppid}-${other12}-o2`);
    const otherUnheld = path.join(realParent, `${process.pid}-${other12}-o3`);
    for (const d of [otherDead, otherAlive, otherUnheld]) gitOther("worktree", "add", "-q", "--detach", d, otherSha);
    const stray = path.join(realParent, `${deadPid}-${other12}-o4`);
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, "left"), "x\n");
    assert.ok((await call({ repo, base: "base-x", head: "lane/y", worktree: true, rerun: true })).includes("Branch review started"));
    const runningY = allowOf();
    const runningYID = `wt-review-${n}`;
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true })).includes("Branch review started"));
    const sweptList = listed();
    assert.ok(sweptList.includes(runningY) && fs.existsSync(runningY), "a running review's checkout survives another start's sweep");
    assert.ok(!sweptList.includes(orphan) && !fs.existsSync(orphan), "a dead process's checkout is removed");
    assert.ok(!sweptList.includes(gone), "so is the entry of one whose folder is gone");
    assert.ok(sweptList.includes(alive) && fs.existsSync(alive), "a live process's checkout stays");
    assert.ok(sweptList.includes(held), "so does one this process holds");
    assert.ok(!sweptList.includes(unheld) && !fs.existsSync(unheld), "this process's checkout no review holds is removed");
    assert.ok(sweptList.includes(`worktree ${foreign}`) && sweptList.includes("prunable"), "and a stale entry outside the folder is not pruned");
    const otherList = gitOther("worktree", "list", "--porcelain");
    assert.ok(!otherList.includes(otherDead) && !fs.existsSync(otherDead), "another repository's checkout of a dead process is removed");
    assert.ok(!otherList.includes(otherUnheld) && !fs.existsSync(otherUnheld), "so is this process's unheld one");
    assert.ok(otherList.includes(otherAlive) && fs.existsSync(otherAlive), "a live process's stays");
    assert.equal(fs.existsSync(stray), false, "and an own-named folder that is no checkout goes");
    gitOther("worktree", "remove", otherAlive);
    assert.equal(gitOther("worktree", "list", "--porcelain"), otherBefore, "the other repository is left as it was");
    await idle(runningYID);
    await idle(`wt-review-${n}`);
    registry.delete(held);
    git("worktree", "remove", alive);
    git("worktree", "remove", held);
    git("worktree", "remove", foreign);
    assert.equal(listed(), before, "after the review only the test's own entries were left");

    // A removal that throws still lets go of the checkout, so a later
    // sweep can take it.
    const stuck = path.join(realParent, `${process.pid}-${head12}-a6`);
    git("worktree", "add", "-q", "--detach", stuck, headSha);
    registry.add(stuck);
    const locked = path.join(stuck, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "f"), "x\n");
    fs.chmodSync(locked, 0o500);
    let threw = false;
    try {
      await removeReviewWorktree(makeShell(), repo, stuck, realParent);
    } catch {
      threw = true;
    } finally {
      fs.chmodSync(locked, 0o700);
    }
    assert.ok(threw, "a removal that cannot delete the folder throws");
    assert.equal(registry.has(stuck), false, "and still lets go of the checkout");
    assert.equal(await removeReviewWorktree(makeShell(), repo, stuck, realParent), true, "which a later call then removes");
    assert.equal(listed(), before, "leaving nothing");

    // A symlink of the head whose target, followed to its end, is outside
    // the checkout is removed from the checkout before the review: the
    // allow is `<checkout>/*` and the host matches paths as written, so a
    // read through such a link would leave the checkout. Links that stay
    // inside are kept, the targets are never touched, and the review is
    // told which paths went.
    const secretDir = path.join(box, "secret-dir");
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, "key.txt"), "not for the critics\n");
    const secretFile = path.join(box, "secret.txt");
    fs.writeFileSync(secretFile, "not for the critics\n");
    git("checkout", "-q", "-b", "lane/links", "base-x");
    fs.mkdirSync(path.join(repo, "sub"));
    const links = {
      "out-file": secretFile,
      "out-dir": secretDir,
      "sub/up": "../../../secret-dir",
      dangling: "/nonexistent-mighty-reviewer-target/x",
      "z-chain": "in-out",
      "in-out": secretFile,
      "in-file": "a.js",
      "sub/in-up": "../a.js",
    };
    for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(repo, name));
    git("add", "-A", ".");
    git("commit", "-q", "-m", "links");
    git("checkout", "-q", "lane/x");
    const escaping = ["dangling", "in-out", "out-dir", "out-file", "sub/up", "z-chain"];
    assert.ok((await call({ repo, base: "base-x", head: "lane/links", worktree: true })).includes("Branch review started"));
    const linkDir = allowOf();
    const lexists = (p) => {
      try {
        fs.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    };
    for (const name of escaping) assert.equal(lexists(path.join(linkDir, name)), false, `a link leaving the checkout is removed: ${name}`);
    for (const name of ["in-file", "sub/in-up"]) assert.ok(fs.lstatSync(path.join(linkDir, name)).isSymbolicLink(), `a link inside the checkout stays: ${name}`);
    assert.ok(fs.existsSync(secretFile) && fs.existsSync(path.join(secretDir, "key.txt")), "and the targets are untouched");
    const linkPrompt = prompts.at(-1).text;
    assert.ok(linkPrompt.includes(`point outside the review checkout and were removed from it before the review, so nothing is read through them: ${escaping.map((e) => JSON.stringify(e)).join(", ")}.`), `the review is told which: ${linkPrompt.slice(0, 200)}`);
    assert.ok(!prompt.includes("point outside the review checkout"), "a head without such links gets no such line");
    await idle(`wt-review-${n}`);
    assert.equal(listed(), before, "and the checkout goes after the verdict");

    // A checkout's `.git` file is its own, and a review's shell could
    // rewrite it: the sweep runs git in the repository that file names only
    // when that repository lists the folder as its worktree, and otherwise
    // removes the folder as it is, leaving the named repository untouched.
    const victim = path.join(box, "victim");
    fs.mkdirSync(victim);
    const gitVictim = (...args) => execFileSync("git", ["-C", victim, ...args], { encoding: "utf8" }).trim();
    gitVictim("init", "-q");
    gitVictim("-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", "commit", "-q", "--allow-empty", "-m", "victim");
    const victimSha = gitVictim("rev-parse", "HEAD");
    const victimTree = path.join(box, "victim-wt");
    gitVictim("worktree", "add", "-q", "--detach", victimTree, victimSha);
    const victimBefore = gitVictim("worktree", "list", "--porcelain");
    const [victimEntry] = fs.readdirSync(path.join(victim, ".git", "worktrees"));
    const planted = path.join(realParent, `${deadPid}-${victimSha.slice(0, 12)}-p1`);
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, ".git"), `gitdir: ${path.join(victim, ".git", "worktrees", victimEntry)}\n`);
    commands.length = 0;
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true })).includes("Branch review started"));
    assert.equal(fs.existsSync(planted), false, "a folder whose .git names a repository that does not list it is removed as it is");
    assert.deepEqual(commands.filter((c) => c.includes(victim)), [], "and no git command runs in the repository it names");
    assert.equal(gitVictim("worktree", "list", "--porcelain"), victimBefore, "which keeps its worktrees");
    assert.ok(fs.existsSync(path.join(victimTree, ".git")), "and their folders");
    await idle(`wt-review-${n}`);
    assert.equal(listed(), before, "and the review's own checkout still goes");

    // Never inside a work tree of the repository, and never a folder open
    // to other users.
    const createdBefore = created.length;
    const insideHooks = await make({ branchWorktreeDir: path.join(repo, ".reviews") });
    const inside = await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true }, insideHooks);
    assert.ok(inside.includes("Branch review not started") && inside.includes("inside a work tree of the reviewed repository"), inside);
    const openDir = path.join(box, "open");
    fs.mkdirSync(openDir, { mode: 0o755 });
    fs.chmodSync(openDir, 0o755);
    const openHooks = await make({ branchWorktreeDir: openDir });
    const open = await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true }, openHooks);
    assert.ok(open.includes("Branch review not started") && open.includes("open to other users"), open);
    // The allow is a glob over the checkout's path, so a folder whose real
    // path holds a glob character would open more than the checkout.
    for (const name of ["glob[x]", "glob*", "glob{a,b}", "glob?"]) {
      const globDir = path.join(box, name);
      const globHooks = await make({ branchWorktreeDir: globDir });
      const refused = await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true }, globHooks);
      assert.ok(refused.includes("Branch review not started") && refused.includes("glob character"), `a folder named ${name} is refused: ${refused}`);
      assert.equal(fs.existsSync(globDir), false, `and not made: ${name}`);
    }
    const linkedGlob = path.join(box, "glob[real]");
    fs.mkdirSync(linkedGlob, { mode: 0o700 });
    fs.symlinkSync(linkedGlob, path.join(box, "plain-link"));
    const linkedHooks = await make({ branchWorktreeDir: path.join(box, "plain-link", "reviews") });
    const linkedRefused = await call({ repo, base: "base-x", head: "lane/x", worktree: true, rerun: true }, linkedHooks);
    assert.ok(linkedRefused.includes("glob character"), `so is one whose real path holds one: ${linkedRefused}`);
    assert.equal(created.length, createdBefore, "neither created a session");
    assert.equal(listed(), before, "nor a checkout");
    assert.ok((await call({ repo, base: "base-x", head: "lane/x", worktree: true })).includes("verdict: NO-SHIP"), "and a refused rerun leaves the last verdict readable");
  } finally {
    for (const h of instances) await h.dispose();
    fs.rmSync(box, { recursive: true, force: true });
  }
}

// 35. Branch reviews survive a reload (backlog B15): review_branch keeps
//     each review in the plugin's own store (branchStoreDir, default
//     $XDG_DATA_HOME/mighty-reviewer/branch-reviews), so a hot reload, which
//     imports the module afresh, loses no finished result and adopts a
//     running review of the same process (its idle is still recorded). A
//     running entry of a process that is gone reads as lost, one of a live
//     process as running until that process records its end. Files are
//     private, a broken file is skipped, and at most 50 finished entries
//     are kept.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { branchStoreFile } = await import("./branch-store.js");
  const scratch = path.join(os.tmpdir(), "opencode", "reviewer-test");
  fs.mkdirSync(scratch, { recursive: true });
  const box = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "store-")));
  const repo = path.join(box, "repo");
  const storeDir = path.join(box, "store");
  const instances = [];
  try {
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "smoke@example.invalid");
    git("config", "user.name", "smoke");
    fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
    git("add", "a.js");
    git("commit", "-q", "-m", "base");
    git("branch", "base-x");
    for (const lane of ["x", "y", "z", "w"]) {
      git("checkout", "-q", "-b", `lane/${lane}`, "base-x");
      fs.writeFileSync(path.join(repo, `${lane}.js`), `export const ${lane} = 2;\n`);
      git("add", `${lane}.js`);
      git("commit", "-q", "-m", lane);
    }

    const reports = new Map();
    const created = [];
    let n = 0;
    let failPrompt = false;
    const client = {
      v2: true,
      tui: { showToast: async () => {} },
      app: { log: async () => {} },
      session: {
        get: async ({ path: p }) => ({ data: { id: p.id } }),
        create: async ({ body }) => {
          created.push(body);
          return { data: { id: `store-review-${++n}` } };
        },
        update: async () => {},
        abort: async () => {},
        promptAsync: async () => {
          if (failPrompt) throw new Error("prompt refused by the host");
        },
        messages: async ({ path: p }) => [{ info: { role: "assistant" }, parts: [{ type: "text", text: reports.get(p.id) ?? "" }] }],
      },
    };
    const make = async (factory, extra = {}) => {
      const h = await factory({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, branchStoreDir: storeDir, ...extra });
      instances.push(h);
      return h;
    };
    const call = (h, args, sessionID = "orch-store") => h.tool.review_branch.execute(args, { sessionID });
    const idle = (h, id) => h.event({ event: { type: "session.idle", properties: { sessionID: id } } });

    // Every local module a published file imports is published too (a
    // missing one breaks the installed plugin at its first import): every
    // relative `from`, `import(` and bare `import`, followed from the
    // published files, either quote, `../` resolved (mighty-instincts'
    // smoke/published-files.mjs is the same guard).
    {
      const root = new URL("./", import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
      const covered = (rel) => pkg.files.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
      const queue = pkg.files.filter((entry) => /\.m?js$/.test(entry));
      const seen = new Set();
      while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        const text = fs.readFileSync(new URL(file, root), "utf8");
        for (const [, spec] of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
          const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
          assert.ok(covered(rel), `${file} imports ${spec} (${rel}), which package.json's files list must cover`);
          if (/\.m?js$/.test(rel) && fs.existsSync(new URL(rel, root))) queue.push(rel);
        }
      }
      assert.ok(seen.has("branch-store.js") && seen.size >= 6, `the guard followed the published modules: ${[...seen].join(",")}`);
    }

    // Before the reload: one review finished NO-SHIP, one still running.
    const a = await make(plugin);
    assert.ok((await call(a, { repo, base: "base-x", head: "lane/x" })).includes("Branch review started"));
    reports.set("store-review-1", "- P1 x.js:1 constant\n\nNO-SHIP");
    await idle(a, "store-review-1");
    assert.ok((await call(a, { repo, base: "base-x", head: "lane/y" })).includes("Branch review started"));
    assert.equal(fs.statSync(storeDir).mode & 0o777, 0o700, "the store folder is private");
    const files = fs.readdirSync(storeDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2, `one file per review: ${files.join(",")}`);
    for (const f of files) assert.equal(fs.statSync(path.join(storeDir, f)).mode & 0o777, 0o600, `and each file too: ${f}`);
    fs.writeFileSync(path.join(storeDir, "broken.json"), "{ not json");
    await a.dispose();

    // The reload: a fresh copy of the module, as OpenCode 2 imports it.
    const fresh = (await import(`./index.js?reload=${Date.now()}`)).MightyReviewer;
    const b = await make(fresh);
    const before = created.length;
    const listedAfter = await b.tool.review_status.execute({}, { sessionID: "orch-store" });
    assert.ok(listedAfter.includes("lane/x") && listedAfter.includes("done: NO-SHIP") && listedAfter.includes("lane/y") && listedAfter.includes("running"), `review_status lists both after the reload: ${listedAfter}`);
    // The running review's idle arrives before anything reads it.
    reports.set("store-review-2", "- P3 y.js:1 naming\n\nSHIP");
    await idle(b, "store-review-2");
    const x = await call(b, { repo, base: "base-x", head: "lane/x" });
    assert.ok(x.includes("verdict: NO-SHIP") && x.includes("x.js:1 constant"), `a finished review is read back after the reload: ${x}`);
    const y = await call(b, { repo, base: "base-x", head: "lane/y" });
    assert.ok(y.includes("verdict: SHIP") && y.includes("y.js:1 naming"), `a running review of this process is adopted, and its idle recorded: ${y}`);
    assert.equal(created.length, before, "and neither starts a new review");

    // A failed start leaves nothing in the store.
    failPrompt = true;
    assert.ok((await call(b, { repo, base: "base-x", head: "lane/w" })).includes("Branch review not started"));
    failPrompt = false;
    const wKey = `${repo}\u0000${git("rev-parse", "base-x")}\u0000${git("rev-parse", "lane/w")}`;
    assert.equal(fs.existsSync(branchStoreFile(storeDir, wKey)), false, "a failed start leaves no entry in the store");

    // A running entry whose process is gone reads as lost; rerun restarts.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const yFile = files.map((f) => path.join(storeDir, f)).find((f) => JSON.parse(fs.readFileSync(f, "utf8")).headRef === "lane/y");
    const zEntry = { ...JSON.parse(fs.readFileSync(yFile, "utf8")) };
    const zSha = git("rev-parse", "lane/z");
    const baseSha = git("rev-parse", "base-x");
    Object.assign(zEntry, { headRef: "lane/z", headSha: zSha, key: `${zEntry.root}\u0000${baseSha}\u0000${zSha}`, status: "running", verdict: null, report: null, finishedAt: null, pid: deadPid, reviewSessionID: "store-review-gone" });
    fs.writeFileSync(branchStoreFile(storeDir, zEntry.key), JSON.stringify(zEntry), { mode: 0o600 });
    const fresh2 = (await import(`./index.js?reload=${Date.now()}-2`)).MightyReviewer;
    const c = await make(fresh2);
    const z = await call(c, { repo, base: "base-x", head: "lane/z" });
    assert.ok(z.includes("lost") && z.includes("rerun: true"), `a dead process's running review reads as lost: ${z}`);
    assert.ok(z.includes("verdict: unknown"), `with no verdict: ${z}`);
    const zStored = JSON.parse(fs.readFileSync(branchStoreFile(storeDir, zEntry.key), "utf8"));
    assert.equal(zStored.status, "done", "and the store holds it as done");
    assert.equal(zStored.verdict ?? null, null, "with no verdict, never SHIP or NO-SHIP");
    assert.ok((await call(c, { repo, base: "base-x", head: "lane/z", rerun: true })).includes("Branch review started"), "and rerun: true restarts it");

    // A live process's running entry past its deadline reads as lost too:
    // the pid may be reused, and the review is past its time either way.
    const pastSha = git("rev-parse", "lane/w");
    const past = { ...zEntry, headRef: "lane/w", headSha: pastSha, key: `${zEntry.root}\u0000${baseSha}\u0000${pastSha}`, pid: process.ppid, deadline: Date.now() - 1000, reviewSessionID: "store-review-past" };
    fs.writeFileSync(branchStoreFile(storeDir, past.key), JSON.stringify(past), { mode: 0o600 });
    const pastRead = await call(c, { repo, base: "base-x", head: "lane/w" });
    assert.ok(pastRead.includes("lost") && pastRead.includes("verdict: unknown"), `a live pid past its deadline reads as lost: ${pastRead}`);

    // A live process's running entry stays running until that process
    // records its end in the store.
    const other = { ...zEntry, headRef: "lane/x", headSha: git("rev-parse", "lane/x"), pid: process.ppid, reviewSessionID: "store-review-other" };
    other.key = `${other.root}\u0000${baseSha}\u0000${other.headSha}`;
    // Another process of the same user took lane/x over in the store.
    fs.writeFileSync(branchStoreFile(storeDir, other.key), JSON.stringify(other), { mode: 0o600 });
    const fresh3 = (await import(`./index.js?reload=${Date.now()}-3`)).MightyReviewer;
    const d = await make(fresh3);
    assert.ok((await call(d, { repo, base: "base-x", head: "lane/x" })).includes("still running"), "a live process's running review reads as running");
    fs.writeFileSync(branchStoreFile(storeDir, other.key), JSON.stringify({ ...other, status: "done", verdict: "SHIP", report: "- P3 x.js:1 nit\n\nSHIP", finishedAt: Date.now() }), { mode: 0o600 });
    assert.ok((await call(d, { repo, base: "base-x", head: "lane/x" })).includes("verdict: SHIP"), "and its end is read from the store once that process writes it");

    // At most 50 finished entries stay in the store, the newest.
    const many = (await import(`./index.js?reload=${Date.now()}-4`)).MightyReviewer;
    const e = await make(many);
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(path.join(storeDir, `old-${i}.json`), JSON.stringify({ ...other, key: `k-${i}`, status: "done", verdict: "SHIP", report: "r", startedAt: i, finishedAt: i }), { mode: 0o600 });
    }
    // A temporary file a crashed write left behind is pruned after an hour;
    // a fresh one (a write in flight) stays.
    const oldTmp = path.join(storeDir, "crashed.json.1.tmp");
    const freshTmp = path.join(storeDir, "inflight.json.2.tmp");
    fs.writeFileSync(oldTmp, "{");
    fs.writeFileSync(freshTmp, "{");
    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    // lane/z's rerun (started by the previous copy) is running; its end is a
    // save, which prunes.
    reports.set(`store-review-${n}`, "SHIP");
    await idle(e, `store-review-${n}`);
    assert.equal(fs.existsSync(oldTmp), false, "a temporary file older than an hour is pruned");
    assert.equal(fs.existsSync(freshTmp), true, "a fresh one is left");
    const kept = fs.readdirSync(storeDir).filter((f) => f.endsWith(".json"));
    const finished = kept.filter((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(storeDir, f), "utf8")).status === "done";
      } catch {
        return false;
      }
    });
    assert.ok(finished.length <= 50, `at most 50 finished entries are kept: ${finished.length}`);
    assert.ok(!kept.includes("old-0.json") && kept.includes("old-54.json"), "the oldest go first");
    assert.ok(kept.includes("broken.json"), "and a file the store cannot read is left alone");

    // Nothing was written outside the store: the test's folder holds only
    // the repository and the store, and the default store was never made.
    assert.deepEqual(fs.readdirSync(box).sort(), ["repo", "store"], "no file outside the store");
    const defaultStore = path.join(process.env.XDG_DATA_HOME, "mighty-reviewer", "branch-reviews");
    const leaked = (fs.existsSync(defaultStore) ? fs.readdirSync(defaultStore) : []).filter((f) => fs.readFileSync(path.join(defaultStore, f), "utf8").includes(box));
    assert.deepEqual(leaked, [], "and none of this section's reviews in the default store");
  } finally {
    for (const h of instances) await h.dispose();
    fs.rmSync(box, { recursive: true, force: true });
  }
}

// 36. Review severity (backlog B16, E1 round 1's false NO-SHIP on c659b;
//     B16a, the owner's yes of 2026-11-13): in every review a finding
//     about comments, documentation or other prose alone is at most P2 and
//     never makes the verdict NO-SHIP, unless the prose is right and the
//     code contradicts it or the text states a guarantee the code lacks.
//     A branch review also keeps the verdict word to the verdict line, and
//     a report whose text states the other verdict is flagged when read.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const scratch = path.join(os.tmpdir(), "opencode", "reviewer-test");
  fs.mkdirSync(scratch, { recursive: true });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "severity-")));
  const wtParents = [];
  let hooks;
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "smoke@example.invalid");
    git("config", "user.name", "smoke");
    fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
    git("add", "a.js");
    git("commit", "-q", "-m", "base");
    git("branch", "base-x");
    for (const lane of ["x", "y"]) {
      git("checkout", "-q", "-b", `lane/${lane}`, "base-x");
      fs.writeFileSync(path.join(repo, `${lane}.js`), `export const ${lane} = 2;\n`);
      git("add", `${lane}.js`);
      git("commit", "-q", "-m", lane);
    }
    const prompts = new Map();
    const reports = new Map();
    let n = 0;
    const client = {
      v2: true,
      tui: { showToast: async () => {} },
      app: { log: async () => {} },
      session: {
        get: async ({ path: p }) => ({ data: { id: p.id } }),
        create: async () => ({ data: { id: `sev-review-${++n}` } }),
        update: async () => {},
        abort: async () => {},
        promptAsync: async ({ path: p, body }) => prompts.set(p.id, body.parts[0].text),
        messages: async ({ path: p }) => [{ info: { role: "assistant" }, parts: [{ type: "text", text: reports.get(p.id) ?? "" }] }],
      },
    };
    const wtParent = fs.mkdtempSync(path.join(scratch, "severity-wt-"));
    wtParents.push(wtParent);
    hooks = await plugin({ client, directory: repo, worktree: repo, $: makeShell() }, { idleDebounceMs: 0, updateCheck: false, branchWorktreeDir: wtParent });
    const call = (args) => hooks.tool.review_branch.execute(args, { sessionID: "orch-sev" });
    const idle = (id) => hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } });

    assert.ok((await call({ repo, base: "base-x", head: "lane/x" })).includes("Branch review started"));
    const branchPrompt = prompts.get("sev-review-1");
    const exception = "If the comment or the documentation is right and the code contradicts it, or the text states a guarantee the code lacks (security, data safety, limits), it is a behaviour finding at its own severity.";
    const proseRule = `A finding about comments, documentation or other prose alone, with no change in behaviour, is at most P2 in this review and never makes the verdict NO-SHIP. ${exception}`;
    const slopCap = `(P2 at most: a finding about prose alone never blocks the change). ${exception}`;
    assert.ok(branchPrompt.includes(`   - ${proseRule}`), "a branch review caps a prose-only finding at P2 in its verdict rule, with the exception for a behaviour defect");
    assert.ok(branchPrompt.includes(slopCap), "and so does the slop critic's standing order");
    assert.ok(!branchPrompt.includes("P1 only for chatbot residue"), "which no longer makes false documentation P1 by itself");
    assert.ok(branchPrompt.includes("Write SHIP or NO-SHIP only as the verdict line itself: never start any other line of the report with either word."), "the verdict word stands on the verdict line only");

    // B21 (the benchmark of 2026-11-13: all four false alarms were an unrun
    // Gradle gate read as a failed one): in a branch review an unrun gate
    // never makes NO-SHIP by itself.
    const unrunRule = "A gate recorded as not run, for any reason (the time budget, no direct tool for it, dependencies not installed, the working tree not at the head), is not a failed gate and never makes the verdict NO-SHIP by itself: only a gate that ran and failed does. Name the gates that did not run in the report.";
    assert.ok(branchPrompt.includes(`   - ${unrunRule}`), "a branch review's verdict rule says an unrun gate is never a failure by itself");

    // The slop critic's own agent prompt rates prose the same way: P2 at
    // most, P1 only for the behaviour case (the critic's round 2 P3 on
    // b6e926b..ab4e4e8).
    const cfg36 = {};
    hooks.config(cfg36);
    const slopPrompt = cfg36.agent["ai-slop-critic"].prompt;
    assert.ok(slopPrompt.includes(`  - P1 only when the prose reveals a behaviour defect: ${exception}`), "the slop critic's P1 is the behaviour case only");
    assert.ok(slopPrompt.includes("  - P2 (at most) for any finding about prose alone:"), "and its prose findings are P2 at most");
    assert.ok(!slopPrompt.includes("  - P1: chatbot residue"), "with no P1 for prose alone left");

    // The automatic review of a coding turn gets the same cap (B16a), and
    // not the branch review's verdict-line rule.
    const ordinary = await makeHarness("SHIP", { options: { updateCheck: false } });
    await ordinary.turn("parent-sev", "edit");
    const ordinaryPrompt = ordinary.promptCalls[0]?.text ?? "";
    assert.ok(ordinaryPrompt.includes("<!--adversarial-review-auto-->"), "the automatic review ran");
    assert.ok(ordinaryPrompt.includes(`   - ${proseRule}`) && ordinaryPrompt.includes(slopCap), "the automatic review caps a prose-only finding the same way");
    assert.ok(!ordinaryPrompt.includes("P1 only for chatbot residue"), "and no longer makes false documentation P1 by itself");
    assert.ok(!ordinaryPrompt.includes("verdict line itself"), "but keeps its verdict rules otherwise");
    assert.ok(!ordinaryPrompt.includes("A gate recorded as not run, for any reason"), "and gets no branch rule about unrun gates");
    ordinary.hooks.dispose();

    // A report whose text states the other verdict is flagged on reading.
    reports.set("sev-review-1", "## Findings\n- P2 x.js:1 naming\n\nNO-SHIP, adversarial verification found no verified P0 or P1. The verdict below follows the rule.\n\nSHIP");
    await idle("sev-review-1");
    const flagged = await call({ repo, base: "base-x", head: "lane/x" });
    assert.ok(flagged.includes("verdict: SHIP"), `the verdict is still the last line's: ${flagged}`);
    assert.ok(flagged.includes("note: the report's text also states NO-SHIP (\"NO-SHIP, adversarial verification found no verified P0 or P1."), `and the contradicting line is named: ${flagged}`);
    assert.ok((await call({ repo, base: "base-x", head: "lane/y" })).includes("Branch review started"));
    reports.set("sev-review-2", "## Findings\n- P3 y.js:1 a rule that would make this NO-SHIP if it were behaviour\n\nVerdict:\nSHIP");
    await idle("sev-review-2");
    const clean = await call({ repo, base: "base-x", head: "lane/y" });
    assert.ok(clean.includes("verdict: SHIP") && !clean.includes("note: the report's text"), `a verdict word inside a sentence is not flagged: ${clean}`);
    // B21 in a worktree review: a gate with no direct tool reads as not run.
    const wtCall = await hooks.tool.review_branch.execute({ repo, base: "base-x", head: "lane/y", worktree: true }, { sessionID: "orch-sev" });
    assert.ok(wtCall.includes("Branch review started"), wtCall);
    const wtPrompt = prompts.get(`sev-review-${n}`);
    assert.ok(wtPrompt.includes("A gate the review checkout cannot run at all (no direct tool for it, as for checks that run only through a build wrapper such as Gradle) is recorded as 'not run (no direct tool)', never as a failure."), "a worktree review records a gate with no direct tool as not run");
    assert.ok(wtPrompt.includes(`   - ${unrunRule}`), "and its verdict rule says so too");
    reports.set(`sev-review-${n}`, "SHIP");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: `sev-review-${n}` } } });
    assert.deepEqual(fs.readdirSync(wtParent), [], "and its checkout is gone after the verdict");
  } finally {
    await hooks?.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
    for (const d of wtParents) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log("ALL SMOKE TESTS PASSED");
