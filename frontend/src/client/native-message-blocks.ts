import { createBlock } from "./create-block";
import { messageImageUrl } from "./images";
import type { Block, NativeMessage } from "./types";

export function messageBlocks(
  sessionId: string,
  message: NativeMessage,
  apiBase: string,
): Block[] {
  const blocks: Block[] = [];
  if (message.role === "tool" || message.text || message.parts?.length) {
    const b = createBlock(sessionId, message.id, "text", "text", message.role);
    if (message.role === "user" && message.source === "framework")
      b.payload.source = "framework";
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
      b.callId = message.call_id;
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
  for (const call of message.tool_calls ?? []) {
    const b = createBlock(sessionId, message.id, call.id, "tool", "assistant");
    b.callId = call.id;
    b.tool = {
      name: call.name,
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
    if (message.role === "user" && message.source !== "framework")
      block.operationId = message.submission_operation_id;
    block.position = message.position ?? null;
    block.clientInvocationId = message.client_invocation_id ?? null;
    // Only this selected response owns its usage; receipt order and Session totals do not.
    if (message.role === "assistant" && message.usage !== undefined)
      block.payload.providerMetadata = { tokens: message.usage };
  }
  return blocks;
}
