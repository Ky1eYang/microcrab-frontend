import { toolReferenceProjection } from "./toolReferences";
import { referenceLabels } from "./referenceLabels";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeSession, useApp } from "../state";
import { ContentViewer } from "./content-inspection/ContentViewer";
import { RequestAudit, type AuditScope } from "./RequestAudit";
import type { Transcript } from "../client/types";
import {
  historyBranchReplaced,
  presentationIdentity,
  presentationIdentityChanged,
} from "./conversation/presentationIdentity";
import { terminalSummary } from "./trajectoryStopReason";
import {
  TOOL_STATUS_ICON,
  toolDisplayStatus,
  type ToolDisplayStatus,
} from "./tool-status";
import { measuredDuration } from "./trajectoryTiming";
import {
  useInternalAssistantAudit,
  orderTrajectoryBlocks,
} from "./InternalAssistantAudit";
import { Payload } from "./Payload";
import { ContentDialog } from "./ContentDialog";
import { activeLocale, t } from "../i18n";
import { useNarrowViewport } from "../client/viewport";
import {
  Icon,
  elapsed,
  isCompactResult,
  isSubagent,
  type FeatureBlock,
} from "./shared";

interface TrajectoryItem {
  block: FeatureBlock;
  index: number;
  turn: number;
  turnKey: string | null;
  lane: "input" | "message" | "tool" | "sub";
  kind: string;
  label: string;
  summary: string;
  time: string;
  duration: number;
  start: number;
  end: number;
  started: number | null;
  status: string;
  content: string;
}

interface TimelineAnchor {
  id: string;
  offset: number;
  fraction: number;
  observed: number | null;
}
interface TimelineRange {
  from: TimelineAnchor;
  to: TimelineAnchor;
  observedIds: string[];
}

// Compressed display coordinates are disposable: delayed clocks can change every
// idle-gap offset. A chosen interval belongs to real clocks, or exact untimed rows.
function anchorTime(anchor: TimelineAnchor, items: TrajectoryItem[]) {
  const item = items.find((item) => item.block.id === anchor.id);
  return (
    anchor.observed ??
    (item?.started == null
      ? null
      : item.started + anchor.fraction * item.duration)
  );
}
function anchorAt(
  time: number,
  items: TrajectoryItem[],
): TimelineAnchor | null {
  const timed = items.filter(
    (item) => item.started != null && item.start <= time && item.end >= time,
  );
  const candidates = timed.length ? timed : items;
  const item = candidates.reduce<TrajectoryItem | null>((best, next) => {
    const distance = (row: TrajectoryItem) =>
      Math.max(row.start - time, time - row.end, 0);
    return !best || distance(next) < distance(best) ? next : best;
  }, null);
  if (!item) return null;
  const offset = Math.max(
    0,
    Math.min(item.end - item.start, time - item.start),
  );
  return {
    id: item.block.id,
    offset,
    fraction: offset / Math.max(item.end - item.start, 1),
    observed:
      item.started == null
        ? null
        : item.started + Math.min(item.duration, offset),
  };
}
function anchorDisplay(anchor: TimelineAnchor, items: TrajectoryItem[]) {
  const observed = anchorTime(anchor, items);
  if (observed != null) {
    const timed = items.filter((item) => item.started != null);
    const item = timed.reduce<TrajectoryItem | null>((best, next) => {
      const distance = (row: TrajectoryItem) =>
        Math.max(
          row.started! - observed,
          observed - (row.started! + Math.max(row.duration, 1)),
          0,
        );
      return !best || distance(next) < distance(best) ? next : best;
    }, null);
    if (item)
      return (
        item.start +
        Math.max(0, Math.min(item.end - item.start, observed - item.started!))
      );
  }
  const item = items.find((item) => item.block.id === anchor.id);
  return item
    ? item.start +
        (anchor.observed == null
          ? anchor.fraction * (item.end - item.start)
          : anchor.offset)
    : null;
}

const lanes = [
  ["input", "输入"],
  ["message", "模型"],
  ["tool", "工具"],
  ["sub", "助手"],
] as const;

function laneOf(kind: string): TrajectoryItem["lane"] {
  if (kind === "user" || kind === "model-request") return "input";
  if (kind === "tool") return "tool";
  if (kind === "subagent" || kind === "internal-assistant") return "sub";
  return "message";
}

function kindOf(block: FeatureBlock) {
  if (block.role === "user" && !isCompactResult(block)) return "user";
  if (block.kind === "internal-assistant") return "internal-assistant";
  if (block.kind === "model-request") return "model-request";
  if (block.kind === "model-generation") return "model-generation";
  if (block.kind === "reasoning") return "thought";
  if (isSubagent(block) || block.tool?.builtin === "delegate")
    return "subagent";
  if (block.kind === "tool") return "tool";
  if (block.kind === "compaction" || isCompactResult(block))
    return "compaction";
  if (block.kind === "error") return "error";
  return "message";
}

function labelOf(block: FeatureBlock, kind: string) {
  if (kind === "user") return "用户";
  if (kind === "model-request") return t("timeline.modelInput");
  if (kind === "model-generation") return t("timeline.modelGeneration");
  if (kind === "internal-assistant") return block.payload.auditAssistant;
  if (kind === "thought") return "思考";
  if (block.tool && (kind === "tool" || kind === "subagent"))
    return block.tool.name;
  if (kind === "tool") return "工具";
  if (kind === "subagent") return "助手";
  if (kind === "compaction") return "压缩";
  if (kind === "error") return "错误";
  return "消息";
}

function summaryOf(block: FeatureBlock) {
  if (block.tool) {
    const projection = toolReferenceProjection(block.tool.input, block.tool.presentation, "arguments");
    const input = projection ? JSON.parse(projection.display) : block.tool.input;
    const value =
      (!projection && block.tool.title) ||
      (typeof input?.command === "string" && input.command) ||
      input?.filePath ||
      input?.path ||
      input?.pattern ||
      "";
    return String(value).replace(/\s+/g, " ").trim();
  }
  return plainSummary(block.payload.text) || terminalSummary(block);
}

