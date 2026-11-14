import type {
  NativeExecution,
  NativeExecutionContentPage,
  NativeExecutionOutputPage,
} from "../client/types";
import { t } from "../i18n";

export const pendingExecution = (execution: NativeExecution) =>
  ["running", "waiting", "cancelling"].includes(execution.status);

/** A missing start stays unknown; terminal time never grows with the browser clock. */
export function executionElapsed(
  execution: NativeExecution,
  now = Date.now(),
): number | null {
  if (
    typeof execution.elapsed_ms === "number" &&
    Number.isFinite(execution.elapsed_ms) &&
    execution.elapsed_ms >= 0
  )
    return execution.elapsed_ms;
  const start = execution.started_at_unix_ms;
  return pendingExecution(execution) &&
    typeof start === "number" &&
    Number.isFinite(start) &&
    start >= 0
    ? Math.max(0, now - start)
    : null;
}
export const executionStatus = (execution: NativeExecution) =>
  t(
    pendingExecution(execution) && execution.elapsed_ms != null
      ? "execution.finishing"
      : `execution.status.${execution.status}`,
  );

const uint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const invalid = () => new Error(t("execution.invalidPage"));
const changed = () => new Error(t("execution.sourceChanged"));
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
type Identity = Pick<
  NativeExecution,
  "execution_id" | "session_id" | "call_id"
>;
type ContentField = "arguments" | "result";

/** The source hash fences paged reads from travel, cleanup and result normalization. */
export async function readCompleteExecutionContent(
  read: (cursor: number) => Promise<NativeExecutionContentPage>,
  identity: Identity,
  field: ContentField,
  active = () => true,
): Promise<{ available: boolean; content: string }> {
  let cursor = 0;
  let end: number | undefined;
  let hash: string | null | undefined;
  const parts: string[] = [];
  do {
    if (!active()) throw changed();
    const page = await read(cursor);
    if (!active()) throw changed();
    if (
      !page ||
      page.execution_id !== identity.execution_id ||
      page.session_id !== identity.session_id ||
      page.call_id !== identity.call_id ||
      page.field !== field ||
      typeof page.content !== "string" ||
      !uint(page.cursor) ||
      page.cursor !== cursor ||
      !uint(page.next_cursor) ||
      page.next_cursor < cursor ||
      !uint(page.end_cursor) ||
      page.end_cursor < page.next_cursor ||
      !uint(page.revision) ||
      typeof page.available !== "boolean" ||
      encoder.encode(page.content).length !== page.next_cursor - cursor ||
      (page.available
        ? typeof page.source_hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(page.source_hash)
        : page.source_hash != null)
    )
      throw invalid();
    if (
      end !== undefined &&
      (page.end_cursor !== end || page.source_hash !== hash)
    )
      throw changed();
    if (!page.available) {
      if (
        cursor !== 0 ||
        page.content ||
        page.end_cursor !== 0 ||
        page.next_cursor !== 0
      )
        throw invalid();
      return { available: false, content: "" };
    }
    end = page.end_cursor;
    hash = page.source_hash;
    if (page.next_cursor === cursor && cursor < end) throw invalid();
    parts.push(page.content);
    cursor = page.next_cursor;
  } while (cursor < end!);
  return { available: true, content: parts.join("") };
}

/** A ring read clamps only an unavailable prefix. Chunks certify every UTF-8 byte. */
export function validateOutputPage(
  page: NativeExecutionOutputPage,
  executionId: number,
  cursor: number,
): void {
  if (
    !page ||
    page.execution_id !== executionId ||
    !Array.isArray(page.chunks) ||
    !uint(page.start_cursor) ||
    !uint(page.cursor) ||
    page.cursor !== Math.max(cursor, page.start_cursor) ||
    !uint(page.next_cursor) ||
    page.next_cursor < page.cursor ||
    !uint(page.end_cursor) ||
    page.end_cursor < page.next_cursor ||
    !uint(page.revision) ||
    typeof page.closed !== "boolean"
  )
    throw invalid();
  let expected = page.cursor;
  for (const chunk of page.chunks) {
    if (
      !chunk ||
      typeof chunk.content !== "string" ||
      (chunk.channel !== null && typeof chunk.channel !== "string") ||
      !uint(chunk.cursor) ||
      chunk.cursor !== expected ||
      !uint(chunk.next_cursor) ||
      chunk.next_cursor <= chunk.cursor ||
      chunk.next_cursor > page.next_cursor ||
      encoder.encode(chunk.content).length !== chunk.next_cursor - chunk.cursor
    )
      throw invalid();
    expected = chunk.next_cursor;
  }
  if (
    expected !== page.next_cursor ||
    (page.next_cursor === page.cursor && page.cursor < page.end_cursor)
  )
    throw invalid();
}

export type RetainedOutput = {
  chunks: NativeExecutionOutputPage["chunks"];
  endCursor: number;
  startCursor: number;
  closed: boolean;
};
/** Read a captured end without chasing a live tail. Retention gaps remain explicit. */
export async function readCompleteRetainedOutput(
  read: (cursor: number) => Promise<NativeExecutionOutputPage>,
  identity: Identity,
  active = () => true,
): Promise<RetainedOutput> {
  let cursor = 0;
  let end: number | undefined;
  const result: RetainedOutput = {
    chunks: [],
    endCursor: 0,
    startCursor: 0,
    closed: false,
  };
  do {
    if (!active()) throw changed();
    const page = await read(cursor);
    if (!active()) throw changed();
    validateOutputPage(page, identity.execution_id, cursor);
    if (end === undefined) end = page.end_cursor;
    if (page.end_cursor < end) throw changed();
    for (const chunk of page.chunks) {
      if (chunk.cursor >= end) continue;
      const next = Math.min(chunk.next_cursor, end);
      let content: string;
      try {
        content = decoder.decode(
          encoder.encode(chunk.content).slice(0, next - chunk.cursor),
        );
      } catch {
        throw changed();
      }
      const previous = result.chunks.at(-1);
      if (
        previous &&
        previous.channel === chunk.channel &&
        previous.next_cursor === chunk.cursor
      ) {
        previous.content += content;
        previous.next_cursor = next;
      } else result.chunks.push({ ...chunk, content, next_cursor: next });
    }
    result.endCursor = end;
    result.startCursor = Math.max(
      result.startCursor,
      Math.min(page.start_cursor, end),
    );
    result.closed = page.closed;
    cursor = page.next_cursor;
  } while (cursor < end!);
  return result;
}
