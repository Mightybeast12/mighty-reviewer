/**
 * OpenCode 2 sidebar panel for mighty-reviewer.
 *
 * Shows the background review for the session tree being viewed: one row for
 * the review session (diff scope, elapsed time, and live phase while
 * running) and one row per critic: the four expected critics are listed as
 * pending until their subagent sessions exist, then each row tracks its
 * session. Once a critic returns, its row shows the findings it reported, a
 * constant-position severity run plus its token total. A totals row sums the
 * raw per-critic counts and, once the review itself is done, how many of
 * them survived its own verification pass. A cycle line surfaces the
 * re-review loop (index.js MAX_REREVIEW_CYCLES) once it has run at least
 * once. Everything is derived from host session data and the TUI client;
 * the server side only adds the review-progress metadata snapshot (see
 * index.js reviewMetadataFor) and the notices below.
 *
 * While no review exists yet for the viewed session, the panel instead shows
 * the latest queued notice for it (index.js showToast via the v2 synthetic-
 * inbox bridge in v2.js), so a skip ("diff too large") is not silent.
 *
 * A "mighty-reviewer.findings" session.panel claim shows the P0/P1 lines of
 * the selected critic (or all of them) plus the review's own status;
 * clicking a critic row opens it, and so does the global `/review-findings`
 * command registered through a keymap layer.
 *
 * Laid out like the oh-my-opencode-slim agent panel (single border, header
 * row, a status glyph column, muted labels) so the two read as siblings.
 *
 * Loaded lazily by tui.js: @opentui/solid and solid-js are provided by the
 * OpenCode TUI at runtime and are absent anywhere else (e.g. smoke tests).
 * The pure counting and formatting helpers live in internals.js instead, so
 * smoke-test.mjs can exercise them without those two packages.
 */

import { createElement, insert, setProp } from "@opentui/solid";
import { createMemo, createSignal, onCleanup } from "solid-js";

import {
  countFindings,
  countVerifiedFindings,
  criticLabel,
  extractAssistantReport,
  formatCompactElapsed,
  formatTokenCount,
  isReviewSession,
  phaseOf,
  severityTokens,
  SEVERITIES,
  TERMINAL_PHASES,
  METADATA_KEY,
  PKG_NAME,
  PKG_VERSION,
} from "./internals.js";

// Phase suffixes are appended to REVIEW_TITLE (internals.js) as
// "Adversarial review - <phase>".
const BADGE = "Mighty Reviewer";
// Phases before any critic has been dispatched: shown nowhere in the row
// detail, since there is nothing to say yet beyond "it's running" (which the
// spinner already says). Later phases ("critics 2/4", "verifying", ...) are
// genuinely informative and stay on the row.
const EARLY_PHASES = new Set(["starting", "gates"]);
// The four critics every review dispatches (index.js AGENT_DEFINITIONS, with
// the "-critic" suffix dropped as criticName does). Shown as pending rows
// until their sessions exist, so the panel has the same shape at every phase.
const EXPECTED_CRITICS = ["adversarial-risk", "design-principles", "security-checklist", "ai-slop"];
const FINDINGS_PANEL = "mighty-reviewer.findings";
const REVIEW_FINDINGS_COMMAND = "mighty-reviewer.review-findings";

// A critic row's detail block (severity run or "clean"/"no report", plus
// the token count) is padded to these fixed widths, so its total width
// never changes between a quiet row and a loud one: a long row's severity
// run no longer squeezes a different row's label by a different amount,
// which used to truncate critic names inconsistently, and the token count
// always lands on the same column.
const SEVERITY_CELL_WIDTH = 4; // fits "N PX" at a single-digit N; "·" pads to it
const SEVERITY_RUN_WIDTH = SEVERITY_CELL_WIDTH * SEVERITIES.length + (SEVERITIES.length - 1);
const TOKEN_WIDTH = 5; // right-aligned, fits up to "999k"

