import type { Block } from "../types";

export interface ConversationNodeDefinition {
  kind:
    | "user"
    | "assistant"
    | "reasoning"
    | "tool"
    | "error"
    | "compaction"
    | "inbox";
  /** The projector has already resolved the event's native identity. Matching
   * its projection avoids a second call/message placement algorithm. */
  match(block: Block): boolean;
  start(block: Block): Block;
  update(current: Block, next: Block): void;
}
/** Registry roots update in place; their nested publication facts never do.
 * Freeze only the registry's private clone, never an incoming Transcript. */
function publicationCopy(block: Block): Block {
  const copy = structuredClone(block);
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (
      Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
  };
  for (const value of Object.values(copy)) freeze(value);
  return copy;
}
function update(current: Block, next: Block) {
  const replacement = publicationCopy(next);
  for (const key of Object.keys(current))
    if (!Object.hasOwn(replacement, key)) delete current[key];
  Object.assign(current, replacement);
}
function definition(
  kind: ConversationNodeDefinition["kind"],
  match: ConversationNodeDefinition["match"],
): ConversationNodeDefinition {
  return {
    kind,
    match,
    start: publicationCopy,
    update,
  };
}
export const conversationNodeDefinitions: readonly ConversationNodeDefinition[] =
  [
    definition("inbox", (block) => block.kind === "inbox"),
    definition(
      "compaction",
      (block) => !!block.isCompact || block.kind === "compaction",
    ),
    definition(
      "error",
      (block) => !!block.payload.failure || block.kind === "error",
    ),
    definition(
      "tool",
      (block) => block.kind === "tool" || block.kind === "child",
    ),
    definition("reasoning", (block) => block.kind === "reasoning"),
    definition("user", (block) => block.role === "user"),
    definition("assistant", () => true),
  ];
export function definitionFor(block: Block): ConversationNodeDefinition {
  // The final assistant adapter covers status/model-request and future display
  // projections without manufacturing identity or model-facing material.
  return conversationNodeDefinitions.find((candidate) =>
    candidate.match(block),
  )!;
}
export function hasVisibleContent(block: Block): boolean {
  if (["tool", "child", "compaction", "inbox"].includes(block.kind))
    return true;
  return (
    !!block.payload.text.trim() ||
    !!block.payload.attachments?.length ||
    !!block.payload.failure
  );
}
