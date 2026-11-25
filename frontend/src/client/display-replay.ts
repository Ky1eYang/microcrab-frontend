import {
  observeDisplayGraph,
  composeDisplayGraph,
  applyDisplayGraphEnvelope,
} from "./display-graph";
import type {
  Transcript,
  NativeDisplayRecord,
  NativeDisplayBatch,
  DisplayReplayAttempt,
} from "./types";

/** The server scans all archive rows but sends only selected attempts. Missing
 * row numbers inside a certified range are intentional selection, not lost data. */
export function applyDisplayBatch(
  transcript: Transcript,
  sessionId: string,
  page: NativeDisplayBatch,
  compose = true,
): boolean {
  if (
    page.history_lineage !== transcript.historyView?.lineage ||
    ![page.after, page.scanned_through, page.high_water].every(
      Number.isSafeInteger,
    ) ||
    page.after < 0 ||
    page.scanned_through < page.after ||
    page.scanned_through > page.high_water ||
    !Array.isArray(page.records) ||
    page.records.some(
      (record) =>
        !Number.isSafeInteger(record.sequence) ||
        record.sequence <= page.after ||
        record.sequence > page.scanned_through,
    )
  )
    return false;
  const prior = transcript.displayReplay;
  const watermark =
    prior?.sessionId === sessionId && prior.lineage === page.history_lineage
      ? prior.watermark
      : 0;
  if (
    page.graph &&
    !applyDisplayGraphEnvelope(transcript, sessionId, page.graph, false)
  )
    return false;
  replayDisplayObservations(transcript, sessionId, page.records, false);
  if (compose) flushDisplayProjection(transcript);
  const archive = transcript.displayReplay!;
  if (!page.error && page.after <= watermark) {
    archive.watermark = Math.max(archive.watermark, page.scanned_through);
    while (archive.seen[archive.watermark + 1]) archive.watermark++;
  }
  transcript.displayCoverage = page.coverage;
  return true;
}
import { createBlock } from "./create-block";

const reasoningDirty = new WeakMap<Transcript, Set<string>>();

/** At most one partial page per subscribed display scope; replacing a socket
 * subscription discards partial bytes before any new owner can observe them. */
export class DisplayFragments {
  private subscription = "";
  private failure: string | null = null;
  private bytes = 0;
  private readonly maxBytes = 128 * 1024 * 1024;
  takeFailure(): string | null {
    const failure = this.failure;
    this.failure = null;
    return failure;
  }
  private reject(reason: string): null {
    this.pending.clear();
    this.bytes = 0;
    this.failure = reason;
    return null;
  }
  private pending = new Map<
    string,
    {
      id: string;
      next: number;
      parts: string[];
      bytes: number;
      event: string;
      lineage: string;
    }
  >();
  receive(
    event: import("./types").NativeEvent,
  ): import("./types").NativeEvent | null {
    const subscription = `${event.subscription_id}:${event.generation}`;
    if (subscription !== this.subscription) {
      this.subscription = subscription;
      this.pending.clear();
      this.bytes = 0;
      this.failure = null;
    }
    if (event.event !== "display.fragment") return event;
    const fragment = event.data;
    if (
      !fragment ||
      typeof fragment.id !== "string" ||
      typeof fragment.text !== "string" ||
      !Number.isSafeInteger(fragment.index) ||
      fragment.index < 0 ||
      typeof fragment.last !== "boolean" ||
      !["display.batch", "display.settled"].includes(fragment.event)
    )
      return this.reject("Malformed display fragment header");
    const scope = fragment.child_session_id ?? "";
    if (fragment.index === 0) {
      if (this.pending.has(scope))
        return this.reject("Overlapping display fragment pages");
      if (this.pending.size >= 8)
        return this.reject("Display fragment scope limit exceeded");
      this.pending.set(scope, {
        id: fragment.id,
        next: 0,
        parts: [],
        bytes: 0,
        event: fragment.event,
        lineage: fragment.history_lineage,
      });
    }
    const page = this.pending.get(scope);
    if (
      !page ||
      page.id !== fragment.id ||
      page.next !== fragment.index ||
      page.event !== fragment.event ||
      page.lineage !== fragment.history_lineage
    )
      return this.reject("Missing or out-of-order display fragment");
    if (page.parts.length >= 131072)
      return this.reject("Display fragment count limit exceeded");
    const bytes = new TextEncoder().encode(fragment.text).byteLength;
    if (bytes > this.maxBytes - this.bytes)
      return this.reject("Display fragment aggregate exceeds 128 MiB");
    this.bytes += bytes;
    page.bytes += bytes;
    page.parts.push(fragment.text);
    page.next++;
    if (!fragment.last) return null;
    this.pending.delete(scope);
    this.bytes -= page.bytes;
    try {
      const data = JSON.parse(page.parts.join("")) as NativeDisplayBatch;
      if (
        data.history_lineage !== fragment.history_lineage ||
        (data.child_session_id ?? "") !== scope
      )
        return this.reject("Display fragment lineage or child scope mismatch");
      return { ...event, event: fragment.event, data };
    } catch {
      return this.reject("Malformed display fragment JSON");
    }
  }
}

