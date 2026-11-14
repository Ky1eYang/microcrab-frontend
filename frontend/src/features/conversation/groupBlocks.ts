import type { FeatureBlock } from "../shared";
import {
  childId,
  isCompactInstruction,
  isCompactResult,
  isSubagent,
} from "../shared";

export interface ConversationItem {
  type: "single" | "tools" | "subagents" | "compaction";
  blocks: FeatureBlock[];
  summary?: string;
  title?: string;
  shadowedCount?: number;
  streaming?: boolean;
}

/** Native request-start previews carry no conversation content. Keep their
 * evidence in the transcript, but do not let them split adjacent tool rows.
 * Check content and failure state as a preview can later become a visible reply.
 */
function invisibleModelRequest(block: FeatureBlock): boolean {
  return (
    block.role === "assistant" &&
    (block.kind === "model-request" ||
      (block.kind === "text" && block.temporary === true && !!block.preview)) &&
    !block.payload.text &&
    !block.payload.attachments?.length &&
    !block.payload.failure &&
    block.stream !== "error" &&
    !block.isCompact &&
    !block.tool
  );
}

/** Called after card ordering and history slicing, so visible cards remain
 * grouping boundaries and navigation continues to use the original records.
 */
export function groupBlocks(blocks: FeatureBlock[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const consumed = new Set<string>();
  blocks.forEach((b, index) => {
    if (consumed.has(b.id)) return;
    if (invisibleModelRequest(b) && items.at(-1)?.type === "tools") {
      const next = blocks
        .slice(index + 1)
        .find((row) => !invisibleModelRequest(row));
      if (next?.kind === "tool" && !isSubagent(next)) return;
    }
    const type = isSubagent(b)
      ? "subagents"
      : b.kind === "tool"
        ? "tools"
        : "single";
    if (type !== "single") {
      const previous = items.at(-1);
      const left =
        previous?.blocks.at(-1)?.position ?? previous?.blocks.at(-1)?.preview;
      const right = b.position ?? b.preview;
      const sameTurn =
        !left ||
        !right ||
        (left.epoch === right.epoch && left.turn === right.turn);
      if (previous?.type === type && sameTurn) {
        if (type === "subagents") {
          const cid = childId(b);
          const existingIdx = previous.blocks.findIndex(
            (eb) => childId(eb) === cid,
          );
          if (existingIdx >= 0) {
            const existing = previous.blocks[existingIdx];
            const existingText = existing.payload.text.trim();
            const incomingText = b.payload.text.trim();
            const existingHasText =
              existingText && !existingText.startsWith("SubAgent (");
            const newHasText =
              incomingText && !incomingText.startsWith("SubAgent (");
            if (!existingHasText && newHasText) {
              previous.blocks[existingIdx] = b;
            }
          } else {
            previous.blocks.push(b);
          }
        } else {
          previous.blocks.push(b);
        }
      } else {
        items.push({ type, blocks: [b] });
      }
      return;
    }
    if (
      isCompactInstruction(b) ||
      isCompactResult(b) ||
      b.kind === "compaction"
    ) {
      const instruction = isCompactInstruction(b);
      const paired = instruction
        ? blocks.find(
            (r) =>
              isCompactResult(r) &&
              (r.messageId === b.messageId ||
                r.id.endsWith(":summary") ||
                r.id.includes("compact")),
          )
        : undefined;
      if (paired) consumed.add(paired.id);
      const raw = b.payload.text.trim();
      const custom =
        instruction && raw && !["Compaction", "上下文压缩"].includes(raw)
          ? raw.startsWith('Compaction with "') && raw.endsWith('"')
            ? raw.slice(17, -1)
            : raw
          : undefined;
      items.push({
        type: "compaction",
        blocks: [b, ...(paired ? [paired] : [])],
        summary: instruction ? paired?.payload.text : b.payload.text,
        // Raw custom instruction; the localized prefix is applied at render.
        title: custom,
        shadowedCount: blocks
          .slice(0, index)
          .filter(
            (p) =>
              !p.isCompact && p.kind !== "compaction" && p.role !== "system",
          ).length,
        streaming: b.stream === "streaming" || paired?.stream === "streaming",
      });
    } else items.push({ type: "single", blocks: [b] });
  });
  return items;
}
