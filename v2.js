/**
 * OpenCode 2 adapter for mighty-reviewer.
 *
 * OpenCode 2 replaced the v1 plugin surface (hook object + SDK client) with a
 * context object of domains (ctx.session, ctx.tool, ctx.agent, ...). Rather
 * than fork the reviewer, this module presents the v1 surface to the
 * unchanged MightyReviewer factory and translates in both directions:
 *
 *   v1 client call            v2 context call
 *   session.get               ctx.session.get
 *   session.messages          ctx.session.context
 *   session.create            ctx.session.create (+ agent/model/permissions)
 *   session.prompt(Async)     ctx.session.prompt (delivery: queue)
 *   session.update            ctx.session.update
 *   session.abort             ctx.session.interrupt
 *   tui.showToast             ctx.session.synthetic into the target session
 *   app.log                   console.error
 *
 *   v1 hook                   v2 registration
 *   config (agents/command)   ctx.agent.transform / ctx.command.transform
 *   tool.review_status        ctx.tool.transform
 *   tool.execute.before/after ctx.tool.hook
 *   chat.message              ctx.session.hook("prompt")
 *   event session.idle        ctx.event.subscribe (session.execution.*)
 *   enforceNoShip throw       ctx.permission.hook("evaluate") -> deny
 *
 * Tool names differ between hosts (bash -> shell, task -> subagent); events
 * reaching the reviewer carry the v1 names so its phase tracking is unchanged.
 */

import { execFile } from "node:child_process";
import path from "node:path";

import { PKG_NAME } from "./internals.js";

const TOOL_NAME_TO_V1 = { shell: "bash", subagent: "task" };
const TOOL_NAME_TO_V2 = { bash: "shell", task: "subagent", write: "edit", patch: "edit" };
const IDLE_EVENTS = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);
const NOTICE_METADATA_KEY = "mightyReviewer";

export function createV2Setup(factory) {
  return async function setup(ctx) {
    const options = ctx.options ?? {};
    const directory = ctx.location.directory;
    const worktree = ctx.location.project?.directory ?? directory;
    const client = createLegacyClient(ctx, options);
    const hooks = await factory({ client, directory, worktree, $: makeShell() }, options);
    if (!hooks || Object.keys(hooks).length === 0) return;

    const registrations = [];
    const register = async (promise) => {
      const registration = await promise;
      if (registration) registrations.push(registration);
    };

    if (hooks.config) {
      const cfg = { agent: {}, command: {} };
      hooks.config(cfg);
      await register(
        ctx.agent.transform((editor) => {
          for (const [id, definition] of Object.entries(cfg.agent)) {
            if (editor.get(id)) continue;
            editor.update(id, (agent) => applyAgentDefinition(agent, definition));
          }
        }),
      );
      const existing = await ctx.command.list();
      for (const [name, definition] of Object.entries(cfg.command)) {
        if (existing.data.some((command) => command.name === name)) continue;
        await register(
          ctx.command.transform((editor) =>
            editor.add({
              name,
              description: definition.description,
              execute: async (input) => {
                await hooks["command.execute.before"]?.({ command: name, sessionID: input.sessionID });
                await ctx.session.prompt({
                  sessionID: input.sessionID,
                  text: [definition.template, input.prompt?.text].filter(Boolean).join("\n\n"),
                  delivery: input.delivery,
                });
              },
            }),
          ),
        );
      }
    }

    for (const [name, tool] of Object.entries(hooks.tool ?? {})) {
      await register(
        ctx.tool.transform((editor) =>
          editor.add({
            name,
            description: tool.description,
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async (args, toolContext) => ({
              content: String(await tool.execute(args, { sessionID: toolContext.sessionID })),
            }),
          }),
        ),
      );
    }

    if (hooks["tool.execute.before"]) {
      await register(
        ctx.tool.hook("execute.before", async (event) => {
          try {
            await hooks["tool.execute.before"](
              { sessionID: event.sessionID, tool: toV1ToolName(event.tool) },
              { args: event.input ?? {} },
            );
          } catch {
            // Denials are enforced through the permission hook below; a throw
            // here would surface as a host defect instead of a clean refusal.
          }
        }),
      );
      await register(
        ctx.permission.hook("evaluate", async (event) => {
          if (event.action !== "shell" || event.effect === "deny") return;
          try {
            await hooks["tool.execute.before"](
              { sessionID: event.sessionID, tool: "bash" },
              { args: { command: event.resources.join("\n") } },
            );
          } catch (error) {
            event.effect = "deny";
            event.message = error instanceof Error ? error.message : String(error);
          }
        }),
      );
    }

    if (hooks["tool.execute.after"]) {
      await register(
        ctx.tool.hook("execute.after", (event) =>
          hooks["tool.execute.after"]({ sessionID: event.sessionID, tool: toV1ToolName(event.tool) }),
        ),
      );
    }

    if (hooks["chat.message"]) {
      await register(
        ctx.session.hook("prompt", (event) =>
          hooks["chat.message"](
            { sessionID: event.sessionID },
            { parts: [{ type: "text", text: event.prompt?.text ?? "" }] },
          ),
        ),
      );
    }

    const controller = new AbortController();
    const watcher = hooks.event
      ? (async () => {
          try {
            for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
              const event = toIdleEvent(raw);
              if (!event) continue;
              if (!(await belongsToLocation(ctx, raw, event.properties.sessionID))) continue;
              await hooks.event({ event });
            }
          } catch (error) {
            if (!controller.signal.aborted) console.error(`[${PKG_NAME}] event bridge failed`, error);
          }
        })()
      : Promise.resolve();

    return async () => {
      controller.abort();
      await watcher;
      hooks.dispose?.();
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    };
  };
}

