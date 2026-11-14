import type { NativeMessage, NativeSnapshot } from "./types";

/**
 * Incremental session protocol (v0.1.14). The server never pushes a whole
 * session view; the browser materializes it from:
 * - `session.meta`: top-level field patch;
 * - `blocks.page`: the canonical window, replacing rows;
 * - `blocks.upsert`: authoritative id order plus only the changed rows;
 * - `history.reset`: the selected lineage changed (a page follows);
 * - `statistics.updated`.
 * Unchanged rows keep their object identity, so projection can share them.
 */
export interface BlocksEvent {
  reason?: string;
  ids?: string[];
  messages: NativeMessage[];
  messages_truncated?: boolean;
  next_cursor?: number | null;
  history_view?: NativeSnapshot["history_view"];
}

export interface Materialized {
  view: NativeSnapshot;
  /** An upsert named a row whose body this client never received. */
  incomplete: boolean;
  /** Whether the settled view changed. */
  changed: boolean;
}

export function materialize(
  view: NativeSnapshot,
  event: string,
  data: unknown,
): Materialized {
  if (event === "session.meta") {
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { view, incomplete: true, changed: false };
    const patch = data as Partial<NativeSnapshot>;
    if (
      Object.hasOwn(patch, "messages") ||
      (Object.hasOwn(patch, "session") && patch.session?.id !== view.session.id)
    )
      return { view, incomplete: true, changed: false };
    return { view: { ...view, ...patch }, incomplete: false, changed: true };
  }
  if (event === "statistics.updated")
    return {
      view: { ...view, statistics: data as NativeSnapshot["statistics"] },
      incomplete: false,
      changed: true,
    };
  if (event === "blocks.page" || event === "blocks.upsert") {
    const blocks = data as BlocksEvent | null;
    if (
      !blocks ||
      !Array.isArray(blocks.messages) ||
      blocks.messages.some(
        (row) => !row || typeof row.id !== "string" || !row.id,
      ) ||
      new Set(blocks.messages.map((row) => row.id)).size !==
        blocks.messages.length ||
      (event === "blocks.upsert" &&
        (!Array.isArray(blocks.ids) ||
          blocks.ids.some((id) => typeof id !== "string" || !id) ||
          new Set(blocks.ids).size !== blocks.ids.length))
    )
      return { view, incomplete: true, changed: false };
    let messages: NativeMessage[];
    let incomplete = false;
    if (event === "blocks.page") messages = blocks.messages ?? [];
    else {
      const known = new Map<string, NativeMessage>();
      for (const row of view.messages ?? []) known.set(row.id, row);
      for (const row of blocks.messages ?? []) known.set(row.id, row);
      messages = [];
      for (const id of blocks.ids ?? []) {
        const row = known.get(id);
        if (row) messages.push(row);
        else incomplete = true;
      }
    }
    return {
      view: {
        ...view,
        messages,
        messages_truncated: blocks.messages_truncated,
        next_cursor: blocks.next_cursor,
        history_view: blocks.history_view,
      },
      incomplete,
      changed: true,
    };
  }
  return { view, incomplete: false, changed: false };
}
