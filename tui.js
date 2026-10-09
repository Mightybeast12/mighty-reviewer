/**
 * OpenCode 2 TUI companion for mighty-reviewer.
 *
 * Server plugins cannot show toasts on OpenCode 2, so the server side queues
 * each notice as a synthetic inbox item on the session it concerns (see
 * v2.js). The item is admitted immediately (session.inbox.enqueued) and only
 * enters the conversation on the next turn, so this module toasts on the
 * enqueue event to restore the v1 toast timing.
 */

import { PKG_NAME } from "./internals.js";

const NOTICE_METADATA_KEY = "mightyReviewer";

const plugin = {
  id: PKG_NAME,
  setup(ctx) {
    const controller = new AbortController();
    const watcher = (async () => {
      try {
        for await (const raw of ctx.client.event.subscribe({ signal: controller.signal })) {
          const notice = noticeFrom(raw);
          if (!notice) continue;
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
    return async () => {
      controller.abort();
      await watcher;
    };
  },
};

function noticeFrom(raw) {
  const envelope = raw?.payload ?? raw;
  const source = envelope?.type === "sync" && envelope.syncEvent ? envelope.syncEvent : envelope;
  if (source?.type !== "session.inbox.enqueued") return null;
  const item = source.data?.item;
  if (item?.type !== "synthetic") return null;
  const notice = item.payload?.metadata?.[NOTICE_METADATA_KEY];
  if (!notice || typeof notice.message !== "string") return null;
  return { message: notice.message, variant: notice.variant ?? "info", sessionID: source.data.sessionID };
}

export default plugin;
