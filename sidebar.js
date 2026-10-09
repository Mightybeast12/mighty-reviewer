/**
 * OpenCode 2 sidebar panel for mighty-reviewer.
 *
 * Shows the background review for the session tree being viewed: one row for
 * the review session (with the phase parsed from its live title) and one row
 * per critic: the four expected critics are listed as pending until their
 * subagent sessions exist, then each row tracks its session. Once a critic
 * returns, its row shows the findings it reported, counted by severity. Everything is derived from host
 * session data and the TUI client; the server side needs no extra wiring.
 *
 * Laid out like the oh-my-opencode-slim agent panel (single border, header
 * row, a status glyph column, muted labels) so the two read as siblings.
 *
 * Loaded lazily by tui.js: @opentui/solid and solid-js are provided by the
 * OpenCode TUI at runtime and are absent anywhere else (e.g. smoke tests).
 */

import { createElement, insert, setProp } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";

// Must match the title index.js gives review sessions; phase suffixes are
// appended as "Adversarial review - <phase>".
const REVIEW_TITLE = "Adversarial review";
const NOTICE_METADATA_KEY = "mightyReviewer";
const BADGE = "Mighty Reviewer";
const TERMINAL_PHASES = new Set(["SHIP", "NO-SHIP", "done", "timed out"]);
// Phases before any critic has been dispatched.
const EARLY_PHASES = new Set(["starting", "gates"]);
// The four critics every review dispatches (index.js AGENT_DEFINITIONS, with
// the "-critic" suffix dropped as criticName does). Shown as pending rows
// until their sessions exist, so the panel has the same shape at every phase.
const EXPECTED_CRITICS = ["adversarial-risk", "design-principles", "security-checklist", "ai-slop"];
const SEVERITIES = ["P0", "P1", "P2", "P3"];

const BORDER = { type: "single" };
const FRAME_MS = 100;
const POLL_MS = 1000;
const RETRY_MS = 5000;
const DISCOVER_MS = 30000;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH_PENDING = "•";
const GLYPH_DONE = "✓";
const RAW_NOTE = "Critic counts are raw, before the review checks them.";
const IDLE_STATUS = (colors) => ({ label: "idle", color: colors.muted });

const FALLBACK = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  border: "#4b5563",
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
};

const IDLE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

// Session events that can change what the panel shows. Host data reads are
// store-backed and already reactive; these keep a local copy current so the
// panel survives the host evicting review sessions from its cache.
const WATCHED_EVENTS = [
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.status",
  "session.metadata.updated",
  "session.execution.started",
  ...IDLE_EVENTS,
];

export function mountSidebar(ctx) {
  const store = createStore(ctx);
  const [now, setNow] = createSignal(Date.now());
  const [openOverride, setOpenOverride] = createSignal(null);

  let animating = false;
  const pollTimer = setInterval(store.bump, POLL_MS);
  const frameTimer = setInterval(() => {
    if (animating) setNow(Date.now());
  }, FRAME_MS);
  store.discoverReviews();

  const dispose = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      const view = createMemo(
        () => {
          store.tick();
          const sessionID = input?.sessionID ?? routeSessionID(ctx);
          return sessionID ? store.readReview(sessionID) : null;
        },
        null,
        { equals: (a, b) => viewKey(a) === viewKey(b) },
      );
      const root = box({ width: "100%", flexDirection: "column" });
      insert(root, () => {
        const review = view();
        animating = review?.running === true;
        const colors = palette(ctx.theme);
        // No review for this session tree yet: keep the panel visible, like
        // the other sidebar panels, folded to its header.
        if (!review) return frame(colors, [header(colors, { open: false, status: IDLE_STATUS(colors) })]);
        // Open while running, folded once finished, unless the user toggled
        // this particular review.
        const override = openOverride();
        const open = override?.id === review.id ? override.open : review.running;
        return renderPanel(review, colors, now, {
          open,
          toggle: () => setOpenOverride({ id: review.id, open: !open }),
          navigate: (sessionID) => navigate(ctx, sessionID),
          hasSelection: () => hasSelection(ctx.renderer),
        });
      });
      return root;
    },
  });

  return () => {
    clearInterval(pollTimer);
    clearInterval(frameTimer);
    store.dispose();
    dispose?.();
  };
}

