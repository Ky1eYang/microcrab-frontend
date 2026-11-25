import { isDirectUserSource, validateNativeInputSource } from "./input-source";
import { createBlock } from "./create-block";
import { messageImageUrl } from "./images";
import { responseCompletionTime } from "./response-completion";
import {
  displayExecutionId,
  displayExecutionStatus,
  mergeDisplayExecution,
  toolResultExecutionId,
  toolResultOccurrence,
} from "./tool-execution-display";
import type { Block, NativeMessage } from "./types";

export function messageBlocks(
  sessionId: string,
  message: NativeMessage,
  apiBase: string,
): Block[] {
  if (message.role === "user") validateNativeInputSource(message.source);
  const blocks: Block[] = [];
  if (message.role === "tool" || message.text || message.parts?.length) {
    const b = createBlock(sessionId, message.id, "text", "text", message.role);
    if (message.role === "user" && message.source !== undefined)
      b.payload.source = structuredClone(message.source);
    b.payload.text =
      message.text ||
      message.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
    b.payload.attachments = (message.parts ?? []).flatMap((part, index) => {
      if (part.type !== "image") return [];
      const url = messageImageUrl(
        part.source,
        sessionId,
        message.id,
        index,
        apiBase,
      );
      return [
        {
          partId: `image-${index}`,
          mime:
            part.media_type ??
            (part.source?.type === "data" ? part.source.media_type : undefined),
          marker: "[Image]",
          url,
          sourceOmitted: part.source_omitted === true || !url,
        },
      ];
    });
    if (message.role === "tool") {
      b.kind = "tool";
      b.payload.toolPresentation = message.presentation;
      b.callId = message.call_id;
      mergeDisplayExecution(
        b,
        toolResultExecutionId(message, sessionId),
        displayExecutionStatus(message.execution_status),
      );
      if (b.displayExecutionId !== undefined)
        b.resultExecutionCall = toolResultOccurrence(message);
      b.tool = {
        name: message.tool_name ?? "tool",
        builtin: message.tool_builtin === "delegate" ? "delegate" : undefined,
        callId: message.call_id,
        status: "completed",
        input: {},
      };
      try {
        b.payload.structured = JSON.parse(message.text ?? "");
      } catch {
        /* Plain text tool output is valid. */
      }
    }
    blocks.push(b);
  }
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const b = createBlock(sessionId, message.id, call.id, "tool", "assistant");
    b.callId = call.id;
    b.toolCallIndex = index;
    if (message.role === "assistant")
      mergeDisplayExecution(
        b,
        displayExecutionId(call.execution_id),
        displayExecutionStatus(call.execution_status),
      );
    b.tool = {
      name: call.name,
      presentation: call.presentation,
      builtin: call.builtin === "delegate" ? "delegate" : undefined,
      callId: call.id,
      input: call.arguments,
      // No status until a paired result or execution event supplies one; an
      // unpaired historical call is shown as unknown, never as success.
    };
    blocks.push(b);
  }
  for (const block of blocks) {
    block.canonicalSourceId = message.canonical_source_id;
    if (message.role === "user" && isDirectUserSource(message.source))
      block.operationId = message.submission_operation_id;
    block.position = message.position ?? null;
    block.clientInvocationId = message.client_invocation_id ?? null;
    if (message.role === "assistant") {
      block.responseAdmission = "admitted";
      block.responseCompletedAtMs = responseCompletionTime(
        message.response_completed_at_ms,
      );
    }
    // Only this selected response owns its usage; receipt order and Session totals do not.
    if (message.role === "assistant" && message.usage !== undefined)
      block.payload.providerMetadata = { tokens: message.usage };
  }
  return blocks;
}
