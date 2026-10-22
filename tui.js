/**
 * OpenCode 2 TUI companion for mighty-reviewer.
 *
 * Server plugins cannot show toasts on OpenCode 2, so the server side queues
 * each notice as a synthetic inbox item on the session it concerns (see
 * v2.js). The item is admitted immediately (session.inbox.enqueued) and only
 * enters the conversation on the next turn, so this module toasts on the
 * enqueue event to restore the v1 toast timing (noticeFrom below).
 *
 * That alone still left a running review silent until the next notice was
 * queued: the phase toaster below watches the review session's title
 * directly (session.created / session.renamed, the same events the sidebar
 * panel tracks) and toasts on phase transitions the title already carries,
 * independent of whether a synthetic notice was ever posted for that phase.
 * index.js stops posting synthetic notices for pure progress phases on v2
 * (see v2.js and index.js's showToast), since the phase toaster now covers
 * them; where a notice is still posted for a phase the phase toaster also
 * covers (started, SHIP, NO-SHIP, timed out), isDuplicateOfPhaseToast drops
 * the redundant toast so the user sees it once, not twice.
 *
 * It also mounts the sidebar review panel and the prompt footer status line
 * (sidebar.js) when the host offers slots and session data. That module
 * imports the host's @opentui/solid and solid-js, so it is loaded lazily and
 * a failure there never stops toasts.
 */

import {
  PKG_NAME,
  METADATA_KEY,
  isReviewSession,
  phaseOf,
  formatCompactElapsed,
  extractAssistantReport,
  topVerifiedFinding,
} from "./internals.js";

const CRITICS_PHASE = /^critics (\d+)\/(\d+)$/;
// Of the critics-phase transitions, only the ones worth a toast: roughly
// the halfway point and completion (the latter coinciding with the move to
// "verifying"), so a 4-critic review produces two progress toasts, not a
// toast per critic.
const CRITICS_HALF_DONE = 2;