/** First meaningful line of Markdown as plain text (no #, *, `, > markers). */
function plainSummary(text: string) {
  const line =
    text
      .split("\n")
      .filter((value) => !/^\s*(```|~~~)/.test(value))
      .map((value) =>
        value
          .replace(
            /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
            "",
          )
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/[*_`~]+/g, "")
          .replace(/^>\s?/, "")
          .trim(),
      )
      .find((value) => value && !/^[-|:\s]+$/.test(value)) ?? "";
  return line.replace(/\s+/g, " ").slice(0, 220);
}

function timeOf(ms: number | null) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function statusOf(block: FeatureBlock) {
  if (
    ["internal-assistant", "model-request", "model-generation"].includes(
      block.kind,
    )
  )
    return block.payload.auditStatus === "cancelled"
      ? "cancelled"
      : block.payload.auditStatus === "failed"
        ? "error"
        : block.payload.auditStatus === "succeeded"
          ? "done"
          : block.payload.auditStatus === "pending"
            ? "awaiting-result"
            : "unknown";
  if (
    block.stream === "cancelled" ||
    block.payload.failure?.code === "cancelled" ||
    block.payload.stopReason?.reason === "cancelled"
  )
    return "cancelled";
  if (block.tool) {
    if (block.displayExecutionStatus) return block.displayExecutionStatus;
    const status = toolDisplayStatus(block.tool.status);
    const outcome = block.payload.auditToolOutcome;
    if (status === "cancelled" || status === "interrupted") return status;
    if (outcome === "cancelled") return "cancelled";
    if (status === "failed" || outcome === "failed") return "failed";
    return outcome === "succeeded" ? "succeeded" : status;
  }
  if (block.kind === "reasoning") {
    if (
      block.payload.auditStatus === "failed" ||
      ["error", "failed"].includes(block.stream)
    )
      return "error";
    if (
      block.endedMs != null ||
      block.stream === "complete" ||
      block.stream === "done"
    )
      return "done";
    return block.stream === "streaming" ? "running" : "unknown";
  }
  if (block.kind === "error") return "error";
  return "done";
}

/** Same glyph vocabulary as the conversation tool rows. */
function trajectoryGlyph(item: TrajectoryItem): ToolDisplayStatus | null {
  const status = item.status;
  if (["error", "failed"].includes(status)) return "failed";
  if (status === "cancelled") return "cancelled";
  if (["running", "thinking", "pending"].includes(status)) return "running";
  if (["unknown", "awaiting-result"].includes(status)) return "unknown";
  if (item.block.tool) {
    const display = toolDisplayStatus(item.block.tool.status);
    return display === "succeeded" ? "succeeded" : display;
  }
  return null;
}

function statusLabel(status: string) {
  if (status === "cancelled") return t("stopReason.cancelled");
  if (status === "awaiting-result") return t("trajectory.status.awaitingResult");
  if (status === "unknown") return t("trajectory.status.unconfirmed");
  if (isFailed(status)) return t("tools.status.failed");
  if (status === "thinking") return t("trajectory.status.inProgress");
  if (status === "done") return t("tools.status.succeeded");
  return t(`tools.status.${toolDisplayStatus(status)}`);
}

function stamp(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return t("trajectory.notRecorded");
  return new Date(ms).toLocaleString("sv-SE").replace("T", " ");
}

function timeRange(block: FeatureBlock) {
  const started = block.startedMs ?? block.tool?.startedMs;
  const ended = block.endedMs ?? block.tool?.endedMs;
  const start = stamp(started);
  if (started == null) return start;
  return `${start} – ${ended == null ? (statusOf(block) === "running" ? "进行中" : "结束时间未记录") : stamp(ended)}`;
}

function hasRequestDelta(item: TrajectoryItem) {
  return (
    (item.kind === "model-request" || item.kind === "internal-assistant") &&
    typeof item.block.payload.auditSelector?.call_id === "string" &&
    Boolean(item.block.payload.auditSelector.call_id)
  );
}

function hasRequestInfo(item: TrajectoryItem) {
  return (
    item.kind === "user" ||
    item.kind === "tool" ||
    (item.kind === "subagent" && Boolean(item.block.tool)) ||
    ((item.kind === "message" || item.kind === "thought") &&
      item.block.role === "assistant") ||
    item.kind === "internal-assistant" ||
    item.kind === "model-request" ||
    item.kind === "model-generation"
  );
}

function toolNumber(item: TrajectoryItem) {
  const id = item.block.displayExecutionId ?? item.block.executionId;
  return item.block.tool &&
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0
    ? `#${id}`
    : null;
}

function itemTitle(item: TrajectoryItem) {
  const number = toolNumber(item);
  return number ? `${item.label} ${number}` : item.label;
}

function isFailed(status: string) {
  return status === "error" || status === "failed";
}

