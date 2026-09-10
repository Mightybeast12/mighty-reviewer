import assert from "node:assert/strict";
import plugin, { MightyReviewer } from "./index.js";

assert.equal(plugin, MightyReviewer, "default export matches named export");

// Stub $ template tag (never called at init time).
const $ = () => ({ text: async () => "" });
const client = {};

// 1. Normal init returns all hooks.
const hooks = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ });
for (const key of ["config", "tool.execute.after", "chat.message", "event"]) {
  assert.ok(typeof hooks[key] === "function", `hook ${key} registered`);
}

// 2. config hook injects both agents without clobbering existing ones.
const cfg = { agent: { "design-principles-critic": { description: "user override", mode: "subagent", prompt: "mine" } } };
hooks.config(cfg);
assert.ok(cfg.agent["adversarial-risk-critic"], "risk critic injected");
assert.equal(cfg.agent["adversarial-risk-critic"].mode, "subagent");
assert.ok(cfg.agent["adversarial-risk-critic"].prompt.length > 100, "risk critic has prompt");
assert.equal(cfg.agent["design-principles-critic"].prompt, "mine", "user override preserved");

// 3. config hook works when cfg.agent is absent.
const cfg2 = {};
hooks.config(cfg2);
assert.ok(cfg2.agent["adversarial-risk-critic"] && cfg2.agent["design-principles-critic"], "agents injected into empty config");

// 4. Options-based disable returns empty hooks.
const disabled = await plugin({ client, directory: "/tmp", worktree: "/tmp", $ }, { disabled: true });
assert.deepEqual(Object.keys(disabled), [], "disabled via options returns no hooks");

console.log("ALL SMOKE TESTS PASSED");
