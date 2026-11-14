import type { NativeMessage, NativeSnapshot } from "./types";

interface LoadedHistory {
  session: { id: string };
  history?: NativeSnapshot["history"];
  messages: NativeMessage[];
  messages_truncated?: boolean;
  next_cursor?: number | null;
  history_view?: NativeSnapshot["history_view"];
  history_gap?: boolean;
}
export interface HistoryPage {
  items: NativeMessage[];
  history_view?: NativeSnapshot["history_view"];
  truncated: boolean;
  next_cursor: number | null;
}

export function coherentHistoryRange(
  value: Pick<LoadedHistory, "messages" | "history_view">,
): boolean {
  const view = value.history_view;
  return (
    !!view &&
    Number.isSafeInteger(view.start_cursor) &&
    Number.isSafeInteger(view.end_cursor) &&
    view.start_cursor >= 0 &&
    view.end_cursor >= view.start_cursor &&
    view.end_cursor - view.start_cursor === value.messages.length
  );
}

/** A lineage is selected-history evidence from the Server, not a guessed branch. */
export function sameSelectedHistory(
  left: Pick<LoadedHistory, "session" | "history" | "history_view">,
  right: Pick<LoadedHistory, "session" | "history" | "history_view">,
): boolean {
  if (left.session.id !== right.session.id) return false;
  if (left.history_view && right.history_view)
    return (
      left.history_view.lineage === right.history_view.lineage &&
      left.history_view.epoch === right.history_view.epoch
    );
  return JSON.stringify(left.history) === JSON.stringify(right.history);
}

function authoritative(
  message: NativeMessage,
  previous?: NativeMessage,
): NativeMessage {
  // IDs are content-addressed. A deliberately abbreviated projection cannot erase
  // a previously received full body; current status/position metadata still wins.
  if (
    previous &&
    !message.client_invocation_id &&
    !previous.client_invocation_id &&
    !previous.content_truncated &&
    message.content_truncated
  )
    return {
      ...message,
      text: previous.text,
      parts: previous.parts,
      tool_calls: previous.tool_calls,
      content_truncated: false,
    };
  return message;
}

/** A page contributes history facts only, never a second source of Session state.
 * Missing/conflicting witnesses cannot be repaired by inventing cursor extents.
 */
export function mergeHistoryPage<T extends LoadedHistory>(
  previous: T,
  page: HistoryPage,
): T | null {
  const before = previous.history_view;
  const next = page.history_view;
  if (
    !before ||
    !next ||
    before.lineage !== next.lineage ||
    before.epoch !== next.epoch ||
    !coherentHistoryRange(previous) ||
    !coherentHistoryRange({ messages: page.items, history_view: next }) ||
    next.start_cursor > before.end_cursor ||
    before.start_cursor > next.end_cursor
  )
    return null;
  const start = Math.max(before.start_cursor, next.start_cursor);
  const end = Math.min(before.end_cursor, next.end_cursor);
  for (let cursor = start; cursor < end; cursor++)
    if (
      previous.messages[cursor - before.start_cursor].id !==
      page.items[cursor - next.start_cursor].id
    )
      return null;
  return retainLoadedMessages(
    {
      ...previous,
      messages: page.items,
      messages_truncated: page.truncated,
      next_cursor: page.next_cursor,
      history_view: next,
      history_gap: false,
    },
    previous,
  );
}

/** Retain every received canonical prefix, not just explicitly fetched pages.
 * Ordered overlap and the runtime selected-lineage witness prove append continuity.
 * An unbridged gap keeps the old view visibly incomplete rather than splicing ends.
 */
