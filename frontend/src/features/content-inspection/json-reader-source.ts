import { prettyJson } from "./format-json";
import { decodeJsonString, scanJson, type JsonEvent } from "./json-lexemes";

export type JsonReaderSource =
  { kind: "text"; text: string } | { kind: "value"; value: unknown };
type ContainerKind = "object" | "array";
export type JsonNode = {
  kind: ContainerKind | "string" | "number" | "literal";
  start: number;
  end: number;
  count: number;
  key?: Pick<JsonEvent, "start" | "end">;
  ordinal: number;
};

/** Already decoded data has no wire lexemes. Only admit JSON data descriptors;
 * don't run accessors, inherited array elements, or an object's toJSON hook. */
export function* structuredJson(value: unknown): Generator<string> {
  type Frame = {
    value: object;
    keys: string[] | null;
    length: number;
    index: number;
  };
  const frames: Frame[] = [];
  const ancestors = new Set<object>();
  function open(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return Object.is(item, -0) ? "-0" : String(item);
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw new Error("Not a structured JSON value");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Not a structured JSON collection");
    const keys = array ? null : Object.keys(item);
    const length =
      keys?.length ?? Object.getOwnPropertyDescriptor(item, "length")?.value;
    frames.push({ value: item, keys, length, index: 0 });
    ancestors.add(item);
    return array ? "[" : "{";
  }
  // At pathological depths, pretty indentation is quadratic. Keep the tree
  // usable with compact serialization; pretty copy streams two spaces per level.
  yield open(value);
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (frame.index === frame.length) {
      frames.pop();
      ancestors.delete(frame.value);
      yield frame.keys ? "}" : "]";
      continue;
    }
    if (frame.index) yield ",";
    const key = frame.keys?.[frame.index] ?? String(frame.index);
    frame.index++;
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Not a structured JSON data property");
    if (frame.keys) yield JSON.stringify(key) + ":";
    yield open(descriptor.value);
  }
}

export async function cooperative<T>(
  items: Iterable<T>,
  consume: (item: T) => void,
  signal: AbortSignal,
) {
  let deadline = performance.now() + 7;
  let count = 0;
  for (const item of items) {
    if (signal.aborted) throw signal.reason;
    consume(item);
    if ((++count & 7) === 0 && performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 7;
    }
  }
  if (signal.aborted) throw signal.reason;
}

export async function readerText(
  input: JsonReaderSource,
  signal: AbortSignal,
): Promise<string> {
  if (input.kind === "text") return input.text;
  const parts: string[] = [];
  await cooperative(
    structuredJson(input.value),
    (part) => parts.push(part),
    signal,
  );
  return parts.join("");
}

type Range = { end: number; count: number };
const MAX_INDEXED_CONTAINERS = 100_000;

/** Index only compound boundaries/counts; don't materialize scalar rows, paths,
 * decoded strings or copied substrings for collapsed descendants. Above the
 * index budget, those compounds are still accessible using cooperative scans. */
export async function readJsonDocument(
  text: string,
  signal: AbortSignal,
  structured = false,
) {
  let root: JsonNode | undefined;
  const ranges = new Map<number, Range>();
  const frames: { start: number; count: number }[] = [];
  await cooperative(
    scanJson(text),
    (token) => {
      if (token.kind === "checkpoint" || token.kind === "key") return;
      if (token.kind === "endObject" || token.kind === "endArray") {
        const frame = frames.pop()!; // balanced scanner events
        if (ranges.size < MAX_INDEXED_CONTAINERS)
          ranges.set(frame.start, { end: token.end, count: frame.count });
        if (!frames.length && root)
          Object.assign(root, { end: token.end, count: frame.count });
        return;
      }
      const parent = frames.at(-1);
      if (parent) parent.count++;
      else root = { ...token, count: 0, ordinal: 0 };
      if (token.kind === "object" || token.kind === "array")
        frames.push({ start: token.start, count: 0 });
    },
    signal,
  );
  if (!root) throw new Error("Missing JSON document");
  return { text, root, ranges, structured };
}
export type JsonDocument = Awaited<ReturnType<typeof readJsonDocument>>;

/** Locate one window of immediate children. Indexed compounds are skipped in
 * constant time, including when their descendants cannot be mounted. */