const BORDER = { type: "single" };
const FRAME_MS = 100;
const POLL_MS = 1000;
const RETRY_MS = 5000;
const DISCOVER_MS = 30000;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH_PENDING = "•";
const GLYPH_DONE = "✓";
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
  "session.inbox.enqueued",
  ...IDLE_EVENTS,
];

export function mountSidebar(ctx) {
  const store = createStore(ctx);
  const [now, setNow] = createSignal(Date.now());
  const [openOverride, setOpenOverride] = createSignal(null);
  const [selectedCritic, setSelectedCritic] = createSignal(null);

  let animating = false;
  let footerAnimating = false;
  const pollTimer = setInterval(store.bump, POLL_MS);
  const frameTimer = setInterval(() => {
    if (animating || footerAnimating) setNow(Date.now());
  }, FRAME_MS);
  store.discoverReviews();

  // Opening the findings panel is a thin wrapper so the panel content (which
  // re-reads `selectedCritic`) always matches whichever row (or none, for
  // the global command) was clicked. A no-op when the host has no panel
  // system, which also keeps the review row's/critic rows' click handlers
  // free to bind it unconditionally.
  const openFindings = (criticID) => {
    setSelectedCritic(criticID ?? null);
    if (typeof ctx.ui?.panel?.open === "function") {
      ctx.ui.panel.open(FINDINGS_PANEL, { presentation: "panel" });
    }
  };

  const disposeSidebar = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      const view = createMemo(
        () => {
          store.tick();
          const sessionID = input?.sessionID ?? routeSessionID(ctx);
          if (!sessionID) return null;
          const review = store.readReview(sessionID);
          return review ? { review } : { notice: store.noticeFor(sessionID) };
        },
        null,
        { equals: (a, b) => viewKey(a) === viewKey(b) },
      );
      const root = box({ width: "100%", flexDirection: "column" });
      insert(root, () => {
        const current = view();
        const review = current?.review ?? null;
        animating = review?.running === true;
        const colors = palette(ctx.theme);
        // No review for this session tree yet: keep the panel visible, like
        // the other sidebar panels, folded to its header. Surface the last
        // queued notice (e.g. "diff too large, skipped") underneath it.
        if (!review) {
          const notice = current?.notice;
          return frame(colors, [
            header(colors, { open: false, status: IDLE_STATUS(colors) }),
            notice ? noticeLine(colors, notice) : null,
          ]);
        }
        // Open while running, folded once finished, unless the user toggled
        // this particular review.
        const override = openOverride();
        const open = override?.id === review.id ? override.open : review.running;
        return renderPanel(review, colors, now, {
          open,
          toggle: () => setOpenOverride({ id: review.id, open: !open }),
          navigate: (sessionID) => navigate(ctx, sessionID),
          openFindings,
          hasSelection: () => hasSelection(ctx.renderer),
        });
      });
      return root;
    },
  });

  // Footer status line ("prompt.footer.status"): while a review for the
  // viewed session is running, one muted line under the prompt box showing
  // the spinner (FRAMES, shared with the review row above), live critic
  // count, and elapsed time; nothing while no review is running. Reuses
  // the same store, so it needs no extra session tracking of its own.
  // `footerAnimating` is separate from the sidebar panel's `animating` so
  // either slot alone keeps the frame timer ticking.
  // Mounted with `after`, as a sibling of the host's status box, not
  // `append` inside it: the host box has flexGrow 1 and squeezes appended
  // children to zero width while a turn runs. The root sizes to its content
  // (no fixed width) so that, while no review is running, the empty box
  // claims no columns; a `width: "100%"` here crushed the host's own
  // spinner and "esc interrupt" hint down to a few truncated cells.
  const disposeFooterStatus = ctx.ui.slot({
    after: "prompt.footer.status",
    render: (input) => {
      const root = box({ flexDirection: "row", flexShrink: 0 });
      insert(root, () => {
        store.tick();
        const sessionID = input?.sessionID ?? routeSessionID(ctx);
        const review = sessionID ? store.readReview(sessionID) : null;
        footerAnimating = review?.running === true;
        if (!footerAnimating) return null;
        return footerStatusLine(review, palette(ctx.theme), now);
      });
      return root;
    },
  });

  // Detail view for a critic (or, from the global command below, every
  // critic): the P0/P1 lines countFindings captured, plus the review's own
  // status. Registered unconditionally; a host without session.panel simply
  // never calls this render with our name. controlledPanels makes sure a
  // given panel instance only gets its keymap layer/focus set up once,
  // even though render runs again on every reactive tick (store.tick(),
  // selectedCritic()).
  const controlledPanels = new WeakSet();
  const disposeFindingsPanel = ctx.ui.slot({
    append: "session.panel",
    render: (panel) => {
      if (panel?.name !== FINDINGS_PANEL) return null;
      // A stable outer box per panel instance: the keymap layer targets a
      // renderable (the host subscribes to its DESTROYED event), so the
      // reactive content is inserted inside it rather than returned anew
      // on every tick.
      const shell = box({ width: "100%", flexDirection: "column" });
      insert(shell, () => renderFindingsPanel(panel, store, selectedCritic, ctx.theme));
      if (!controlledPanels.has(panel)) {
        controlledPanels.add(panel);
        setupPanelControls(ctx, panel, shell);
      }
      return shell;
    },
  });

  const disposeKeymap = mountFindingsCommand(ctx, openFindings);

  return () => {
    clearInterval(pollTimer);
    clearInterval(frameTimer);
    store.dispose();
    disposeSidebar?.();
    disposeFooterStatus?.();
    disposeFindingsPanel?.();
    disposeKeymap?.();
  };
}

