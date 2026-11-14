import { diagnosticMessage } from "../diagnostics";
/** Shared JSON framing for both browser sockets. Socket owners validate their
 * own closed frame vocabulary after this single bounded parse. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type DecodedFrame =
  | { ok: true; frame: Record<string, any> }
  | { ok: false; closeCode: 4002 | 4009; reason: string };

export function decodeFrame(data: unknown): DecodedFrame {
  if (
    typeof data !== "string" ||
    new TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES
  )
    return {
      ok: false,
      closeCode: 4009,
      reason:
        typeof data === "string"
          ? "WebSocket frame exceeds the byte budget"
          : "Expected a JSON text WebSocket frame",
    };
  try {
    const frame: unknown = JSON.parse(data);
    if (!frame || typeof frame !== "object" || Array.isArray(frame))
      return {
        ok: false,
        closeCode: 4002,
        reason: "Expected a JSON object WebSocket frame",
      };
    return { ok: true, frame: frame as Record<string, any> };
  } catch (error) {
    return {
      ok: false,
      closeCode: 4002,
      reason: diagnosticMessage(error) || "Malformed JSON WebSocket frame",
    };
  }
}

export function encodeCommand(
  method: string,
  params: Record<string, unknown>,
  requestId: string,
): string {
  return JSON.stringify({
    v: 1,
    type: "command",
    request_id: requestId,
    method,
    params,
  });
}