/** Archive records are display evidence only: never replay text/tool deltas into
 * canonical rows. Archive sequence deduplicates catchup/live overlap even when a
 * later live chunk arrives before an earlier replay page. */
export function replayDisplayObservations(
  transcript: Transcript,
  sessionId: string,
  records: NativeDisplayRecord[],
  compose = true,
): void {
  let archive = transcript.displayReplay;
  if (
    !archive ||
    archive.sessionId !== sessionId ||
    archive.lineage !== transcript.historyView?.lineage
  ) {
    archive = {
      sessionId,
      watermark: 0,
      lineage: transcript.historyView?.lineage,
      seen: {},
      attempts: {},
    };
    transcript.displayReplay = archive;
  }
  let dirty = reasoningDirty.get(transcript);
  if (!dirty) reasoningDirty.set(transcript, (dirty = new Set()));
  for (const record of records) {
    if (
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      !record.attempt_id ||
      archive.seen[record.sequence]
    )
      continue;
    archive.seen[record.sequence] = true;
    while (archive.seen[archive.watermark + 1]) archive.watermark++;
    const event = record.event;
    if (!event) continue;
    if (
      observeDisplayGraph(
        transcript,
        sessionId,
        event,
        record.sequence,
        record.attempt_id,
        false,
      )
    )
      continue;
    if (typeof event.call_id !== "string") continue;
    dirty.add(record.attempt_id);
    const priorAttempt = archive.attempts[record.attempt_id];
    const attempt: DisplayReplayAttempt = priorAttempt
      ? {
          ...priorAttempt,
          event: { ...priorAttempt.event },
          chunks: { ...priorAttempt.chunks },
          offsets: priorAttempt.offsets
            ? { ...priorAttempt.offsets }
            : undefined,
        }
      : { event: { ...event }, chunks: {}, firstSequence: record.sequence };
    archive.attempts[record.attempt_id] = attempt;
    // An attempt identity cannot change its producer coordinates during replay.
    if (
      ["operation_id", "call_id", "epoch", "turn", "round"].some(
        (key) => attempt.event[key] !== event[key],
      )
    )
      continue;
    attempt.firstSequence = Math.min(attempt.firstSequence, record.sequence);
    if (event.phase === "reasoning_delta" && typeof event.text === "string") {
      attempt.chunks[record.sequence] = event.text;
      if (Number.isSafeInteger(event.stream_offset))
        (attempt.offsets ??= {})[record.sequence] =
          event.stream_offset as number;
    }
    if (
      (event.phase === "validated" || event.phase === "invalidated") &&
      record.sequence > (attempt.terminalSequence ?? 0)
    ) {
      attempt.terminal = event.phase;
      if (event.phase === "invalidated") {
        attempt.event.reason = event.reason;
        attempt.event.detail = event.detail;
      }
      attempt.terminalSequence = record.sequence;
      if (Number.isSafeInteger(event.reasoning_bytes))
        attempt.reasoningBytes = event.reasoning_bytes as number;
    }
  }
  if (compose) flushDisplayProjection(transcript);
}

/** Exact publication barrier after ordered ingestion of complete pages. */
export function flushDisplayProjection(transcript: Transcript): void {
  composeDisplayReasoning(transcript);
  composeDisplayGraph(transcript);
}