// Registered the way a global keymap command is documented: a claim on the
// "app" slot (rendered once, nowhere in particular) that registers a
// reactive keymap layer and renders nothing itself. Skipped entirely on a
// host without a keymap API.
function mountFindingsCommand(ctx, openFindings) {
  if (typeof ctx.keymap?.layer !== "function") return undefined;
  return ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: REVIEW_FINDINGS_COMMAND,
            title: "Mighty Reviewer: review findings",
            slash: { name: "review-findings" },
            run: () => openFindings(null),
          },
        ],
      }));
      return null;
    },
  });
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
  const reviewReports = new Map();
  const notices = new Map();
  const lastTry = new Map();
  // Review ids that already got their "no diff summary" console.debug, so a
  // review stuck without one (every poll tick calls readReview) logs why
  // exactly once instead of spamming the console.
  const diffSummaryDebugged = new Set();

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
    const cachedMessages = safe(() => data.session.message.list(criticID)) ?? [];
    const cachedReport = extractAssistantReport(cachedMessages, "asc");
    if (cachedReport !== null) return keepResult(criticID, cachedReport, cachedMessages);
    if (throttled(`messages:${criticID}`, RETRY_MS)) {
      fetchMessages(criticID)
        .then((messages) => {
          const report = extractAssistantReport(messages, "desc");
          if (report !== null) keepResult(criticID, report, messages);
          else if (settled) results.set(criticID, { noReport: true });
          bump();
        })
        .catch(() => {});
    }
    return null;
  };

  const keepResult = (criticID, report, messages) => {
    const { counts, lines } = countFindings(report);
    const result = { counts, lines, tokens: tokensOf(criticID, messages) };
    results.set(criticID, result);
    return result;
  };

  // Session.tokens is the authoritative running total; fall back to summing
  // whatever assistant messages were on hand (host cache or the fallback
  // fetch above) when the session itself hasn't got one yet.
  const tokensOf = (criticID, messages) => {
    const sessionTokens = known.get(criticID)?.tokens;
    if (sessionTokens) return sumTokenUsage(sessionTokens);
    const total = messages.reduce((sum, message) => sum + messageTokens(message), 0);
    return total > 0 ? total : null;
  };

  // The review's own merged/verified report, counted by countVerifiedFindings
  // (its Findings section only, capped at the critics' raw total) so the
  // totals row can show "verified N of <raw total>" without N ever
  // exceeding M.
  const verifiedCountOf = (reviewID, rawTotal) => {
    if (reviewReports.has(reviewID)) return reviewReports.get(reviewID);
    const cachedMessages = safe(() => data.session.message.list(reviewID)) ?? [];
    const cachedReport = extractAssistantReport(cachedMessages, "asc");
    if (cachedReport !== null) {
      const verified = countVerifiedFindings(cachedReport, rawTotal);
      reviewReports.set(reviewID, verified);
      return verified;
    }
    if (throttled(`review-report:${reviewID}`, RETRY_MS)) {
      fetchMessages(reviewID)
        .then((messages) => {
          const report = extractAssistantReport(messages, "desc");
          if (report !== null) {
            reviewReports.set(reviewID, countVerifiedFindings(report, rawTotal));
            bump();
          }
        })
        .catch(() => {});
    }
    return null;
  };

  const fetchMessages = async (sessionID) => {
    const response = await ctx.client.message.list({ sessionID, limit: 10, order: "desc" });
    return Array.isArray(response) ? response : (response?.data ?? []);
  };

  // The review row's diff scope, tried in order: the parent (coding)
  // session's own Session.summary, which is what normally has it; the
  // review session's summary, on the rare host that attaches one there
  // instead; and data.session.diff(reviewID) (a per-file diff list, summed
  // into file/addition/deletion counts) when neither session carries a
  // summary at all. Once none of the three has anything, nothing is shown,
  // and why is logged once (not every poll tick) via console.debug.
  const diffSummaryFor = (review, parentSession) => {
    const fromParent = summaryText(parentSession?.summary);
    if (fromParent) return fromParent;
    const fromReview = summaryText(review.summary);
    if (fromReview) return fromReview;
    const diff = safe(() => data.session.diff?.(review.id));
    const fromDiff = summaryText(diffStatsOf(diff));
    if (fromDiff) return fromDiff;
    if (!diffSummaryDebugged.has(review.id)) {
      diffSummaryDebugged.add(review.id);
      console.debug(
        `[${PKG_NAME}] review ${review.id}: no diff summary (parent session summary: ${describeMissing(parentSession?.summary)}, review session summary: ${describeMissing(review.summary)}, session.diff(): ${describeMissing(diff)})`,
      );
    }
    return null;
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
    } else if (type === "session.inbox.enqueued") {
      const notice = noticeFromItem(info.item);
      if (notice) notices.set(id, notice);
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
      const parentID = info.metadata?.[METADATA_KEY]?.parentID;
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
    // The review's own time.updated and metadata only land in `known` once
    // it is refreshed from the host; family() may or may not include the
    // review session itself, so refresh it explicitly.
    remember(safe(() => data.session.get(review.id)));
    review = known.get(review.id) ?? review;

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

    const parentID = review.metadata?.[METADATA_KEY]?.parentID;
    const parentSession = parentID ? safe(() => data.session.get(parentID)) : null;
    const diffSummary = diffSummaryFor(review, parentSession);

    const rawCounts = totalCounts(critics);
    let verifiedSuffix = null;
    if (rawCounts && finished) {
      const verified = verifiedCountOf(review.id, sumCounts(rawCounts));
      if (verified !== null) verifiedSuffix = ` · verified ${verified} of ${sumCounts(rawCounts)}`;
    }

    const reviewMeta = review.metadata?.[METADATA_KEY];
    const cycleLabel =
      reviewMeta?.cycle > 0
        ? `cycle ${reviewMeta.cycle}/${reviewMeta.maxCycles ?? reviewMeta.cycle}${
            reviewMeta.verdict === "NO-SHIP" ? " · fixes sent to session" : ""
          }`
        : null;

    return {
      id: review.id,
      phase,
      finished,
      running: reviewRunning,
      time: review.time,
      diffSummary,
      rawCounts,
      verifiedSuffix,
      cycleLabel,
      critics: withExpected(critics),
    };
  };

  return {
    tick,
    bump,
    readReview,
    discoverReviews,
    noticeFor: (sessionID) => notices.get(sessionID) ?? null,
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

function definedFields(info) {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
}

// Critic agents are all named "<topic>-critic"; the suffix only costs width.
function criticName(info) {
  const tagged = /@([\w.-]+)/.exec(info.title ?? "");
  const name = info.agent ? String(info.agent) : tagged ? tagged[1] : (info.title ?? "subagent");
  return name.replace(/-critic$/, "");
}

function sumTokenUsage(tokens) {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
}

function messageTokens(message) {
  const isAssistant = message?.type === "assistant" || message?.info?.role === "assistant";
  return isAssistant ? sumTokenUsage(message.tokens) : 0;
}

function sumCounts(counts) {
  return SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}

// Sums each critic's raw counts; null (not a zero-filled object) when no
// critic has reported yet, so the totals row knows to stay hidden.
function totalCounts(critics) {
  let any = false;
  const sums = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const critic of critics) {
    if (!critic.result?.counts) continue;
    any = true;
    for (const severity of SEVERITIES) sums[severity] += critic.result.counts[severity];
  }
  return any ? sums : null;
}

