import {
  PluginBlockVariant,
  useBlockTextVariant,
} from "./plugin-block-variants";
import { ActionMenu, type ActionMenuGroup } from "./action-menu";
import { InterleavedMarkdown } from "./markdown-interleaved";
import { InputSourceLabel } from "./InputSourceLabel";
import { isDirectUserSource } from "../client/input-source";
import {
  useQuestionImageScope,
  questionImageComponents,
  type QuestionImageScope,
} from "./questions/question-images";
import { markdownExtensions } from "./markdown-extensions";
import SvgBlock from "./visualizers/SvgBlock";
import { citationDestinations } from "./citations/parser";
import { citationComponents } from "./citations/FileCitation";
import { useCitationScope, type CitationScope } from "./citations/context";
import { stopReasonText } from "../client/stop-reason";
import { failureText } from "../client/failure";
import { t, activeLocale, subscribeLocale } from "../i18n";
import { childText } from "./childPresentation";
import { SecretCard } from "./questions/SecretCard";
import type { NativeHistoryView, PendingQuestion } from "../client/types";
import {
  Fragment,
  type ReactNode,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { createContext, useContext } from "react";
import { VisualPreview, visualLanguage } from "./visualizers/VisualPreview";
import { MathNode } from "./visualizers/MathNode";
import { closedFence } from "./visualizers/policy";
import { ChartInteractions } from "./visualizers/chart-interactions";
import { useAppDispatch, useAppSelector } from "../state";
import {
  useConversationBlock,
  useConversationBlocks,
} from "./conversation/registry-context";
import { Payload } from "./Payload";
import { CodeText, syntaxForLanguage } from "./content-inspection/CodeText";
import { ContentViewer } from "./content-inspection/ContentViewer";
import { ContentDialog, useInContentDialog } from "./ContentDialog";
import {
  CHILD_STATUS_ICON,
  childDisplayStatus,
  TOOL_STATUS_ICON,
  isActiveToolStatus,
  toolDisplayStatus,
  toolOutcomeCounts,
} from "./tool-status";
import { ConversationImages } from "./composer/Images";
import {
  Icon,
  childId,
  elapsed,
  formatNumber,
  isCompactInstruction,
  isCompactResult,
  lower,
  type FeatureBlock,
} from "./shared";

function headingAttributes() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (node.type === "heading") {
        const last = node.children?.at(-1);
        const match =
          last?.type === "text" ? /\s+\{([^{}]*)\}\s*$/.exec(last.value) : null;
        if (match) {
          const properties: Record<string, unknown> = {};
          const classes: string[] = [];
          for (const token of match[1].match(
            /(?:[^\s"']+|"[^"]*"|'[^']*')+/g,
          ) ?? []) {
            if (token.startsWith("#")) properties.id = token.slice(1);
            else if (token.startsWith(".")) classes.push(token.slice(1));
          }
          if (classes.length) properties.className = classes;
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, ...properties },
          };
          last.value = last.value.slice(0, match.index);
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function extractText(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node) && (node.props as any)?.children) {
    return extractText((node.props as any).children);
  }
  return "";
}

export function CodeBlock({
  language = "text",
  children,
  visual = false,
  rawSource,
  chartInteractions,
}: {
  language?: string;
  children: any;
  visual?: boolean;
  rawSource?: string;
  chartInteractions?: ChartInteractions;
}) {
  const localInteractions = useRef<ChartInteractions | null>(null);
  if (!localInteractions.current)
    localInteractions.current = new ChartInteractions();
  const interactions = chartInteractions ?? localInteractions.current;
  const [format, setFormat] = useState("preview");
  const [copied, setCopied] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const inContentDialog = useInContentDialog();
  const [copyFailed, setCopyFailed] = useState(false);
  const source = rawSource ?? extractText(children);
  const text = rawSource ?? source.replace(/\n$/, "");
  const rich = visual && visualLanguage(language);
  const raw = (
    <pre
      className="code-block-pre"
      tabIndex={0}
      role="region"
      aria-label={t("code.label", { language: language || "text" })}
    >
      <CodeText text={source} kind={syntaxForLanguage(language)} />
    </pre>
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (copied || !text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <div className="code-block-card" data-testid="code-block">
      <div className="code-block-header">
        {rich ? (
          <select
            className="visual-format"
            aria-label={t("contentViewer.format")}
            value={format}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="preview">{t("visual.preview")}</option>
            <option value="raw">{t("contentViewer.raw")}</option>
          </select>
        ) : (
          <span className="code-block-lang">{language || "text"}</span>
        )}
        <div className="code-block-actions">
          {!inContentDialog && (
            <button
              type="button"
              className="code-block-copy-btn"
              title={t("content.expand")}
              aria-label={t("content.expand")}
              onClick={() => setInspecting(true)}
            >
              <Icon name="expand" size={12} />
            </button>
          )}
          <button
            type="button"
            className="code-block-copy-btn"
            onClick={handleCopy}
            title={t(copied ? "common.copied" : "code.copy")}
          >
            <Icon name={copied ? "check" : "copy"} className="copy-icon" />
            <span aria-live="polite">
              {t(
                copied
                  ? "common.copied"
                  : copyFailed
                    ? "common.copyFailed"
                    : "common.copy",
              )}
            </span>
          </button>
        </div>
      </div>
      {rich && format === "preview" ? (
        <VisualPreview
          language={language}
          source={source}
          fallback={raw}
          interactions={interactions}
        />
      ) : (
        raw
      )}
      {inspecting && !inContentDialog && (
        <ContentDialog
          maximizable
          title={t("code.label", { language })}
          onClose={() => setInspecting(false)}
        >
          {rich ? (
            <CodeBlock
              language={language}
              visual
              rawSource={source}
              chartInteractions={interactions}
            >
              {source}
            </CodeBlock>
          ) : (
            <ContentViewer
              source={text}
              defaultFormat={
                syntaxForLanguage(language) === "raw"
                  ? "raw"
                  : syntaxForLanguage(language)
              }
            />
          )}
        </ContentDialog>
      )}
    </div>
  );
}

export type RichMarkdownContext = { streaming: boolean };
const RichContext = createContext<{ text: string; enabled: boolean }>({
  text: "",
  enabled: false,
});
function mathProperties(options: { source: string }) {
  return (tree: any) => {
    const visit = (node: any) => {
      if (node.type === "math" || node.type === "inlineMath") {
        const raw = options.source.slice(
          node.position.start.offset,
          node.position.end.offset,
        );
        node.data = {
          hName: "span",
          hProperties: {
            "data-math-source": node.value,
            "data-math-raw": raw,
            "data-math-display": node.type === "math" ? "true" : "false",
          },
          hChildren: [{ type: "text", value: raw }],
        };
      } else node.children?.forEach(visit);
    };
    visit(tree);
  };
}
// ReactMarkdown uses renderer functions as element types. Recreating them during
// a parent update would remount unchanged code/details and discard native focus.
const markdownComponents: Components = {
  input: ({ node: _node, ...props }) =>
    props.type === "checkbox" ? (
      <input
        {...props}
        aria-label={t(
          props.checked ? "markdown.taskDone" : "markdown.taskOpen",
        )}
      />
    ) : (
      <input {...props} />
    ),
  table: ({ children }) => (
    <div className="table-container markdown-table-container" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  pre: ({ children, node }) => {
    const context = useContext(RichContext);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const fence =
      start != null && end != null ? context.text.slice(start, end) : "";
    const closed = closedFence(fence);
    const opening = /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(fence);
    const body = opening
      ? fence.slice(
          opening[0].length,
          closed ? fence.lastIndexOf("\n") + 1 : undefined,
        )
      : undefined;
    let lang = "text";
    let codeContent = children;
    if (isValidElement(children)) {
      const childProps = children.props as any;
      if (childProps) {
        if (childProps.className) {
          const match = /(?:^|\s)language-(\S+)/.exec(childProps.className);
          if (match) lang = match[1];
        }
        codeContent = childProps.children ?? children;
      }
    }
    return (
      <CodeBlock
        language={lang}
        visual={context.enabled && closed}
        rawSource={visualLanguage(lang) ? body : undefined}
      >
        {codeContent}
      </CodeBlock>
    );
  },
  span: ({ children, ...props }) => {
    const data = props as any;
    if (typeof data["data-inline-svg"] === "string") {
      const source = data["data-inline-svg"];
      return (
        <SvgBlock
          inline
          source={source}
          fallback={<code className="inline-svg-source">{source}</code>}
        />
      );
    }
    return typeof data["data-math-source"] === "string" ? (
      <MathNode
        source={data["data-math-source"]}
        raw={data["data-math-raw"]}
        display={data["data-math-display"] === "true"}
      />
    ) : (
      <span>{children}</span>
    );
  },
};

const markdownWithoutImages: Components = {
  ...markdownComponents,
  img: ({ alt }) => <span>{alt}</span>,
};

// remark-rehype scopes footnote references, but its section heading has a fixed id.
function footnoteHeadingPrefix({ prefix }: { prefix: string }) {
  type Node = { properties?: Record<string, unknown>; children?: Node[] };
  return (tree: Node) => {
    const visit = (node: Node) => {
      const props = node.properties;
      if (props?.id === "footnote-label") props.id = `${prefix}footnote-label`;
      const describedBy = props?.ariaDescribedBy;
      if (Array.isArray(describedBy))
        props!.ariaDescribedBy = describedBy.map((value) =>
          value === "footnote-label" ? `${prefix}footnote-label` : value,
        );
      else if (typeof describedBy === "string")
        props!.ariaDescribedBy = describedBy
          .split(/\s+/)
          .map((value) =>
            value === "footnote-label" ? `${prefix}footnote-label` : value,
          )
          .join(" ");
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export const Markdown = memo(function Markdown({
  text,
  allowImages = true,
  rich,
  citation,
  questionImages,
  idPrefix,
}: {
  text: string;
  allowImages?: boolean;
  rich?: RichMarkdownContext;
  citation?: CitationScope;
  questionImages?: QuestionImageScope;
  idPrefix?: string;
}) {
  useSyncExternalStore(subscribeLocale, activeLocale, activeLocale);
  const enabled = !!rich && !rich.streaming;
  const context = useMemo(() => ({ text, enabled }), [text, enabled]);
  const components = useMemo(
    () =>
      questionImages && allowImages
        ? { ...markdownComponents, ...questionImageComponents(questionImages) }
        : citation && allowImages
          ? { ...markdownComponents, ...citationComponents(citation) }
          : allowImages
            ? markdownComponents
            : markdownWithoutImages,
    [citation, questionImages, allowImages],
  );
  const plugins = useMemo(() => {
    const result: any[] = [
      remarkGfm,
      headingAttributes,
      [markdownExtensions, { source: text, rich: enabled }],
    ];
    if (enabled) result.push(remarkMath, [mathProperties, { source: text }]);
    if ((citation || questionImages) && allowImages)
      result.push(citationDestinations);
    return result;
  }, [enabled, text, citation, questionImages, allowImages]);
  return (
    <RichContext.Provider value={context}>
      <div className="markdown-body markdown-content">
        <ReactMarkdown
          remarkPlugins={plugins}
          skipHtml
          components={components}
          {...(idPrefix === undefined
            ? {}
            : {
                remarkRehypeOptions: { clobberPrefix: idPrefix },
                rehypePlugins: [[footnoteHeadingPrefix, { prefix: idPrefix }]],
              })}
        >
          {text}
        </ReactMarkdown>
      </div>
    </RichContext.Provider>
  );
});
export function Think({
  text,
  streaming,
  incomplete = false,
}: {
  text: string;
  streaming: boolean;
  incomplete?: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);
  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);
  const count = [...text].length;
  return (
    <div
      className="think-card"
      data-testid="think-block"
      data-expanded={expanded}
      data-streaming={streaming}
      data-incomplete={incomplete}
    >
      <div className="think-header" onClick={() => setExpanded(!expanded)}>
        <div className="think-badge">
          <span className="think-title">
            {t(
              incomplete
                ? "think.incomplete"
                : streaming
                  ? "think.streaming"
                  : "think.done",
            )}
          </span>
          {!streaming && count > 0 && (
            <span className="think-summary">
              {t("think.chars", {
                count: count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count,
              })}
            </span>
          )}
        </div>
        <button
          className="think-toggle-btn"
          type="button"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {t(expanded ? "common.collapse" : "common.expand")}
          <Icon name={expanded ? "up" : "down"} size={12} aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <div className="think-content">
          <Markdown text={text} allowImages={false} rich={{ streaming }} />
        </div>
      )}
    </div>
  );
}
export function CompactionSummaryCard({
  title,
  summary,
  shadowedCount,
  streaming = false,
  id,
}: {
  title?: string;
  summary?: string;
  shadowedCount?: number;
  streaming?: boolean;
  id?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = !!summary?.trim();
  return (
    <div className="compaction-row" id={id}>
      <button
        className="compaction-header-btn"
        type="button"
        aria-expanded={hasSummary ? expanded : undefined}
        disabled={!hasSummary}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="compaction-leading-slot">
          <Icon name="database" className="compaction-icon" />
          {hasSummary && (
            <Icon
              name="chevron"
              size={12}
              className={`compaction-chevron${expanded ? " open" : ""}`}
            />
          )}
        </span>
        <span className="compaction-title">
          {title ?? t("compaction.title")}
        </span>
        <span className="compaction-sep" aria-hidden="true" />
        <span className="compaction-stats-label">
          {streaming
            ? t("compaction.streaming")
            : shadowedCount
              ? t("compaction.count", { count: shadowedCount })
              : t("compaction.done")}
        </span>
      </button>
      {expanded && hasSummary && (
        <div className="compaction-body">
          <Markdown text={summary!} allowImages={false} rich={{ streaming }} />
        </div>
      )}
    </div>
  );
}
export function toolArgsSummary(block: FeatureBlock) {
  const tool = block.tool;
  if (tool?.title?.trim()) return tool.title.trim();
  const input = tool?.input;
  if (!input) return "";
  return typeof input === "string"
    ? input
    : Object.entries(input)
        .filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value),
        )
        .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ")}`)
        .join(", ");
}
type ToolProps = {
  block: FeatureBlock;
  interactionKey?: string;
  isOpen?: boolean;
  onToggle?: () => void;
};
export function Tool(props: ToolProps) {
  const { block, version, locale } = useConversationBlock(props.block);
  const handlers = useRef(props);
  handlers.current = props;
  const onToggle = useCallback(() => handlers.current.onToggle?.(), []);
  return (
    <ToolContent
      {...props}
      block={block}
      version={version}
      locale={locale}
      onToggle={props.onToggle ? onToggle : undefined}
    />
  );
}
const ToolContent = memo(function ToolContent({
  block,
  isOpen,
  onToggle,
  interactionKey,
}: ToolProps & { version: number | string; locale?: string }) {
  const [local, setLocal] = useState(false);
  const expanded = isOpen ?? local;
  const name = block.tool?.name ?? "tool";
  const rawStatus = block.tool?.status;
  const status = toolDisplayStatus(rawStatus);
  const summary = toolArgsSummary(block);
  const ms = elapsed(block);
  const duration =
    ms == null ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const bodyId = useId();
  const noInput =
    block.tool?.input == null || JSON.stringify(block.tool.input) === "{}";
  const statusLabel = t(`tools.status.${status}`);
  const active = isActiveToolStatus(status);
  return (
    <div
      className="tool-accordion-row"
      data-reading-id={interactionKey ?? block.id}
      data-interaction-key={interactionKey}
      data-expanded={expanded}
      data-status={status}
    >
      <button
        type="button"
        className="tool-accordion-header"
        data-testid="tool-row"
        data-tool={name}
        data-status={status}
        data-raw-status={rawStatus ?? undefined}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-busy={active || undefined}
        aria-label={`${name} · ${summary || name} · ${statusLabel}`}
        onClick={() => (onToggle ? onToggle() : setLocal(!local))}
      >
        <span
          className="tool-status-glyph"
          data-testid="tool-status-glyph"
          data-status={status}
          aria-hidden="true"
        >
          <Icon name={TOOL_STATUS_ICON[status]} size={14} />
        </span>
        <span className="tool-name">{name}</span>
        <span className="tool-dot-sep" />
        <span className="tool-summary-text" title={summary || undefined}>
          {summary || name}
        </span>
        {status === "running" && duration ? (
          <span className="tool-duration-tag">{duration}</span>
        ) : status === "succeeded" && ms != null && ms >= 200 ? (
          <span className="tool-duration-tag">{duration}</span>
        ) : null}
        {status !== "succeeded" && (
          <span
            className="tool-status-label"
            data-testid="tool-status-label"
            data-status={status}
          >
            {statusLabel}
          </span>
        )}
        <span className="tool-chevron-icon">
          <Icon name="chevron" />
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="tool-accordion-body tool-expanded-body">
          <Payload
            label={t("tools.arguments")}
            value={noInput ? null : block.tool?.input}
            testid="tool-payload-input"
            variant="trajectory"
            dialogTitle={`${name} · ${t("tools.arguments")}`}
          />
          <Payload
            label={t(status === "failed" ? "tools.error" : "tools.output")}
            status={status === "failed" ? "error" : status}
            value={block.payload.text}
            testid="tool-payload-output"
            variant="trajectory"
            dialogTitle={`${name} · ${t(status === "failed" ? "tools.error" : "tools.output")}`}
            empty={noInput ? t("tools.noContent") : undefined}
          />
          {!!block.payload.attachments?.length && (
            <ConversationImages images={block.payload.attachments} />
          )}
        </div>
      )}
    </div>
  );
});
export interface ToolGroupPresentation {
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
  partial?: boolean;
  grouped?: boolean;
  active?: boolean;
  rowKey?: (block: FeatureBlock) => string;
  renderBlockSlot?: (
    block: FeatureBlock,
    placement: "before" | "after",
  ) => ReactNode;
}
export function ToolAccordionGroup({
  tools: fallback,
  expanded: controlledExpanded,
  onExpandedChange,
  openId: controlledOpenId,
  onOpenChange,
  partial = false,
  grouped = false,
  active = false,
  rowKey,
  renderBlockSlot,
}: { tools: FeatureBlock[] } & ToolGroupPresentation) {
  const tools = useConversationBlocks(fallback);
  const [localExpanded, setExpanded] = useState(false);
  const [localOpenId, setOpenId] = useState<string | null>(null);
  const expanded = controlledExpanded ?? localExpanded;
  const openId =
    controlledOpenId === undefined ? localOpenId : controlledOpenId;
  const statuses = tools.map((b) => toolDisplayStatus(b.tool?.status));
  const running = active || statuses.some(isActiveToolStatus);
  const outcomes = toolOutcomeCounts(statuses);
  const groupStatus = running
    ? "running"
    : outcomes.failed
      ? "failed"
      : statuses.length && outcomes.succeeded === statuses.length
        ? "succeeded"
        : "mixed";
  const outcomeParts = (
    [
      ["failed", "tools.failedCount"],
      ["cancelled", "tools.cancelledCount"],
      ["interrupted", "tools.interruptedCount"],
      ["unknown", "tools.unknownCount"],
    ] as const
  ).filter(([status]) => outcomes[status]);
  const title = t(
    grouped
      ? partial
        ? "conversation.toolGroupCountLoaded"
        : "conversation.toolGroupCount"
      : partial
        ? "conversation.toolCountLoaded"
        : "conversation.toolCount",
    { count: tools.length },
  );
  return (
    <div
      className="tool-accordion-group"
      data-testid="tool-group"
      data-status={groupStatus}
    >
      <button
        type="button"
        className="tool-accordion-group-header"
        aria-expanded={expanded}
        onClick={() => (onExpandedChange ?? setExpanded)(!expanded)}
      >
        <span className="group-header-left">
          <span className="tool-group-title tool-group-seg">{title}</span>
          {running && (
            <span
              className="tool-group-seg tool-group-active"
              data-expanded={expanded}
            >
              <span className="tool-group-sep" aria-hidden="true">
                {" · "}
              </span>
              {t("conversation.toolTurnActive")}
            </span>
          )}
          {outcomeParts.length > 0 && (
            <span
              className="tool-group-outcomes"
              data-testid="tool-group-outcomes"
            >
              {outcomeParts.map(([status, key]) => (
                <span
                  key={status}
                  className="tool-group-seg"
                  data-status={status}
                >
                  <span className="tool-group-sep" aria-hidden="true">
                    {" · "}
                  </span>
                  {t(key, { count: outcomes[status] ?? 0 })}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="group-header-right">
          <span className="group-toggle-btn" data-open={expanded}>
            <Icon name="chevron" size={14} />
          </span>
        </span>
      </button>
      {expanded && (
        <div className="tool-accordion-items">
          {tools.map((b) => (
            <Fragment key={rowKey?.(b) ?? b.id}>
              {renderBlockSlot?.(b, "before")}
              <Tool
                interactionKey={rowKey?.(b)}
                block={b}
                isOpen={openId === b.id}
                onToggle={() => {
                  const id = b.id;
                  (onOpenChange ?? setOpenId)(openId === id ? null : id);
                }}
              />
              {renderBlockSlot?.(b, "after")}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
/** Display-layer status kind for subagent chrome (card / group / menu).
 * Absent status is `unknown`; never inferred as completed. */
const subagentStatusKind = childDisplayStatus;

export function SubagentAccordionGroup({
  blocks: fallback,
  readOnly = false,
  renderBlockSlot,
}: {
  blocks: FeatureBlock[];
  readOnly?: boolean;
  renderBlockSlot?: (
    block: FeatureBlock,
    placement: "before" | "after",
  ) => ReactNode;
}) {
  const blocks = useConversationBlocks(fallback);
  const dispatch = useAppDispatch();
  const [expanded, setExpanded] = useState(false);
  const uniqueBlocks = useMemo(() => {
    const map = new Map<string, FeatureBlock>();
    for (const b of blocks) {
      const id = childId(b) || b.id;
      const prev = map.get(id);
      const prevHasText =
        prev &&
        prev.payload.text.trim() &&
        !prev.payload.text.trim().startsWith("SubAgent (");
      const bHasText =
        b.payload.text.trim() &&
        !b.payload.text.trim().startsWith("SubAgent (");
      if (!prev || (!prevHasText && bHasText)) {
        map.set(id, b);
      }
    }
    return Array.from(map.values());
  }, [blocks]);

  const running = uniqueBlocks.some(
    (b) =>
      lower(b.stream) === "streaming" ||
      (b.tool?.childBinding === "execution" &&
        ["running", "cancelling"].includes(b.tool.status ?? "")) ||
      b.payload.structured?.status === "busy",
  );

  return (
    <div className="tool-accordion-group subagent-accordion-group">
      <button
        type="button"
        className="tool-accordion-group-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="group-header-left">
          <span className="tool-group-title">
            {t(running ? "subagent.groupRunning" : "subagent.groupDispatched", {
              count: uniqueBlocks.length,
            })}
          </span>
        </span>
        <span className="group-header-right">
          <span className="group-toggle-btn" data-open={expanded}>
            <Icon name="chevron" size={14} />
          </span>
        </span>
      </button>
      {expanded && (
        <div className="tool-accordion-items subagent-accordion-items">
          {uniqueBlocks.map((b) => {
            const id = childId(b);
            const kind = subagentStatusKind(
              lower(b.stream) === "streaming"
                ? "running"
                : (b.tool?.childBinding
                    ? childText(b.tool.status)
                    : childText(b.payload.structured?.status)) ||
                    // Legacy builtin receipts project "completed" explicitly;
                    // anything absent stays unknown.
                    (b.tool?.childBinding === "legacy" ? b.tool?.status : ""),
            );
            const title =
              childText(b.tool?.childTarget) ||
              b.payload.text.trim() ||
              childText(b.tool?.input?.prompt) ||
              childText(b.payload.structured?.title) ||
              `SubAgent (${id})`;
            return (
              <Fragment key={b.id || id}>
                {renderBlockSlot?.(b, "before")}
                <div
                  className="subagent-group-item"
                  data-readonly={readOnly ? "true" : undefined}
                  title={readOnly ? t("subagent.readOnly") : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (id && !readOnly)
                      dispatch({ type: "OpenSubAgentDetail", value: id });
                  }}
                >
                  <span
                    className={`subagent-status-dot-sm ${kind === "succeeded" ? "completed" : kind}`}
                    data-status={kind}
                    aria-hidden="true"
                  />
                  <span className="subagent-item-title">{title}</span>
                  <span
                    className="subagent-item-status"
                    data-testid="subagent-item-status"
                    data-status={kind}
                  >
                    {t(`subagent.status.${kind}`)}
                  </span>
                  <button
                    className="subagent-item-detail-btn"
                    type="button"
                    disabled={!id || readOnly}
                    title={readOnly ? t("subagent.readOnly") : undefined}
                  >
                    {id ? t("subagent.details") : t("subagent.awaitingReceipt")}
                  </button>
                </div>
                {renderBlockSlot?.(b, "after")}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
/** Raw status for a child card: structured/bound status, a legacy
 * "title · status" suffix, streaming → running; otherwise unknown. */
export function subagentCardRawStatus(block: FeatureBlock) {
  const structuredStatus = block.tool?.childBinding
    ? childText(block.tool.status)
    : block.tool?.name === "delegate"
      ? childText(block.payload.structured?.status) || "unknown"
      : childText(block.payload.structured?.status) || block.tool?.status;
  const split = structuredStatus ? -1 : block.payload.text.lastIndexOf(" · ");
  return structuredStatus
    ? structuredStatus
    : split >= 0
      ? block.payload.text.slice(split + 3).trim()
      : block.stream === "streaming"
        ? "running"
        : "unknown";
}
export function SubAgentCard({
  block,
  readOnly = false,
}: {
  block: FeatureBlock;
  readOnly?: boolean;
}) {
  const dispatch = useAppDispatch();
  const id = childId(block);
  const structuredStatus = block.tool?.childBinding
    ? childText(block.tool.status)
    : block.tool?.name === "delegate"
      ? childText(block.payload.structured?.status) || "unknown"
      : childText(block.payload.structured?.status) || block.tool?.status;
  const split = structuredStatus ? -1 : block.payload.text.lastIndexOf(" · ");
  const title =
    childText(block.tool?.childTarget) ||
    childText(block.tool?.input?.subagent) ||
    childText(block.tool?.input?.prompt) ||
    (split < 0
      ? (
          childText(block.payload.structured?.title) ||
          block.payload.text ||
          ""
        ).trim()
      : block.payload.text.slice(0, split).trim()) ||
    "Subagent";
  const rawStatus = subagentCardRawStatus(block);
  const status = subagentStatusKind(rawStatus);
  return (
    <div
      className="subagent-card"
      data-status={status}
      data-readonly={readOnly ? "true" : undefined}
      title={readOnly ? t("subagent.readOnly") : undefined}
      onClick={() =>
        !readOnly && id && dispatch({ type: "OpenSubAgentDetail", value: id })
      }
    >
      <div className="subagent-card-header">
        <div className="subagent-icon-badge">
          <Icon name="bot" size={16} aria-hidden="true" />
        </div>
        <div className="subagent-info">
          <div className="subagent-title">{title}</div>
          <div className="subagent-meta">
            <span
              className={`subagent-status-tag ${status === "succeeded" ? "completed" : status}`}
              data-testid="subagent-status"
              data-status={status}
              data-raw-status={rawStatus || undefined}
            >
              <Icon
                name={CHILD_STATUS_ICON[status]}
                size={12}
                aria-hidden="true"
                className={
                  status === "running" || status === "cancelling"
                    ? "animate-spin"
                    : undefined
                }
              />
              {t(`subagent.status.${status}`)}
            </span>
            {id && <span className="subagent-id-tag">{id}</span>}
          </div>
        </div>
        <div className="subagent-action">
          <span className="subagent-open-btn">
            {t("subagent.open")}
            <Icon name="expand" size={12} aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  );
}
/** Explicit content stamp for standalone render fixtures without a registry.
 * Production conversation rendering subscribes to block versions below. */
export function blockRenderKey(block: FeatureBlock, locale: string): string {
  const kind = lower(block.kind);
  if (kind !== "text" && kind !== "reasoning") {
    return `${locale}\u001f${JSON.stringify(block)}`;
  }
  const payload = block.payload;
  return JSON.stringify([
    locale,
    block.id,
    block.role,
    kind,
    block.stream,
    block.isCompact,
    payload.text,
    payload.mime,
    payload.formatHint,
    payload.failure,
    payload.attachments,
    block.preview?.truncated,
    block.preview?.canonicalMessageId,
  ]);
}
/** The registry version is this block's subscription boundary. A contentKey is
 * optional for standalone render fixtures; the production list never stamps text. */
export const BlockView = memo(function BlockView({
  block: fallback,
  readOnly = false,
}: {
  block: FeatureBlock;
  readOnly?: boolean;
  contentKey?: string;
}) {
  const { block } = useConversationBlock(fallback);
  const citation = useCitationScope(block);
  const { variant, mode } = useBlockTextVariant(block);
  const replacement =
    !readOnly && mode === "variant" && variant?.status === "completed"
      ? variant.text
      : undefined;
  // Opt-in acceptance instrumentation counts actual React block renders;
  // the registry remains the sole content/subscription authority.
  const counts = (
    globalThis as unknown as {
      __mcRenderCounts?: Record<string, number>;
    }
  ).__mcRenderCounts;
  if (counts) counts[block.id] = (counts[block.id] ?? 0) + 1;
  const kind = lower(block.kind);
  const text = block.payload.text;
  if (
    isCompactInstruction(block) ||
    isCompactResult(block) ||
    kind === "compaction"
  )
    return (
      <CompactionSummaryCard
        summary={
          isCompactResult(block) || kind === "compaction" ? text : undefined
        }
        streaming={lower(block.stream) === "streaming"}
      />
    );
  let json = /json/i.test(`${block.payload.formatHint} ${block.payload.mime}`);
  let pretty = text;
  if (/^\s*[\[{]/.test(text)) {
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
      json = true;
    } catch {
      /* Incomplete streamed JSON remains readable text. */
    }
  }
  const view =
    kind === "reasoning"
      ? "think"
      : kind === "tool"
        ? "tool"
        : kind === "child"
          ? "subagent"
          : json && !["error", "status"].includes(kind)
            ? "json"
            : "text";
  return (
    <article
      className={`block${lower(block.stream) === "error" ? " block-stream-error" : ""}`}
      data-testid="chat-message"
      data-role={lower(block.role) === "user" ? "user" : "assistant"}
      data-kind={view}
      data-stream={lower(block.stream)}
    >
      <div
        className={`block-body${lower(block.role) === "user" ? " user-bubble" : ""}`}
      >
        {lower(block.role) === "user" && (
          <InputSourceLabel source={block.payload.source} />
        )}
        {block.temporary &&
          block.role === "user" &&
          isDirectUserSource(block.payload.source) &&
          block.submissionStatus && (
            <div
              className="block-incomplete"
              role="status"
              data-testid="input-admission-status"
              data-status={block.submissionStatus}
            >
              {t(
                `composer.input${block.submissionStatus === "admitted" ? "Waiting" : block.submissionStatus === "unknown" ? "Unknown" : "Submitting"}`,
              )}
            </div>
          )}
        {block.preview &&
          (!block.preview.canonicalMessageId ||
            (kind === "reasoning" && block.preview.truncated)) &&
          block.stream === "stopped" &&
          ["text", "reasoning"].includes(kind) && (
            <div
              className="block-incomplete"
              role="status"
              data-testid="incomplete-output"
            >
              {t(
                block.preview.truncated
                  ? "conversation.incompleteTruncated"
                  : "conversation.incomplete",
              )}
              {stopReasonText(block.payload.stopReason ?? {}) && (
                <span> · {stopReasonText(block.payload.stopReason)}</span>
              )}
            </div>
          )}
        {block.payload.failure ? (
          <div role="status" data-testid="operation-failure">
            <strong>
              {t(
                block.payload.failure.code === "cancelled"
                  ? "stopReason.heading"
                  : "failure.heading",
              )}
            </strong>
            <div style={{ whiteSpace: "pre-wrap" }}>
              {failureText(block.payload.failure)}
            </div>
          </div>
        ) : kind === "reasoning" ? (
          <Think
            text={text}
            streaming={lower(block.stream) === "streaming"}
            incomplete={block.displayIncomplete === true}
          />
        ) : kind === "tool" ? (
          <Tool block={block} />
        ) : kind === "child" ? (
          <SubAgentCard block={block} readOnly={readOnly} />
        ) : ["error", "status"].includes(kind) ? (
          text
        ) : !readOnly && mode === "both" && variant?.status === "completed" ? (
          <InterleavedMarkdown
            original={text}
            variant={variant.text}
            label={variant.label}
            citation={citation}
            rich={{ streaming: lower(block.stream) === "streaming" }}
          />
        ) : replacement !== undefined ? (
          <Markdown text={replacement} allowImages={false} />
        ) : json ? (
          <pre tabIndex={0} role="region" aria-label="JSON">
            {pretty}
          </pre>
        ) : text ? (
          <Markdown
            text={text}
            allowImages={!!citation}
            citation={citation}
            rich={{ streaming: lower(block.stream) === "streaming" }}
          />
        ) : null}
        {!["reasoning", "tool", "child", "error", "status"].includes(kind) && (
          <ConversationImages images={block.payload.attachments ?? []} />
        )}
        {!readOnly && block.role === "assistant" && kind === "text" && (
          <PluginBlockVariant block={block} />
        )}
        {lower(block.role) === "user" &&
          isDirectUserSource(block.payload.source) &&
          lower(block.stream) === "error" && (
            <div className="block-error-badge" role="status">
              <Icon name="info" size={14} aria-hidden="true" />
              <span>
                {t("failure.sendFailed", {
                  message: block.payload.failure
                    ? failureText(block.payload.failure)
                    : t("failure.generic"),
                })}
              </span>
            </div>
          )}
      </div>
    </article>
  );
});
export function tokenUsage(block: FeatureBlock) {
  const meta = block.payload.providerMetadata ?? {};
  const u = meta.tokens ?? meta.usage;
  if (!u || typeof u !== "object") return null;
  // Canonical null is authoritative; aliases are only for older receipts.
  const count = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => candidate !== undefined);
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  };
  const input = count(u.input_tokens, u.input),
    output = count(u.output_tokens, u.output);
  const total = count(
    u.total_tokens,
    u.total,
    input !== null && output !== null ? input + output : undefined,
  );
  const result = {
    input,
    output,
    total,
    reasoning: count(u.reasoning_tokens, u.reasoning),
    cacheRead: count(
      u.cache_read_tokens,
      u.cache?.read,
      u.cache_read_input_tokens,
    ),
    cacheWrite: count(
      u.cache_write_tokens,
      u.cache?.write,
      u.cache_creation_input_tokens,
    ),
  };
  return Object.values(result).some((value) => value !== null) ? result : null;
}
// [!important] One user Turn can contain many model rounds. The Server's full
// selected-history summary owns first-request input and accepted-round output.
// Loaded blocks only select its exact scope; never sum a page or borrow usage.
export function answerTokenUsage(
  blocks: FeatureBlock[],
  historyView?: NativeHistoryView,
) {
  const output = [...blocks]
    .reverse()
    .find(
      (block) =>
        block.role === "assistant" &&
        ["text", "reasoning", "tool", "child"].includes(block.kind) &&
        !block.payload.failure,
    );
  const position = output?.position ?? output?.preview;
  if (position?.epoch == null || position.turn == null) return null;
  const summaries = historyView?.turns.filter(
    (turn) => turn.epoch === position.epoch && turn.turn === position.turn,
  );
  if (summaries?.length !== 1 || !summaries[0].usage) return null;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const input = count(summaries[0].usage.input_tokens);
  const outputTokens = count(summaries[0].usage.output_tokens);
  return input !== null || outputTokens !== null
    ? { input, output: outputTokens }
    : null;
}
export function ActionBar({
  text,
  timestamp,
  user = false,
  revertId,
  retryId,
  tokens,
  pluginActions,
  pluginActionScope,
}: {
  text: string;
  pluginActions?: readonly ActionMenuGroup[];
  pluginActionScope?: string;
  timestamp?: number | null;
  user?: boolean;
  revertId?: string;
  retryId?: string;
  tokens?: ReturnType<typeof answerTokenUsage>;
}) {
  const dispatch = useAppDispatch();
  const selected = useAppSelector((state) =>
    JSON.stringify({
      capabilities: state.capabilities,
      sessionStatus: state.transcript.sessionStatus,
      inboxActive: state.transcript.inboxActive,
      compactInflight: state.compactInflight,
      historyMutationPending: state.historyMutationPending,
      retryPending: state.retryPending,
      imageIntakePending: state.imageIntakePending,
      isCreatingSession: state.isCreatingSession,
      historyAvailable: state.historyAvailable,
      resolvedLocale: state.resolvedLocale,
    }),
  );
  const state = useMemo(() => JSON.parse(selected), [selected]);
  const [copied, setCopied] = useState(false);
  // Canonical messages do not all carry wall-clock timing. Keep a local display
  // fallback stable for this mounted bar; never feed it into execution timing.
  const [observedAt] = useState(Date.now);
  const hasSourceTime =
    timestamp != null && Number.isFinite(timestamp) && timestamp > 0;
  const displayTime = hasSourceTime ? timestamp : observedAt;
  const displayDate = new Date(displayTime);
  const padTime = (value: number) => String(value).padStart(2, "0");
  const utcOffset = -displayDate.getTimezoneOffset();
  const offsetMinutes = Math.abs(utcOffset);
  const detailedTime = `${displayDate.getFullYear()}-${padTime(displayDate.getMonth() + 1)}-${padTime(displayDate.getDate())} ${padTime(displayDate.getHours())}:${padTime(displayDate.getMinutes())}:${padTime(displayDate.getSeconds())} UTC${utcOffset >= 0 ? "+" : "-"}${padTime(Math.floor(offsetMinutes / 60))}:${padTime(offsetMinutes % 60)}`;
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      className={`message-action-bar ${user ? "user" : "assistant"}-action-bar`}
    >
      <div className="action-leading-group">
        <button
          className="action-icon-btn"
          title={t(
            copied
              ? "common.copied"
              : user
                ? "message.copyPrompt"
                : "message.copyAnswer",
          )}
          aria-label={t(
            copied
              ? "common.copied"
              : user
                ? "message.copyPrompt"
                : "message.copyAnswer",
          )}
          onClick={() => {
            if (!copied) {
              dispatch({ type: "CopyText", value: text });
              setCopied(true);
            }
          }}
        >
          <Icon
            name={copied ? "check" : "copy"}
            className={copied ? "check-icon" : "copy-icon"}
          />
        </button>
        {!!pluginActions?.length && (
          <ActionMenu key={pluginActionScope} items={pluginActions} />
        )}
        {revertId && (
          <button
            className="action-icon-btn action-undo-btn"
            title={t("conversation.undoTarget", {
              text: text.trim().slice(0, 80),
            })}
            aria-label={t("conversation.undoTarget", {
              text: text.trim().slice(0, 80),
            })}
            data-testid="undo-user-block"
            data-message-id={revertId}
            disabled={
              !state.capabilities?.methods.includes("history.travel") ||
              state.sessionStatus === "busy" ||
              state.inboxActive ||
              state.compactInflight ||
              state.historyMutationPending ||
              state.retryPending ||
              state.imageIntakePending ||
              state.isCreatingSession ||
              state.historyAvailable?.undo === false
            }
            onClick={() => dispatch({ type: "RevertTurn", value: revertId })}
          >
            <Icon name="undo" />
          </button>
        )}
        {retryId && (
          <button
            className="action-icon-btn action-retry-btn"
            title={t("conversation.retry")}
            aria-label={t("conversation.retry")}
            data-testid="retry-model-request"
            data-operation-id={retryId}
            disabled={
              !state.capabilities?.methods.includes("turn.retry") ||
              state.sessionStatus === "busy" ||
              state.inboxActive ||
              state.compactInflight ||
              state.retryPending ||
              state.historyMutationPending ||
              state.isCreatingSession
            }
            onClick={() => dispatch({ type: "RetryTurn", value: retryId })}
          >
            <Icon name="refresh" />
          </button>
        )}
      </div>
      <div className="action-trailing-info">
        {tokens && (
          <span
            className="token-usage-badge"
            data-testid="answer-token-usage"
            title={t("conversation.tokenUsage", {
              input: tokens.input === null ? "-" : formatNumber(tokens.input),
              output:
                tokens.output === null ? "-" : formatNumber(tokens.output),
            })}
          >
            {tokens.output === null ? "-" : formatNumber(tokens.output)} tokens
          </span>
        )}
        <time
          className="message-time-label"
          dateTime={displayDate.toISOString()}
          title={detailedTime}
          data-time-source={hasSourceTime ? "source" : "browser"}
        >
          {displayDate.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
    </div>
  );
}
function PermissionRequestCard({
  value,
}: {
  value: import("../client/types").PermissionRequestView;
}) {
  const dispatch = useAppDispatch();
  const [now, setNow] = useState(Date.now());
  const [expired, setExpired] = useState(value.expires_at_ms <= Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setExpired(value.expires_at_ms <= Date.now());
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, value.expires_at_ms - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value.request_id, value.expires_at_ms]);
  const disabled = value.disabled || expired;
  return (
    <article
      className="flow-card"
      data-testid="permission-request"
      data-request-id={value.request_id}
      data-status={
        expired
          ? "expired"
          : value.submitting
            ? "submitting"
            : value.observer
              ? "observer"
              : "ready"
      }
      aria-busy={value.submitting || undefined}
    >
      <h3>
        {t(
          value.subject?.kind === "agent_init"
            ? "permission.initializationTitle"
            : "permission.title",
        )}{" "}
        ·{" "}
        {value.subject?.kind === "agent_init"
          ? value.subject.component
          : value.tool}
      </h3>
      <p className="flow-card-meta">
        {value.session_id !== value.parent_session_id
          ? t("permission.childSession", { id: value.session_id })
          : t("permission.currentSession")}{" "}
      </p>
      <p className="flow-card-meta">
        {t(
          value.subject?.kind === "agent_init"
            ? "permission.initializationScope"
            : "permission.onceScope",
        )}
      </p>
      {value.review && (
        <p
          className="inline-notice"
          role="status"
          data-testid="permission-review"
          data-phase={value.phase}
        >
          {t("permission.reviewSuggestion", {
            action: t(`permission.action.${value.review.action}`),
            reason: value.review.reason,
          })}
          {value.phase === "review_grace" && (
            <span data-testid="permission-review-countdown">
              {t("permission.reviewCountdown", {
                seconds: Math.max(
                  0,
                  Math.ceil((value.expires_at_ms - now) / 1000),
                ),
              })}
            </span>
          )}
        </p>
      )}
      {value.observer && (
        <p className="inline-notice" role="status">
          {t("permission.observer")}
        </p>
      )}
      {value.submitting && (
        <p
          className="inline-notice"
          role="status"
          data-testid="permission-submitting"
        >
          {t("permission.submitting")}
        </p>
      )}
      {expired && (
        <p className="inline-notice" data-tone="warn" role="status">
          {t("permission.expired")}
        </p>
      )}
      <details className="flow-card-details">
        <summary>{t("permission.details")}</summary>
        <Payload
          value={{
            subject: value.subject,
            arguments: value.arguments,
          }}
          testid="permission-request-payload"
          dialogTitle={`${t("permission.details")} · ${value.tool}`}
        />
      </details>
      <div className="settings-actions-row flow-card-actions">
        <button
          className="primary-btn"
          type="button"
          disabled={disabled}
          onClick={() =>
            dispatch({
              type: "ReplyPermission",
              requestId: value.request_id,
              decision: "allow",
            })
          }
        >
          {t("permission.allowOnce")}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={disabled}
          onClick={() =>
            dispatch({
              type: "ReplyPermission",
              requestId: value.request_id,
              decision: "deny",
            })
          }
        >
          {t("permission.deny")}
        </button>
      </div>
    </article>
  );
}
export function PermissionCard({
  value,
}: {
  value: { requests: import("../client/types").PermissionRequestView[] };
}) {
  return (
    <>
      {(value.requests ?? []).map((request) => (
        <PermissionRequestCard key={request.request_id} value={request} />
      ))}
    </>
  );
}
export function QuestionCard({ value }: { value: PendingQuestion }) {
  return value.secret ? (
    <SecretCard value={value} />
  ) : (
    <QuestionAnswers value={value} />
  );
}
function QuestionAnswers({ value }: { value: PendingQuestion }) {
  const dispatch = useAppDispatch();
  const questionImages = useQuestionImageScope(value);
  const questions = value.questions;
  const requestId = value.id;
  const [selected, setSelected] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [budgetReached, setBudgetReached] = useState(
    value.deadline > 0 && value.deadline <= Date.now(),
  );
  useEffect(() => {
    setBudgetReached(value.deadline > 0 && value.deadline <= Date.now());
    if (!value.deadline) return;
    const timer = setTimeout(
      () => setBudgetReached(true),
      Math.max(0, value.deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value.deadline]);
  const disabled = value.disabled || submitting;
  return (
    <article className="flow-card">
      <h3>{t("question.title")}</h3>
      {value.observer && (
        <p className="inline-notice" role="status">
          {t("question.observer")}
        </p>
      )}
      {value.awaitingConfirmation && (
        <p className="inline-notice" role="status">
          {t("question.awaiting")}
        </p>
      )}
      {value.blockingMode === "deferred" ? (
        <p role="status">{t("question.deferred")}</p>
      ) : value.paused ? (
        <p role="status">{t("question.paused")}</p>
      ) : (
        <p role="status">
          {t(budgetReached ? "question.budgetReached" : "question.waiting")}
        </p>
      )}
      {questions.map((q, index) => (
        <Fragment key={q.id}>
          {q.header && <h4>{q.header}</h4>}
          <div className="question-body">
            <Markdown
              text={q.question}
              allowImages={!!questionImages}
              questionImages={questionImages}
              rich={{ streaming: false }}
            />
          </div>
          <div className="choice-list">
            {(q.options ?? []).map((o) => (
              <button
                key={o.id}
                type="button"
                disabled={disabled}
                aria-pressed={(selected[index] ?? []).includes(o.id)}
                data-selected={(selected[index] ?? []).includes(o.id)}
                onClick={() => {
                  if (!q.multiple)
                    setCustom((previous) =>
                      previous.map((v, i) => (i === index ? "" : v)),
                    );
                  setSelected((previous) =>
                    previous.map((bucket, i) =>
                      i !== index
                        ? bucket
                        : bucket.includes(o.id)
                          ? bucket.filter((x) => x !== o.id)
                          : q.multiple
                            ? [...bucket, o.id]
                            : [o.id],
                    ),
                  );
                }}
              >
                <span className="question-option-indicator" aria-hidden="true">
                  ✓
                </span>
                <span className="question-option-content">
                  {o.label}
                  {o.recommended && (
                    <span className="settings-input-hint">
                      {" "}
                      {t("question.recommended")}
                    </span>
                  )}
                  {o.description && (
                    <span className="settings-input-hint">
                      {" "}
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {q.custom !== false && (
            <input
              aria-label={t("question.customLabel", {
                question: q.header ?? q.question,
              })}
              placeholder={t("question.custom")}
              disabled={disabled}
              maxLength={4000}
              value={custom[index] ?? ""}
              onChange={(e) => {
                const text = e.target.value;
                if (!q.multiple && text.trim())
                  setSelected((previous) =>
                    previous.map((bucket, i) => (i === index ? [] : bucket)),
                  );
                setCustom((previous) =>
                  previous.map((v, i) => (i === index ? text : v)),
                );
              }}
            />
          )}
        </Fragment>
      ))}
      <div className="settings-actions-row">
        <button
          className="ghost-btn"
          type="button"
          disabled={disabled}
          onClick={async () => {
            setSubmitting(true);
            await dispatch({ type: "RejectQuestion", requestId });
            setSubmitting(false);
          }}
        >
          {t("question.dismiss")}
        </button>
        <button
          className="primary-btn"
          type="button"
          disabled={
            disabled ||
            questions.some(
              (_, i) => !(selected[i]?.length || custom[i]?.trim()),
            )
          }
          onClick={async () => {
            setSubmitting(true);
            await dispatch({
              type: "ReplyQuestion",
              requestId,
              answers: questions.map((q, i) => ({
                id: q.id,
                option_ids: selected[i] ?? [],
                custom: custom[i] ?? "",
              })),
            });
            setSubmitting(false);
          }}
        >
          {t("question.submit")}
        </button>
      </div>
    </article>
  );
}
