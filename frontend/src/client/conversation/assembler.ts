import type { Block, Transcript } from "../types";
import { hasVisibleContent } from "./definitions";
import type {
  ConversationRegistry,
  Publication,
  RegistryEntry,
} from "./registry";

/** Present only when it changes grouping, card placement or navigation.
 * Ordinary assistant text is deliberately absent: appending it is content. */
function structuralStamp(block: Block): string {
  const position = block.position ?? block.preview;
  const text = block.payload?.text ?? "";
  const tool = block.tool;
  return JSON.stringify([
    block.sessionId ?? null,
    block.role,
    block.kind,
    block.messageId,
    block.partId ?? null,
    block.callId ?? null,
    block.operationId ?? null,
    block.executionId ?? null,
    block.clientInvocationId ?? null,
    block.failureAfterMessageId ?? null,
    block.temporary === true,
    block.isCompact === true,
    block.stream === "error",
    block.stream === "streaming",
    position?.epoch ?? null,
    position?.turn ?? null,
    position?.round ?? null,
    block.preview?.canonicalMessageId ?? null,
    block.preview?.operationId ?? null,
    block.preview?.toolIndex ?? null,
    block.startedMs ?? null,
    block.endedMs ?? null,
    tool
      ? [
          tool.name ?? null,
          tool.status ?? null,
          tool.callId ?? null,
          tool.childSessionId ?? null,
          tool.childBinding ?? null,
          tool.builtin ?? null,
        ]
      : null,
    // groupBlocks drops an empty model request and keeps one once content
    // exists, so presence (not the text) is structural.
    text.length > 0,
    (block.payload?.attachments?.length ?? 0) > 0,
    block.payload?.failure != null,
    block.payload.source ?? null,
    // Child rows collapse on placeholder/real content classification, including
    // tool rows carrying an authorized child Session identity.
    block.kind === "child" || tool?.childSessionId
      ? !text.trim()
        ? "empty"
        : text.trim().startsWith("SubAgent (")
          ? "placeholder"
          : "content"
      : null,
  ]);
}

function entries(blocks: readonly Block[]): RegistryEntry[] {
  return blocks.map((block) => ({
    block,
    structure: structuralStamp(block),
    content: block,
    visible: hasVisibleContent(block) && block.displayWindowHidden !== true,
  }));
}

/** Display graph ownership lasts for the Session; legacy Context projection
 * remains scoped to its lineage and epoch. */
function historyScope(transcript: Transcript): string {
  if (
    transcript.displayGraph &&
    Object.keys(transcript.displayGraph.nodes).length
  )
    return JSON.stringify(["display", transcript.displayGraph.sessionId]);
  const view = transcript.historyView;
  return JSON.stringify([
    transcript.blocks[0]?.sessionId ?? null,
    view?.lineage ?? null,
    view?.epoch ?? null,
  ]);
}

/** Adopt a transcript the projector already computed. This is the single
 * bookkeeping entry: live events mutate blocks in place, snapshots replace
 * block objects. The registry compares its isolated prior copy against incoming
 * facts; reference equality of mutable input is never used as change evidence. The transcript and its block array are not mutated. */
export function publishTranscript(
  registry: ConversationRegistry,
  transcript: Transcript,
): Publication {
  return registry.commit(historyScope(transcript), entries(transcript.blocks));
}
