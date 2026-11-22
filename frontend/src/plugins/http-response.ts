import { LIMITS } from "./types";

export interface SseEvent {
  type: "sse-event";
  event: string;
  data: string;
  id?: string;
}

function isSse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "text/event-stream"
  );
}

async function* readBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("HTTP response cancelled");
      const part = await reader.read();
      if (signal.aborted) throw Error("HTTP response cancelled");
      total += part.value?.byteLength ?? 0;
      if (total > LIMITS.networkBytes)
        throw Error("HTTP response exceeds 2 MiB");
      const text = decoder.decode(part.value, { stream: !part.done });
      if (text) yield text;
      if (part.done) return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Single-pass SSE line parser (CR, LF and CRLF, including split delimiters).
 * Only a blank line dispatches an event. EOF never publishes partial data. */
async function* readSse(
  response: Response,
  signal: AbortSignal,
  eventLimit: number,
) {
  const encoder = new TextEncoder();
  let partial = "",
    skipLF = false,
    count = 0,
    dataUnits = 0;
  let event = "",
    id: string | undefined;
  let data: string[] = [];
  for await (const chunk of readBody(response, signal)) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (skipLF) {
        skipLF = false;
        if (c === 10) {
          start = i + 1;
          continue;
        }
      }
      if (c !== 10 && c !== 13) continue;
      const line = partial + chunk.slice(start, i);
      partial = "";
      start = i + 1;
      skipLF = c === 13;
      if (line.length > eventLimit)
        throw Error("HTTP SSE line exceeds byte quota");
      if (line === "") {
        if (data.length) {
          if (++count > 4096) throw Error("HTTP SSE event limit exceeded");
          const text = data.join("\n");
          if (
            encoder.encode(text).length +
              encoder.encode(event).length +
              encoder.encode(id ?? "").length >
            eventLimit
          )
            throw Error("HTTP SSE frame exceeds byte quota");
          yield {
            type: "sse-event",
            event: event || "message",
            data: text,
            ...(id !== undefined ? { id } : {}),
          } satisfies SseEvent;
        }
        data = [];
        dataUnits = 0;
        event = "";
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") {
          dataUnits += value.length + Number(data.length > 0);
          if (dataUnits > eventLimit || data.length >= eventLimit)
            throw Error("HTTP SSE frame exceeds byte quota");
          data.push(value);
        } else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
    }
    partial += chunk.slice(start);
    if (partial.length > eventLimit)
      throw Error("HTTP SSE line exceeds byte quota");
  }
}

/** Stream mode carries application events, not necessarily JSON-RPC. */
export async function deliverHttpSse(
  response: Response,
  signal: AbortSignal,
  deliver: (event: SseEvent) => Promise<void>,
): Promise<void> {
  if (!response.ok || !isSse(response) || !response.body) {
    await response.body?.cancel();
    if (response.ok)
      throw Error("HTTP SSE requires a text/event-stream response body");
    return;
  }
  for await (const event of readSse(response, signal, 64 * 1024)) {
    if (signal.aborted) throw Error("HTTP response cancelled");
    await deliver(event);
  }
}

/** Legacy buffered HTTP and exact JSON-RPC response matching (no frame callbacks). */
export async function readHttpResponse(
  response: Response,
  matchId: string | number | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!isSse(response)) {
    let body = "";
    for await (const chunk of readBody(response, signal)) body += chunk;
    return body;
  }
  if (matchId === undefined) {
    await response.body?.cancel();
    throw Error("SSE response requires an exact response identity");
  }
  for await (const { data } of readSse(response, signal, LIMITS.networkBytes)) {
    let value: unknown;
    try {
      value = JSON.parse(data);
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
      return data;
    }
  }
  throw Error("HTTP SSE stream ended without the matching response");
}
