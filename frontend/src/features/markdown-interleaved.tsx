import { Fragment, useId, useMemo, useSyncExternalStore } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { activeLocale, subscribeLocale, t } from "../i18n";
import type { CitationScope } from "./citations/context";
import { Markdown, type RichMarkdownContext } from "./views";

// These plugins install the same CommonMark/GFM/math parser syntax as Markdown.
// Heading attributes are a subsequent transform and do not change source spans.
// HTML extensions may span blocks, so documents containing HTML stay together.
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .freeze();
const nodeLimit = 512;
const sourceLimit = 1024 * 1024;
type SyntaxNode = {
  type: string;
  depth?: number;
  ordered?: boolean | null;
  identifier?: string;
  referenceType?: "full" | "collapsed" | "shortcut";
  children?: SyntaxNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
type Segment = { raw: string; markdown: string; kind: string };
type Document = { blocks: Segment[]; definitions: string };
export type MarkdownBlockPairing = {
  alignment: "blocks" | "grouped";
  pairs: { original: Segment; variant: Segment }[];
  originalDefinitions: string;
  variantDefinitions: string;
};

function documentBlocks(
  source: string,
  budget: { remaining: number },
): Document | null {
  if (source.length > sourceLimit) return null;
  const tree: SyntaxNode = parser.parse(source);
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (--budget.remaining < 0) return null;
    // Footnote ids/backlinks require one document-wide renderer. Nested definitions
    // and semantic HTML likewise cannot safely be relocated between fragments.
    if (node.type === "html" || node.type.startsWith("footnote")) return null;
    if (
      node !== tree &&
      node.children?.some((child) => child.type === "definition")
    )
      return null;
    if (node.children) {
      if (pending.length + node.children.length > budget.remaining) return null;
      pending.push(...node.children);
    }
  }
  const nodes = tree.children ?? [];
  const blocks: Segment[] = [];
  let definitions = "";
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const start = index === 0 ? 0 : node.position?.start.offset;
    const end =
      index + 1 < nodes.length
        ? nodes[index + 1].position?.start.offset
        : source.length;
    if (start == null || end == null) return null;
    const raw = source.slice(start, end);
    if (node.type === "definition") definitions += raw;
    else
      blocks.push({
        raw,
        markdown: raw,
        kind:
          node.type === "heading"
            ? `heading:${node.depth}`
            : node.type === "list"
              ? `list:${!!node.ordered}`
              : node.type,
      });
  }
  if (!blocks.length && source.length) return null;
  if (definitions) {
    for (const block of blocks) block.markdown += `\n\n${definitions}`;
  }
  return { blocks, definitions };
}

/** Positional structural pairing only; equal syntax never proves semantic alignment.
 * Raw slices retain source whitespace, fences and definitions without serialization. */
export function pairMarkdownBlocks(
  original: string,
  variant: string,
): MarkdownBlockPairing {
  const grouped = (): MarkdownBlockPairing => ({
    alignment: "grouped",
    pairs: [
      {
        original: { raw: original, markdown: original, kind: "document" },
        variant: { raw: variant, markdown: variant, kind: "document" },
      },
    ],
    originalDefinitions: "",
    variantDefinitions: "",
  });
  const budget = { remaining: nodeLimit };
  const source = documentBlocks(original, budget);
  const result = source && documentBlocks(variant, budget);
  if (
    !source ||
    !result ||
    !source.blocks.length ||
    source.blocks.length !== result.blocks.length ||
    source.blocks.some(
      (block, index) => block.kind !== result.blocks[index].kind,
    )
  )
    return grouped();
  return {
    alignment: "blocks",
    pairs: source.blocks.map((block, index) => ({
      original: block,
      variant: result.blocks[index],
    })),
    originalDefinitions: source.definitions,
    variantDefinitions: result.definitions,
  };
}