function applyAgentDefinition(agent, definition) {
  if (definition.description !== undefined) agent.description = definition.description;
  if (definition.mode !== undefined) agent.mode = definition.mode;
  if (definition.prompt !== undefined) agent.system = definition.prompt;
  if (definition.temperature !== undefined) {
    agent.request.body.temperature = definition.temperature;
  }
  const model = parseModelRef(definition.model);
  if (model) agent.model = model;
  agent.permissions.push(...toolsToPermissions(definition.tools));
}

function toolsToPermissions(tools) {
  const rules = [];
  const seen = new Set();
  for (const [name, enabled] of Object.entries(tools ?? {})) {
    const action = TOOL_NAME_TO_V2[name] ?? name;
    const effect = enabled ? "allow" : "deny";
    const key = `${action}:${effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ action, resource: "*", effect });
  }
  return rules;
}

function toV1ToolName(name) {
  return TOOL_NAME_TO_V1[name] ?? name;
}

function parseModelRef(spec) {
  if (spec && typeof spec === "object") {
    return spec.providerID && (spec.modelID || spec.id)
      ? { providerID: spec.providerID, id: spec.modelID ?? spec.id }
      : null;
  }
  if (typeof spec !== "string") return null;
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) return null;
  return { providerID: spec.slice(0, i), id: spec.slice(i + 1) };
}

function createLegacyClient(ctx, options) {
  const sessionIDOf = (input) => input?.path?.id ?? input?.sessionID;
  const textOf = (parts) =>
    (parts ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

  return {
    app: {
      log: async ({ body }) => {
        const level = body?.level === "error" ? "error" : "info";
        console[level](`[${PKG_NAME}] ${body?.message ?? ""}`, body?.extra ?? "");
        return { data: true };
      },
    },
    tui: {
      showToast: async ({ body }, sessionID) => {
        const message = body?.message ?? "";
        if (!sessionID) {
          console.info(`[${PKG_NAME}] ${message}`);
          return { data: true };
        }
        await ctx.session.synthetic({
          sessionID,
          text: `${body?.title ?? PKG_NAME}: ${message}`,
          description: PKG_NAME,
          metadata: { [NOTICE_METADATA_KEY]: { message, variant: body?.variant ?? "info" } },
          delivery: "queue",
          resume: false,
        });
        return { data: true };
      },
    },
    session: {
      get: async (input) => ({ data: await ctx.session.get({ sessionID: sessionIDOf(input) }) }),
      messages: async (input) => {
        const messages = await ctx.session.context({ sessionID: sessionIDOf(input) });
        return {
          data: messages.map((message) => ({
            info: { role: message.type === "assistant" ? "assistant" : "user" },
            parts: message.content ?? [{ type: "text", text: message.text ?? "" }],
          })),
        };
      },
      create: async ({ body }) => {
        const model = parseModelRef(options.model);
        // OpenCode 2 caps nested subagents (experimental.subagent_depth,
        // default 1). A review session nested under the coding session could
        // not spawn its four critics, so it is created as a root session and
        // the parent link is kept in metadata instead of parentID.
        const created = await ctx.session.create({
          title: body?.title ?? null,
          ...(body?.parentID ? { metadata: { [NOTICE_METADATA_KEY]: { parentID: body.parentID } } } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          ...(model ? { model } : {}),
          permissions: toolsToPermissions({ edit: false, write: false, patch: false }),
        });
        return { data: created };
      },
      promptAsync: async (input) => {
        await ctx.session.prompt({
          sessionID: sessionIDOf(input),
          text: textOf(input?.body?.parts),
          delivery: "queue",
        });
        return {};
      },
      update: async (input) => {
        await ctx.session.update({ sessionID: sessionIDOf(input), title: input?.body?.title });
        return { data: true };
      },
      abort: async (input) => {
        const result = await ctx.session.interrupt({ sessionID: sessionIDOf(input) });
        return { data: result?.interrupted ?? false };
      },
    },
  };
}

function toIdleEvent(raw) {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  const type = typeof source?.type === "string" ? source.type.replace(/\.1$/, "") : undefined;
  if (!type || !IDLE_EVENTS.has(type)) return null;
  const sessionID = source.data?.sessionID ?? source.properties?.sessionID;
  if (!sessionID) return null;
  return { type: "session.idle", properties: { sessionID } };
}

async function belongsToLocation(ctx, raw, sessionID) {
  const directory = raw?.location?.directory ?? raw?.payload?.location?.directory;
  if (typeof directory === "string") return path.resolve(directory) === path.resolve(ctx.location.directory);
  try {
    const session = await ctx.session.get({ sessionID });
    const sessionDirectory = session?.location?.directory;
    return typeof sessionDirectory === "string" && path.resolve(sessionDirectory) === path.resolve(ctx.location.directory);
  } catch {
    return false;
  }
}

// The reviewer runs git through Bun's `$` template tag. The OpenCode 2 host is
// a Bun binary, so the real tag is available; the fallback covers test runs
// under Node and only implements the subset the reviewer uses.
function makeShell() {
  if (globalThis.Bun?.$) return globalThis.Bun.$;
  return (strings, ...values) => {
    const argv = [];
    strings.forEach((chunk, index) => {
      argv.push(...chunk.split(/\s+/).filter(Boolean));
      if (index < values.length) argv.push(String(values[index]));
    });
    const [command, ...args] = argv;
    const run = () =>
      new Promise((resolve, reject) => {
        execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    const handle = {
      text: () => run(),
      quiet: () => handle,
      nothrow: () => ({ ...handle, text: () => run().catch(() => "") }),
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    };
    return handle;
  };
}
