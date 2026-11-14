import { memo, useMemo } from "react";
import { RICH_TEXT_LIMIT, SYNTAX_TOKEN_LIMIT, type SyntaxKind } from "./format";

import { parseUnifiedDiff } from "./unified-diff";

type Token = { text: string; role?: string };
function tokenize(text: string, kind: SyntaxKind): Token[] {
  if (kind === "raw" || text.length > RICH_TEXT_LIMIT) return [{ text }];
  if (kind === "diff") {
    try {
      return parseUnifiedDiff(text, SYNTAX_TOKEN_LIMIT);
    } catch {
      return [{ text }];
    }
  }
  const pattern =
    kind === "json"
      ? /"(?:[^"\\]|\\.)*"(?=\s*:)|"(?:[^"\\]|\\.)*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|[{}\[\],:]/g
      : /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*|\/?>|[A-Za-z_][\w.:-]*(?=\s*=)|"[^"]*"|'[^']*'|&(?:[\w#]+);/g;
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (tokens.length > SYNTAX_TOKEN_LIMIT) return [{ text }];
    if (match.index! > cursor)
      tokens.push({ text: text.slice(cursor, match.index) });
    const part = match[0];
    let role = "punctuation";
    if (kind === "json") {
      role =
        part[0] === '"'
          ? /^\s*:/.test(text.slice(match.index! + part.length))
            ? "key"
            : "string"
          : /^[\w-]/.test(part)
            ? "literal"
            : "punctuation";
    } else {
      role = part.startsWith("<!--")
        ? "comment"
        : /^["']/.test(part) || part.startsWith("<![CDATA[")
          ? "string"
          : "key";
    }
    tokens.push({ text: part, role });
    cursor = match.index! + part.length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

export function syntaxForLanguage(language: string): SyntaxKind {
  if (/^(json|jsonc)$/i.test(language)) return "json";
  if (/^(xml|html|svg)$/i.test(language)) return "xml";
  if (/^(diff|patch)$/i.test(language)) return "diff";
  return "raw";
}

/** Bounded token spans shared by Payload and existing Markdown code fences. */
export const CodeText = memo(function CodeText({
  text,
  kind = "raw",
  lineNumbers = false,
}: {
  text: string;
  kind?: SyntaxKind;
  lineNumbers?: boolean;
}) {
  const tokens = useMemo(() => tokenize(text, kind), [text, kind]);
  const lines = useMemo(() => {
    if (
      !lineNumbers ||
      text.length > RICH_TEXT_LIMIT ||
      text.split("\n").length > SYNTAX_TOKEN_LIMIT
    )
      return null;
    const result: Token[][] = [[]];
    for (const token of tokens) {
      const parts = token.text.split("\n");
      parts.forEach((part, index) => {
        if (index) result.push([]);
        if (part) result.at(-1)!.push({ text: part, role: token.role });
      });
    }
    return result;
  }, [tokens, lineNumbers, text]);
  const render = (token: Token, index: number) =>
    token.role ? (
      <span key={index} className={`syntax-${token.role}`}>
        {token.text}
      </span>
    ) : (
      token.text
    );
  return (
    <code className="content-code" data-line-numbers={lines ? "true" : "false"}>
      {lines
        ? lines.map((line, index) => (
            <span
              className="content-code-line"
              data-line={index + 1}
              key={index}
            >
              {line.map(render)}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))
        : tokens.map(render)}
    </code>
  );
});
