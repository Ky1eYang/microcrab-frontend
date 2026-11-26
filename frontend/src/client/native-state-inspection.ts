import {
  decodeJsonString,
  scanJson,
} from "../features/content-inspection/json-lexemes";
import { CommandError } from "./errors";
import {
  admitsOrdinaryState,
  parseStateInspection,
} from "./state-inspection";

export type NativeStateInspection = ReturnType<typeof parseStateInspection> & {
  exactRoots: ReadonlyMap<string, string>;
};

const maps = new Set(["values", "metadata", "descriptors", "witness"]);
const isOpen = (kind: string) => kind === "object" || kind === "array";
const isClose = (kind: string) => kind === "endObject" || kind === "endArray";

/** Scan the bounded inspection without decoding a non-admitted value, even if
 * values precede authority metadata. Only metadata and admitted roots leave
 * this function; exact strings do not retain the whole response's backing store. */
export async function decodeNativeStateInspection(
  source: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<NativeStateInspection> {
  const checkScope = () => {
    signal.throwIfAborted();
    if (!isCurrent())
      throw new DOMException("State scope changed", "AbortError");
  };
  let deadline = performance.now() + 8;
  let events = 0;
  const shouldYield = (kind: string) =>
    (kind === "checkpoint" || (++events & 1023) === 0) &&
    performance.now() >= deadline;
  const yieldAndCheck = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    checkScope();
    deadline = performance.now() + 8;
  };
  const invalid = () => new SyntaxError("Invalid State inspection structure");
  try {
    checkScope();
    const envelope: Record<string, unknown> = Object.create(null);
    const names: Record<string, unknown> = Object.create(null);
    const envelopeKeys = new Set<string>();
    const memberKeys = new Set<string>();
    const rowFields = new Set<string>();
    let part = "";
    let depth = 0;
    let start = 0;
    let valuesStart = 0;
    let valuesEnd = 0;
    for (const { kind, start: from, end } of scanJson(source)) {
      if (shouldYield(kind)) await yieldAndCheck();
      if (kind === "checkpoint") continue;
      if (kind === "key") {
        if (depth === 1) {
          part = decodeJsonString(source, from, end);
          if (envelopeKeys.has(part)) throw invalid();
          envelopeKeys.add(part);
          memberKeys.clear();
        } else if (depth === 2 && maps.has(part)) {
          const key = decodeJsonString(source, from, end);
          if (memberKeys.has(key)) throw invalid();
          memberKeys.add(key);
          rowFields.clear();
          if (part === "values") names[key] = undefined;
        } else if (
          depth === 3 &&
          (part === "metadata" || part === "descriptors")
        ) {
          const key = decodeJsonString(source, from, end);
          if (rowFields.has(key)) throw invalid();
          rowFields.add(key);
        }
        continue;
      }
      if (isClose(kind)) {
        depth--;
        if (depth === 1 && maps.has(part)) {
          if (part === "values") {
            valuesStart = start;
            valuesEnd = end;
            envelope.values = names;
          } else envelope[part] = JSON.parse(source.slice(start, end));
        }
        continue;
      }
      if ((depth === 0 || (depth === 1 && maps.has(part))) && kind !== "object")
        throw invalid();
      if (isOpen(kind)) {
        if (depth === 1) start = from;
        depth++;
      }
    }

    const validated = parseStateInspection(envelope);
    const { metadata, descriptors } = validated.ordinary;
    const exactRoots = new Map<string, string>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    function admit(key: string, start: number, end: number) {
      const token = source.slice(start, end);
      // Encode/decode the token to detach it from V8 substring backing storage.
      // The bounded HTTP decoder already guaranteed valid UTF-8 (JSON escapes
      // remain literal ASCII here, even when they encode unpaired surrogates).
      const raw = decoder.decode(encoder.encode(token));
      names[key] = JSON.parse(raw);
      exactRoots.set(key, raw);
    }
    depth = 0;
    let key = "";
    let allowed = false;
    for (const { kind, start: from, end } of scanJson(
      source,
      valuesStart,
      valuesEnd,
    )) {
      if (shouldYield(kind)) await yieldAndCheck();
      if (kind === "checkpoint") continue;
      if (kind === "key") {
        if (depth === 1) {
          key = decodeJsonString(source, from, end);
          allowed = admitsOrdinaryState(metadata, descriptors, key);
        }
      } else if (isOpen(kind)) {
        if (depth === 1 && allowed) start = from;
        depth++;
      } else if (isClose(kind)) {
        depth--;
        if (depth === 1 && allowed) admit(key, start, end);
      } else if (depth === 1 && allowed) admit(key, from, end);
    }
    checkScope();
    return { ...validated, exactRoots };
  } catch (error) {
    checkScope();
    // Never include a raw envelope, field name or value in a diagnostic.
    throw new CommandError(
      "invalid_result",
      error instanceof SyntaxError
        ? "Server returned unreadable State inspection JSON"
        : "Server returned an invalid State inspection",
      true,
    );
  }
}
