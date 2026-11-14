import type { ComposerImage, NativePart } from "../client/types";
import type { ApiClient } from "../client/api";
import { IMAGE_TYPES, inlineImage, messageImageUrl } from "../client/images";
import { t } from "../i18n";

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export async function historicalImages(
  parts: NativePart[],
  sessionId: string,
  messageId: string,
  api: ApiClient,
  limits: Record<string, number>,
  current: () => boolean,
) {
  const images: ComposerImage[] = [];
  let retained = false;
  try {
    for (const [index, part] of parts.entries()) {
      if (part.type !== "image" || part.source?.type !== "url") {
        images.push(...restoredImages([part], sessionId, api));
        continue;
      }
      const url = messageImageUrl(
        part.source,
        sessionId,
        messageId,
        index,
        api.base,
      );
      if (!url || !current()) return null;
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
      });
      if (!current()) {
        await response.body?.cancel();
        return null;
      }
      const policy = imageLimits(limits);
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > policy.bytes
      ) {
        await response.body?.cancel();
        throw Error(t("composer.images.invalid"));
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error(t("composer.images.invalid"));
      const chunks: BlobPart[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (!current() || size > policy.bytes) {
            await reader.cancel();
            if (!current()) return null;
            throw Error(t("composer.images.policy"));
          }
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally {
        reader.releaseLock();
      }
      const file = new File(chunks, t("composer.images.pasted"), {
        type:
          response.headers.get("content-type")?.split(";")[0] ??
          part.media_type ??
          "image/png",
      });
      await validateImageFile(file, limits);
      images.push({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    validateImageBatch(images, limits);
    retained = true;
    return images;
  } finally {
    if (!retained)
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
  }
}

export function restoredImages(
  parts: NativePart[],
  sessionId: string,
  api: ApiClient,
): ComposerImage[] {
  return parts.flatMap<ComposerImage>((part) => {
    if (part.type !== "image") return [];
    const source = part.source;
    if (source?.type === "data")
      return [
        {
          id: crypto.randomUUID(),
          name: t("composer.images.pasted"),
          mediaType: source.media_type,
          data: source.data,
          previewUrl: inlineImage(source.media_type, source.data),
        },
      ];
    if (source?.type === "attachment")
      return [
        {
          id: crypto.randomUUID(),
          name: t("composer.images.pasted"),
          mediaType: part.media_type ?? "image/png",
          attachment: { id: source.attachment_id, sessionId },
          previewUrl: api.url(
            `api/v1/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(source.attachment_id)}`,
          ),
        },
      ];
    return [];
  });
}

export async function uploadInputImages(
  api: ApiClient,
  sessionId: string,
  input: { parts: NativePart[]; variables?: unknown },
  limits: Record<string, number>,
  current: () => boolean,
) {
  if (
    input.parts.some(
      (part) =>
        part.type === "image" &&
        part.source?.type !== "data" &&
        part.source?.type !== "attachment",
    )
  )
    throw Error(t("composer.images.invalid"));
  const images = restoredImages(input.parts, sessionId, api);
  const uploaded = await uploadDraftImages(
    api,
    sessionId,
    images,
    limits,
    current,
  );
  if (!uploaded) return null;
  let index = 0;
  return {
    ...input,
    parts: input.parts.map((part) =>
      part.type !== "image"
        ? part
        : {
            type: "image" as const,
            source: {
              type: "attachment" as const,
              attachment_id: uploaded[index++].attachment!.id,
            },
          },
    ),
  };
}

function imageLimits(limits: Record<string, number> = {}) {
  const value = (key: string, fallback: number) =>
    Number.isSafeInteger(limits[key]) && limits[key] > 0
      ? limits[key]
      : fallback;
  return {
    bytes: value("attachment_image_bytes", 20 * 1024 * 1024),
    count: value("attachment_images", 20),
    total: value("attachment_message_bytes", 200 * 1024 * 1024),
    pixels: value("attachment_pixels", 64_000_000),
    side: value("attachment_max_side", 8192),
  };
}
export function validateImageBatch(
  images: ComposerImage[],
  limits: Record<string, number> = {},
) {
  const policy = imageLimits(limits);
  const sizes = images.map(
    (image) =>
      image.file?.size ?? image.data?.length ?? image.attachment?.bytes ?? 0,
  );
  if (
    images.length > policy.count ||
    sizes.some((size) => size > policy.bytes) ||
    sizes.reduce((sum, size) => sum + size, 0) > policy.total
  )
    throw Error(t("composer.images.policy"));
}

/** Inspect bounded headers before a decoder can allocate a pixel surface. */
export async function validateImageFile(
  file: File,
  limits: Record<string, number> = {},
) {
  const policy = imageLimits(limits);
  if (!IMAGE_TYPES.has(file.type))
    throw Error(t("composer.images.unsupported"));
  if (!file.size || file.size > policy.bytes)
    throw Error(t("composer.images.policy"));
  const bytes = new Uint8Array(
    await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer(),
  );
  const view = new DataView(bytes.buffer);
  let width = 0,
    height = 0;
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (
    file.type === "image/png" &&
    bytes.length >= 24 &&
    view.getUint32(0) === 0x89504e47 &&
    text(12, 4) === "IHDR"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    file.type === "image/gif" &&
    bytes.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(text(0, 6))
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (
    file.type === "image/jpeg" &&
    bytes.length >= 4 &&
    view.getUint16(0) === 0xffd8
  ) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (JPEG_SOF_MARKERS.has(marker) && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    file.type === "image/webp" &&
    bytes.length >= 30 &&
    text(0, 4) === "RIFF" &&
    text(8, 4) === "WEBP"
  ) {
    const kind = text(12, 4);
    if (kind === "VP8X") {
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (
      kind === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height) throw Error(t("composer.images.invalid"));
  if (
    width > policy.side ||
    height > policy.side ||
    width * height > policy.pixels
  )
    throw Error(t("composer.images.policy"));
}

/** Upload to the chosen Session only; caller fences draft and route changes. */
export async function uploadDraftImages(
  api: ApiClient,
  sessionId: string,
  images: ComposerImage[],
  limits: Record<string, number>,
  current: () => boolean,
) {
  validateImageBatch(images, limits);
  const prepared: ComposerImage[] = [];
  for (const image of images) {
    if (!current()) return null;
    if (image.attachment?.sessionId === sessionId) {
      prepared.push(image);
      continue;
    }
    const file =
      image.file ??
      (image.data
        ? new File([new Uint8Array(image.data)], image.name, {
            type: image.mediaType,
          })
        : null);
    if (!file) throw Error(t("composer.images.invalid"));
    await validateImageFile(file, limits);
    if (!current()) return null;
    const uploaded = await api.uploadImage(sessionId, file);
    if (!current()) return null;
    if (
      typeof uploaded.attachment_id !== "string" ||
      !uploaded.attachment_id ||
      uploaded.media_type !== image.mediaType ||
      uploaded.bytes !== file.size
    )
      throw Error(t("composer.images.invalid"));
    prepared.push({
      ...image,
      file,
      data: undefined,
      attachment: {
        id: uploaded.attachment_id,
        sessionId,
        bytes: uploaded.bytes,
      },
    });
  }
  return prepared;
}
