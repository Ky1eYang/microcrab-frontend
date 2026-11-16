type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};
type Parser = { parse(source: string): Node };
type Token = { value: string; at: number; code: boolean };
const phrasing = new Set(["summary", "kbd", "sup", "sub", "mark"]);

/** Keep code opaque using matching CommonMark delimiter runs, including unclosed
 * fences. An unfinished code sample never grants SVG preview authority. */
function syntaxTokens(raw: string): Token[] {
  const pattern =
    /(^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$))|`+|<svg\b[^>]*>[\s\S]*?<\/svg\s*>|<\/?(?:details|summary|kbd|sup|sub|mark)\b[^>]*>/gim;
  const result: Token[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) && result.length < 4096) {
    let end = pattern.lastIndex;
    let code = false;
    if (match[1]) {
      const run = match[2];
      // Backtick info strings cannot contain backticks.
      if (
        run[0] === "`" &&
        match[1].slice(match[1].indexOf(run) + run.length).includes("`")
      )
        continue;
      const close = new RegExp(
        `^ {0,3}${run[0]}{${run.length},}[ \\t]*(?:\\r?\\n|$)`,
        "gm",
      );
      close.lastIndex = end;
      const found = close.exec(raw);
      end = found ? close.lastIndex : raw.length;
      code = true;
    } else if (match[0][0] === "`") {
      const runs = /`+/g;
      runs.lastIndex = end;
      let found: RegExpExecArray | null;
      while ((found = runs.exec(raw)) && found[0].length !== match[0].length) {
        /* Match the complete delimiter run. */
      }
      if (!found) continue;
      end = runs.lastIndex;
      code = true;
    }
    result.push({ value: raw.slice(match.index, end), at: match.index, code });
    pattern.lastIndex = end;
  }
  return result;
}

/** Only admitted semantic syntax becomes HAST. Arbitrary HTML still reaches
 * ReactMarkdown.skipHtml; all native SVG goes through its independent sanitizer. */
export function markdownExtensions(
  this: Parser,
  options: { source: string; rich: boolean },
) {
  const parser = this;
  return (tree: Node) => {
    let work = 0;
    const parseFragment = (
      source: string,
      base: number,
      inline: boolean,
      depth: number,
    ): Node[] => {
      if (!source) return [];
      if (depth > 32 || ++work > 4096) return [{ type: "text", value: source }];
      const parsed = parser.parse(source);
      const rebase = (node: Node) => {
        for (const edge of [node.position?.start, node.position?.end])
          if (edge?.offset != null) edge.offset += base;
        node.children?.forEach(rebase);
      };
      rebase(parsed);
      visit(parsed, depth + 1);
      if (!inline) return parsed.children ?? [];
      const children = (parsed.children ?? []).flatMap((node) =>
        node.type === "paragraph" ? (node.children ?? []) : [node],
      );
      // Parsing an isolated phrasing fragment must not lose sentence spacing.
      const leading = /^\s+/.exec(source)?.[0];
      const trailing = /\s+$/.exec(source)?.[0];
      if (leading && children.length)
        children.unshift({ type: "text", value: leading });
      if (trailing && children.length)
        children.push({ type: "text", value: trailing });
      if (!children.length && /^\s+$/.test(source))
        children.push({ type: "text", value: source });
      return children;
    };
    const visit = (parent: Node, depth = 0): void => {
      if (!parent.children || depth > 32 || ++work > 4096) return;
      const output: Node[] = [];
      const stack: { tag: string; node: Node }[] = [];
      const append = (node: Node) =>
        (stack.at(-1)?.node.children ?? output).push(node);
      const inline = !["root", "blockquote", "listItem"].includes(parent.type);
      for (let index = 0; index < parent.children.length; index++) {
        let child = parent.children[index];
        if (
          child.type === "html" &&
          /^<svg\b/i.test(child.value ?? "") &&
          !/<\/svg\s*>/i.test(child.value ?? "")
        ) {
          const start = child.position?.start.offset;
          const end = parent.children.findIndex(
            (node, at) =>
              at >= index &&
              node.type === "html" &&
              /<\/svg\s*>/i.test(node.value ?? ""),
          );
          const stop =
            end >= index
              ? parent.children[end].position?.end.offset
              : undefined;
          if (start != null && stop != null) {
            child = { ...child, value: options.source.slice(start, stop) };
            index = end;
          }
        }
        if (child.type !== "html" || typeof child.value !== "string") {
          visit(child, depth + 1);
          // A block disclosure authored in a paragraph must become a sibling block.
          if (
            child.type === "paragraph" &&
            child.children?.some((node) => node.data?.hName === "details")
          ) {
            let phrase: Node[] = [];
            for (const node of child.children) {
              if (node.data?.hName === "details") {
                if (phrase.length)
                  append({ type: "paragraph", children: phrase });
                phrase = [];
                append(node);
              } else phrase.push(node);
            }
            if (phrase.length) append({ type: "paragraph", children: phrase });
          } else append(child);
          continue;
        }
        const raw = child.value;
        const tokens = syntaxTokens(raw);
        let outside = "";
        let cursor = 0;
        for (const token of tokens) {
          outside += raw.slice(cursor, token.at);
          if (!token.code && !/^<svg\b/i.test(token.value))
            outside += token.value;
          cursor = token.at + token.value.length;
        }
        outside += raw.slice(cursor);
        if (
          /<(?:script|style|iframe|object|textarea|xmp|plaintext)\b/i.test(
            outside,
          )
        ) {
          append(child);
          continue;
        }
        cursor = 0;
        const base = child.position?.start.offset ?? 0;
        const addText = (text: string, at: number) => {
          const inPhrase = stack.length
            ? phrasing.has(stack.at(-1)!.tag)
            : inline;
          for (const node of parseFragment(
            text,
            base + at,
            inPhrase,
            depth + 1,
          ))
            append(node);
        };
        for (let ti = 0; ti < tokens.length; ti++) {
          const token = tokens[ti];
          if (++work > 4096) break;
          addText(raw.slice(cursor, token.at), cursor);
          cursor = token.at + token.value.length;
          if (token.code) {
            addText(token.value, token.at);
            continue;
          }
          if (/^<svg\b/i.test(token.value)) {
            append(
              options.rich
                ? {
                    type: "richSvg",
                    data: {
                      hName: "span",
                      hProperties: { "data-inline-svg": token.value },
                    },
                  }
                : { type: "text", value: token.value },
            );
            continue;
          }
          const tag = /^<\/?([a-z]+)/i.exec(token.value)![1].toLowerCase();
          if (/^<\//.test(token.value)) {
            if (stack.at(-1)?.tag === tag) stack.pop();
            continue;
          }
          const valid =
            tag === "details"
              ? /^<details(?:\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?\s*>$/i.test(
                  token.value,
                )
              : new RegExp(`^<${tag}\\s*>$`, "i").test(token.value);
          if (!valid || stack.length + depth >= 32) continue;
          const node: Node = {
            type: "richSemantic",
            children: [],
            data: {
              hName: tag,
              hProperties:
                tag === "details" && /\sopen\b/i.test(token.value)
                  ? { open: true }
                  : {},
            },
          };
          // Parse a complete semantic body once: this preserves CommonMark code and
          // phrasing around nested tags instead of reparsing sentence fragments.
          let balance = 1;
          let close = ti + 1;
          for (; close < tokens.length; close++) {
            const candidate = tokens[close];
            if (
              candidate.code ||
              !new RegExp(`^<\\/?${tag}\\b`, "i").test(candidate.value)
            )
              continue;
            balance += /^<\//.test(candidate.value) ? -1 : 1;
            if (!balance) break;
          }
          if (close < tokens.length) {
            node.children = parseFragment(
              raw.slice(cursor, tokens[close].at),
              base + cursor,
              phrasing.has(tag),
              depth + 1,
            );
            cursor = tokens[close].at + tokens[close].value.length;
            ti = close;
            append(node);
            if (
              !inline &&
              (tag === "details" || tag === "summary") &&
              cursor < raw.length
            ) {
              addText(raw.slice(cursor), cursor);
              cursor = raw.length;
              break;
            }
          } else {
            append(node);
            stack.push({ tag, node });
          }
        }
        if (!tokens.length) append(child);
        else if (cursor < raw.length) addText(raw.slice(cursor), cursor);
      }
      parent.children = output;
    };
    visit(tree);
  };
}
