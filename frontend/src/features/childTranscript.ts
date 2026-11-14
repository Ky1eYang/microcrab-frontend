import { applyDisplayGraphEnvelope } from "../client/display-graph";
import { applySnapshot, replayDisplayObservations } from "../client/projector";
import type { NativeChildDetail, Transcript } from "../client/types";
import { childText } from "./childPresentation";

/** Pure read projection through the normal message/tool reconciler, never session attachment. */
export function childTranscript(detail: NativeChildDetail): Transcript {
  const transcript = applySnapshot({
    session: {
      id: detail.id,
      title: childText(detail.name) || detail.id,
      project_id: "",
      status: "idle",
      agent: null,
      mode: null,
      model: "",
      created_at_ms: 0,
      updated_at_ms: 0,
      revision: 0,
      archived: false,
    },
    messages: detail.messages,
    executions: detail.executions,
    permission: {
      revision: 0,
      config: { overrides: [], review: false, initialization: "allow" },
    },
    operations: [],
    history: null,
    history_view: detail.history_view,
    messages_truncated: detail.next_cursor != null,
    next_cursor: detail.next_cursor,
    usage: detail.usage,
  });
  transcript.connected = false;
  transcript.sessionStatus = childText(detail.status) || "unknown";
  for (const graph of detail.display_graph_pages ?? [])
    applyDisplayGraphEnvelope(transcript, detail.id, graph);
  if (detail.display_records)
    replayDisplayObservations(transcript, detail.id, detail.display_records);
  transcript.displayCoverage =
    detail.display_coverage ?? detail.display?.coverage;
  for (const block of transcript.blocks) {
    block.payload.auditScope = {
      parentId: detail.parent_session_id,
      childId: detail.id,
    };
  }
  return transcript;
}
