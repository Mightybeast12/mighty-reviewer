// Captures what one review_branch start sends and runs, with every path
// and commit replaced by a placeholder, so a branch start can be compared
// byte for byte with a recorded one (smoke-test.mjs section 34 compares the
// start without `worktree` with test/branch-0.12.0.json, which this
// function recorded on 0.12.0). It takes the plugin factory and the shell
// maker as arguments, so the same capture runs on any version's files.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function captureBranchStart({ plugin, makeShell, scratch, args = {} }) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "capture-")));
  let hooks;
  try {
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
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
    const baseSha = git("rev-parse", "base-x");
    const headSha = git("rev-parse", "HEAD");

    const created = [];
    const prompts = [];
    const commands = [];
    const client = {
      v2: true,
      tui: { showToast: async () => {} },
      app: { log: async () => {} },
      session: {
        get: async ({ path: p }) => ({ data: { id: p.id } }),
        create: async ({ body }) => {
          created.push(body);
          return { data: { id: "capture-review" } };
        },
        update: async () => {},
        abort: async () => {},
        promptAsync: async ({ body }) => {
          prompts.push(body);
        },
        messages: async () => [],
      },
    };
    const shell = makeShell();
    const recording = (strings, ...values) => {
      commands.push(String.raw({ raw: strings }, ...values).replace(/\s+/g, " ").trim());
      return shell(strings, ...values);
    };
    hooks = await plugin({ client, directory: repo, worktree: repo, $: recording }, { idleDebounceMs: 0, updateCheck: false });
    const reply = await hooks.tool.review_branch.execute({ repo, base: "base-x", head: "lane/x", ...args }, { sessionID: "capture-orch" });
    const normalize = (value) =>
      JSON.parse(
        JSON.stringify(value)
          .split(repo)
          .join("<REPO>")
          .split(baseSha)
          .join("<BASE>")
          .split(headSha)
          .join("<HEAD>")
          .split(baseSha.slice(0, 12))
          .join("<BASE12>")
          .split(headSha.slice(0, 12))
          .join("<HEAD12>"),
      );
    return normalize({
      reply: reply.split("\n").slice(1).join("\n"),
      created,
      prompts,
      commands,
    });
  } finally {
    await hooks?.dispose?.();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