// ---------------------------------------------------------------- data

function createStore(ctx) {
  const data = ctx.data;
  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);

  // Review sessions are roots on OpenCode 2 (see v2.js), so the host may drop
  // them, and their critics, from its cache when they are not open in a tab,
  // and after a restart they are not loaded at all. Keep a local copy of
  // every review and critic seen, from host data, events, and the client.
  const known = new Map();
  const running = new Set();
  const results = new Map();
  const lastTry = new Map();

  const throttled = (key, everyMs) => {
    const at = Date.now();
    if (at - (lastTry.get(key) ?? 0) < everyMs) return false;
    lastTry.set(key, at);
    return true;
  };

  const remember = (info) => {
    if (!info?.id) return;
    if (!isReviewSession(info) && !isCritic(info)) return;
    known.set(info.id, { ...known.get(info.id), ...definedFields(info) });
  };

  const isCritic = (info) => info.parentID !== undefined && isReviewSession(known.get(info.parentID));

  const directory = () => ctx.location?.directory ?? safe(() => data.location.default())?.directory;

  const listSessions = async (query) => {
    const dir = directory();
    const response = await ctx.client.session.list({ ...(dir ? { directory: dir } : {}), ...query });
    return Array.isArray(response) ? response : (response?.data ?? []);
  };

  // After a restart nothing about past reviews is cached. Ask the server for
  // recent root sessions once in a while and keep the reviews among them.
  const discoverReviews = () => {
    if (!throttled("discover:reviews", DISCOVER_MS)) return;
    listSessions({ parentID: null, order: "desc", limit: 50 })
      .then((sessions) => {
        for (const info of sessions) if (isReviewSession(info)) remember(info);
        bump();
      })
      .catch(() => {});
  };

  const discoverCritics = (reviewID) => {
    if (!throttled(`discover:${reviewID}`, RETRY_MS)) return;
    listSessions({ parentID: reviewID, order: "asc", limit: 20 })
      .then((sessions) => {
        for (const info of sessions) if (info?.parentID === reviewID) remember(info);
        bump();
      })
      .catch(() => {});
  };

  // A critic's report is its final assistant text. Prefer the host's message
  // cache; otherwise fetch the newest messages once. A returned critic's
  // report never changes, so a parsed result is kept for good.
  const resultOf = (criticID, settled) => {
    if (results.has(criticID)) return results.get(criticID);
    const cached = reportFrom(safe(() => data.session.message.list(criticID)) ?? [], "asc");
    if (cached !== null) return keepResult(criticID, cached);
    if (throttled(`messages:${criticID}`, RETRY_MS)) {
      fetchMessages(criticID)
        .then((messages) => {
          const report = reportFrom(messages, "desc");
          if (report !== null) keepResult(criticID, report);
          else if (settled) results.set(criticID, { noReport: true });
          bump();
        })
        .catch(() => {});
    }
    return null;
  };

  const keepResult = (criticID, report) => {
    const result = { counts: countFindings(report) };
    results.set(criticID, result);
    return result;
  };

  const fetchMessages = async (sessionID) => {
    const response = await ctx.client.message.list({ sessionID, limit: 10, order: "desc" });
    return Array.isArray(response) ? response : (response?.data ?? []);
  };

  const onEvent = (type, event) => {
    const info = event?.data ?? {};
    const id = info.sessionID;
    if (!id) return;
    if (type === "session.created") {
      remember({ ...info, id, time: { created: event.created ?? Date.now() } });
    } else if (type === "session.renamed" && (known.has(id) || isReviewSession(info))) {
      known.set(id, { ...known.get(id), id, title: info.title });
      safe(() => data.session.sync(id))?.catch?.(() => {});
    } else if (type === "session.metadata.updated" && known.has(id)) {
      known.set(id, { ...known.get(id), metadata: info.metadata });
    } else if (type === "session.deleted") {
      known.delete(id);
    }
    if (type === "session.execution.started") running.add(id);
    if (IDLE_EVENTS.has(type)) running.delete(id);
    if (type === "session.status") {
      if (info.status?.type === "idle") running.delete(id);
      else if (info.status?.type) running.add(id);
    }
    bump();
  };

  const offs = WATCHED_EVENTS.map((type) => {
    try {
      return data.on(type, (event) => onEvent(type, event));
    } catch {
      return () => {};
    }
  });

  const isRunning = (id) => safe(() => data.session.status(id)) === "running" || running.has(id);

  const rootOf = (id) => {
    const hostRoot = safe(() => data.session.root(id));
    if (hostRoot && hostRoot !== id) return hostRoot;
    let current = known.get(id);
    while (current?.parentID && known.has(current.parentID)) current = known.get(current.parentID);
    return current?.parentID ?? current?.id ?? id;
  };

  const readReview = (viewedID) => {
    const cached = safe(() => data.session.list()) ?? [];
    for (const info of cached) if (isReviewSession(info)) remember(info);
    for (const info of cached) if (isCritic(info)) remember(info);

    const rootID = rootOf(viewedID);
    const tree = new Set([rootID, viewedID, ...(safe(() => data.session.family(rootID)) ?? [])]);

    let review;
    for (const info of known.values()) {
      if (!isReviewSession(info)) continue;
      const parentID = info.metadata?.[NOTICE_METADATA_KEY]?.parentID;
      if (!tree.has(info.id) && !tree.has(parentID)) continue;
      if (!review || millis(info.time?.created) > millis(review.time?.created)) review = info;
    }
    if (!review) {
      discoverReviews();
      return null;
    }

    for (const id of safe(() => data.session.family(review.id)) ?? []) {
      remember(safe(() => data.session.get(id)));
    }
    const phase = phaseOf(review.title);
    const finished = TERMINAL_PHASES.has(phase);
    const critics = [...known.values()]
      .filter((info) => info.parentID === review.id)
      .sort((a, b) => millis(a.time?.created) - millis(b.time?.created))
      .map((info) => {
        const criticRunning = isRunning(info.id);
        const result = criticRunning ? null : resultOf(info.id, finished);
        return { id: info.id, name: criticName(info), running: criticRunning, result };
      });
    if (critics.length === 0 && !EARLY_PHASES.has(phase)) discoverCritics(review.id);

    const reviewRunning = !finished && (isRunning(review.id) || critics.some((c) => c.running));
    return { id: review.id, phase, finished, running: reviewRunning, critics: withExpected(critics) };
  };

  return {
    tick,
    bump,
    readReview,
    discoverReviews,
    dispose: () => {
      for (const off of offs) off?.();
    },
  };
}

