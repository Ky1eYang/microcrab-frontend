import { CommandError } from "./errors";

export const MAX_CITATION_BYTES = 8 * 1024 * 1024;
export const CITATION_TIMEOUT_MS = 15_000;
export interface CitationRequest {
  sessionId: string;
  messageId: string;
  historyLineage: string;
  href: string;
  childSessionId?: string;
}
export function citationPath(request: CitationRequest): string {
  const query = new URLSearchParams({
    history_lineage: request.historyLineage,
    href: request.href,
  });
  if (request.childSessionId)
    query.set("child_session_id", request.childSessionId);
  return `api/v1/sessions/${encodeURIComponent(request.sessionId)}/files/${encodeURIComponent(request.messageId)}?${query}`;
}
/** Called only inside ApiClient.http: inherits its central authentication,
 * revocation controller, timeout and cancellation ownership. */
export async function boundedCitationBlob(
  response: Response,
  signal: AbortSignal,
): Promise<Blob> {
  const reader = response.body?.getReader();
  const limit = () =>
    new CommandError("file_limit", "Cited file exceeds the 8 MiB limit");
  const length = response.headers.get("content-length");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > MAX_CITATION_BYTES)
    )
      throw limit();
    if (reader)
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_CITATION_BYTES) throw limit();
        chunks.push(new Uint8Array(next.value));
      }
    signal.throwIfAborted();
    const mime = response.headers.get("content-type")?.split(";")[0];
    const type = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ].includes(mime ?? "")
      ? mime!
      : "application/octet-stream";
    return new Blob(chunks, { type });
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