// A Session.summary-shaped object (files/additions/deletions), whether it
// came straight off a session or was summed from a raw diff below, as the
// review row's one-line diff scope; null when there is nothing to show.
function summaryText(summary) {
  if (!summary || typeof summary.files !== "number") return null;
  return `${summary.files} files +${summary.additions ?? 0}/-${summary.deletions ?? 0}`;
}

// data.session.diff(sessionID) is a per-file diff list (SnapshotFileDiff[]
// in the host), possibly wrapped as { data: [...] } like the other list
// endpoints this file already calls; summed into the same file/additions/
// deletions shape Session.summary uses. Null when the shape is not a list
// at all, so the caller knows this fallback had nothing either.
function diffStatsOf(diff) {
  const files = Array.isArray(diff) ? diff : Array.isArray(diff?.data) ? diff.data : Array.isArray(diff?.files) ? diff.files : null;
  if (!files) return null;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += Number(file?.additions) || 0;
    deletions += Number(file?.deletions) || 0;
  }
  return { files: files.length, additions, deletions };
}

// Short reason fragments for the "no diff summary" debug line: distinguishes
// a value that was simply absent from one a fallback attempt returned but
// that carried nothing usable.
function describeMissing(value) {
  if (value === undefined) return "unavailable";
  if (value === null) return "empty";
  return "no usable fields";
}

