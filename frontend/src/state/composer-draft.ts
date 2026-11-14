import type { ComposerImage } from "../client/types";

/** Files become attachment references; object URLs never cross the wire. */
export function draftParts(text: string, images: ComposerImage[]) {
  return [
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({
      type: "image" as const,
      source:
        image.attachment || image.file
          ? {
              type: "attachment" as const,
              attachment_id: image.attachment?.id ?? `pending-${image.id}`,
            }
          : {
              type: "data" as const,
              media_type: image.mediaType,
              data: image.data ?? [],
            },
    })),
  ];
}

export function turnFitsBudget(
  text: string,
  images: ComposerImage[],
  budget: number,
): boolean {
  // Bound the current main-Send envelope, including activation and UUID/session
  // ids. This also covers the smaller passive queue and steer envelopes.
  return (
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        type: "command",
        request_id: "x".repeat(36),
        method: "turn.queue",
        session_id: "x".repeat(128),
        params: {
          input: { parts: draftParts(text, images) },
          operation_id: "x".repeat(36),
          activate_if_idle: true,
        },
      }),
    ).byteLength <= budget
  );
}

const SLASH_COMMAND = /^\/([^\s]*)(?:\s([\s\S]*))?$/;

export type SlashCommand =
  | { kind: "compact"; instruction: string }
  | { kind: "unknown"; name: string }
  | null;
export function parseSlash(text: string): SlashCommand {
  if (!text.startsWith("/")) return null;
  const match = SLASH_COMMAND.exec(text);
  if (!match || match[1].toLowerCase() !== "compact")
    return { kind: "unknown", name: match?.[1] ?? text };
  return { kind: "compact", instruction: match[2] ?? "" };
}