// Expected critics first, in a fixed order, each replaced by its real session
// once spawned; any other child of the review (ad hoc verification subagents)
// follows. A missing critic is a pending row with no session to open.
function withExpected(critics) {
  const rest = [...critics];
  const rows = EXPECTED_CRITICS.map((name) => {
    const index = rest.findIndex((critic) => critic.name === name);
    if (index === -1) return { id: null, name, running: false, result: null, pending: true };
    return rest.splice(index, 1)[0];
  });
  return [...rows, ...rest];
}

function isReviewSession(info) {
  return typeof info?.title === "string" && info.title.startsWith(REVIEW_TITLE);
}

function definedFields(info) {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
}

function phaseOf(title) {
  const rest = title.slice(REVIEW_TITLE.length).replace(/^\s*-\s*/, "").trim();
  return rest || "starting";
}

// Critic agents are all named "<topic>-critic"; the suffix only costs width.
function criticName(info) {
  const tagged = /@([\w.-]+)/.exec(info.title ?? "");
  const name = info.agent ? String(info.agent) : tagged ? tagged[1] : (info.title ?? "subagent");
  return name.replace(/-critic$/, "");
}

// Final assistant text of a session, or null when there is none yet.
// `order` says whether `messages` is oldest-first or newest-first.
function reportFrom(messages, order) {
  const list = order === "asc" ? [...messages].reverse() : messages;
  for (const message of list) {
    if (message?.type !== "assistant" && message?.info?.role !== "assistant") continue;
    const parts = message.content ?? message.parts ?? [];
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------- findings

const DECORATION = /^(?:\s+|[#>*+|-]+|\d+[.)]|__|[[(`])/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#/;
const TOP_LEVEL_ITEM = /^ ?(?:[-*+]|\d+[.)])\s/;
const STRUCTURAL = /^\s*(?:#|[-*+]\s|\d+[.)]\s|\|)/;
const LEADING_TAG = /^(P[0-3])\b/i;
const FIELD_TAG = /^severity\b[\s*_]*[:=-]?[\s*_]*[[(`]?\s*(P[0-3])\b/i;
const BRACKET_TAG = /[[(](P[0-3])[\])]/i;
// A bare severity label used as a group heading: "### P1", "**P2 findings**",
// "P1 - High:", "P3 (nits)". Items listed under it carry its severity.
const GROUP_LABEL =
  /^(P[0-3])\b[\s*_:\u2013-]*(?:\(?\s*(?:critical|high|medium|low|minor|major|nits?|findings?|issues?|blocking|none|n\/a|nothing)(?:\s+(?:findings?|issues?))?\s*\)?)?[\s*_:.\u2013-]*$/i;
const EMPTY_LABEL = /\b(?:none|n\/a|nothing)\b/i;
// After a tag on a plain paragraph line, only a separator marks a finding
// ("P1: foo.ts:3 ...", "P2 - ..."); "P1 is reserved for ..." is prose.
const PLAIN_SEPARATOR = /^[\])*_`]*\s*[:|\u2013-]/;
// What may follow a leading tag without it being a finding: a range or pair
// ("P0-P3", "P0/P1"), prose about the severity itself ("P1 findings must"),
// a summary of nothing ("P1: none"), or a bare tally ("P1: 2").
const NOT_A_FINDING =
  /^(?:\s*[-/\u2013]\s*P?[0-3]\b|[\s\])`*_:\u2013-]*findings?\b|[\s\])`*_:\u2013-]*(?:none|n\/a|nothing)\b|[\s\])`*_:=\u2013-]*\d+[\s*_.]*$)/i;

/**
 * Counts one critic's findings by severity.
 *
 * The critic prompts (index.js AGENT_DEFINITIONS) require a P0-P3 severity on
 * every finding but leave the layout free, so three shapes are recognized,
 * each only at the start of a line after markdown decoration
 * (#, -, *, 1., |, **):
 *   - a severity tag that opens the finding: "### [P1] ...", "- **P2** ...",
 *     "| P3 | file:line |", or a bracketed tag in a heading or list item;
 *   - a group heading that is only a severity label ("### P1", "**P2**"),
 *     where each top-level list item under it is one finding;
 *   - a severity field inside a finding block: "- Severity: P1".
 * A finding written in two shapes (tagged heading plus a Severity field)
 * must count once, so field lines are tallied separately and the larger
 * tally wins. Severity mentions inside prose, ranges like "P0-P3", and lines
 * like "P1: none" or "P1: 2" never count. Code fences are skipped.
 */
export function countFindings(report) {
  const tagged = emptyCounts();
  const fields = emptyCounts();
  let fenced = false;
  let section = null;
  let sectionLevel = 0;
  let sectionByHeadings = false;
  for (const raw of String(report ?? "").split("\n")) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.trim()) continue;
    const line = stripDecoration(raw);
    const isItem = TOP_LEVEL_ITEM.test(raw);
    const structural = STRUCTURAL.test(raw);
    const level = headingLevel(raw);

    const group = isGroupLine(raw, isItem) ? GROUP_LABEL.exec(line) : null;
    if (group) {
      section = EMPTY_LABEL.test(line) ? null : group[1].toUpperCase();
      sectionLevel = level || 99;
      sectionByHeadings = false;
      continue;
    }
    // A deeper heading inside a severity group is one finding of that group;
    // a heading at the group's level or above ends the group.
    const subHeading = level > 0 && section !== null && level > sectionLevel;
    if (level > 0 && !subHeading) section = null;
    // Once a group lists its findings as sub-headings, list items below them
    // are details of those findings, not findings of their own.
    if (subHeading) sectionByHeadings = true;

    const field = FIELD_TAG.exec(line);
    if (field) {
      fields[field[1].toUpperCase()] += 1;
      continue;
    }
    const lead = LEADING_TAG.exec(line);
    const rest = lead ? line.slice(lead[0].length) : "";
    const leadCounts = lead && !NOT_A_FINDING.test(rest) && (structural || PLAIN_SEPARATOR.test(rest));
    const bracket = lead || !structural ? null : BRACKET_TAG.exec(line);
    const tag = leadCounts ? lead[1] : bracket?.[1];
    if (tag) tagged[tag.toUpperCase()] += 1;
    else if (!lead && section && (subHeading || (isItem && !sectionByHeadings))) tagged[section] += 1;
  }
  return total(tagged) >= total(fields) ? tagged : fields;
}

function headingLevel(raw) {
  const match = /^\s*(#+)\s/.exec(raw);
  return match ? match[1].length : 0;
}

// Group labels only come as headings, bold lines, or lines ending in ":".
function isGroupLine(raw, isItem) {
  if (isItem) return false;
  return HEADING.test(raw) || /^\s*(\*\*|__).*(\*\*|__)\s*:?\s*$/.test(raw) || /:\s*$/.test(raw);
}

function stripDecoration(line) {
  let rest = line;
  for (let previous = null; previous !== rest; ) {
    previous = rest;
    rest = rest.replace(DECORATION, "");
  }
  return rest;
}

function emptyCounts() {
  return { P0: 0, P1: 0, P2: 0, P3: 0 };
}

function total(counts) {
  return SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}

// ---------------------------------------------------------------- helpers

function viewKey(view) {
  return view ? JSON.stringify(view) : "";
}

function millis(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.epochMillis === "number") return value.epochMillis;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function safe(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function routeSessionID(ctx) {
  const route = safe(() => ctx.ui.router.current());
  return route?.type === "session" ? route.sessionID : undefined;
}

function navigate(ctx, sessionID) {
  safe(() => ctx.ui.router.navigate({ type: "session", sessionID }));
}

function hasSelection(renderer) {
  const text = safe(() => renderer?.getSelection?.()?.getSelectedText?.());
  return typeof text === "string" && text.length > 0;
}

// ---------------------------------------------------------------- theme

// Resolves a color from the first theme path that exists. OpenCode 2.0.26
// nests colors as text.base / text.feedback.success.base; earlier 2.x builds
// used text.default / text.subdued. A color is a string or an RGBA object.
function pick(theme, paths, fallback) {
  for (const path of paths) {
    let value = theme;
    for (const key of path.split(".")) value = value?.[key];
    if (isColorGroup(value)) value = value.base;
    if (typeof value === "string" || isRGBA(value)) return value;
  }
  return fallback;
}

function isRGBA(value) {
  return typeof value === "object" && value !== null && "r" in value;
}

function isColorGroup(value) {
  return typeof value === "object" && value !== null && !isRGBA(value) && "base" in value;
}

function palette(theme) {
  return {
    text: pick(theme, ["text.base", "text.default", "text"], FALLBACK.text),
    muted: pick(theme, ["text.muted", "text.subdued", "textMuted"], FALLBACK.muted),
    border: pick(theme, ["border.base", "border.default", "borderActive"], FALLBACK.border),
    success: pick(theme, ["text.feedback.success", "success"], FALLBACK.success),
    warning: pick(theme, ["text.feedback.warning", "warning"], FALLBACK.warning),
    error: pick(theme, ["text.feedback.error", "error"], FALLBACK.error),
  };
}

// ---------------------------------------------------------------- view

function renderPanel(review, colors, now, ui) {
  const status = statusOf(review, colors);
  const panelHeader = header(colors, { open: ui.open, status, toggle: ui.toggle, hasSelection: ui.hasSelection });
  if (!ui.open) return frame(colors, [panelHeader]);

  const criticRows = review.critics.map((critic) =>
    critic.pending
      ? row({
          glyph: glyphOf(false, false, colors, now),
          label: critic.name,
          detail: review.finished ? [text({ fg: colors.muted, wrapMode: "none" }, ["not run"])] : null,
          indent: 2,
          colors,
          onClick: () => {},
          hasSelection: ui.hasSelection,
        })
      : row({
          glyph: glyphOf(critic.running, critic.result !== null || review.finished, colors, now),
          label: critic.name,
          detail: critic.running ? null : resultCells(critic.result, colors),
          indent: 2,
          colors,
          onClick: () => ui.navigate(critic.id),
          hasSelection: ui.hasSelection,
        }),
  );
  const hasCounts = review.critics.some((critic) => critic.result?.counts);
  return frame(colors, [
    panelHeader,
    row({
      glyph: glyphOf(review.running, review.finished, colors, now),
      label: "review",
      detail: review.finished ? null : [text({ fg: colors.muted, wrapMode: "none" }, [review.phase])],
      colors,
      onClick: () => ui.navigate(review.id),
      hasSelection: ui.hasSelection,
    }),
    ...criticRows,
    hasCounts ? text({ fg: colors.muted, marginTop: 1 }, [RAW_NOTE]) : null,
  ]);
}

function frame(colors, children) {
  return box(
    {
      width: "100%",
      flexDirection: "column",
      border: BORDER,
      borderColor: colors.border,
      paddingTop: 1,
      paddingBottom: 1,
      paddingRight: 1,
    },
    children,
  );
}

function statusOf(review, colors) {
  if (!review) return IDLE_STATUS(colors);
  if (review.running) return { label: "running", color: colors.success };
  if (review.phase === "SHIP") return { label: "SHIP", color: colors.success };
  if (review.phase === "NO-SHIP") return { label: "NO-SHIP", color: colors.error };
  if (review.phase === "timed out") return { label: "timed out", color: colors.warning };
  if (review.finished) return { label: "done", color: colors.muted };
  return IDLE_STATUS(colors);
}

// Panel title line: fold marker, badge, status at the right edge. Without a
// toggle (no review yet) the line is inert.
function header(colors, { open, status, toggle, hasSelection }) {
  const line = box({ width: "100%", flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, [
    box({ flexDirection: "row", alignItems: "center" }, [
      text({ fg: colors.muted, width: 2 }, [open ? "▼ " : "▶ "]),
      text({ fg: colors.text }, [BADGE]),
    ]),
    text({ fg: status.color, wrapMode: "none" }, [status.label]),
  ]);
  return toggle ? clickable(line, toggle, hasSelection) : line;
}

// "1 P1 2 P3" with each pair in its severity color, "clean" when the critic
// reported nothing, "no report" when it ended without any text.
function resultCells(result, colors) {
  if (!result) return null;
  if (result.noReport) return [text({ fg: colors.muted, wrapMode: "none" }, ["no report"])];
  const present = SEVERITIES.filter((severity) => result.counts[severity] > 0);
  if (present.length === 0) return [text({ fg: colors.success, wrapMode: "none" }, ["clean"])];
  const severityColor = { P0: colors.error, P1: colors.error, P2: colors.warning, P3: colors.muted };
  return present.map((severity, index) =>
    text({ fg: severityColor[severity], wrapMode: "none", marginLeft: index === 0 ? 0 : 1 }, [
      `${result.counts[severity]} ${severity}`,
    ]),
  );
}

function glyphOf(isRunning, settled, colors, now) {
  if (isRunning) {
    return { color: colors.success, value: () => `${FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length]} ` };
  }
  return { color: colors.muted, value: `${settled ? GLYPH_DONE : GLYPH_PENDING} ` };
}

function row({ glyph, label, detail, indent = 0, colors, onClick, hasSelection }) {
  return clickable(
    box({ width: "100%", flexDirection: "row", paddingLeft: indent, shouldFill: true }, [
      text({ fg: glyph.color, width: 2, flexShrink: 0, wrapMode: "none" }, [glyph.value]),
      text({ fg: colors.muted, wrapMode: "none", truncate: true, flexShrink: 1, flexGrow: 1 }, [label]),
      detail ? box({ flexDirection: "row", flexShrink: 0, marginLeft: 1 }, detail) : null,
    ]),
    onClick,
    hasSelection,
  );
}

function clickable(node, onActivate, hasSelection) {
  setProp(node, "onMouseUp", (event) => {
    if (event?.button !== undefined && event.button !== 0) return;
    if (hasSelection()) return;
    onActivate();
  });
  return node;
}

function element(tag, props, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }
  return node;
}

function box(props, children) {
  return element("box", props, children);
}

function text(props, children) {
  return element("text", props, children);
}