// Same parse as tui.js's noticeFrom, applied to the raw inbox item instead of
// the wrapped event envelope: a synthetic item carrying our metadata key.
function noticeFromItem(item) {
  if (item?.type !== "synthetic") return null;
  const notice = item.payload?.metadata?.[METADATA_KEY];
  if (!notice || typeof notice.message !== "string") return null;
  return { message: notice.message, variant: notice.variant ?? "info" };
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

// Severity -> color, zero-valued slots always rendered in the faint/muted
// color regardless of which severity they are.
function severityColors(colors) {
  return { P0: colors.error, P1: colors.error, P2: colors.warning, P3: colors.muted };
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
          label: criticLabel(critic.name),
          detail: review.finished ? [text({ fg: colors.muted, wrapMode: "none" }, ["not run"])] : null,
          indent: 2,
          colors,
          onClick: () => {},
          hasSelection: ui.hasSelection,
        })
      : row({
          glyph: glyphOf(critic.running, critic.result !== null || review.finished, colors, now),
          label: criticLabel(critic.name),
          detail: critic.running ? null : resultDetail(critic.result, colors),
          indent: 2,
          colors,
          onClick: () => ui.navigate(critic.id),
          onPress: () => ui.openFindings(critic.id),
          hasSelection: ui.hasSelection,
        }),
  );
  return frame(colors, [
    panelHeader,
    row({
      glyph: glyphOf(review.running, review.finished, colors, now),
      label: "review",
      detail: reviewDetail(review, colors, now),
      colors,
      onClick: () => ui.navigate(review.id),
      hasSelection: ui.hasSelection,
    }),
    ...criticRows,
    totalsLine(review, colors),
    cycleLine(review, colors),
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
      PKG_VERSION ? text({ fg: colors.muted, marginLeft: 1, wrapMode: "none" }, [`v${PKG_VERSION}`]) : null,
    ]),
    text({ fg: status.color, wrapMode: "none" }, [status.label]),
  ]);
  return toggle ? clickable(line, toggle, undefined, hasSelection) : line;
}

