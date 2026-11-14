import { createBlock } from "../../client/projector";
import type { Block, QuestionIdentity } from "../../client/types";

interface Boundary {
  after: string | null;
  before: string | null;
}
export type CardBoundaries = Map<string, Boundary>;

/** Conversation-only cards share the canonical stream without changing history.
 * A recovered invocation is anchored by durable identity first. Until its block
 * arrives, remember the observed boundary so later messages cannot push it down.
 */
export function orderedCards(
  blocks: Block[],
  questions: readonly QuestionIdentity[],
  compact: { operation_id: string; status: string; sessionId: string } | null,
  sessionId: string,
  boundaries: CardBoundaries,
): Block[] {
  const slots = new Map<number, { block: Block; time: number }[]>();
  const add = (block: Block, index: number, time = 0) => {
    const rows = slots.get(index) ?? [];
    rows.push({ block, time });
    slots.set(index, rows);
  };
  const fallback = (key: string, preferred?: number) => {
    if (preferred != null) return preferred;
    let boundary = boundaries.get(key);
    if (!boundary) {
      boundary = { after: blocks.at(-1)?.id ?? null, before: null };
      boundaries.set(key, boundary);
    }
    if (boundary.before) {
      const index = blocks.findIndex((block) => block.id === boundary.before);
      if (index >= 0) return index;
    }
    if (boundary.after) {
      const index = blocks.findIndex((block) => block.id === boundary.after);
      if (index >= 0) return index + 1;
    }
    return 0;
  };
  for (const question of questions) {
    const id = question.id;
    const scope = question.sessionId;
    if (!id || (scope !== sessionId && question.parentSessionId !== sessionId))
      continue;
    const card = createBlock(
      sessionId,
      `question:${id}`,
      "card",
      "question",
      "system",
    );
    card.payload.question = question;
    let index = blocks.findIndex(
      (block) => block.sessionId === scope && block.clientInvocationId === id,
    );
    const { callId, epoch, turnId, roundId, createdAt } = question;
    const position =
      typeof callId === "string" &&
      typeof epoch === "number" &&
      Number.isSafeInteger(epoch) &&
      typeof turnId === "number" &&
      Number.isSafeInteger(turnId) &&
      typeof roundId === "number" &&
      Number.isSafeInteger(roundId)
        ? { callId, epoch, turnId, roundId }
        : null;
    if (index < 0 && position) {
      index = blocks.findIndex(
        (block) =>
          block.sessionId === scope &&
          block.callId === position.callId &&
          block.position?.epoch === position.epoch &&
          block.position?.turn === position.turnId &&
          block.position?.round === position.roundId,
      );
    }
    if (index < 0 && scope !== sessionId) {
      index = blocks.findIndex(
        (block) =>
          block.sessionId === sessionId &&
          block.tool?.childBinding === "execution" &&
          block.tool?.childSessionId === scope,
      );
    }
    let preferred = index < 0 ? undefined : index + 1;
    if (preferred == null && position) {
      // Position comparison orders an invocation whose own block is still in
      // flight before later turns/rounds, without joining unrelated call IDs.
      const later = blocks.findIndex((block) => {
        const p = block.position;
        return (
          block.sessionId === scope &&
          p != null &&
          (p.epoch > position.epoch ||
            (p.epoch === position.epoch && p.turn > position.turnId) ||
            (p.epoch === position.epoch &&
              p.turn === position.turnId &&
              p.round > position.roundId))
        );
      });
      if (later >= 0) preferred = later;
    }
    const hasTime = typeof createdAt === "number" && Number.isFinite(createdAt);
    const time = hasTime ? createdAt : 0;
    if (preferred == null && hasTime) {
      const later = blocks.findIndex((block) => {
        const time = block.startedMs ?? block.endedMs;
        return time != null && time > createdAt;
      });
      if (later >= 0) preferred = later;
    }
    const slot = fallback(card.id, preferred);
    if (preferred != null)
      boundaries.set(card.id, {
        after: blocks[slot - 1]?.id ?? null,
        before: blocks[slot]?.id ?? null,
      });
    add(card, slot, time);
  }
  if (
    compact &&
    compact.sessionId === sessionId &&
    compact.status !== "completed"
  ) {
    const card = createBlock(
      sessionId,
      `compact:${compact.operation_id}`,
      "card",
      "compact-command",
      "system",
    );
    add(card, fallback(card.id));
  }
  const result: Block[] = [];
  for (let index = 0; index <= blocks.length; index++) {
    const cards = slots.get(index) ?? [];
    cards.sort(
      (a, b) => a.time - b.time || a.block.id.localeCompare(b.block.id),
    );
    result.push(...cards.map((row) => row.block));
    if (index < blocks.length) result.push(blocks[index]);
  }
  return result;
}
