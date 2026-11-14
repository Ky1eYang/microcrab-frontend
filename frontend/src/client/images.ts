export const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function inlineImage(mediaType: string, data: number[]): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8192)
    binary += String.fromCharCode(...data.slice(offset, offset + 8192));
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/** Accept only the exact authenticated image-resource identity emitted for this part. */
export function messageImageUrl(
  source: unknown,
  sessionId: string,
  messageId: string,
  partIndex: number,
  apiBase: string,
): string | undefined {
  if (!source || typeof source !== "object") return;
  const value = source as {
    type?: string;
    url?: string;
    media_type?: string;
    data?: number[];
  };
  if (
    value.type === "data" &&
    IMAGE_TYPES.has(value.media_type ?? "") &&
    Array.isArray(value.data) &&
    value.data.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    return inlineImage(value.media_type!, value.data);
  if (value.type !== "url" || typeof value.url !== "string") return;
  const expected = `/api/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(messageId)}/${partIndex}`;
  if (value.url !== expected) return;
  try {
    const base = new URL(apiBase),
      url = new URL(value.url, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