// A muted single line under the folded header, for the latest queued notice
// (index.js showToast, delivered as a synthetic inbox item on v2 - see
// noticeFromItem) when there is no review to show instead.
function noticeLine(colors, notice) {
  return box({ width: "100%", flexDirection: "row", paddingLeft: 2 }, [
    text({ fg: colors.muted, wrapMode: "none", truncate: true }, [notice.message]),
  ]);
}

// Review row detail, left to right: diff scope (parent session's
// Session.summary), the phase while it is running and worth saying, and the
// elapsed time, right-aligned by the row's own layout (label grows, detail
// shrinks). Elapsed ticks every frame while running; it is a fixed value
// once finished.
function reviewDetail(review, colors, now) {
  const items = [];
  if (review.diffSummary) items.push(review.diffSummary);
  const phaseLabel = review.running && !EARLY_PHASES.has(review.phase) ? review.phase : null;
  if (phaseLabel) items.push(phaseLabel);
  const elapsed = elapsedLabel(review, now);
  if (elapsed !== null) items.push(elapsed);
  if (!items.length) return null;
  return items.map((value, index) =>
    text({ fg: colors.muted, wrapMode: "none", marginLeft: index === 0 ? 0 : 1 }, [value]),
  );
}

// A plain string once finished (static), a reactive thunk reading `now()`
// while running (so it ticks), or null when there is no created time to
// measure from yet.
function elapsedLabel(review, now) {
  const created = millis(review.time?.created);
  if (!created) return null;
  if (review.finished) {
    const updated = millis(review.time?.updated);
    return updated >= created ? formatCompactElapsed(updated - created) : null;
  }
  return () => formatCompactElapsed(Math.max(0, now() - created));
}

// "prompt.footer.status" content for a running review: a spinner frame
// (FRAMES, same ones the review row's glyph animates through), how many of
// the expected critics have returned (review.critics already includes the
// pending ones via withExpected, so its length is the stable denominator),
// and elapsed time. Only called while review.running, so there is always a
// created time to measure from.
function footerStatusLine(review, colors, now) {
  const frame = FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length];
  const total = review.critics.length;
  const done = review.critics.filter((critic) => !critic.pending && !critic.running).length;
  const created = millis(review.time?.created);
  const elapsed = created ? formatCompactElapsed(Math.max(0, now() - created)) : null;
  const parts = [`${frame} reviewing`, `critics ${done}/${total}`, ...(elapsed ? [elapsed] : [])];
  return text({ fg: colors.muted, wrapMode: "none" }, [parts.join(" \u00b7 ")]);
}

// "1 P0  ·  ·  2 P3" with each severity in a constant position (its color
// when counted, faint when zero), "clean" when the critic reported nothing,
// "no report" when it ended without any text, each (but "no report")
// followed by the critic session's token total, right-aligned so every
// row's detail block is exactly the same width (SEVERITY_RUN_WIDTH plus the
// token field) no matter how many severities it is showing.
function resultDetail(result, colors) {
  if (!result) return null;
  if (result.noReport) return [text({ fg: colors.muted, wrapMode: "none" }, ["no report".padEnd(SEVERITY_RUN_WIDTH)])];
  const cells = [];
  const hasFindings = SEVERITIES.some((severity) => result.counts[severity] > 0);
  if (!hasFindings) {
    cells.push(text({ fg: colors.success, wrapMode: "none" }, ["clean".padEnd(SEVERITY_RUN_WIDTH)]));
  } else {
    const severityColor = severityColors(colors);
    severityTokens(result.counts).forEach((token, index) => {
      cells.push(
        text(
          {
            fg: token.count > 0 ? severityColor[token.severity] : colors.muted,
            wrapMode: "none",
            marginLeft: index === 0 ? 0 : 1,
          },
          [token.label.padStart(SEVERITY_CELL_WIDTH)],
        ),
      );
    });
  }
  const tokenLabel = formatTokenCount(result.tokens);
  if (tokenLabel) cells.push(text({ fg: colors.muted, wrapMode: "none", marginLeft: 1 }, [tokenLabel.padStart(TOKEN_WIDTH)]));
  return cells;
}

