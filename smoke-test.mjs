import assert from "node:assert/strict";
import plugin, { MightyReviewer, extractVerdict } from "./index.js";

assert.equal(plugin, MightyReviewer, "default export matches named export");

// Stub $ template tag (never called at init time).
const $ = () => ({ text: async () => "" });
const client = {};

// 1. Normal init returns all hooks.
const hooks = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ });
for (const key of ["config", "tool.execute.after", "chat.message", "event"]) {
  assert.ok(typeof hooks[key] === "function", `hook ${key} registered`);
}

// 2. config hook injects all agents without clobbering existing ones.
const cfg = { agent: { "design-principles-critic": { description: "user override", mode: "subagent", prompt: "mine" } } };
hooks.config(cfg);
assert.ok(cfg.agent["adversarial-risk-critic"], "risk critic injected");
assert.equal(cfg.agent["adversarial-risk-critic"].mode, "subagent");
assert.ok(cfg.agent["adversarial-risk-critic"].prompt.length > 100, "risk critic has prompt");
assert.ok(cfg.agent["adversarial-risk-critic"].prompt.includes("Weakened guardrails"), "risk critic checks weakened guardrails");
assert.ok(cfg.agent["security-checklist-critic"], "security critic injected");
assert.ok(cfg.agent["security-checklist-critic"].prompt.includes("Path traversal"), "security critic has checklist");
assert.equal(cfg.agent["design-principles-critic"].prompt, "mine", "user override preserved");

// 3. config hook works when cfg.agent is absent.
const cfg2 = {};
hooks.config(cfg2);
assert.ok(
  cfg2.agent["adversarial-risk-critic"] && cfg2.agent["design-principles-critic"] && cfg2.agent["security-checklist-critic"],
  "agents injected into empty config",
);

// 4. Options-based disable returns empty hooks.
const disabled = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ }, { disabled: true });
assert.deepEqual(Object.keys(disabled), [], "disabled via options returns no hooks");

// 5. Critic agents are mechanically read-only (no mutation tools, no shell, no delegation).
for (const name of ["adversarial-risk-critic", "security-checklist-critic"]) {
  const tools = cfg.agent[name].tools;
  for (const denied of ["edit", "write", "patch", "bash", "task"]) {
    assert.equal(tools[denied], false, `${name} denies ${denied}`);
  }
}
assert.notEqual(
  cfg.agent["adversarial-risk-critic"].tools,
  cfg.agent["security-checklist-critic"].tools,
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

// 7. NO-SHIP feedback loop: findings injected into parent, capped at 2 cycles,
//    cap reset by a genuine user message.
{
  const promptCalls = [];
  const toasts = [];
  let childN = 0;
  const fclient = {
    tui: { showToast: async ({ body }) => toasts.push(body) },
    session: {
      create: async () => ({ data: { id: `child-${++childN}` } }),
      prompt: async ({ path, body }) => promptCalls.push({ id: path.id, text: body.parts[0].text }),
      promptAsync: async ({ path, body }) => promptCalls.push({ id: path.id, text: body.parts[0].text }),
      messages: async () => [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "findings body\n\nNO-SHIP" }] },
      ],
    },
    app: { log: async () => {} },
  };
  let diffN = 0;
  const f$ = () => ({ text: async () => `diff-${++diffN}` });
  const fhooks = await plugin({ client: fclient, directory: "/tmp", worktree: "/tmp", $: f$ });
  const tick = () => new Promise((r) => setTimeout(r, 25));
  const turn = async (msgText) => {
    await fhooks["chat.message"]({ sessionID: "parent" }, { parts: [{ type: "text", text: msgText }] });
    await fhooks["tool.execute.after"]({ sessionID: "parent", tool: "edit" });
    await fhooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } });
    await tick();
  };
  const childIdle = (id) =>
    fhooks.event({ event: { type: "session.idle", properties: { sessionID: id } } });
  const injections = () => promptCalls.filter((c) => c.id === "parent");

  await turn("please add a feature");
  assert.equal(promptCalls[0]?.id, "child-1", "review spawned in child session");
  assert.ok(promptCalls[0].text.includes("<!--adversarial-review-auto-->"), "child got review prompt");

  await childIdle("child-1");
  assert.equal(injections().length, 1, "NO-SHIP findings injected into parent");
  assert.ok(injections()[0].text.includes("<!--adversarial-review-feedback-->"), "injection carries feedback marker");
  assert.ok(injections()[0].text.includes("findings body"), "injection carries the report");
  assert.ok(toasts.some((t) => t.message.includes("cycle 1/2")), "toast reports cycle 1/2");

  await turn(injections()[0].text);
  await childIdle("child-2");
  assert.equal(injections().length, 2, "second NO-SHIP injected");
  assert.ok(toasts.some((t) => t.message.includes("cycle 2/2")), "toast reports cycle 2/2");

  await turn(injections()[1].text);
  await childIdle("child-3");
  assert.equal(injections().length, 2, "third NO-SHIP hits cycle cap, no injection");
  assert.ok(toasts.some((t) => t.message.includes("cycle cap")), "toast reports cycle cap");

  await turn("a brand new user request");
  await childIdle("child-4");
  assert.equal(injections().length, 3, "genuine user message resets the cycle budget");
}

console.log("ALL SMOKE TESTS PASSED");
