import type {
  Block,
  DisplayExecutionCertificate,
  DisplayExecutionStatus,
  NativeMessage,
} from "./types";

export function displayExecutionStatus(
  value: unknown,
): DisplayExecutionStatus | undefined {
  return value === "failed" || value === "cancelled" || value === "interrupted"
    ? value
    : undefined;
}

export function mergeDisplayExecution(
  block: Block,
  id: number | undefined,
  status: DisplayExecutionStatus | undefined,
): void {
  if (id === undefined) return;
  if (block.displayExecutionId === undefined) block.displayExecutionId = id;
  if (block.displayExecutionId === id) block.displayExecutionStatus ??= status;
}

export function preferDisplayExecution(
  block: Block,
  certificate: DisplayExecutionCertificate,
): void {
  block.displayExecutionStatus =
    certificate.status ??
    (certificate.id === block.displayExecutionId
      ? block.displayExecutionStatus
      : undefined);
  block.displayExecutionId = certificate.id;
}

export function displayExecutionId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function toolResultExecutionId(
  message: NativeMessage,
  sessionId: string,
): number | undefined {
  return message.role === "tool" && message.execution_session_id === sessionId
    ? displayExecutionId(message.execution_id)
    : undefined;
}

function validSlot(index: unknown): index is number {
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
}

export function toolResultOccurrence(
  message: NativeMessage,
): Block["resultExecutionCall"] {
  const sourceId = message.execution_call_source_id;
  const index = message.execution_call_index;
  return typeof sourceId === "string" && sourceId && validSlot(index)
    ? { sourceId, index }
    : undefined;
}

/** Never use a result's call ID alone as evidence of the producing occurrence. */
function toolOccurrenceKey(
  sourceId: unknown,
  index: unknown,
  callId: unknown,
): string | undefined {
  return typeof sourceId === "string" &&
    sourceId &&
    validSlot(index) &&
    typeof callId === "string" &&
    callId
    ? JSON.stringify([sourceId, index, callId])
    : undefined;
}

export function callOccurrenceKey(block: Block): string | undefined {
  return block.role === "assistant"
    ? toolOccurrenceKey(
        block.canonicalSourceId,
        block.toolCallIndex,
        block.callId,
      )
    : undefined;
}

export function resultOccurrenceKey(block: Block): string | undefined {
  return toolOccurrenceKey(
    block.resultExecutionCall?.sourceId,
    block.resultExecutionCall?.index,
    block.callId,
  );
}

/** Exact canonical occurrence can gain metadata, but a disagreeing id cannot
 * replace the already witnessed certificate. Body and status merge separately. */
export function mergeExecutionCertificates(
  message: NativeMessage,
  previous: NativeMessage,
  sessionId: string,
): NativeMessage {
  if (
    message.id !== previous.id ||
    message.role !== previous.role ||
    message.canonical_source_id !== previous.canonical_source_id
  )
    return message;
  if (message.role === "assistant") {
    let changed = false;
    const tool_calls = (message.tool_calls ?? []).map((call, index) => {
      const prior = previous.tool_calls?.[index];
      const id =
        prior?.id === call.id
          ? displayExecutionId(prior.execution_id)
          : undefined;
      if (id === undefined) return call;
      const status =
        displayExecutionStatus(prior?.execution_status) ??
        (call.execution_id === id
          ? displayExecutionStatus(call.execution_status)
          : undefined);
      if (id === call.execution_id && status === call.execution_status)
        return call;
      changed = true;
      return { ...call, execution_id: id, execution_status: status };
    });
    return changed ? { ...message, tool_calls } : message;
  }
  if (message.role !== "tool" || message.call_id !== previous.call_id)
    return message;
  const id = toolResultExecutionId(previous, sessionId);
  if (id === undefined) return message;
  const current = toolResultExecutionId(message, sessionId);
  const occurrence =
    toolResultOccurrence(previous) ??
    (current === id ? toolResultOccurrence(message) : undefined);
  return {
    ...message,
    execution_id: id,
    execution_status:
      displayExecutionStatus(previous.execution_status) ??
      (current === id
        ? displayExecutionStatus(message.execution_status)
        : undefined),
    execution_session_id: sessionId,
    execution_call_source_id: occurrence?.sourceId,
    execution_call_index: occurrence?.index,
  };
}