function TrajectoryTitle({ item }: { item: TrajectoryItem }) {
  const number = toolNumber(item);
  const sent = hasRequestDelta(item);
  return (
    <span className="trajectory-title" title={itemTitle(item)}>
      <span className="trajectory-title-text">{item.label}</span>
      {number && <span className="trajectory-title-number">{number}</span>}
      {sent && (
        <span
          className="trajectory-title-send"
          role="img"
          aria-label={t("timeline.requestSent")}
          title={t("timeline.requestSent")}
        >
          <Icon name="send" size={12} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

function tabsFor(item: TrajectoryItem) {
  const tabs =
    item.kind === "tool" || item.kind === "subagent"
      ? [
          ["overview", "概述"],
          ["input", "参数"],
          ["output", "结果"],
          ["schema", "Schema"],
        ]
      : [
          ["overview", "概述"],
          ["preview", "预览"],
          ["raw", "原始内容"],
        ];
  if (hasRequestDelta(item)) tabs.push(["delta", t("timeline.requestDelta")]);
  if (hasRequestInfo(item) || item.kind === "subagent")
    tabs.push(["request-info", "请求信息"]);
  return tabs;
}

function contentOf(block: FeatureBlock) {
  const parts: string[] = [];
  if (block.tool) {
    parts.push(`${block.tool.name}`);
    if (block.tool.input != null)
      parts.push(
        toolReferenceProjection(block.tool.input, block.tool.presentation, "arguments")?.display ??
        (typeof block.tool.input === "string" ? block.tool.input : JSON.stringify(block.tool.input, null, 2)),
      );
  }
  const output = toolReferenceProjection(block.payload.text, block.payload.toolPresentation, "result")?.display ?? block.payload.text;
  if (output.trim()) parts.push(output.trim());
  return parts.join("\n\n");
}

function buildItems(blocks: FeatureBlock[]): TrajectoryItem[] {
  let turn = 0;
  let localTurn: string | null = null;
  const raw = blocks.map((block, index) => {
    const kind = kindOf(block);
    if (kind === "user") {
      turn += 1;
      localTurn = `input:${block.id}`;
    }
    const position = block.position ?? block.preview;
    const turnKey =
      position?.epoch != null && position.turn != null
        ? `${position.epoch}:${position.turn}`
        : localTurn;
    const duration = Math.max(0, elapsed(block) ?? 0);
    const started = block.startedMs ?? block.payload.auditTimelineAt;
    return {
      block,
      index: index + 1,
      turn: position?.turn ?? turn,
      turnKey,
      lane: laneOf(kind),
      kind,
      label: labelOf(block, kind),
      summary: summaryOf(block),
      time: timeOf(elapsed(block)),
      duration,
      started: started != null && Number.isFinite(started) ? started : null,
      status: statusOf(block),
      content: contentOf(block),
    };
  });
  const ordered = raw
    .filter((item) => item.started != null)
    .sort(
      (left, right) =>
        (left.started ?? 0) - (right.started ?? 0) || left.index - right.index,
    );
  const removed = new Map<number, number>();
  let idle = 0;
  let covered: number | null = null;
  for (const item of ordered) {
    const started = item.started ?? 0;
    if (covered != null && started > covered) idle += started - covered;
    removed.set(item.index, idle);
    const end = started + item.duration;
    covered = covered == null ? end : Math.max(covered, end);
  }
  let cursor = ordered.length ? ordered[0].started! : 0;
  return raw.map((item) => {
    const start =
      item.started == null
        ? cursor
        : item.started - (removed.get(item.index) ?? 0);
    cursor = Math.max(cursor, start + Math.max(item.duration, 1));
    return {
      ...item,
      start,
      end: start + Math.max(item.duration, 1),
    };
  });
}

function TrajectoryPreview({ text, title }: { text: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };
  return (
    <div className="trajectory-content">
      <div className="trajectory-content-actions">
        <button
          type="button"
          className="trajectory-content-action"
          onClick={() => void copy()}
          aria-label={t(copied ? "content.copied" : "content.copy")}
          title={t(copied ? "content.copied" : "content.copy")}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
        <button
          type="button"
          className="trajectory-content-action"
          data-testid="trajectory-content-expand"
          aria-label={t("content.expand")}
          title={t("content.expand")}
          onClick={() => setOpen(true)}
        >
          <Icon name="expand" size={12} />
        </button>
      </div>
      {copyFailed && <p role="alert">{t("contentViewer.copyFailed")}</p>}
      <div
        className="trajectory-content-body"
        role="region"
        aria-label={title}
        tabIndex={0}
      >
        <ContentViewer
          source={text}
          defaultFormat="markdown"
          title={title}
          controls={false}
        />
      </div>
      {open && (
        <ContentDialog maximizable title={title} onClose={() => setOpen(false)}>
          <ContentViewer source={text} defaultFormat="markdown" title={title} />
        </ContentDialog>
      )}
    </div>
  );
}

export function TrajectoryView({
  transcript: suppliedTranscript,
  auditScope,
  title,
  active = true,
}: {
  transcript?: Transcript;
  auditScope?: AuditScope;
  title?: string;
  active?: boolean;
} = {}) {
  const { state, dispatch } = useApp();
  const transcript = suppliedTranscript ?? state.transcript;
  const locale = activeLocale();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selection = useRef<{
    block: FeatureBlock;
    scope: string;
    key: string;
  } | null>(null);
  const [historyChanged, setHistoryChanged] = useState(false);
  const [tab, setTab] = useState("overview");
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState<TimelineRange | null>(null);
  const drag = useRef<{ ratio: number; anchor: TimelineAnchor } | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const {
    blocks: internalAssistants,
    error: assistantAuditError,
    timeline: auditTimeline,
    stages: auditStages,
    loading: assistantAuditLoading,
  } = useInternalAssistantAudit({ transcript, auditScope });
  const [historyLimit, setHistoryLimit] = useState(96);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const ledger = useRef<HTMLDivElement>(null);
  const historyLoad = useRef<object | null>(null);
  const historyAnchor = useRef<{
    scope: string;
    id: string;
    top: number;
  } | null>(null);
  const previousScrollTop = useRef(0);
  const readingHistory = useRef(false);
  const readingAnchor = useRef<{
    scope: string;
    id: string;
    offset: number;
  } | null>(null);
  const initialViewport = useRef<string | null>(null);
  const residentStart = useRef<{ scope: string; id: string } | null>(null);
  const viewScope = JSON.stringify([
    state.authSession?.principal?.owner,
    state.sessionId,
    auditScope?.parentId,
    auditScope?.childId,
  ]);
  const trajectoryScope = JSON.stringify([
    viewScope,
    transcript.historyView?.lineage,
    transcript.historyView?.epoch,
  ]);
  const previousHistory = useRef({
    view: viewScope,
    history: transcript.historyView,
    reset: transcript.historyResetRevision,
  });
  const presentationRevision = useRef(0);
  if (
    previousHistory.current.view !== viewScope ||
    historyBranchReplaced(
      previousHistory.current.history,
      transcript.historyView,
    ) ||
    (previousHistory.current.reset ?? 0) !==
      (transcript.historyResetRevision ?? 0)
  )
    presentationRevision.current++;
  const presentationScope = JSON.stringify([
    viewScope,
    presentationRevision.current,
  ]);
  previousHistory.current = {
    view: viewScope,
    history: transcript.historyView,
    reset: transcript.historyResetRevision,
  };
  const auditPresentationScope = transcript.historyView
    ? `${trajectoryScope}:${presentationScope}`
    : undefined;
  const currentScope = useRef(trajectoryScope);
  currentScope.current = trajectoryScope;
  useEffect(() => {
    historyLoad.current = null;
    historyAnchor.current = null;
    previousScrollTop.current = 0;
    readingHistory.current = false;
    readingAnchor.current = null;
    setHistoryLimit(96);
    setSelectedId(null);
    selection.current = null;
    setHistoryChanged(false);
    setRange(null);
    drag.current = null;
    setLoadingOlder(false);
  }, [viewScope]);
  useEffect(() => {
    // Canonical reads cannot cross a branch/epoch fence; reading intent can.
    historyLoad.current = null;
    historyAnchor.current = null;
    setLoadingOlder(false);
    drag.current = null;
  }, [trajectoryScope]);
  const allItems = useMemo(
    () =>
      buildItems(
        orderTrajectoryBlocks(
          transcript.blocks.map((block) =>
            auditScope
              ? { ...block, payload: { ...block.payload, auditScope } }
              : block,
          ),
          internalAssistants,
          auditTimeline,
          auditStages,
        ),
      ),
    [
      transcript,
      locale,
      internalAssistants,
      auditTimeline,
      auditStages,
      auditScope?.parentId,
      auditScope?.childId,
    ],
  );
  const rowKeys = useRef({
    view: viewScope,
    scope: presentationScope,
    next: 0,
    native: new Map<string, { identity: string; key: string }>(),
    identities: new Map<string, string>(),
  });
  const owners = rowKeys.current;
  if (owners.view !== viewScope) {
    owners.view = viewScope;
    owners.native.clear();
    owners.identities.clear();
  }
  if (owners.scope !== presentationScope) {
    // Unbound legacy preview ids cannot carry native DOM into a new branch.
    for (const identity of owners.identities.keys())
      if (JSON.parse(identity)[2] === "display")
        owners.identities.delete(identity);
  }
  const keys = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const { block } of allItems) {
    const identity = presentationIdentity(block);
    const prior = owners.native.get(block.id);
    let key =
      prior &&
      owners.scope === presentationScope &&
      !presentationIdentityChanged(prior.identity, block)
        ? prior.key
        : owners.identities.get(identity);
    if (!key || usedKeys.has(key)) key = `trajectory-row:${owners.next++}`;
    keys.set(block.id, key);
    usedKeys.add(key);
    owners.native.set(block.id, { identity, key });
    owners.identities.set(identity, key);
  }
  owners.scope = presentationScope;
  const rowKey = (id: string) =>
    keys.get(id) ?? owners.native.get(id)?.key ?? id;
  useEffect(() => {
    setRange((current) => {
      if (!current) return current;
      const survivorId = (id: string) =>
        allItems.find((item) => rowKey(item.block.id) === rowKey(id))?.block
          .id ?? id;
      const bind = (anchor: TimelineAnchor) => {
        const id = survivorId(anchor.id);
        const rebound = id === anchor.id ? anchor : { ...anchor, id };
        const observed = anchorTime(rebound, allItems);
        return rebound.observed == null && observed != null
          ? { ...rebound, observed }
          : rebound;
      };
      const from = bind(current.from);
      const to = bind(current.to);
      const observedIds = current.observedIds.map(survivorId);
      return from === current.from &&
        to === current.to &&
        observedIds.every((id, index) => id === current.observedIds[index])
        ? current
        : { ...current, from, to, observedIds };
    });
  }, [allItems]);
  const priorSelection = selection.current;
  const sameAuthority = priorSelection?.scope === presentationScope;
  const selectedItem =
    selectedId && priorSelection
      ? (allItems.find(({ block }) => {
          const prior = priorSelection.block;
          const sameCanonical =
            Boolean(prior.messageId || prior.preview?.canonicalMessageId) &&
            (!prior.preview || Boolean(prior.preview.canonicalMessageId)) &&
            (!block.preview || Boolean(block.preview.canonicalMessageId)) &&
            !prior.temporary &&
            !block.temporary &&
            presentationIdentity(prior) === presentationIdentity(block);
          if (
            sameCanonical ||
            (block.id === selectedId &&
              sameAuthority &&
              !presentationIdentityChanged(presentationIdentity(prior), block))
          )
            return true;
          // Projector normally preserves the live id. This fallback accepts only
          // its explicit canonical binding within the same selected history.
          return (
            sameAuthority &&
            prior.kind === block.kind &&
            prior.callId === block.callId &&
            prior.partId === block.partId &&
            Boolean(
              (prior.preview?.canonicalMessageId &&
                prior.preview.canonicalMessageId === block.messageId) ||
              (block.preview?.canonicalMessageId &&
                block.preview.canonicalMessageId === prior.messageId),
            )
          );
        }) ??
        (sameAuthority && !allItems.some(({ block }) => block.id === selectedId)
          ? (buildItems([priorSelection.block])[0] ?? null)
          : null))
      : null;
  const selectedIndex = selectedItem ? allItems.indexOf(selectedItem) : -1;
  useEffect(() => {
    if (!selectedId || !priorSelection) return;
    if (!selectedItem) {
      selection.current = null;
      setSelectedId(null);
      setHistoryChanged(true);
    } else {
      selection.current = {
        ...priorSelection,
        block: selectedItem.block,
        scope: presentationScope,
      };
      if (selectedId !== selectedItem.block.id)
        setSelectedId(selectedItem.block.id);
    }
  }, [selectedItem, selectedId, trajectoryScope, presentationScope]);
  const rangeEvidence = useRef({
    scope: presentationScope,
    identities: new Map<string, string>(),
  });
  useEffect(() => {
    const previous = rangeEvidence.current;
    const identities = new Map(
      allItems.map(({ block }) => [block.id, presentationIdentity(block)]),
    );
    setRange((current) => {
      if (!current) return current;
      const invalid = (id: string) => {
        const identity = identities.get(id);
        return identity === undefined
          ? previous.scope !== presentationScope
          : previous.identities.has(id) &&
              previous.identities.get(id) !== identity;
      };
      return invalid(current.from.id) || invalid(current.to.id)
        ? null
        : current;
    });
    rangeEvidence.current = { scope: presentationScope, identities };
  }, [presentationScope, allItems]);
  const recentStart = Math.max(0, allItems.length - historyLimit);
  const retainedStart =
    residentStart.current?.scope === viewScope
      ? allItems.findIndex(
          (item) => rowKey(item.block.id) === residentStart.current?.id,
        )
      : -1;
  const items = allItems.slice(
    Math.min(
      recentStart,
      selectedIndex >= 0 ? selectedIndex : recentStart,
      retainedStart >= 0 ? retainedStart : recentStart,
    ),
  );
  const residentOlder = items.length < allItems.length;
  const remoteOlder = auditScope?.childId
    ? state.popup.type === "subagentDetail" &&
      state.popup.parentId === auditScope.parentId &&
      state.popup.parentId === state.sessionId &&
      state.popup.childId === auditScope.childId &&
      state.popup.detail?.next_cursor != null
    : !suppliedTranscript && state.historyTruncated;
  useLayoutEffect(() => {
    if (items[0])
      residentStart.current = {
        scope: viewScope,
        id: rowKey(items[0].block.id),
      };
    if (!active) {
      initialViewport.current = null;
      readingHistory.current = false;
      readingAnchor.current = null;
      return;
    }
    // Show the latest resident row immediately, even while audit requests wait.
    // Hydration may add rows: finish positioning after it settles. Any explicit
    // gesture below cancels that pending correction so history reading wins.
    if (
      initialViewport.current !== viewScope &&
      !readingHistory.current &&
      !selectedId &&
      items.length &&
      ledger.current &&
      ledger.current.clientHeight > 0
    ) {
      ledger.current.scrollTop = ledger.current.scrollHeight;
      previousScrollTop.current = ledger.current.scrollTop;
      if (!assistantAuditLoading) initialViewport.current = viewScope;
    }
  }, [
    active,
    trajectoryScope,
    assistantAuditLoading,
    items[0]?.block.id,
    items.length,
  ]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    if (!anchor) return;
    if (anchor.scope !== trajectoryScope) {
      historyAnchor.current = null;
      return;
    }
    const row = rowRefs.current.get(anchor.id);
    if (row && ledger.current) {
      ledger.current.scrollTop += row.getBoundingClientRect().top - anchor.top;
      previousScrollTop.current = ledger.current.scrollTop;
    }
    historyAnchor.current = null;
    rememberReadingAnchor();
  }, [items[0]?.block.id, items.length, trajectoryScope]);
  const rememberReadingAnchor = () => {
    const host = ledger.current;
    if (!host) return;
    const top = host.getBoundingClientRect().top;
    const first = [
      ...host.querySelectorAll<HTMLButtonElement>(
        '[data-testid="trajectory-entry"]',
      ),
    ].find((row) => row.getBoundingClientRect().bottom > top);
    const id = first?.dataset.readingKey;
    readingAnchor.current =
      first && id
        ? {
            scope: viewScope,
            id,
            offset: first.getBoundingClientRect().top - top + host.scrollTop,
          }
        : null;
  };
  useLayoutEffect(() => {
    const host = ledger.current;
    const anchor = readingAnchor.current;
    if (
      active &&
      readingHistory.current &&
      anchor?.scope === viewScope &&
      host
    ) {
      const row = rowRefs.current.get(anchor.id);
      if (row) {
        host.scrollTop +=
          row.getBoundingClientRect().top -
          host.getBoundingClientRect().top +
          host.scrollTop -
          anchor.offset;
        previousScrollTop.current = host.scrollTop;
      }
    }
    rememberReadingAnchor();
  }, [allItems, active, trajectoryScope]);
  const loadOlder = async () => {
    if (historyLoad.current || (!residentOlder && !remoteOlder)) return;
    const request = {};
    const scope = trajectoryScope;
    historyLoad.current = request;
    const host = ledger.current;
    const firstVisible =
      host &&
      [...rowRefs.current].find(
        ([, row]) =>
          row.getBoundingClientRect().bottom > host.getBoundingClientRect().top,
      );
    historyAnchor.current = firstVisible
      ? {
          scope,
          id: firstVisible[0],
          top: firstVisible[1].getBoundingClientRect().top,
        }
      : null;
    setLoadingOlder(true);
    try {
      if (!residentOlder && remoteOlder)
        await dispatch({
          type: auditScope?.childId
            ? "LoadEarlierChildMessages"
            : "LoadEarlier",
        });
      if (currentScope.current !== scope) return;
      setHistoryLimit((limit) => limit + 96);
    } finally {
      if (historyLoad.current === request) {
        historyLoad.current = null;
        setLoadingOlder(false);
      }
    }
  };
  const totalDuration = measuredDuration(items.map((item) => item.block));
  const timingKeys = new Set<string>();
  const timelineItems = items.filter((item) => {
    const key = `${item.lane}:${item.block.payload.auditTimingKey ?? item.block.id}`;
    if (timingKeys.has(key)) return false;
    timingKeys.add(key);
    return true;
  });
  const ratioOf = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const place = (ratio: number, span = 0) => {
    const rect = track.current?.getBoundingClientRect();
    const host = timeline.current?.getBoundingClientRect();
    if (!rect || !host || host.width <= 0) return { left: "0%", width: "0%" };
    return {
      left: `${((rect.left - host.left + ratio * rect.width) / host.width) * 100}%`,
      width: `${((span * rect.width) / host.width) * 100}%`,
    };
  };
  const origin = items.reduce(
    (min, item) => Math.min(min, item.start),
    items[0]?.start ?? 0,
  );
  const domain = Math.max(1, ...items.map((item) => item.end - origin));
  const rangeTimes = range
    ? [anchorTime(range.from, allItems), anchorTime(range.to, allItems)]
    : null;
  const rangeStart =
    rangeTimes?.[0] != null && rangeTimes?.[1] != null
      ? Math.min(rangeTimes[0], rangeTimes[1])
      : null;
  const rangeEnd =
    rangeTimes?.[0] != null && rangeTimes?.[1] != null
      ? Math.max(rangeTimes[0], rangeTimes[1])
      : null;
  const rangeDisplay = range
    ? [anchorDisplay(range.from, items), anchorDisplay(range.to, items)]
    : null;
  const rangeRatios =
    rangeDisplay?.[0] != null && rangeDisplay?.[1] != null
      ? rangeDisplay
          .map((time) => Math.min(1, Math.max(0, (time! - origin) / domain)))
          .sort((left, right) => left - right)
      : null;
  const makeRange = (
    from: TimelineAnchor,
    ratio: number,
  ): TimelineRange | null => {
    const to = anchorAt(origin + ratio * domain, items);
    const start = anchorDisplay(from, items);
    if (!to || start == null) return null;
    const end = origin + ratio * domain;
    return {
      from,
      to,
      observedIds: items
        .filter(
          (item) =>
            item.end >= Math.min(start, end) &&
            item.start <= Math.max(start, end),
        )
        .map((item) => item.block.id),
    };
  };
  const needle = query.trim().toLowerCase();
  const ranged = range
    ? items.filter((item) => {
        if (item.started == null || rangeStart == null || rangeEnd == null)
          return range.observedIds.includes(item.block.id);
        return (
          item.started + Math.max(item.duration, 1) >= rangeStart &&
          item.started <= rangeEnd
        );
      })
    : items;
  const visible = needle
    ? ranged.filter((item) =>
        `${itemTitle(item)} ${item.summary} ${item.content}`
          .toLowerCase()
          .includes(needle),
      )
    : ranged;
  const selected = selectedItem;
  const counts = {
    turns: (() => {
      const recorded = new Set(
        items.flatMap((item) => {
          const position = item.block.position ?? item.block.preview;
          return position?.epoch != null && position.turn != null
            ? [`${position.epoch}:${position.turn}`]
            : [];
        }),
      );
      const known =
        recorded.size ||
        new Set(items.flatMap((item) => (item.turnKey ? [item.turnKey] : [])))
          .size;
      return known || (items.length ? "—" : 0);
    })(),
    tools: new Set(
      items
        .filter((item) => item.kind === "tool")
        .map(
          (item) =>
            `${JSON.stringify(item.block.position)}:${item.block.tool?.callId ?? item.block.id}`,
        ),
    ).size,
  };
  const pauseInspection = () => {
    initialViewport.current = viewScope;
    readingHistory.current = true;
    rememberReadingAnchor();
  };
  const select = (id: string) => {
    const item = allItems.find((item) => item.block.id === id);
    if (!item) return;
    pauseInspection();
    if (selected?.block.id === id) return;
    selection.current = {
      block: item.block,
      scope: presentationScope,
      key: id,
    };
    setHistoryChanged(false);
    setSelectedId(id);
    setTab("overview");
    rowRefs.current.get(rowKey(id))?.scrollIntoView({ block: "nearest" });
    rememberReadingAnchor();
  };
  useEffect(() => {
    if (!selected || tabsFor(selected).some(([id]) => id === tab)) return;
    setTab("overview");
  }, [selected, tab]);
  const selectAt = (ratio: number) => {
    if (!items.length) return;
    const time = origin + Math.min(1, Math.max(0, ratio)) * domain;
    const hit =
      items.find((item) => item.start <= time && time <= item.end) ??
      items.reduce((best, item) =>
        Math.abs(item.start - time) < Math.abs(best.start - time) ? item : best,
      );
    if (hit) select(hit.block.id);
  };
  // Narrow layout: the inspector is a bottom sheet; Esc closes it.
  const narrow = useNarrowViewport();
  useEffect(() => {
    if (!narrow || !selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setSelectedId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, selected]);
  const copy = (text: string) => dispatch({ type: "CopyText", value: text });
  const sessionLabel = referenceLabels("session", [...state.sessions.map((row) => row.id), state.sessionId]);
  const report = () =>
    [
      "# 会话执行轨迹",
      `- 会话: ${title || activeSession(state)?.title || (state.sessionId && sessionLabel(state.sessionId)) || "unknown"}`,
      `- 事件: ${items.length}`,
      `- 执行时长: ${timeOf(totalDuration)}`,
      "",
      ...items.map(
        (item) => `## #${item.index} ${itemTitle(item)}\n${item.content}`,
      ),
    ].join("\n");
  return (
    <div
      className="trajectory-view"
      data-history-epoch={transcript.historyView?.epoch}
      data-history-lineage={transcript.historyView?.lineage}
      data-inspector={!!selected}
      onPointerDownCapture={() => {
        initialViewport.current = viewScope;
        readingHistory.current = true;
      }}
      onWheelCapture={() => {
        initialViewport.current = viewScope;
        readingHistory.current = true;
      }}
      onKeyDownCapture={() => {
        initialViewport.current = viewScope;
        readingHistory.current = true;
      }}
    >
      <div className="trajectory-main">
        {assistantAuditError && <p role="alert">{assistantAuditError}</p>}
        <div className="trajectory-toolbar" role="toolbar" aria-label="轨迹">
          <span className="trajectory-metric">
            <Icon name="clock" size={13} /> 执行时长{" "}
            <span data-testid="trajectory-total-duration">
              {timeOf(totalDuration)}
            </span>
          </span>
          <span
            className="trajectory-metric"
            data-testid="trajectory-turn-count"
          >
            {counts.turns} 轮次
          </span>
          <span className="trajectory-metric">{counts.tools} 调用</span>
          <label className="trajectory-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              aria-label="搜索轨迹"
              placeholder="搜索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="ghost-btn trajectory-copy"
            type="button"
            aria-label="复制轨迹报告"
            disabled={!items.length}
            onClick={() => copy(report())}
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
        <div
          className="trajectory-timeline"
          ref={timeline}
          // A group, not a slider: the lane bars inside are real buttons and a
          // slider may not contain interactive children. Arrow keys still move
          // the selection.
          role="group"
          aria-label="时间线概览，拖动以框选时间段，方向键切换条目"
          tabIndex={0}
          onPointerDown={(event) => {
            // Segment buttons select their exact record. Capturing their pointer
            // here retargets the click to this group and selects by time instead,
            // which is ambiguous for points and overlapping provider intervals.
            if (
              event.target instanceof Element &&
              event.target.closest("button")
            )
              return;
            const ratio = ratioOf(event.clientX);
            const anchor = anchorAt(origin + ratio * domain, items);
            if (!anchor) return;
            drag.current = { ratio, anchor };
            setRange(makeRange(anchor, ratio));
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const ratio = ratioOf(event.clientX);
            setHover(ratio);
            if (drag.current == null) return;
            setRange(
              Math.abs(drag.current.ratio - ratio) < 0.004
                ? null
                : makeRange(drag.current.anchor, ratio),
            );
          }}
          onPointerUp={(event) => {
            const start = drag.current;
            drag.current = null;
            if (start == null) return;
            const end = ratioOf(event.clientX);
            if (Math.abs(end - start.ratio) < 0.004) {
              setRange(null);
              selectAt(end);
            } else {
              setRange(makeRange(start.anchor, end));
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(event) => {
            const index = items.findIndex(
              (item) => item.block.id === selected?.block.id,
            );
            const next =
              event.key === "ArrowRight"
                ? items[index + 1]
                : event.key === "ArrowLeft"
                  ? items[index - 1]
                  : null;
            if (next) {
              event.preventDefault();
              select(next.block.id);
            }
          }}
        >
          {(residentOlder || remoteOlder) && (
            <button
              type="button"
              className="trajectory-history-load"
              data-testid="trajectory-load-older"
              disabled={loadingOlder}
              onPointerEnter={(event) => event.stopPropagation()}
              onPointerMove={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              aria-label={t(
                loadingOlder ? "timeline.loadingOlder" : "timeline.loadOlder",
              )}
              title={t(
                loadingOlder ? "timeline.loadingOlder" : "timeline.loadOlder",
              )}
              onClick={(event) => {
                event.stopPropagation();
                void loadOlder();
              }}
            >
              <Icon
                name={loadingOlder ? "spinner" : "refresh"}
                size={14}
                className={loadingOlder ? "animate-spin" : undefined}
              />
            </button>
          )}
          {rangeRatios && (
            <i
              className="trajectory-selection"
              data-testid="trajectory-selected-range"
              data-started-ms={rangeStart ?? undefined}
              data-ended-ms={rangeEnd ?? undefined}
              style={place(rangeRatios[0], rangeRatios[1] - rangeRatios[0])}
            />
          )}
          {hover != null && (
            <i className="trajectory-hover" style={place(hover)} />
          )}
          {selected && (
            <i
              className="trajectory-playhead"
              style={place((selected.start - origin) / domain)}
            />
          )}
          {lanes.map(([lane, label], laneIndex) => (
            <div className="trajectory-lane" key={lane} data-lane={lane}>
              <span>{label}</span>
              <div ref={laneIndex === 0 ? track : undefined}>
                {timelineItems
                  .filter((item) => item.lane === lane)
                  .map((item) => (
                    <button
                      key={rowKey(item.block.id)}
                      type="button"
                      data-testid="trajectory-seg"
                      data-lane={lane}
                      data-status={item.status}
                      aria-label={`选中 #${item.index} ${itemTitle(item)}${isFailed(item.status) ? `，${statusLabel(item.status)}` : ""}`}
                      data-current={selected?.block.id === item.block.id}
                      data-duration-ms={elapsed(item.block) ?? undefined}
                      data-started-ms={item.block.startedMs ?? undefined}
                      title={`${itemTitle(item)} · ${item.time}${isFailed(item.status) ? ` · ${statusLabel(item.status)}` : ""}`}
                      style={{
                        left: `${((item.start - origin) / domain) * 100}%`,
                        width: `${Math.max(0.45, ((item.end - item.start) / domain) * 100)}%`,
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        select(item.block.id);
                      }}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
        {historyChanged && (
          <p role="status">{t("conversation.inspectionChanged")}</p>
        )}
        <div className="trajectory-stage">
          <div
            className="trajectory-ledger"
            ref={ledger}
            onPointerDownCapture={pauseInspection}
            onFocusCapture={pauseInspection}
            onWheel={(event) => {
              pauseInspection();
              if (event.deltaY < 0 && event.currentTarget.scrollTop <= 48)
                void loadOlder();
            }}
            onScroll={(event) => {
              const top = event.currentTarget.scrollTop;
              const movingUp = top < previousScrollTop.current;
              previousScrollTop.current = top;
              if (movingUp) {
                initialViewport.current = viewScope;
                readingHistory.current = true;
              }
              rememberReadingAnchor();
              if (movingUp && top <= 48) void loadOlder();
            }}
          >
            {!visible.length ? (
              <div className="trajectory-empty">当前会话暂无匹配轨迹</div>
            ) : (
              visible.map((item, index) => {
                const boundary =
                  index === 0 || visible[index - 1].turnKey !== item.turnKey;
                return (
                  <div key={rowKey(item.block.id)}>
                    {boundary && (
                      <div className="trajectory-turn-mark">
                        {item.turnKey ? `第 ${item.turn} 轮` : "—"}
                      </div>
                    )}
                    <button
                      ref={(node) => {
                        if (node)
                          rowRefs.current.set(rowKey(item.block.id), node);
                        else rowRefs.current.delete(rowKey(item.block.id));
                      }}
                      className="trajectory-entry"
                      data-testid="trajectory-entry"
                      data-trajectory-id={item.block.id}
                      data-reading-key={rowKey(item.block.id)}
                      type="button"
                      data-kind={item.kind}
                      data-status={item.status}
                      data-selected={selected?.block.id === item.block.id}
                      aria-current={
                        selected?.block.id === item.block.id || undefined
                      }
                      onClick={() => select(item.block.id)}
                    >
                      <span
                        className="trajectory-entry-glyph tool-status-glyph"
                        data-testid="trajectory-status-glyph"
                        data-status={trajectoryGlyph(item) ?? "none"}
                      >
                        {trajectoryGlyph(item) && (
                          <>
                            <Icon
                              name={TOOL_STATUS_ICON[trajectoryGlyph(item)!]}
                              size={14}
                              aria-hidden="true"
                            />
                            <span className="sr-only">
                              {statusLabel(item.status)}
                            </span>
                          </>
                        )}
                      </span>
                      <span className="trajectory-entry-kind">
                        <TrajectoryTitle item={item} />
                      </span>
                      <span className="trajectory-entry-text">
                        {item.summary || item.label}
                      </span>
                      <span
                        className="trajectory-entry-time"
                        data-status={item.status}
                      >
                        {isFailed(item.status)
                          ? statusLabel(item.status)
                          : item.time}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
          {selected && (
            <aside
              key={selection.current?.key ?? selected.block.id}
              onPointerDownCapture={pauseInspection}
              onFocusCapture={pauseInspection}
              onWheelCapture={pauseInspection}
              className="trajectory-inspector"
              data-testid="trajectory-inspector"
              aria-label="轨迹详情"
            >
              <header>
                <strong>
                  <TrajectoryTitle item={selected} />
                  <span className="trajectory-step-label">
                    {selected.turnKey
                      ? `第 ${selected.turn} 轮`
                      : selected.kind === "internal-assistant"
                        ? "独立请求"
                        : "—"}{" "}
                    · #{selected.index}
                  </span>
                </strong>
                <button
                  type="button"
                  aria-label="关闭详情"
                  onClick={() => setSelectedId(null)}
                >
                  <Icon name="close" size={15} />
                </button>
              </header>
              <div className="trajectory-tabs" role="tablist">
                {tabsFor(selected).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="trajectory-inspector-body">
                {tab === "overview" && (
                  <>
                    <section className="trajectory-pane">
                      <h3>时间</h3>
                      <dl>
                        <div>
                          <dt>来源</dt>
                          <dd>步骤 #{selected.index}</dd>
                        </div>
                        <div>
                          <dt>状态</dt>
                          <dd data-status={selected.status}>
                            {statusLabel(selected.status)}
                          </dd>
                        </div>
                        <div>
                          <dt>时间</dt>
                          <dd className="trajectory-range">
                            {timeRange(selected.block)}
                          </dd>
                        </div>
                        <div>
                          <dt>总时长</dt>
                          <dd>{selected.time}</dd>
                        </div>
                      </dl>
                    </section>
                    {(selected.kind === "tool" ||
                      selected.kind === "subagent") && (
                      <section className="trajectory-pane">
                        <h3>参数</h3>
                        <div className="trajectory-scroll-area">
                          {selected.block.tool?.presentation === "view-image" ? (
                            <RequestAudit
                              block={selected.block as any}
                              presentationScope={auditPresentationScope}
                              authoredArguments
                            />
                          ) : (
                            <Payload
                              variant="trajectory"
                              value={selected.block.tool?.input}
                         projection={toolReferenceProjection(selected.block.tool?.input, selected.block.tool?.presentation, "arguments")}
                              testid="tool-payload-input"
                              empty="未记录参数"
                            />
                          )}
                        </div>
                      </section>
                    )}
                    <section className="trajectory-pane">
                      <h3>预览</h3>
                      <div className="trajectory-scroll-area">
                        {selected.block.tool ? (
                          <Payload
                            variant="trajectory"
                            value={selected.block.payload.text}
                         projection={toolReferenceProjection(selected.block.payload.text, selected.block.payload.toolPresentation, "result")}
                            testid="tool-payload-output"
                            status={selected.status}
                            empty="(无内容)"
                          />
                        ) : (
                          <TrajectoryPreview
                            title={selected.label}
                            text={
                              selected.block.payload.text ||
                              terminalSummary(selected.block) ||
                              selected.summary ||
                              "(无内容)"
                            }
                          />
                        )}
                      </div>
                    </section>
                  </>
                )}
                {tab === "preview" && (
                  <div className="trajectory-scroll-area">
                    <TrajectoryPreview
                      title={selected.label}
                      text={
                        selected.block.payload.text ||
                        terminalSummary(selected.block) ||
                        "(无内容)"
                      }
                    />
                  </div>
                )}
                {tab === "raw" && (
                  <div className="trajectory-scroll-area">
                    <Payload
                      variant="trajectory"
                      fillBody
                      value={{
                        role: selected.block.role,
                        kind: selected.block.kind,
                        text: selected.block.payload.text,
                        tool: selected.block.tool,
                      }}
                    />
                  </div>
                )}
                {tab === "input" && (
                  <div className="trajectory-scroll-area">
                    {selected.block.tool?.presentation === "view-image" ? (
                      <RequestAudit
                        block={selected.block as any}
                        presentationScope={auditPresentationScope}
                        authoredArguments
                      />
                    ) : (
                      <Payload
                        variant="trajectory"
                        value={selected.block.tool?.input}
                         projection={toolReferenceProjection(selected.block.tool?.input, selected.block.tool?.presentation, "arguments")}
                        fillBody
                        empty="未记录参数"
                      />
                    )}
                  </div>
                )}
                {tab === "output" && (
                  <div className="trajectory-scroll-area">
                    <Payload
                      variant="trajectory"
                      value={selected.block.payload.text}
                         projection={toolReferenceProjection(selected.block.payload.text, selected.block.payload.toolPresentation, "result")}
                      status={isFailed(selected.status) ? "error" : undefined}
                      fillBody
                      empty="未记录结果"
                    />
                  </div>
                )}
                {tab === "schema" && (
                  <RequestAudit
                    block={selected.block as any}
                    presentationScope={auditPresentationScope}
                    schema
                  />
                )}
                {tab === "delta" && (
                  <RequestAudit
                    block={selected.block as any}
                    presentationScope={auditPresentationScope}
                  />
                )}
                {tab === "request-info" && (
                  <RequestAudit
                    block={selected.block as any}
                    presentationScope={auditPresentationScope}
                    metadata
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
