import type { StateNode } from "./inspection";

const MAX_LEVELS = 4;
const MAX_ENTRIES = 80;
const MAX_BYTES = 4 * 1024;
const encoder = new TextEncoder();

type StateValuePreview =
  | { kind: "none" }
  | { kind: "scalar"; text: string }
  | { kind: "json" | "excerpt"; type: "array" | "object"; text: string };

function quotedCharacterBytes(character: string): number {
  const code = character.codePointAt(0)!;
  if (code === 0x22 || code === 0x5c || /[\b\t\n\f\r]/.test(character))
    return 2;
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

/** Format only the selected, already authorized tree node; never consult exact
 * evidence or recover values missing from the bounded display tree. */
export function stateValuePreview(node: StateNode): StateValuePreview {
  if (node.metadata.visibility === "secret") return { kind: "none" };
  if (node.type !== "object" && node.type !== "array") {
    return node.preview === undefined
      ? { kind: "none" }
      : { kind: "scalar", text: node.preview };
  }

  const chunks: string[] = [];
  let remaining = MAX_BYTES;
  let entries = 0;
  const write = (text: string, bytes = encoder.encode(text).byteLength) => {
    if (bytes > remaining) return false;
    chunks.push(text);
    remaining -= bytes;
    return true;
  };
  const writeQuoted = (text: string) => {
    if (!remaining) return false;
    let end = 0;
    let bytes = 1; // opening quote
    // Admit whole characters at their escaped UTF-8 cost before serialization.
    for (const character of text) {
      const size = quotedCharacterBytes(character);
      if (bytes + size > remaining) break;
      bytes += size;
      end += character.length;
    }
    const complete = end === text.length && bytes < remaining;
    const quoted = JSON.stringify(text.slice(0, end));
    if (complete) return write(quoted, bytes + 1);
    write(quoted.slice(0, -1), bytes);
    return false;
  };
  function visit(current: StateNode, level: number): boolean {
    if (current.type === "string")
      return (
        current.projectedString !== undefined &&
        writeQuoted(current.projectedString)
      );
    if (current.type !== "array" && current.type !== "object") {
      const { type, preview } = current;
      // No complete JSON representation for an absent value or a number that
      // overflowed JS numeric range when parsed from the wire.
      return (
        preview !== undefined &&
        (type !== "number" || Number.isFinite(Number(preview))) &&
        write(preview)
      );
    }

    const array = current.type === "array";
    if (!write(array ? "[" : "{")) return false;
    for (let i = 0; i < current.children.length; i++) {
      if (level >= MAX_LEVELS || entries >= MAX_ENTRIES) return false;
      entries++;
      const child = current.children[i];
      if (array && child.key !== String(i)) return false;
      if (
        !write(`${i ? "," : ""}\n${"  ".repeat(level + 1)}`) ||
        (!array && (!writeQuoted(child.key) || !write(": "))) ||
        !visit(child, level + 1)
      )
        return false;
    }
    if (current.childrenLimited) return false;
    return (
      (!current.children.length || write(`\n${"  ".repeat(level)}`)) &&
      write(array ? "]" : "}")
    );
  }

  const complete = visit(node, 0);
  return {
    kind: complete ? "json" : "excerpt",
    type: node.type,
    text: chunks.join(""),
  };
}