export async function readChildren(
  document: JsonDocument,
  parent: JsonNode,
  first: number,
  last: number,
  signal: AbortSignal,
): Promise<JsonNode[]> {
  const children: JsonNode[] = [];
  const { text, ranges } = document;
  let ordinal = 0;
  let offset = parent.start + 1;
  // A parent already validated by the document scanner can use punctuation to
  // jump past its immediate children without traversing a skipped subtree.
  function* select(): Generator<JsonNode | undefined> {
    while (ordinal < last && offset < parent.end - 1) {
      while (offset < parent.end - 1 && " \t\r\n,".includes(text[offset])) {
        if ((++offset & 8191) === 0) yield;
      }
      let key: JsonNode["key"];
      if (parent.kind === "object") {
        for (const token of scanJson(text, offset, parent.end - 1)) {
          if (token.kind === "checkpoint") {
            yield;
            continue;
          }
          key = token;
          offset = token.end;
          break;
        }
        while (offset < parent.end - 1 && " \t\r\n:".includes(text[offset])) {
          if ((++offset & 8191) === 0) yield;
        }
      }
      const range = ranges.get(offset);
      if (range) {
        if (ordinal >= first)
          yield {
            kind: text[offset] === "{" ? "object" : "array",
            start: offset,
            ordinal,
            key,
            ...range,
          };
        else yield;
        offset = range.end;
      } else {
        let node: JsonNode | undefined;
        let depth = 0;
        for (const token of scanJson(text, offset, parent.end - 1)) {
          yield;
          if (token.kind === "checkpoint" || token.kind === "key") continue;
          if (token.kind === "endObject" || token.kind === "endArray") {
            if (--depth === 0 && node) {
              node.end = token.end;
              break;
            }
            continue;
          }
          if (!node) node = { ...token, count: 0, ordinal, key };
          else if (depth === 1) node.count++;
          if (token.kind === "object" || token.kind === "array") depth++;
          if (!depth) break;
        }
        if (!node) break;
        offset = node.end;
        if (ordinal >= first) yield node;
      }
      ordinal++;
    }
  }
  await cooperative(
    select(),
    (node) => {
      if (node) children.push(node);
    },
    signal,
  );
  return children;
}

/** Read at most `limit` complete Unicode code points from a known string token.
 * Decode a bounded JSON fragment, then trim without splitting surrogate pairs. */
export function stringWindow(
  text: string,
  from: number,
  endQuote: number,
  limit: number,
) {
  let end = from;
  let units = 0;
  let previousHigh = false;
  while (end < endQuote) {
    let unit = text.charCodeAt(end);
    let width = 1;
    if (text[end] === "\\") {
      width = text[end + 1] === "u" ? 6 : 2;
      unit =
        width === 6 ? Number.parseInt(text.slice(end + 2, end + 6), 16) : 0;
    }
    if (!(previousHigh && unit >= 0xdc00 && unit <= 0xdfff)) {
      if (units >= limit) break;
      units++;
    }
    previousHigh = unit >= 0xd800 && unit <= 0xdbff;
    end += width;
  }
  return { text: JSON.parse('"' + text.slice(from, end) + '"') as string, end };
}

/** Node values are copied exactly; this intentionally differs from whole-source
 * copy for a quoted string token and when the source starts/ends in whitespace. */
export async function copyJsonNode(
  document: JsonDocument,
  node: JsonNode,
  signal: AbortSignal,
): Promise<string> {
  const { text, structured } = document;
  if (node.kind === "string")
    return decodeJsonString(text, node.start, node.end);
  if (!structured || (node.kind !== "array" && node.kind !== "object"))
    return text.slice(node.start, node.end);
  const parts: string[] = [];
  await cooperative(
    prettyJson(text, node.start, node.end),
    (part) => parts.push(part),
    signal,
  );
  return parts.join("");
}

export function jsonValueStart(text: string): boolean {
  // Large documents are validated by the tree reader; small inputs can be
  // positively identified synchronously by the owning surface as needed.
  return /^[ \t\r\n]*[\[{]/.test(text);
}

export async function isJsonText(text: string, signal: AbortSignal): Promise<boolean> {
  try {
    await cooperative(scanJson(text), () => {}, signal);
    return true;
  } catch {
    return false;
  }
}