// Markdown resolves reference labels document-wide. Namespace only reference syntax
// in copy output, so independent source/variant definitions cannot redirect links.
// Captions, destinations, code and all other authored source remain byte-for-byte.
function copyReferences(source: string, namespace: string): string {
  if (!source.includes("]:")) return source;
  const tree: SyntaxNode = parser.parse(source);
  const nodes: SyntaxNode[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      node.type === "definition" ||
      node.type === "linkReference" ||
      node.type === "imageReference" ||
      node.type === "footnoteDefinition" ||
      node.type === "footnoteReference"
    )
      nodes.push(node);
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index]);
    }
  }
  const names = new Map<string, string>();
  const footnotes = new Map<string, string>();
  // Use one generated label per normalized identifier: first-definition precedence
  // and duplicate-definition behavior remain the canonical Markdown parser's own.
  for (const node of nodes) {
    const identifiers = node.type === "footnoteDefinition" ? footnotes : names;
    if (
      (node.type === "definition" || node.type === "footnoteDefinition") &&
      node.identifier &&
      !identifiers.has(node.identifier)
    )
      identifiers.set(
        node.identifier,
        `${namespace}${node.type === "footnoteDefinition" ? "footnote-" : ""}${identifiers.size}`,
      );
  }
  if (!names.size && !footnotes.size) return source;
  const edits: { start: number; end: number; value: string }[] = [];
  const unescaped = (raw: string, index: number) => {
    let slashes = 0;
    for (let at = index - 1; at >= 0 && raw[at] === "\\"; at--) slashes++;
    return slashes % 2 === 0;
  };
  for (const node of nodes) {
    const footnote =
      node.type === "footnoteDefinition" || node.type === "footnoteReference";
    const name =
      node.identifier && (footnote ? footnotes : names).get(node.identifier);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (!name || start == null || end == null) continue;
    const raw = source.slice(start, end);
    if (node.type === "definition" || footnote) {
      const opening = raw.indexOf("[") + (footnote ? 1 : 0);
      for (let at = opening + 1; at < raw.length; at++) {
        if (raw[at] === "]" && unescaped(raw, at)) {
          edits.push({
            start: start + opening + 1,
            end: start + at,
            value: name,
          });
          break;
        }
      }
    } else if (node.referenceType === "shortcut") {
      edits.push({ start: end, end, value: `[${name}]` });
    } else {
      // Full/collapsed references end in their reference-label brackets. Escaped
      // brackets inside a label must not be mistaken for that final opening edge.
      for (let at = raw.length - 2; at >= 0; at--) {
        if (raw[at] === "[" && unescaped(raw, at)) {
          edits.push({ start: start + at + 1, end: end - 1, value: name });
          break;
        }
      }
    }
  }
  for (const edit of edits.sort((left, right) => right.start - left.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

/** Copy follows exactly the rendered original/variant pair order. Definitions are
 * emitted once per input document, rather than repeating fragment render context.
 * Reference identifiers are scoped for the combined document's link resolution. */
export function interleavedMarkdownText(
  original: string,
  variant: string,
): string {
  // Pick a prefix absent from either input, including unresolved reference text.
  let namespace = "interleaved-";
  while (original.includes(namespace) || variant.includes(namespace))
    namespace += "x-";
  const plan = pairMarkdownBlocks(
    copyReferences(original, `${namespace}original-`),
    copyReferences(variant, `${namespace}variant-`),
  );
  const body = plan.pairs
    .flatMap((pair) => [pair.original.raw, pair.variant.raw])
    .join("\n\n---\n\n");
  return (
    body +
    (plan.originalDefinitions ? `\n\n${plan.originalDefinitions}` : "") +
    (plan.variantDefinitions ? `\n\n${plan.variantDefinitions}` : "")
  );
}

export function InterleavedMarkdown({
  original,
  variant,
  label,
  citation,
  rich,
}: {
  original: string;
  variant: string;
  label: string;
  citation?: CitationScope;
  rich?: RichMarkdownContext;
}) {
  useSyncExternalStore(subscribeLocale, activeLocale, activeLocale);
  const id = useId();
  const plan = useMemo(
    () => pairMarkdownBlocks(original, variant),
    [original, variant],
  );
  return (
    <div className="markdown-interleaved" data-alignment={plan.alignment}>
      {plan.alignment === "grouped" && (
        <small className="muted">{t("variants.alignmentGrouped")}</small>
      )}
      {plan.pairs.map((pair, index) => (
        <Fragment key={index}>
          {index > 0 && <hr className="markdown-interleaved-divider" />}
          <div data-interleaved="original">
            <Markdown
              text={pair.original.markdown}
              allowImages={!!citation}
              citation={citation}
              rich={rich}
              idPrefix={`${id}original-`}
            />
          </div>
          <hr className="markdown-interleaved-divider" />
          <div data-interleaved="variant" aria-label={label}>
            <Markdown
              text={pair.variant.markdown}
              allowImages={false}
              idPrefix={`${id}variant-`}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
