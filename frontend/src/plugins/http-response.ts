import { LIMITS } from "./types";
/** Bounded incremental POST response reader; returns on the exact RPC response,
 * cancelling the stream even if the server keeps the connection open. */
export async function readHttpResponse(
  response: Response,
  matchId: string | number | undefined,
  signal: AbortSignal,
): Promise<string> {
  const sse =
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "text/event-stream";
  if (sse && matchId === undefined)
    throw Error("SSE response requires an exact response identity");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0,
    buffer = "",
    events = 0,
    skipLF = false;
  let data: string[] = [];
  const frame = (): string | undefined => {
    if (!data.length) return;
    if (++events > 4096) throw Error("HTTP SSE event limit exceeded");
    const text = data.join("\n");
    data = [];
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw Error("Invalid JSON in HTTP SSE response");
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "id" in value
    ) {
      if (value.id !== matchId)
        throw Error("HTTP SSE response identity does not match the request");
      return text;
    }
  };
  const take = (): string | undefined => {
    for (;;) {
      const delimiter = /[\r\n]/.exec(buffer);
      if (!delimiter) return;
      const index = delimiter.index;
      const line = buffer.slice(0, index);
      const cr = buffer[index] === "\r";
      buffer = buffer.slice(index + 1);
      if (cr) {
        if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        else if (!buffer) skipLF = true;
      }
      if (!line) {
        const result = frame();
        if (result !== undefined) return result;
      } else if (line === "data" || line.startsWith("data:"))
        data.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
    }
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("HTTP response cancelled");
      const part = await reader.read();
      if (signal.aborted) throw Error("HTTP response cancelled");
      const chunk = decoder.decode(part.value, { stream: !part.done });
      if (!part.done) {
        total += part.value.byteLength;
        if (total > LIMITS.networkBytes)
          throw Error("HTTP response exceeds 2 MiB");
      }
      if (sse && skipLF && chunk.length) {
        buffer += chunk.startsWith("\n") ? chunk.slice(1) : chunk;
        skipLF = false;
      } else buffer += chunk;
      if (sse) {
        const result = take();
        if (result !== undefined) return result;
      }
      if (part.done) {
        if (!sse) return buffer;
        throw Error("HTTP SSE stream ended without the matching response");
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
