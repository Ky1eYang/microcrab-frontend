import { JsonFormatBudgetError, prettyJson } from "./format-json";
import { parseUnifiedDiff } from "./unified-diff";

export const CONTENT_FORMATS = [
  "auto",
  "raw",
  "json",
  "xml",
  "diff",
  "markdown",
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export type SyntaxKind = "raw" | "json" | "xml" | "diff";
export type Presentation = {
  text: string;
  kind: SyntaxKind | "markdown";
  error?: string;
  jsonCandidate?: true;
  notice?: "large" | "xmlPreserved";
};

// Deliberately conservative CPU/DOM budgets, not transport limits. Raw and copy
// always keep the complete input; rich rendering never scales per character.
export const RICH_TEXT_LIMIT = 128 * 1024;
export const SYNTAX_TOKEN_LIMIT = 6000;
const MAX_DEPTH = 128;

export function sourceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return value === null ? "null" : "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

/** Pretty-print while retaining every key, escape and numerical lexeme. */
export function formatJson(
  source: string,
  stringValue?: (path: readonly (string | number)[], lexeme: string) => string,
): string {
  return [...prettyJson(source, 0, source.length, { depth: MAX_DEPTH, tokens: SYNTAX_TOKEN_LIMIT }, stringValue)].join("");
}

/** XML stays text throughout. Reject DTD/entities before any parser or preview;
 * conservative validation never resolves resources or constructs executable DOM. */
export function formatXml(source: string): {
  text: string;
  preserved: boolean;
} {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source))
    throw new Error("XML DTD and entity declarations are not supported");
  const validateEntities = (text: string) => {
    const invalidEntity =
      /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.exec(text);
    if (invalidEntity)
      throw new Error(
        `Unsupported or incomplete XML entity (${invalidEntity.index + 1})`,
      );
    for (const match of text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
      const code =
        match[1][0] === "x"
          ? Number.parseInt(match[1].slice(1), 16)
          : Number(match[1]);
      if (!(
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )) {
        throw new Error("Invalid XML character reference");
      }
    }
  };
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(source))
    throw new Error("Invalid XML control character");
  const pieces: { text: string; depth: number }[] = [];
  const stack: string[] = [];
  let cursor = 0;
  let roots = 0;
  let preserved = false;
  let count = 0;
  const fail = (reason: string): never => {
    throw new Error(`${reason} (${cursor + 1})`);
  };
  while (cursor < source.length) {
    if (++count > SYNTAX_TOKEN_LIMIT)
      fail("XML token count exceeds safe formatting budget");
    const start = cursor;
    if (source[cursor] !== "<") {
      const end = source.indexOf("<", cursor);
      cursor = end < 0 ? source.length : end;
      const text = source.slice(start, cursor);
      validateEntities(text);
      if (text.includes("]]>")) fail("Unexpected ]]> in XML text");
      if (text.trim()) {
        if (!stack.length) fail("XML text outside the root element");
        preserved = true;
      }
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end < 0 || source.slice(cursor + 4, end).includes("--"))
        fail("Malformed XML comment");
      cursor = end + 3;
    } else if (source.startsWith("<![CDATA[", cursor)) {
      if (!stack.length) fail("CDATA outside XML root");
      const end = source.indexOf("]]>", cursor + 9);
      if (end < 0) fail("Unterminated XML CDATA");
      cursor = end + 3;
      preserved = true;
    } else if (source.startsWith("<?", cursor)) {
      const end = source.indexOf("?>", cursor + 2);
      if (end < 0) fail("Unterminated XML processing instruction");
      cursor = end + 2;
      // Whitespace around processing instructions can be significant.
      preserved = true;
    } else {
      let quote = "";
      cursor++;
      while (cursor < source.length) {
        const ch = source[cursor++];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        else if (ch === "<") fail("Unexpected < in XML tag");
      }
      if (source[cursor - 1] !== ">" || quote) fail("Unterminated XML tag");
      const tag = source.slice(start, cursor);
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(tag);
      if (close) {
        if (stack.pop() !== close[1])
          fail(`Mismatched XML closing tag ${close[1]}`);
        pieces.push({ text: tag, depth: stack.length });
        continue;
      }
      const open = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(tag);
      if (!open) fail("Malformed XML element");
      const attrs = open![2];
      validateEntities(attrs);
      let rest = attrs;
      const names = new Set<string>();
      while (rest.length) {
        if (!rest.trim()) break;
        const attr =
          /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
        if (!attr) fail("Expected a quoted XML attribute");
        if (names.has(attr![1])) fail(`Duplicate XML attribute ${attr![1]}`);
        names.add(attr![1]);
        if (attr![1] === "xml:space") preserved = true;
        rest = rest.slice(attr![0].length);
      }
      if (!stack.length && ++roots > 1)
        fail("XML has more than one root element");
      pieces.push({ text: tag, depth: stack.length });
      if (!open![3]) stack.push(open![1]);
      if (stack.length > MAX_DEPTH)
        fail("XML nesting exceeds safe formatting depth");
      continue;
    }
    pieces.push({ text: source.slice(start, cursor), depth: stack.length });
  }
  if (stack.length) fail(`Unclosed XML element ${stack.at(-1)}`);
  if (!roots) fail("Expected an XML root element");
  return {
    text: preserved
      ? source
      : pieces.map((piece) => "  ".repeat(piece.depth) + piece.text).join("\n"),
    preserved,
  };
}

export function presentContent(
  source: string,
  mode: ContentFormat,
): Presentation {
  if (mode === "raw") return { text: source, kind: "raw" };
  if (source.length > RICH_TEXT_LIMIT)
    return { text: source, kind: "raw", notice: "large" };
  if (mode === "markdown") return { text: source, kind: "markdown" };
  if (mode === "json" || mode === "auto") {
    try {
      return { text: formatJson(source), kind: "json" };
    } catch (error) {
      // A rendering budget does not decide whether the supplied document is JSON.
      const candidate = error instanceof JsonFormatBudgetError ? { jsonCandidate: true as const } : {};
      if (mode === "auto" && candidate.jsonCandidate) return { text: source, kind: "raw", ...candidate };
      if (mode === "json")
        return {
          text: source,
          kind: "raw",
          error: String(error instanceof Error ? error.message : error),
          ...candidate,
        };
    }
  }
  if (
    mode === "xml" ||
    (mode === "auto" && source.trimStart().startsWith("<"))
  ) {
    try {
      const xml = formatXml(source);
      return {
        text: xml.text,
        kind: "xml",
        notice: xml.preserved ? "xmlPreserved" : undefined,
      };
    } catch (error) {
      if (mode === "xml")
        return {
          text: source,
          kind: "raw",
          error: String(error instanceof Error ? error.message : error),
        };
    }
  }
  if (
    mode === "diff" ||
    (mode === "auto" &&
      /^(?:diff --git |--- [^\n]+\n\+\+\+ |@@ -\d)/m.test(source))
  ) {
    try {
      parseUnifiedDiff(source, SYNTAX_TOKEN_LIMIT);
      return { text: source, kind: "diff" };
    } catch (error) {
      if (mode === "diff")
        return {
          text: source,
          kind: "raw",
          error: String(error instanceof Error ? error.message : error),
        };
    }
  }
  return { text: source, kind: "raw" };
}
