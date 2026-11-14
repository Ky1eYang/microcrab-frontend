import type { Block } from "./types";

export function createBlock(
  sessionId: string,
  messageId: string,
  partId: string,
  kind = "text",
  role = "assistant",
): Block {
  return {
    id: `${sessionId}:${messageId}:${partId}`,
    sessionId,
    messageId,
    partId,
    role,
    kind,
    isCompact: false,
    tool: null,
    payload: {
      text: "",
      mime: "text/markdown",
      formatHint: "markdown",
      attachments: [],
      structured: null,
      content: [],
      outputPaths: [],
      providerMetadata: null,
    },
    stream: "complete",
    fold: "auto",
  };
}