export function retainLoadedMessages<T extends LoadedHistory>(
  incoming: T,
  previous?: LoadedHistory,
): T {
  if (!previous || !sameSelectedHistory(previous, incoming)) return incoming;
  const old = new Map(
    previous.messages.map((message) => [message.id, message]),
  );
  const messages = incoming.messages.map((message) =>
    authoritative(message, old.get(message.id)),
  );
  incoming = { ...incoming, messages };
  if (previous.history_view && incoming.history_view) {
    const before = previous.history_view;
    const next = incoming.history_view;
    if (
      coherentHistoryRange(previous) &&
      coherentHistoryRange({ messages, history_view: next })
    ) {
      const oldStart = before.start_cursor;
      const oldEnd = before.end_cursor;
      const newStart = next.start_cursor;
      const newEnd = next.end_cursor;
      const overlapStart = Math.max(oldStart, newStart);
      const overlapEnd = Math.min(oldEnd, newEnd);
      // A covered range cannot revoke previously received content outside it.
      let agrees = true;
      for (let cursor = overlapStart; cursor < overlapEnd; cursor++) {
        if (
          previous.messages[cursor - oldStart].id !==
          messages[cursor - newStart].id
        ) {
          agrees = false;
          break;
        }
      }
      if (agrees && newStart <= oldEnd && oldStart <= newEnd) {
        const start = Math.min(oldStart, newStart);
        const end = Math.max(oldEnd, newEnd);
        const combined = Array.from({ length: end - start }, (_, index) => {
          const cursor = start + index;
          return cursor >= newStart && cursor < newEnd
            ? messages[cursor - newStart]
            : previous.messages[cursor - oldStart];
        });
        const earlier =
          newStart < oldStart ||
          (newStart === oldStart && !incoming.messages_truncated)
            ? incoming
            : previous;
        // Counts belong to the full coherent selected Context, not page extent.
        // Preserve summaries for already loaded Turns absent from the new tail.
        const newer =
          next.message_count >= before.message_count ? next : before;
        const older = newer === next ? before : next;
        const turns = new Map(
          older.turns.map((turn) => [
            JSON.stringify([turn.epoch, turn.turn]),
            turn,
          ]),
        );
        for (const turn of newer.turns) {
          const key = JSON.stringify([turn.epoch, turn.turn]);
          const prior = turns.get(key);
          const oldSequence = prior?.usage?.audit_sequence;
          const newSequence = turn.usage?.audit_sequence;
          // Usage may commit without changing message_count. A delayed page must
          // not replace newer audit evidence; fresh explicit unknowns still win.
          const olderUsage =
            next.message_count === before.message_count &&
            typeof oldSequence === "number" &&
            Number.isSafeInteger(oldSequence) &&
            oldSequence >= 0 &&
            typeof newSequence === "number" &&
            Number.isSafeInteger(newSequence) &&
            newSequence >= 0 &&
            newSequence < oldSequence;
          turns.set(key, olderUsage ? { ...turn, usage: prior?.usage } : turn);
        }
        return {
          ...incoming,
          messages: combined,
          messages_truncated: earlier.messages_truncated,
          next_cursor: earlier.next_cursor,
          history_gap: false,
          history_view: {
            ...newer,
            start_cursor: start,
            end_cursor: end,
            turns: [...turns.values()],
          },
        };
      }
      const keepPrevious = (historyGap: LoadedHistory["history_gap"]): T => ({
        ...incoming,
        messages: previous.messages,
        messages_truncated: previous.messages_truncated,
        next_cursor: previous.next_cursor,
        history_gap: historyGap,
        history_view: { ...before },
      });
      if (newEnd < oldStart && agrees) return keepPrevious(previous.history_gap);
      if (newStart > oldEnd && agrees) return keepPrevious(true);
      // Conflicting overlap is not append proof; never splice its identities.
    }
    return incoming;
  }
  if (
    !incoming.messages_truncated ||
    !messages.length ||
    !previous.messages.length
  )
    return incoming;
  const start = previous.messages.findIndex(
    (message) => message.id === messages[0].id,
  );
  if (start < 0) {
    if (
      previous.history_view &&
      incoming.history_view &&
      previous.history_view.end_cursor === incoming.history_view.start_cursor
    )
      return {
        ...incoming,
        messages: [...previous.messages, ...messages],
        messages_truncated: previous.messages_truncated,
        next_cursor: previous.next_cursor,
        history_gap: false,
        history_view: {
          ...incoming.history_view,
          start_cursor: previous.history_view.start_cursor,
        },
      };
    if (
      previous.history_view &&
      incoming.history_view &&
      previous.history_view.end_cursor <= incoming.history_view.start_cursor
    )
      return {
        ...incoming,
        messages: previous.messages,
        messages_truncated: previous.messages_truncated,
        next_cursor: previous.next_cursor,
        history_gap: true,
        history_view: {
          ...incoming.history_view,
          start_cursor: previous.history_view.start_cursor,
          end_cursor: previous.history_view.end_cursor,
        },
      };
    return incoming;
  }
  const overlap = Math.min(previous.messages.length - start, messages.length);
  for (let index = 0; index < overlap; index++)
    if (previous.messages[start + index].id !== messages[index].id)
      return incoming;
  return {
    ...incoming,
    messages: [...previous.messages.slice(0, start), ...messages],
    messages_truncated: previous.messages_truncated,
    next_cursor: previous.next_cursor,
    history_gap: false,
    ...(incoming.history_view && previous.history_view
      ? {
          history_view: {
            ...incoming.history_view,
            start_cursor: previous.history_view.start_cursor,
          },
        }
      : {}),
  };
}