// "total" line: the summed severity run across every critic that has
// counts, plus " · verified N of M" once the review itself is done and its
// own report could be fetched and counted.
function totalsLine(review, colors) {
  if (!review.rawCounts) return null;
  const severityColor = severityColors(colors);
  const cells = [
    text({ fg: colors.muted, wrapMode: "none" }, ["total"]),
    text({ fg: colors.muted, wrapMode: "none" }, [" "]),
  ];
  severityTokens(review.rawCounts).forEach((token, index) => {
    cells.push(
      text(
        { fg: token.count > 0 ? severityColor[token.severity] : colors.muted, wrapMode: "none", marginLeft: index === 0 ? 0 : 1 },
        [token.label],
      ),
    );
  });
  if (review.verifiedSuffix) cells.push(text({ fg: colors.muted, wrapMode: "none" }, [review.verifiedSuffix]));
  return box({ width: "100%", flexDirection: "row" }, cells);
}

// "cycle N/max" once the re-review loop (index.js MAX_REREVIEW_CYCLES) has
// run at least once for this review's parent session, with " · fixes sent
// to session" appended while the latest verdict is NO-SHIP.
function cycleLine(review, colors) {
  if (!review.cycleLabel) return null;
  return box({ width: "100%", flexDirection: "row" }, [
    text({ fg: colors.muted, wrapMode: "none" }, [review.cycleLabel]),
  ]);
}

function glyphOf(isRunning, settled, colors, now) {
  if (isRunning) {
    return { color: colors.success, value: () => `${FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length]} ` };
  }
  return { color: colors.muted, value: `${settled ? GLYPH_DONE : GLYPH_PENDING} ` };
}

function row({ glyph, label, detail, indent = 0, colors, onClick, onPress, hasSelection }) {
  return clickable(
    box({ width: "100%", flexDirection: "row", paddingLeft: indent, shouldFill: true }, [
      text({ fg: glyph.color, width: 2, flexShrink: 0, wrapMode: "none" }, [glyph.value]),
      text({ fg: colors.muted, wrapMode: "none", truncate: true, flexShrink: 1, flexGrow: 1 }, [label]),
      detail ? box({ flexDirection: "row", flexShrink: 0, marginLeft: 1 }, detail) : null,
    ]),
    onClick,
    onPress,
    hasSelection,
  );
}

// onMouseUp keeps the existing click-to-navigate behavior; onMouseDown (when
// given) additionally opens the findings panel, so a host without a panel
// system is left with exactly the old navigate-only behavior.
function clickable(node, onActivate, onPress, hasSelection) {
  setProp(node, "onMouseUp", (event) => {
    if (event?.button !== undefined && event.button !== 0) return;
    if (hasSelection()) return;
    onActivate?.();
  });
  if (onPress) {
    setProp(node, "onMouseDown", (event) => {
      if (event?.button !== undefined && event.button !== 0) return;
      if (hasSelection()) return;
      onPress();
    });
  }
  return node;
}

// ---------------------------------------------------------------- findings panel

