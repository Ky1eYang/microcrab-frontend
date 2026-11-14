import type {
  NativeDisplayRecord,
  NativeMessage,
  NativeSnapshot,
  Transcript,
} from "../src/client/types";
import { applyEvent, applySnapshot } from "../src/client/projector";
import { nativeSnapshot } from "./native-fixture";

// Focused protocol inputs use the agreed producer fields. The shared recorder
// fixture separately checks that native production emits this same wire.
export const producer = {
  operation_id: "turn",
  call_id: "provider",
  epoch: 0,
  turn: 1,
  round: 1,
};
export function snapshot(messages: NativeMessage[] = []): NativeSnapshot {
  const view = structuredClone(nativeSnapshot);
  view.session.status = "running";
  view.messages = messages;
  view.history_view = {
    lineage: "selected",
    epoch: 0,
    message_count: messages.length,
    start_cursor: 0,
    end_cursor: messages.length,
    turns: [],
  };
  return view;
}
export function message(
  id: string,
  role: NativeMessage["role"],
  text: string,
  extra = {},
): NativeMessage {
  return {
    id,
    role,
    text,
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: 1, round: role === "user" ? 0 : 1 },
    canonical_source_id: `source:${id}`,
    ...extra,
  };
}
export function chunk(
  sequence: number,
  blockId: string,
  parent: string | null,
  kind: string,
  text: string,
  options: {
    offset?: number;
    first?: number;
    attempt?: string;
    head?: boolean;
    extra?: Record<string, unknown>;
  } = {},
): NativeDisplayRecord {
  const attempt = options.attempt ?? "attempt";
  return {
    sequence,
    attempt_id: attempt,
    event: {
      ...producer,
      display_graph_version: 1,
      phase: kind === "tool_call" ? "tool_call_delta" : `${kind}_delta`,
      ...(kind === "tool_call"
        ? { arguments: text, index: 0, id: "tool", name: "read" }
        : { text }),
      display_block: {
        block_id: blockId,
        parent_block_id: parent,
        block_type: kind,
        content_ref: `display:${blockId}`,
        sequence: options.first ?? sequence,
        timestamp_ms: 1,
        attempt_id: attempt,
        stream_key: kind === "tool_call" ? "tool:0" : kind,
        content_offset: options.offset ?? 0,
        content_bytes: new TextEncoder().encode(text).byteLength,
      },
      ...(options.head === false
        ? {}
        : {
            display_head: {
              previous_block_id: parent,
              selected_block_id: blockId,
            },
          }),
      ...options.extra,
    },
  };
}
export function canonical(
  sequence: number,
  id: string,
  parent: string | null,
  native: NativeMessage,
): NativeDisplayRecord {
  const content = {
    canonical_message_id: native.id,
    canonical_source_id: native.canonical_source_id!,
    message: native,
  };
  const base = chunk(sequence, id, parent, "canonical", "", {
    attempt: native.canonical_source_id,
  });
  base.event = { ...base.event, phase: "display_canonical", content };
  (base.event.display_block as { content_bytes: number }).content_bytes =
    new TextEncoder().encode(JSON.stringify(content)).byteLength;
  return base;
}
export function terminal(
  sequence: number,
  reasoningBytes: number,
  textBytes: number,
  attempt = "attempt",
): NativeDisplayRecord {
  return {
    sequence,
    attempt_id: attempt,
    event: {
      ...producer,
      phase: "validated",
      reasoning_bytes: reasoningBytes,
      text_bytes: textBytes,
    },
  };
}
export function binding(
  sequence: number,
  ids: string[],
  native: NativeMessage,
  attempt = "attempt",
): NativeDisplayRecord {
  return {
    sequence,
    attempt_id: attempt,
    event: {
      ...producer,
      phase: "display_binding",
      producer_call_id: attempt,
      producer_block_ids: ids,
      canonical_message_id: native.id,
      canonical_source_id: native.canonical_source_id!,
      tool_call_ids: native.tool_calls.map((call) => call.id),
      message: native,
    },
  };
}
export function emit(
  transcript: Transcript,
  record: NativeDisplayRecord,
): void {
  applyEvent(transcript, {
    v: 1,
    type: "event",
    session_id: "s1",
    subscription_id: "sub",
    generation: "g",
    sequence: record.sequence,
    event: "model_observation",
    data: {
      ...record.event,
      archive_sequence: record.sequence,
      attempt_id: record.attempt_id,
    },
  });
}
export function graphTranscript() {
  return applySnapshot(snapshot());
}
export function graphRows(transcript: Transcript) {
  return transcript.blocks.filter((block) => block.displayGraphId);
}
