import { decodeJsonString, scanJson } from "./json-lexemes";

export class JsonFormatBudgetError extends Error {}

/** Pretty-print without normalizing lexemes. Streaming the pieces also lets
 * structured evidence copy use the same formatting without the display limit. */
export function* prettyJson(
  source: string,
  start: number,
  end: number,
  limits?: { depth: number; tokens: number },
  stringValue?: (path: readonly (string | number)[], lexeme: string) => string,
): Generator<string> {
  const path: (string | number)[] = [];
  const frames: { count: number; key?: string }[] = [];
  let tokens = 0;
  for (const token of scanJson(source, start, end)) {
    const { kind } = token;
    const frame = frames.at(-1);
    const depth = frames.length;
    if (kind === "checkpoint") {
      yield "";
      continue;
    }
    if (kind === "key") {
      if (!frame) throw new Error("Missing JSON object frame");
      yield (frame.count++ ? "," : "") +
        "\n" +
        "  ".repeat(depth) +
        source.slice(token.start, token.end) +
        ": ";
      frame.key = stringValue
        ? decodeJsonString(source, token.start, token.end)
        : "";
      continue;
    }
    if (kind === "endObject" || kind === "endArray") {
      yield (frame?.count ? "\n" + "  ".repeat(depth - 1) : "") +
        source[token.start];
      frames.pop();
      if (stringValue && depth > 1) path.pop();
      continue;
    }
    if (limits && depth > limits.depth)
      throw new JsonFormatBudgetError(
        `JSON nesting exceeds safe formatting depth (${token.start + 1})`,
      );
    if (limits && ++tokens > limits.tokens)
      throw new JsonFormatBudgetError(
        `JSON token count exceeds safe formatting budget (${token.start + 1})`,
      );
    if (frame) {
      if (frame.key !== undefined) {
        if (stringValue) path.push(frame.key);
        frame.key = undefined;
      } else {
        yield (frame.count ? "," : "") + "\n" + "  ".repeat(depth);
        if (stringValue) path.push(frame.count);
        frame.count++;
      }
    }
    if (kind === "object" || kind === "array") {
      yield source[token.start];
      frames.push({ count: 0 });
    } else {
      const lexeme = source.slice(token.start, token.end);
      yield kind === "string" && stringValue
        ? stringValue(path, lexeme)
        : lexeme;
      if (stringValue && frame) path.pop();
    }
  }
}