// Gives the findings panel keyboard escape/q close and an f fullscreen
// toggle, plus input focus on first render, since the host documents
// that a panel's keymap layers and input modes are active only while
// the panel owns input, and nothing closes a panel unless the plugin
// does. Guarded on both ctx.keymap.layer and panel.focus actually
// existing: a host missing either surface just leaves the mouse hint
// (and, for focus, one extra click) as the only way in.
function setupPanelControls(ctx, panel, target) {
  if (typeof ctx.keymap?.layer === "function") {
    try {
      // `target` must be an OpenTUI renderable, never the PanelInput: the
      // host calls target().once(DESTROYED, ...) to retire the layer, and
      // passing the input object crashed the whole session.panel slot.
      const dispose = ctx.keymap.layer(() => ({
        target: () => target,
        commands: [
          { id: `${PKG_NAME}.panel.close`, bind: "escape", run: () => { panel.close(); } },
          { id: `${PKG_NAME}.panel.close-q`, bind: "q", run: () => { panel.close(); } },
          { id: `${PKG_NAME}.panel.fullscreen`, bind: "f", run: () => { panel.toggleFullscreen(); } },
        ],
      }));
      if (typeof dispose === "function") {
        try {
          onCleanup(dispose);
        } catch {
          // onCleanup needs a reactive owner; harmless to skip without one.
        }
      }
    } catch (error) {
      console.error(`[${PKG_NAME}] findings panel keymap layer registration failed`, error);
    }
  }
  try {
    panel.focus?.();
  } catch {
    // Best-effort: a host without focus() just needs one extra click.
  }
}

// Title on the left, close/fullscreen hints on the right. The hints are
// muted (not actionable-looking text) but clickable, mirroring the
// keyboard bindings setupPanelControls registers: esc or q closes the
// panel, f toggles fullscreen.
function findingsPanelHeader(colors, panel) {
  return box({ width: "100%", flexDirection: "row", justifyContent: "space-between" }, [
    text({ fg: colors.text, wrapMode: "none" }, ["Mighty Reviewer findings"]),
    box({ flexDirection: "row" }, [
      panelHint("close (esc)", colors, () => panel.close()),
      text({ fg: colors.muted, wrapMode: "none" }, ["  "]),
      panelHint("fullscreen (f)", colors, () => panel.toggleFullscreen()),
    ]),
  ]);
}

// A muted, clickable hint (primary mouse button only, mirroring
// clickable's guard).
function panelHint(label, colors, onActivate) {
  return box(
    {
      flexDirection: "row",
      onMouseUp: (event) => {
        if (event?.button !== undefined && event.button !== 0) return;
        onActivate();
      },
    },
    [text({ fg: colors.muted, wrapMode: "none" }, [label])],
  );
}

// "mighty-reviewer.findings" session.panel content: the P0/P1 lines of the
// selected critic (or every critic, for the global command / no selection),
// plus the review's own status.
function renderFindingsPanel(panel, store, selectedCritic, theme) {
  const colors = palette(theme);
  const review = store.readReview(panel.sessionID);
  if (!review) {
    return panelBox(colors, [findingsPanelHeader(colors, panel), text({ fg: colors.muted }, ["No review for this session."])]);
  }

  const criticID = selectedCritic();
  const selected = criticID ? review.critics.find((critic) => critic.id === criticID) : null;
  const targets = selected ? [selected] : review.critics;

  const lines = [];
  for (const critic of targets) {
    const criticLines = critic.result?.lines;
    if (!criticLines) continue;
    for (const severity of ["P0", "P1"]) {
      for (const line of criticLines[severity] ?? []) {
        lines.push(text({ fg: colors.error, wrapMode: "none" }, [`${severity} [${critic.name}] ${line}`]));
      }
    }
  }

  const status = statusOf(review, colors);
  return panelBox(colors, [
    findingsPanelHeader(colors, panel),
    text({ fg: colors.text }, [selected ? `Findings: ${selected.name}` : "Findings: all critics"]),
    text({ fg: status.color, wrapMode: "none" }, [status.label]),
    ...(lines.length ? lines : [text({ fg: colors.muted }, ["No P0/P1 findings."])]),
  ]);
}

function panelBox(colors, children) {
  return box({ width: "100%", flexDirection: "column", padding: 1 }, children);
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