export function composeDisplayReasoning(transcript: Transcript) {
  const archive = transcript.displayReplay;
  if (!archive) return;
  const dirty = reasoningDirty.get(transcript);
  const attempts = dirty
    ? [...dirty].flatMap((id) =>
        archive.attempts[id] ? [[id, archive.attempts[id]] as const] : [],
      )
    : Object.entries(archive.attempts);
  reasoningDirty.set(transcript, new Set());
  for (const [attemptId, attempt] of attempts.sort(
    ([, a], [, b]) => a.firstSequence - b.firstSequence,
  )) {
    const text = Object.entries(attempt.chunks)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, body]) => body)
      .join("");
    if (!text) continue;
    let covered = 0;
    let contiguous = true;
    for (const [sequence, chunk] of Object.entries(attempt.chunks).sort(
      ([a], [b]) => Number(a) - Number(b),
    )) {
      const offset = attempt.offsets?.[Number(sequence)];
      if (offset != null && offset !== covered) contiguous = false;
      covered += new TextEncoder().encode(chunk).byteLength;
    }
    const complete =
      contiguous &&
      (attempt.reasoningBytes == null || attempt.reasoningBytes === covered);
    const event = attempt.event;
    const archiveId = `display:${archive.sessionId}:${attemptId}:reasoning`;
    const key = JSON.stringify([
      archive.sessionId,
      event.operation_id ?? null,
      event.epoch,
      event.turn,
      event.round,
      event.call_id,
    ]);
    let block =
      transcript.blocks.find(
        (item) =>
          item.displayAttemptId === attemptId &&
          item.sessionId === archive.sessionId,
      ) ??
      transcript.blocks.find(
        (item) =>
          item.kind === "reasoning" &&
          item.sessionId === archive.sessionId &&
          !item.displayAttemptId &&
          item.preview?.key === key,
      );
    // Archive sequence certifies this exact producer, not a new visual item.
    // Keep its local render identity and witnessed suffix while replay pages are
    // still catching up. Neither is promoted into canonical/model-facing data.
    const id = block?.id ?? archiveId;
    const observedText = block?.payload.text;
    const displayText =
      observedText &&
      contiguous &&
      !(attempt.terminal && complete) &&
      observedText.startsWith(text)
        ? observedText
        : text;
    const positioned = [event.epoch, event.turn, event.round].every(
      Number.isSafeInteger,
    );
    const position = positioned
      ? {
          epoch: event.epoch,
          turn: event.turn!,
          round: event.round!,
        }
      : null;
    // Replace only the exact live witness. Never infer provider call identity
    // from a canonical assistant text row or equal request-body hash.
    transcript.blocks = transcript.blocks.filter(
      (item) =>
        item.id === id ||
        item.kind !== "reasoning" ||
        item.sessionId !== archive.sessionId ||
        (item.displayAttemptId != null &&
          item.displayAttemptId !== attemptId) ||
        item.preview?.key !== key,
    );
    if (!block)
      block = createBlock(
        archive.sessionId,
        id,
        `${event.call_id}:reasoning`,
        "reasoning",
        "assistant",
      );
    block.id = id;
    block.payload = {
      ...block.payload,
      text: displayText,
      stopReason:
        attempt.terminal === "invalidated"
          ? { reason: event.reason, detail: event.detail }
          : undefined,
    };
    block.position = position;
    const user = position
      ? [...transcript.blocks]
          .reverse()
          .find(
            (item) =>
              item.role === "user" &&
              item.sessionId === archive.sessionId &&
              item.position?.epoch === position.epoch &&
              item.position?.turn === position.turn,
          )
      : undefined;
    block.preview = {
      key,
      operationId: event.operation_id,
      callId: event.call_id,
      ...(position ?? {}),
      userMessageId: user?.messageId ?? "",
      assistantOrdinal: 0,
    };
    block.responseAdmission = "preview";
    block.displayAttemptId = attemptId;
    block.callId = event.call_id;
    block.validated = attempt.terminal === "validated" && complete;
    block.temporary = false;
    block.stream =
      attempt.terminal === "validated" && complete
        ? "complete"
        : attempt.terminal != null ||
            !contiguous ||
            !transcript.connected ||
            transcript.sessionStatus !== "busy"
          ? "stopped"
          : "streaming";
    // An existing display witness owns its first visible position. Archive
    // replay and terminal binding update content/authority, never its placement.
    // Snapshot reconciliation already retained that witness at its neighbors.
    if (transcript.blocks.includes(block)) continue;
    // A newly replayed historical block needs a canonical/position anchor.
    // A new live block has no such anchor and appends at first content arrival.
    let insertion = -1;
    if (insertion < 0 && position)
      insertion = transcript.blocks.findIndex((item) => {
        if (item.sessionId !== archive.sessionId || !item.position)
          return false;
        const other = item.position;
        return (
          other.epoch > position.epoch ||
          (other.epoch === position.epoch &&
            (other.turn > position.turn ||
              (other.turn === position.turn &&
                (other.round > position.round ||
                  (other.round === position.round &&
                    item.role === "assistant" &&
                    !item.displayAttemptId)))))
        );
      });
    if (insertion < 0) transcript.blocks.push(block);
    else transcript.blocks.splice(insertion, 0, block);
  }
}
