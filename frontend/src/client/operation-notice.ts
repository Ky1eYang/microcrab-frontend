import type { Block, Transcript } from "./types";

/** A terminal receipt follows its own observed output or certified boundary.
 * No receipt timestamp can move it ahead of first-observed content. */
export function placeOperationNotice(transcript: Transcript, block: Block) {
  const others = transcript.blocks.filter((item) => item !== block);
  const output = others.filter(
    (item) =>
      item.operationId === block.operationId ||
      item.preview?.operationId === block.operationId,
  );
  let anchor = output.at(-1);
  if (!anchor && typeof block.failureAfterMessageId === "string")
    anchor = [...others]
      .reverse()
      .find((item) => item.messageId === block.failureAfterMessageId);
  if (!anchor && block.position) {
    const position = block.position;
    anchor = [...others].reverse().find((item) => {
      const p = item.position ?? item.preview;
      return (
        p?.epoch === position.epoch &&
        p.turn === position.turn &&
        typeof p.round === "number" &&
        p.round <= position.round
      );
    });
  }
  if (!anchor) return;
  transcript.blocks.splice(transcript.blocks.indexOf(block), 1);
  transcript.blocks.splice(transcript.blocks.indexOf(anchor) + 1, 0, block);
}