const plugin = {
  id: PKG_NAME,
  async setup(ctx) {
    const controller = new AbortController();
    const toaster = createPhaseToaster(ctx);
    const watcher = (async () => {
      try {
        for await (const raw of ctx.client.event.subscribe({ signal: controller.signal })) {
          const source = unwrapEvent(raw);
          if (!source) continue;
          await toaster.handleEvent(source);
          const notice = noticeFrom(source);
          if (!notice || toaster.isDuplicateOfPhaseToast(notice)) continue;
          ctx.ui.toast.show({
            title: PKG_NAME,
            message: notice.message,
            variant: notice.variant,
            sessionID: notice.sessionID,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error(`[${PKG_NAME}] tui event bridge failed`, error);
      }
    })();
    const disposeSidebar = await mountSidebar(ctx);
    return async () => {
      disposeSidebar?.();
      controller.abort();
      await watcher;
    };
  },
};

async function mountSidebar(ctx) {
  if (typeof ctx.ui?.slot !== "function" || typeof ctx.data?.session?.list !== "function") return undefined;
  try {
    const sidebar = await import("./sidebar.js");
    return sidebar.mountSidebar(ctx);
  } catch (error) {
    console.error(`[${PKG_NAME}] sidebar panel unavailable`, error);
    return undefined;
  }
}

// raw SSE-style events from ctx.client.event.subscribe arrive either bare or
// wrapped as a sync envelope; unwrap once so every handler below reads the
// same shape.
function unwrapEvent(raw) {
  const envelope = raw?.payload ?? raw;
  return envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
}

function noticeFrom(source) {
  if (source?.type !== "session.inbox.enqueued") return null;
  const item = source.data?.item;
  if (item?.type !== "synthetic") return null;
  const notice = item.payload?.metadata?.[METADATA_KEY];
  if (!notice || typeof notice.message !== "string") return null;
  return { message: notice.message, variant: notice.variant ?? "info", sessionID: source.data.sessionID };
}

// A notice's message text mapped to the phase-toast category it would
// duplicate, so isDuplicateOfPhaseToast can tell "SHIP: background review
// passed." apart from, say, a NO-SHIP cycle-cap notice for a DIFFERENT
// review. Returns null for notices the phase toaster has no opinion on
// (diff-too-large, update checks, nudges, extensions, ...), which are never
// deduped.
function categorizeNotice(message) {
  if (/^(?:Code changed, running background review|Review requested, running in background)/.test(message)) {
    return "started";
  }
  if (message.includes("mechanical gates done, critics running")) return "gates-done";
  if (message.includes("critics done, verifying findings")) return "critics-done";
  if (message.startsWith("SHIP:")) return "ship";
  if (message.startsWith("NO-SHIP:")) return "no-ship";
  if (message.includes("timed out")) return "timed-out";
  return null;
}

/**
 * Tracks review sessions by title transition (the same titles the sidebar
 * panel reads, see sidebar.js's readReview) and toasts once per transition
 * per review: started, gates done / critics running, critics N/4 done (at
 * the halfway point and at completion), and the terminal SHIP / NO-SHIP /
 * timed out phases. Independent of the synthetic-notice bridge above: these
 * toasts fire straight off session.created / session.renamed events, so
 * they show up live even though a synthetic notice for the same moment
 * would sit queued until the next turn.
 */
function createPhaseToaster(ctx) {
  // reviewID -> { parentID, startedAt, criticsTotal, lastCategory,
  // toastedCriticsHalf, toastedCriticsDone }. lastCategory also drives
  // isDuplicateOfPhaseToast: the last phase this review was toasted for.
  const reviews = new Map();

  function ensure(reviewID) {
    let review = reviews.get(reviewID);
    if (!review) {
      review = { parentID: null, startedAt: Date.now(), criticsTotal: 0, lastCategory: null };
      reviews.set(reviewID, review);
    }
    return review;
  }

  function setParent(reviewID, parentID) {
    if (!parentID) return;
    ensure(reviewID).parentID = parentID;
  }

  function targetSessionID(reviewID) {
    return reviews.get(reviewID)?.parentID ?? reviewID;
  }

  function toast(reviewID, category, message, variant) {
    const review = ensure(reviewID);
    review.lastCategory = category;
    ctx.ui.toast.show({ title: PKG_NAME, message, variant, sessionID: targetSessionID(reviewID) });
  }

  function elapsedSince(reviewID) {
    const startedAt = reviews.get(reviewID)?.startedAt ?? Date.now();
    return formatCompactElapsed(Date.now() - startedAt);
  }

  async function noShipCounts(reviewID) {
    try {
      const response = await ctx.client.message.list({ sessionID: reviewID, limit: 10, order: "desc" });
      const messages = Array.isArray(response) ? response : (response?.data ?? []);
      const report = extractAssistantReport(messages, "desc");
      return report ? topVerifiedFinding(report)?.counts ?? null : null;
    } catch {
      return null;
    }
  }

  async function handleTitle(reviewID, title) {
    if (!isReviewSession({ title })) return;
    const review = ensure(reviewID);
    const phase = phaseOf(title);

    if (phase === "starting") {
      if (!review.toastedStarted) {
        review.toastedStarted = true;
        toast(reviewID, "started", "Review started.", "info");
      }
      return;
    }

    const criticsMatch = CRITICS_PHASE.exec(phase);
    if (criticsMatch) {
      const done = Number(criticsMatch[1]);
      const total = Number(criticsMatch[2]);
      review.criticsTotal = total;
      if (!review.toastedGatesDone) {
        review.toastedGatesDone = true;
        toast(reviewID, "gates-done", "Gates done, critics running.", "info");
      }
      if (done === CRITICS_HALF_DONE && !review.toastedCriticsHalf) {
        review.toastedCriticsHalf = true;
        toast(reviewID, "critics-half", `Critics ${done}/${total} done.`, "info");
      }
      return;
    }

    if (phase === "verifying") {
      if (!review.toastedCriticsDone) {
        review.toastedCriticsDone = true;
        const total = review.criticsTotal || 4;
        toast(reviewID, "critics-done", `Critics ${total}/${total} done.`, "info");
      }
      return;
    }

    if (phase === "SHIP") {
      if (!review.toastedTerminal) {
        review.toastedTerminal = true;
        toast(reviewID, "ship", `SHIP in ${elapsedSince(reviewID)}.`, "success");
      }
      return;
    }

    if (phase === "NO-SHIP") {
      if (!review.toastedTerminal) {
        review.toastedTerminal = true;
        const counts = await noShipCounts(reviewID);
        const breakdown = counts ? `${counts.P0} P0, ${counts.P1} P1` : "findings";
        toast(reviewID, "no-ship", `NO-SHIP: ${breakdown} in ${elapsedSince(reviewID)}.`, "error");
      }
      return;
    }

    if (phase === "timed out" && !review.toastedTerminal) {
      review.toastedTerminal = true;
      toast(reviewID, "timed-out", "Timed out.", "warning");
    }
  }

  async function handleEvent(source) {
    const type = source?.type;
    if (type === "session.deleted") {
      const id = source.data?.sessionID;
      if (id) reviews.delete(id);
      return;
    }
    if (type !== "session.created" && type !== "session.renamed" && type !== "session.metadata.updated") return;
    const info = source.data ?? {};
    const id = info.sessionID;
    if (!id) return;
    const metaParentID = info.metadata?.[METADATA_KEY]?.parentID;
    if (metaParentID) setParent(id, metaParentID);
    if (type === "session.metadata.updated") return; // parentID backfill only, no title here
    if (typeof info.title === "string") await handleTitle(id, info.title);
  }

  function isDuplicateOfPhaseToast(notice) {
    const category = categorizeNotice(notice.message);
    if (!category) return false;
    for (const review of reviews.values()) {
      if (review.parentID === notice.sessionID && review.lastCategory === category) return true;
    }
    return false;
  }

  return { handleEvent, isDuplicateOfPhaseToast };
}

export default plugin;
