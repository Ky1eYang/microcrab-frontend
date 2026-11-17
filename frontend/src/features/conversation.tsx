import {
  PluginAnswerVariants,
  useAnswerVariantActions,
} from "./plugin-block-variants";
import { isDirectUserSource } from "../client/input-source";
import { CitationConversationProvider } from "./citations/context";
import { ExpandableNotice } from "./ExpandableNotice";
import { useClientPlugins } from "../state";
import {
  sessionTabPlugins,
  selectedSessionPlugin,
} from "../plugins/session-tabs";
import { PluginSurface, PluginBlockSlots } from "../plugins/PluginSidebar";
import type { ConversationRegistry } from "../client/conversation/registry";
import {
  ConversationRegistryProvider,
  useConversationStructure,
  useConversationBlocks,
  useIsolatedConversationRegistry,
} from "./conversation/registry-context";
import { ComposerNotificationDock } from "./composer/ComposerNotificationDock";
import { CompactionCommand } from "./CompactionCommand";
import { SubAgentDetailDialog } from "./popups/SubAgentDetailDialog";
import {
  Fragment,
  Suspense,
  lazy,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAppDispatch, useAppSelector, useAppStore } from "../state";
import { computeTurns } from "../client";
import { t } from "../i18n";
import type { AppState, NativeHistoryView, Transcript } from "../client/types";
import { ComposerStack } from "./composer";
import { WidthHandle } from "./rightRail";
import { TrajectoryView } from "./trajectory";
import {
  historyFoldPolicy,
  type HistoryFoldState,
} from "./conversation/historyFoldPolicy";
import {
  historyBranchReplaced,
  presentationIdentity,
  presentationIdentityChanged,
} from "./conversation/presentationIdentity";
import { FloatingScrollButton } from "./conversation/FloatingScrollButton";
import { orderedCards, type CardBoundaries } from "./conversation/orderedCards";
import { groupBlocks, type ConversationItem } from "./conversation/groupBlocks";
import {
  ActionBar,
  BlockView,
  CompactionSummaryCard,
  PermissionCard,
  QuestionCard,
  SubagentAccordionGroup,
  ToolAccordionGroup,
  answerTokenUsage,
  retryEligible,
  type ToolGroupPresentation,
} from "./views";
import {
  Icon,
  isBusy,
  isCompactInstruction,
  lower,
  type FeatureBlock,
} from "./shared";

function chunks(items: ConversationItem[]) {
  const result: { assistant: boolean; items: ConversationItem[] }[] = [];
  for (const item of items) {
    const assistant =
      item.type === "tools" ||
      item.type === "subagents" ||
      (item.type === "single" && item.blocks[0].role === "assistant");
    if (assistant && result.at(-1)?.assistant)
      result[result.length - 1].items.push(item);
    else result.push({ assistant, items: [item] });
  }
  return result;
}
function retainRenderKeys<T>(
  entries: { item: T; ids: string[]; fallback: () => string }[],
  cache: Map<string, string>,
  priority: (id: string) => number,
) {
  // Match all destinations before updating the cache. Otherwise an earlier split
  // can consume the parent that still owns the user's focused/selected detail.
  const candidates = entries
    .flatMap((entry, index) => {
      const prior = new Map<string, { priority: number; count: number }>();
      for (const id of entry.ids) {
        const key = cache.get(id);
        if (!key) continue;
        const found = prior.get(key);
        prior.set(key, {
          priority: Math.max(found?.priority ?? 0, priority(id)),
          count: (found?.count ?? 0) + 1,
        });
      }
      return [...prior].map(([key, match]) => ({ index, key, ...match }));
    })
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.count - left.count ||
        left.index - right.index,
    );
  const keys = new Map<T, string>();
  const used = new Set<string>();
  for (const candidate of candidates) {
    const entry = entries[candidate.index];
    if (keys.has(entry.item) || used.has(candidate.key)) continue;
    keys.set(entry.item, candidate.key);
    used.add(candidate.key);
  }
  for (const entry of entries) {
    let key = keys.get(entry.item);
    if (!key) {
      key = entry.fallback();
      while (used.has(key)) key += ":split";
      keys.set(entry.item, key);
      used.add(key);
    }
    for (const id of entry.ids) cache.set(id, key);
  }
  return keys;
}
function renderPiece(
  item: ConversationItem,
  id?: string,
  readOnly = false,
  tools?: ToolGroupPresentation,
) {
  return (
    <SubscribedPiece item={item} id={id} readOnly={readOnly} tools={tools} />
  );
}
function SubscribedPiece({
  item,
  id,
  readOnly,
  tools,
}: {
  item: ConversationItem;
  id?: string;
  readOnly: boolean;
  tools?: ToolGroupPresentation;
}) {
  const grouped = item.type === "tools" || item.type === "subagents";
  const renderBlockSlot = (
    block: FeatureBlock,
    placement: "before" | "after",
  ) => (
    <PluginBlockSlots
      blocks={[block]}
      readOnly={readOnly}
      placement={placement}
    />
  );
  const content =
    item.type === "tools" ? (
      <ToolAccordionGroup
        tools={item.blocks}
        {...tools}
        renderBlockSlot={renderBlockSlot}
      />
    ) : item.type === "subagents" ? (
      <SubagentAccordionGroup
        blocks={item.blocks}
        readOnly={readOnly}
        renderBlockSlot={renderBlockSlot}
      />
    ) : item.type === "compaction" ? (
      <SubscribedCompaction item={item} id={id} />
    ) : item.blocks[0].kind === "question" ? (
      <QuestionCard value={item.blocks[0].payload.question} />
    ) : item.blocks[0].kind === "compact-command" ? (
      <CompactionCommand />
    ) : (
      <BlockView block={item.blocks[0]} readOnly={readOnly} />
    );
  return (
    <>
      <PluginBlockSlots
        blocks={item.blocks}
        readOnly={readOnly}
        placement="before"
        observeOnly={grouped}
      />
      {content}
      {!grouped && (
        <PluginBlockSlots blocks={item.blocks} readOnly={readOnly} />
      )}
    </>
  );
}
function SubscribedCompaction({
  item,
  id,
}: {
  item: ConversationItem;
  id?: string;
}) {
  const members = useConversationBlocks(item.blocks);
  const first = members[0];
  const instruction = isCompactInstruction(first);
  const raw = first.payload.text.trim();
  const title =
    instruction && raw && !["Compaction", "上下文压缩"].includes(raw)
      ? raw.startsWith('Compaction with "') && raw.endsWith('"')
        ? raw.slice(17, -1)
        : raw
      : undefined;
  return (
    <CompactionSummaryCard
      id={id}
      title={
        title ? t("compaction.titleWith", { instruction: title }) : undefined
      }
      summary={instruction ? members[1]?.payload.text : first.payload.text}
      streaming={members.some((block) => block.stream === "streaming")}
      shadowedCount={item.shadowedCount}
    />
  );
}

function assistantOutputOperation(block: FeatureBlock) {
  return block.role === "assistant"
    ? (block.preview?.operationId ?? block.operationId)
    : undefined;
}

function ConversationActionBar({
  blocks: fallback,
  historyView,
  readOnly = false,
  user = false,
  retryOperationId,
  lifecycle,
  inboxActive,
  hasLaterOutput,
}: {
  blocks: FeatureBlock[];
  historyView?: NativeHistoryView;
  readOnly?: boolean;
  user?: boolean;
  retryOperationId?: string | null;
  lifecycle?: Transcript["turnLifecycle"];
  inboxActive?: boolean;
  hasLaterOutput?: (operationId: string) => boolean;
}) {
  const blocks = useConversationBlocks(fallback);
  const first = blocks[0];
  const texts = blocks.filter(
    (block) => block.kind === "text" && block.payload.text.trim(),
  );
  const answer = texts.length
    ? texts
    : blocks.filter(
        (block) => block.kind === "reasoning" && block.payload.text.trim(),
      );
  const variantActions = useAnswerVariantActions(answer);
  const observed = useRef<{ id?: string; pending: boolean }>({ pending: false });
  const [settled, setSettled] = useState<{ id: string; at: number }>();
  const output =
    user || readOnly
      ? undefined
      : [...blocks].reverse().find(assistantOutputOperation);
  const operationId = output && assistantOutputOperation(output);
  const exactLifecycle =
    lifecycle?.sessionId === output?.sessionId ? lifecycle : undefined;
  const receipt = operationId
    ? exactLifecycle?.operations[operationId]
    : undefined;
  const superseded = !!operationId && hasLaterOutput?.(operationId) === true;
  // A model round can validate before tools run. Its foreground receipt owns
  // settlement; a generic busy Session proves nothing about a historical row.
  const pending =
    !!operationId &&
    !superseded &&
    receipt !== "terminal" &&
    (receipt === "active" ||
      blocks.some(
        (block) =>
          assistantOutputOperation(block) === operationId &&
          block.stream === "streaming" &&
          (block.kind !== "tool" || block.tool?.status === "running"),
      ) ||
      (operationId.startsWith("inbox:") &&
        inboxActive === true &&
        observed.current.id === operationId &&
        observed.current.pending));
  useLayoutEffect(() => {
    if (
      operationId &&
      !pending &&
      !superseded &&
      observed.current.pending &&
      observed.current.id === operationId
    )
      setSettled({ id: operationId, at: Date.now() });
    observed.current = { id: operationId, pending };
  }, [operationId, pending, superseded]);
  let timestamp: number | null | undefined;
  for (const block of blocks)
    timestamp = block.endedMs ?? block.startedMs ?? timestamp;
  const terminalAt =
    operationId && !superseded
      ? exactLifecycle?.terminalAt?.[operationId]
      : undefined;
  const observedCompletionAt =
    operationId && !superseded
      ? (exactLifecycle?.terminalObservedAt?.[operationId] ??
        (operationId === settled?.id ? settled.at : undefined))
      : undefined;
  return (
    <ActionBar
      user={user}
      pending={pending}
      observedCompletionAt={observedCompletionAt}
      text={user ? first.payload.text : variantActions.text}
      pluginActions={
        user || readOnly ? undefined : variantActions.pluginActions
      }
      pluginActionScope={variantActions.actionScope}
      timestamp={
        user
          ? (first.startedMs ?? first.endedMs)
          : (terminalAt ?? (observedCompletionAt == null ? timestamp : undefined))
      }
      revertId={
        user &&
        isDirectUserSource(first.payload.source) &&
        !readOnly &&
        !first.temporary
          ? first.messageId
          : undefined
      }
      retryId={
        !readOnly &&
        retryOperationId &&
        blocks.some((block) => retryEligible(block, retryOperationId)) &&
        // A failure block renders its own labelled Retry inline.
        !blocks.some(
          (block) =>
            !!block.payload.failure && retryEligible(block, retryOperationId),
        )
          ? retryOperationId
          : undefined
      }
      tokens={user ? undefined : answerTokenUsage(blocks, historyView)}
    />
  );
}

function shortSummary(text: string, max = 40) {
  let line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? t("conversation.noPromptText");
  const sentence = line.match(/^.*?[。！？!?]/u)?.[0];
  if (sentence && [...sentence].length >= 5) line = sentence;
  return [...line].length > max
    ? [...line].slice(0, max).join("") + "..."
    : line;
}
interface NavTurn {
  blockId: string;
  index: number;
  block: FeatureBlock;
}
function TurnNavigator({
  turns,
  active,
  onNavigate,
  busy = false,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  turns: NavTurn[];
  active: number;
  onNavigate: (index: number) => void;
  busy?: boolean;
  canLoadOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder: () => void;
}) {
  const blocks = useConversationBlocks(turns.map((turn) => turn.block));
  const summaries = blocks.map((block) =>
    isCompactInstruction(block)
      ? block.payload.text.startsWith('Compaction with "')
        ? t("compaction.titleWith", {
            instruction: shortSummary(block.payload.text.slice(17, -1), 30),
          })
        : t("compaction.title")
      : shortSummary(block.payload.text),
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [center, setCenter] = useState(50);
  if (turns.length < 2 && !canLoadOlder) return null;
  return (
    <nav
      className="turn-navigator-rail"
      aria-label={t("conversation.turnNav")}
      onMouseLeave={() => setHovered(null)}
    >
      <div className="turn-navigator-scroller">
        {canLoadOlder && (
          <button
            className="turn-navigator-mark"
            type="button"
            aria-label={t(
              loadingOlder
                ? "conversation.loadingEarlier"
                : "conversation.loadEarlier",
            )}
            title={t("conversation.loadEarlier")}
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            <Icon name="clock" size={14} />
          </button>
        )}
        {turns.map((turn, index) => (
          <button
            key={turn.blockId}
            className="turn-navigator-mark"
            type="button"
            data-active={active === index}
            data-busy={index === turns.length - 1 && busy}
            aria-label={t("conversation.turnLabel", {
              index: index + 1,
              summary: summaries[index],
            })}
            aria-current={active === index ? "true" : "false"}
            onPointerEnter={(e) => {
              const button = e.currentTarget;
              setCenter(
                button.offsetTop +
                  button.offsetHeight / 2 -
                  (button.parentElement?.scrollTop ?? 0),
              );
              setHovered(index);
            }}
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(index);
            }}
          >
            <span className="turn-navigator-dot" />
          </button>
        ))}
      </div>
      {hovered != null && turns[hovered] && (
        <div
          className="turn-navigator-tooltip"
          style={{ "--turn-preview-center": `${center}px` } as CSSProperties}
        >
          <div className="turn-tooltip-header">
            <span className="turn-tooltip-tag">
              {t("conversation.turnN", { n: hovered + 1 })}
            </span>
          </div>
          <div className="turn-tooltip-summary">{summaries[hovered]}</div>
        </div>
      )}
    </nav>
  );
}
type ConversationProps = {
  transcript?: Transcript;
  readOnly?: boolean;
  footer?: ReactNode;
  notices?: ReactNode;
  userLabel?: string;
  sessionId?: string;
};

// The list selects immutable metadata owners; payloads stay in per-block subscriptions.
function sameMetadataFields<T extends object>(before: T, after: T) {
  return (Object.keys(after) as (keyof T)[]).every((key) =>
    Object.is(before[key], after[key]),
  );
}
function sameConversationMetadata(
  before: ReturnType<typeof conversationMetadata>,
  after: ReturnType<typeof conversationMetadata>,
) {
  return (Object.keys(after) as (keyof typeof after)[]).every((key) => {
    if (key === "transcript")
      return (
        before.transcript === after.transcript ||
        (!!before.transcript &&
          !!after.transcript &&
          sameMetadataFields(before.transcript, after.transcript))
      );
    if (key === "childHistory")
      return (
        before.childHistory === after.childHistory ||
        (!!before.childHistory &&
          !!after.childHistory &&
          sameMetadataFields(before.childHistory, after.childHistory))
      );
    return Object.is(before[key], after[key]);
  });
}
function conversationMetadata(state: AppState, provided: boolean) {
  const source = state.transcript;
  return {
    owner: state.authSession?.principal?.owner,
    sessionId: state.sessionId,
    viewMode: state.viewMode,
    conversationWidth: state.conversationWidth,
    resolvedLocale: state.resolvedLocale,
    compactOperation: state.compactOperation,
    retryOperationId: state.retryOperationId,
    isCreatingSession: state.isCreatingSession,
    historyTruncated: state.historyTruncated,
    executionActive: state.statistics?.activity.execution?.active,
    childHistory:
      state.popup.type === "subagentDetail"
        ? {
            parentId: state.popup.parentId,
            childId: state.popup.childId,
            nextCursor: state.popup.detail?.next_cursor,
          }
        : null,
    transcript: provided
      ? null
      : {
          historyView: source.historyView,
          historyGap: source.historyGap,
          historyTruncated: source.historyTruncated,
          displayCoverage: source.displayCoverage,
          turnLifecycle: source.turnLifecycle,
          inboxActive: source.inboxActive,
          sessionStatus: source.sessionStatus,
          compactionActive: source.compactionActive,
          pendingQuestions: source.pendingQuestions,
          pendingPermission: source.pendingPermission,
        },
  };
}

export function Conversation(props: ConversationProps = {}) {
  const store = useAppStore();
  const local = useIsolatedConversationRegistry(props.transcript);
  const registry = props.transcript ? local : store.conversation;
  const locale = useAppSelector((state) => state.resolvedLocale);
  return (
    <CitationConversationProvider
      transcript={props.transcript}
      sessionId={props.sessionId}
      readOnly={props.readOnly}
    >
      <ConversationRegistryProvider registry={registry} locale={locale}>
        <ConversationList {...props} registry={registry} />
      </ConversationRegistryProvider>
    </CitationConversationProvider>
  );
}

function ConversationList({
  transcript: provided,
  readOnly = false,
  footer,
  notices,
  userLabel,
  sessionId,
  registry,
}: ConversationProps & { registry: ConversationRegistry }) {
  const store = useAppStore();
  const dispatch = useAppDispatch();
  const state = useAppSelector(
    (state) => conversationMetadata(state, !!provided),
    sameConversationMetadata,
  );
  const structureRevision = useConversationStructure(registry);
  const transcript: Transcript = useMemo(
    () =>
      provided ?? {
        ...store.getSnapshot().transcript,
        ...state.transcript,
      },
    [provided, store, state.transcript, structureRevision],
  );
  const viewId = sessionId ?? provided?.blocks[0]?.sessionId ?? state.sessionId;
  const turnPrefix = readOnly ? `child-${viewId}-turn-` : "chat-turn-";
  const cardPositions = useRef<{
    sessionId: string;
    positions: CardBoundaries;
  }>({
    sessionId: viewId ?? "",
    positions: new Map(),
  });
  if (cardPositions.current.sessionId !== viewId) {
    cardPositions.current = { sessionId: viewId ?? "", positions: new Map() };
  }
  const questionKey = JSON.stringify(transcript.pendingQuestions);
  const compactKey = JSON.stringify(state.compactOperation);
  const blocks = useMemo(
    () =>
      orderedCards(
        [...registry.blocks()],
        readOnly ? [] : transcript.pendingQuestions,
        readOnly ? null : state.compactOperation,
        viewId ?? "",
        cardPositions.current.positions,
      ),
    [registry, structureRevision, questionKey, readOnly, compactKey, viewId],
  );
  const [showAll, setShowAll] = useState(false);
  const [foldBoundary, setFoldBoundary] = useState<string | null>(null);
  const [toolExpanded, setToolExpanded] = useState<
    Record<string, { expanded: boolean; revision: number }>
  >({});
  const interactionRevision = useRef(0);
  const readingInteraction = useRef<{ key: string; revision: number } | null>(
    null,
  );
  const markInteraction = (
    key: string,
    revision = ++interactionRevision.current,
  ) => {
    readingInteraction.current = { key, revision };
  };
  const [toolOpen, setToolOpen] = useState<
    Record<string, { open: boolean; revision: number }>
  >({});
  const liveExpanded = useRef(new Set<string>());
  const toolGroupKeys = useRef(new Map<string, string>());
  const assistantChunkKeys = useRef(new Map<string, string>());
  const nextChunkKey = useRef(0);
  const foldPolicy = useRef<HistoryFoldState>({
    observed: false,
    completionRevision: null,
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Follow changes schedule layout publication; the synchronous ref below
  // owns the follow value used by scroll handlers and reading anchors.
  const [stick, setStick] = useState(true);
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLElement>(null);
  const following = useRef(true);
  const pauseRevision = useRef(0);
  const jumping = useRef(false);
  const pendingTurn = useRef<number | null>(null);
  const historyLoad = useRef<object | null>(null);
  const historyAnchor = useRef<{
    scope: string;
    id: string;
    top: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const viewScopeKey = JSON.stringify([
    state.owner,
    state.sessionId,
    readOnly,
    viewId,
  ]);
  const [historyChanged, setHistoryChanged] = useState(false);
  const previousViewScope = useRef(viewScopeKey);
  const presentationReset = useRef(false);
  const historyScopeKey = JSON.stringify([
    viewScopeKey,
    transcript.historyView?.lineage ?? "legacy",
    transcript.historyView?.epoch ?? null,
  ]);
  const historyScope = useRef(historyScopeKey);
  historyScope.current = historyScopeKey;
  const previousPresentation = useRef({
    view: viewScopeKey,
    history: transcript.historyView,
    reset: transcript.historyResetRevision,
    identities: new Map(
      blocks.map((block) => [block.id, presentationIdentity(block)]),
    ),
  });
  const priorPresentation = previousPresentation.current;
  const authorityReset =
    historyBranchReplaced(priorPresentation.history, transcript.historyView) ||
    (priorPresentation.reset ?? 0) !== (transcript.historyResetRevision ?? 0);
  const changedIdentity = blocks.some((block) => {
    const prior = priorPresentation.identities.get(block.id);
    return prior !== undefined && presentationIdentityChanged(prior, block);
  });
  const presentationRevision = useRef(0);
  if (
    priorPresentation.view !== viewScopeKey ||
    authorityReset ||
    changedIdentity
  )
    presentationRevision.current++;
  const presentationScopeKey = JSON.stringify([
    viewScopeKey,
    presentationRevision.current,
  ]);
  previousPresentation.current = {
    view: viewScopeKey,
    history: transcript.historyView,
    reset: transcript.historyResetRevision,
    identities: new Map(
      blocks.map((block) => [block.id, presentationIdentity(block)]),
    ),
  };
  const presentationScope = useRef(presentationScopeKey);
  const previousScrollTop = useRef(0);
  const bottomIntentUntil = useRef(0);
  const touchY = useRef<number | null>(null);
  const readingAnchor = useRef<{
    scope: string;
    id: string;
    top: number;
  } | null>(null);
  const resetAnchors = useRef<Array<{ messages: string[]; offset: number }>>(
    [],
  );
  const anchorAuthority = useRef(presentationScopeKey);
  const canonicalMessages = (items: FeatureBlock[]) =>
    JSON.stringify(
      items.flatMap((block) => {
        const id = block.messageId ?? block.preview?.canonicalMessageId;
        return id ? [id] : [];
      }),
    );
  const captureReadingAnchor = (preserve = false) => {
    const host = scroll.current;
    if (!host || host.clientHeight === 0) return;
    if (following.current) {
      readingAnchor.current = null;
      return;
    }
    const top = host.getBoundingClientRect().top;
    if (anchorAuthority.current === presentationScopeKey)
      resetAnchors.current = [
        ...host.querySelectorAll<HTMLElement>("[data-canonical-messages]"),
      ]
        .map((node) => ({
          messages: JSON.parse(
            node.dataset.canonicalMessages ?? "[]",
          ) as string[],
          offset: node.getBoundingClientRect().top - top,
        }))
        .filter((anchor) => anchor.messages.length > 0)
        .sort((left, right) => Math.abs(left.offset) - Math.abs(right.offset));
    const rows = [
      ...host.querySelectorAll<HTMLElement>(
        "[data-history-id], [data-reading-id]",
      ),
    ];
    const anchor = readingAnchor.current;
    if (
      preserve &&
      anchor?.scope === viewScopeKey &&
      rows.some(
        (node) =>
          (node.dataset.readingId ?? node.dataset.historyId) === anchor.id,
      )
    )
      return;
    previousScrollTop.current = host.scrollTop;
    const visibleRows = rows.filter(
      (node) => node.getBoundingClientRect().bottom > top,
    );
    const row =
      visibleRows
        .filter((node) => node.getBoundingClientRect().top <= top + 80)
        .at(-1) ?? visibleRows[0];
    readingAnchor.current = row
      ? {
          scope: viewScopeKey,
          id: row.dataset.readingId ?? row.dataset.historyId!,
          top: row.getBoundingClientRect().top - top,
        }
      : null;
  };
  const restoreReadingAnchor = () => {
    const host = scroll.current;
    const anchor = readingAnchor.current;
    if (
      !host ||
      host.clientHeight === 0 ||
      !anchor ||
      anchor.scope !== viewScopeKey
    )
      return;
    const row = [
      ...host.querySelectorAll<HTMLElement>(
        "[data-history-id], [data-reading-id]",
      ),
    ].find(
      (node) =>
        (node.dataset.readingId ?? node.dataset.historyId) === anchor.id,
    );
    if (row) {
      // A user may move the viewport before the native scroll callback runs.
      // Compensation writes update previousScrollTop synchronously, so only an
      // unobserved movement changes the user's requested reading offset here.
      // Content replacement can clamp the old scroll position to a smaller
      // maximum before the browser dispatches scroll. Only movement beyond that
      // passive clamp changes the user's requested reading offset.
      const prior = Math.min(
        previousScrollTop.current,
        Math.max(0, host.scrollHeight - host.clientHeight),
      );
      anchor.top -= host.scrollTop - prior;
      const delta =
        row.getBoundingClientRect().top -
        host.getBoundingClientRect().top -
        anchor.top;
      if (Math.abs(delta) > 0.5) host.scrollTop += delta;
      previousScrollTop.current = host.scrollTop;
    }
  };
  // Layout scrolling and browser anchoring are effects of content updates, not
  // consent to resume following. Only a user bottom gesture/send can do that.
  useLayoutEffect(() => {
    // The anchor was measured before disclosure. Preserve that same node/offset
    // after the body mounts instead of replacing it with the toggled row.
    if (!following.current) restoreReadingAnchor();
    else followLatest();
    captureReadingAnchor(true);
  });
  const followLatest = () => {
    const host = scroll.current;
    if (!host || host.clientHeight === 0 || !following.current) return;
    for (const body of host.querySelectorAll<HTMLElement>(
      '.think-card[data-expanded="true"][data-streaming="true"] .think-content',
    ))
      body.scrollTop = body.scrollHeight;
    host.scrollTop = host.scrollHeight;
    previousScrollTop.current = host.scrollTop;
  };
  useLayoutEffect(() => {
    const host = scroll.current;
    const inner = host?.querySelector(".transcript-inner");
    if (!host || !inner) return;
    const sync = () => {
      if (host.clientHeight === 0) return;
      if (following.current) followLatest();
      else {
        bottomIntentUntil.current = 0;
        restoreReadingAnchor();
      }
      captureReadingAnchor(true);
    };
    // The footer is outside the scroller. Changes to its height resize the
    // transcript viewport, but are never a request to resume following.
    const observer = new ResizeObserver(sync);
    observer.observe(inner);
    observer.observe(host);
    const observed = new WeakSet<Element>();
    const observeThinking = () => {
      // The capped scroll host stops resizing at 480px. Observe its actual
      // Markdown instead, including delayed code/media layout changes.
      for (const content of inner.querySelectorAll(
        ".think-content > .markdown-body",
      )) {
        if (observed.has(content)) continue;
        observed.add(content);
        observer.observe(content);
      }
    };
    observeThinking();
    let frame: number | undefined;
    const changed = () => {
      if (frame !== undefined) return;
      // Registry content notifications precede the subscribed piece's commit.
      // Read the rendered content on the next frame without rerendering the list.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        observeThinking();
        sync();
      });
    };
    const unsubscribe = registry
      .blocks()
      .filter((block) => block.kind === "reasoning")
      .map((block) => registry.subscribe(block.id, changed));
    return () => {
      observer.disconnect();
      unsubscribe.forEach((dispose) => dispose());
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [presentationScopeKey, structureRevision, stick]);
  const pauseForReading = () => {
    pauseRevision.current++;
    bottomIntentUntil.current = 0;
    jumping.current = false;
    following.current = false;
    setStick(false);
    captureReadingAnchor();
  };
  useEffect(() => {
    const selected = () => {
      const selection = window.getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        scroll.current?.contains(selection.anchorNode)
      )
        pauseForReading();
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [presentationScopeKey]);
  const resumeFollowing = () => {
    setHistoryChanged(false);
    following.current = true;
    readingAnchor.current = null;
    setStick(true);
    const host = scroll.current;
    if (host) host.scrollTop = host.scrollHeight;
  };
  const submissionIntent = () => {
    const revision = pauseRevision.current;
    const scope = historyScopeKey;
    return () => {
      if (revision === pauseRevision.current && scope === historyScope.current)
        resumeFollowing();
    };
  };
  const requestBottomFollow = () => {
    bottomIntentUntil.current = performance.now() + 1500;
    const host = scroll.current;
    if (host && host.scrollHeight - host.scrollTop - host.clientHeight <= 35) {
      bottomIntentUntil.current = 0;
      resumeFollowing();
    }
  };
  const navTurns: NavTurn[] = useMemo(
    () =>
      computeTurns({ ...transcript, blocks })
        .filter((t) => t.userIndex != null && blocks[t.userIndex])
        .map((t, index) => {
          const b = blocks[t.userIndex];
          return {
            index,
            blockId: b.id,
            block: b,
          };
        }),
    [blocks, transcript.historyView, state.resolvedLocale],
  );
  const execution = !provided && !readOnly ? state.executionActive : false;
  const completion = transcript.turnLifecycle?.completionRevision ?? null;
  const foldingBusy =
    (transcript.turnLifecycle?.activeOperationIds.length ?? 0) > 0 ||
    transcript.inboxActive === true ||
    isBusy(transcript) ||
    ["running", "thinking"].includes(lower(transcript.sessionStatus)) ||
    transcript.compactionActive === true ||
    execution === true;
  useEffect(() => {
    const eligible =
      navTurns.length > 2 || (navTurns.length > 1 && blocks.length > 30);
    const boundary = eligible
      ? (navTurns[Math.max(0, navTurns.length - 2)]?.blockId ?? null)
      : null;
    const decision = historyFoldPolicy(foldPolicy.current, {
      hasBlocks: blocks.length > 0,
      busy: foldingBusy,
      completionRevision: completion,
      following: following.current,
      showAll,
      failed: blocks.some(
        (block) => block.stream === "error" || block.payload.failure,
      ),
    });
    foldPolicy.current = decision.state;
    if (decision.fold) setFoldBoundary(boundary);
  }, [completion, blocks, navTurns, showAll, foldingBusy]);
  const startTurn =
    showAll || (!readOnly && transcript.pendingQuestions.length > 0)
      ? 0
      : Math.max(
          0,
          navTurns.findIndex((turn) => turn.blockId === foldBoundary),
        );
  const first = startTurn
    ? Math.max(
        0,
        blocks.findIndex((b) => b.id === navTurns[startTurn]?.blockId),
      )
    : 0;
  const firstCard = blocks.findIndex((block) => block.kind === "question");
  const visible = useMemo(
    () => blocks.slice(firstCard >= 0 ? Math.min(first, firstCard) : first),
    [blocks, firstCard, first],
  );
  // Content updates notify pieces; only structure and overlays regroup.
  const stream = useMemo(() => chunks(groupBlocks(visible)), [visible]);
  const turnKey = (block: FeatureBlock) => {
    const position = block.position ?? block.preview;
    return position?.epoch != null && position.turn != null
      ? `${position.epoch}:${position.turn}`
      : null;
  };
  const nativeCallKey = (block: FeatureBlock) => {
    const position = block.position ?? block.preview;
    const call = block.callId ?? block.tool?.callId ?? block.tool?.id;
    return position &&
      [position.epoch, position.turn, position.round].every(
        Number.isSafeInteger,
      ) &&
      typeof call === "string" &&
      call
      ? `${position.epoch}:${position.turn}:${position.round}:${call}`
      : `row:${block.id}`;
  };
  // Keep the disclosure owner for a streamed slot once it gains a call id.
  // The exact native row and scoped slot prove this upgrade; a coincidentally
  // reused call id on a replaced branch does not.
  const toolSlots = useRef(new Map<string, { identity: string; key: string }>());
  if (priorPresentation.view !== viewScopeKey || authorityReset)
    toolSlots.current.clear();
  const keysByToolRow = new Map<string, string>();
  const nextToolSlots = new Map<string, { identity: string; key: string }>();
  for (const block of blocks) {
    if (block.kind !== "tool") continue;
    const prior = toolSlots.current.get(block.id);
    const key = prior && !presentationIdentityChanged(prior.identity, block)
      ? prior.key
      : nativeCallKey(block);
    keysByToolRow.set(block.id, key);
    nextToolSlots.set(block.id, { identity: presentationIdentity(block), key });
  }
  toolSlots.current = nextToolSlots;
  const callKey = (block: FeatureBlock) => keysByToolRow.get(block.id) ?? nativeCallKey(block);
  const canonicalTools = new Map(
    blocks
      .filter((block) => block.kind === "tool")
      .map((block) => [callKey(block), presentationIdentity(block)] as const),
  );
  const previousCanonicalTools = useRef(canonicalTools);
  const survivingCalls = new Set(
    [...canonicalTools]
      .filter(
        ([key, identity]) =>
          previousCanonicalTools.current.get(key) === identity,
      )
      .map(([key]) => key),
  );
  useLayoutEffect(() => {
    previousCanonicalTools.current = canonicalTools;
  });
  if (presentationScope.current !== presentationScopeKey) {
    presentationScope.current = presentationScopeKey;
    for (const keys of [toolGroupKeys.current, assistantChunkKeys.current])
      for (const key of keys.keys())
        if (
          previousViewScope.current !== viewScopeKey ||
          (key.startsWith("call:")
            ? !survivingCalls.has(key.slice(5))
            : !blocks.some(
                (block) =>
                  key === `block:${block.id}` &&
                  priorPresentation.identities.get(block.id) ===
                    presentationIdentity(block),
              ))
        )
          keys.delete(key);
  }
  const blockKey = (block: FeatureBlock) =>
    block.kind === "tool" ? `call:${callKey(block)}` : `block:${block.id}`;
  const recordReadingInteraction = (target: EventTarget) => {
    const element = target instanceof Element ? target : null;
    const owner = element?.closest<HTMLElement>("[data-interaction-key]");
    const key = owner?.dataset.interactionKey;
    if (!key) return;
    const revision = ++interactionRevision.current;
    markInteraction(key, revision);
    // Body focus/selection can move back to B after A was last toggled. Only an
    // already rendered open row may refresh its open intent; closed rows/groups
    // are never reopened by focus or by an old native reading witness.
    if (owner?.dataset.expanded !== "true") return;
    const block = blocks.find(
      (candidate) => candidate.kind === "tool" && blockKey(candidate) === key,
    );
    if (!block || !toolOpen[callKey(block)]?.open) return;
    const id = callKey(block);
    setToolOpen((previous) =>
      previous[id]?.open
        ? {
            ...previous,
            [id]: { open: true, revision },
          }
        : previous,
    );
    setToolExpanded((previous) => ({
      ...previous,
      [id]: { expanded: true, revision },
    }));
  };
  const interactionPriority = (id: string) => {
    const call = id.startsWith("call:") ? id.slice(5) : null;
    const revision = Math.max(
      call ? (toolExpanded[call]?.revision ?? 0) : 0,
      call ? (toolOpen[call]?.revision ?? 0) : 0,
      readingInteraction.current?.key === id
        ? readingInteraction.current.revision
        : 0,
    );
    return revision * 2 + (readingInteraction.current?.key === id ? 1 : 0);
  };
  const chunkKeys = retainRenderKeys(
    stream
      .filter((chunk) => chunk.assistant)
      .map((chunk) => ({
        item: chunk,
        ids: chunk.items.flatMap((item) => item.blocks.map(blockKey)),
        fallback: () => `assistant-chunk:${nextChunkKey.current++}`,
      })),
    assistantChunkKeys.current,
    interactionPriority,
  );
  const toolItems = stream
    .flatMap((chunk) => chunk.items)
    .filter((item) => item.type === "tools");
  const groupKeys = retainRenderKeys(
    toolItems.map((item) => ({
      item,
      ids: item.blocks.map(blockKey),
      fallback: () => `tools:${callKey(item.blocks[0])}`,
    })),
    toolGroupKeys.current,
    interactionPriority,
  );
  const toolGroupCounts = new Map<string | null, number>();
  for (const item of toolItems) {
    const scope = turnKey(item.blocks[0]);
    toolGroupCounts.set(scope, (toolGroupCounts.get(scope) ?? 0) + 1);
  }
  const latestPosition = [...blocks]
    .reverse()
    .find((block) => turnKey(block) != null);
  const activeTurn = latestPosition && turnKey(latestPosition);
  const toolPresentation = (
    item: ConversationItem,
  ): ToolGroupPresentation | undefined => {
    if (item.type !== "tools") return undefined;
    const scope = turnKey(item.blocks[0]);
    const current =
      scope != null &&
      scope === activeTurn &&
      (transcript.inboxActive === true || isBusy(transcript));
    const ids = item.blocks.map(callKey);
    if (current) ids.forEach((id) => liveExpanded.current.add(id));
    const explicit = ids
      .map((id) => toolExpanded[id])
      .filter((choice) => choice !== undefined)
      .sort((left, right) => right.revision - left.revision)[0];
    const loaded = new Set(
      blocks
        .filter((block) => block.kind === "tool" && turnKey(block) === scope)
        .map(callKey),
    ).size;
    const summary = transcript.historyView?.turns.find(
      (turn) => `${turn.epoch}:${turn.turn}` === scope,
    );
    const opened = item.blocks
      .filter((block) => toolOpen[callKey(block)]?.open)
      .sort(
        (left, right) =>
          toolOpen[callKey(right)].revision - toolOpen[callKey(left)].revision,
      )[0];
    return {
      expanded: explicit
        ? explicit.expanded
        : current || ids.some((id) => liveExpanded.current.has(id)),
      active: current,
      grouped: (toolGroupCounts.get(scope) ?? 0) > 1,
      partial:
        transcript.historyGap ||
        (transcript.historyTruncated === true &&
          (!summary || loaded < summary.ordinary_tool_calls)),
      rowKey: blockKey,
      openId: opened?.id ?? null,
      onExpandedChange: (expanded) => {
        setShowAll(true);
        const revision = ++interactionRevision.current;
        markInteraction(blockKey(opened ?? item.blocks[0]), revision);
        setToolExpanded((previous) => ({
          ...previous,
          ...Object.fromEntries(ids.map((id) => [id, { expanded, revision }])),
        }));
      },
      onOpenChange: (id) => {
        setShowAll(true);
        const revision = ++interactionRevision.current;
        const selected = item.blocks.find((block) => block.id === id);
        const interacted = selected ?? opened;
        if (interacted) markInteraction(blockKey(interacted), revision);
        if (selected)
          setToolExpanded((previous) => ({
            ...previous,
            [callKey(selected)]: { expanded: true, revision },
          }));
        setToolOpen((previous) => ({
          ...previous,
          ...Object.fromEntries(
            item.blocks.map((block) => [
              callKey(block),
              { open: block.id === id, revision },
            ]),
          ),
        }));
      },
    };
  };
  const canLoadRemote = readOnly
    ? state.childHistory?.parentId === state.sessionId &&
      state.childHistory?.childId === viewId &&
      state.childHistory?.nextCursor != null
    : !provided && state.historyTruncated;
  const loadOlder = async () => {
    if (historyLoad.current || (startTurn === 0 && !canLoadRemote)) return;
    const host = scroll.current;
    if (!host || host.clientHeight === 0) return;
    const rows = [...host.querySelectorAll<HTMLElement>("[data-history-id]")];
    const top = host.getBoundingClientRect().top;
    const row = rows.find(
      (node) =>
        node.getBoundingClientRect().bottom > top &&
        ![...node.querySelectorAll<HTMLElement>("[data-history-id]")].some(
          (child) => child.getBoundingClientRect().bottom > top,
        ),
    );
    historyAnchor.current = row
      ? {
          scope: historyScopeKey,
          id: row.dataset.historyId!,
          top: row.getBoundingClientRect().top,
          scrollTop: host.scrollTop,
          scrollHeight: host.scrollHeight,
        }
      : null;
    pauseRevision.current++;
    following.current = false;
    jumping.current = false;
    setStick(false);
    const scope = historyScopeKey;
    const request = {};
    historyLoad.current = request;
    setLoadingOlder(true);
    try {
      if (startTurn > 0) setShowAll(true);
      else
        await dispatch({
          type: readOnly ? "LoadEarlierChildMessages" : "LoadEarlier",
        });
      if (historyScope.current === scope) setShowAll(true);
    } finally {
      if (historyLoad.current === request) {
        historyLoad.current = null;
        setLoadingOlder(false);
      }
    }
  };
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const host = scroll.current;
    if (!anchor || !host) return;
    if (anchor.scope !== historyScopeKey) {
      historyAnchor.current = null;
      return;
    }
    const row = [
      ...host.querySelectorAll<HTMLElement>("[data-history-id]"),
    ].find((node) => node.dataset.historyId === anchor.id);
    if (row) host.scrollTop += row.getBoundingClientRect().top - anchor.top;
    else
      host.scrollTop =
        anchor.scrollTop + host.scrollHeight - anchor.scrollHeight;
    previousScrollTop.current = host.scrollTop;
    historyAnchor.current = null;
  }, [visible[0]?.id, showAll, historyScopeKey]);
  const anchors = new Map(
    navTurns.map((t) => [t.blockId, `${turnPrefix}${t.index}`]),
  );
  const turnNodes = () =>
    Array.from(
      scroll.current?.querySelectorAll<HTMLElement>("[id]") ?? [],
    ).filter((node) => node.id.startsWith(turnPrefix));
  const updateActive = () => {
    const element = scroll.current;
    if (!element) return;
    const nodes = turnNodes();
    if (!nodes.length) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    let next = Number(nodes[0].id.slice(turnPrefix.length));
    if (distance <= 40)
      next = Number(nodes[nodes.length - 1].id.slice(turnPrefix.length));
    else
      for (const node of nodes) {
        if (
          node.getBoundingClientRect().top <=
          element.getBoundingClientRect().top + 120
        )
          next = Number(node.id.slice(turnPrefix.length));
        else break;
      }
    setActive(next);
  };
  const toBottom = () => {
    setHistoryChanged(false);
    const element = scroll.current;
    if (!element) return;
    following.current = true;
    setStick(true);
    jumping.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    const pin = () => {
      const current = scroll.current;
      if (!jumping.current || !current) return;
      const gap =
        current.scrollHeight - current.scrollTop - current.clientHeight;
      // Content or footer height can change before the smooth scroll settles.
      if (gap > 1) current.scrollTop = current.scrollHeight;
      jumping.current = false;
      following.current = true;
      setStick(true);
      updateActive();
    };
    element.addEventListener("scrollend", pin, { once: true });
    window.setTimeout(pin, 700);
  };
  useLayoutEffect(() => {
    historyLoad.current = null;
    historyAnchor.current = null;
    setLoadingOlder(false);
  }, [historyScopeKey]);
  useLayoutEffect(() => {
    const changedView = previousViewScope.current !== viewScopeKey;
    const hadHistory = presentationReset.current;
    previousViewScope.current = viewScopeKey;
    presentationReset.current = true;
    historyLoad.current = null;
    historyAnchor.current = null;
    previousScrollTop.current = scroll.current?.scrollTop ?? 0;
    readingAnchor.current = null;
    bottomIntentUntil.current = 0;
    jumping.current = false;
    if (changedView || !hadHistory) {
      setShowAll(false);
      following.current = true;
      setStick(true);
      setHistoryChanged(false);
    } else {
      // A new canonical authority revokes row identities, not user consent to
      // follow. Coordinates/call ids can be reused by a different branch.
      pauseRevision.current++;
      following.current = false;
      setStick(false);
      setHistoryChanged(true);
      const host = scroll.current;
      if (host) {
        const rows = [
          ...host.querySelectorAll<HTMLElement>("[data-canonical-messages]"),
        ];
        for (const anchor of resetAnchors.current) {
          const survivor = rows.find((node) => {
            const ids = JSON.parse(
              node.dataset.canonicalMessages ?? "[]",
            ) as string[];
            return anchor.messages.some((id) => ids.includes(id));
          });
          if (survivor) {
            host.scrollTop +=
              survivor.getBoundingClientRect().top -
              host.getBoundingClientRect().top -
              anchor.offset;
            break;
          }
        }
      }
    }
    setFoldBoundary(null);
    const keep = (key: string) =>
      !changedView && hadHistory && survivingCalls.has(key);
    setToolExpanded((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => keep(key))),
    );
    setToolOpen((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => keep(key))),
    );
    liveExpanded.current.clear();
    interactionRevision.current = 0;
    readingInteraction.current = null;
    foldPolicy.current = { observed: false, completionRevision: null };
    setLoadingOlder(false);
    pendingTurn.current = null;
    anchorAuthority.current = presentationScopeKey;
    captureReadingAnchor();
  }, [presentationScopeKey]);
  useEffect(() => {
    if (pendingTurn.current != null && showAll) {
      turnNodes()
        .find((node) => node.id === `${turnPrefix}${pendingTurn.current}`)
        ?.scrollIntoView();
      pendingTurn.current = null;
      captureReadingAnchor();
    } else if (following.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    updateActive();
  }, [
    transcript,
    blocks,
    blocks.length,
    blocks.at(-1)?.payload.text,
    showAll,
    state.viewMode,
  ]);
  const navigate = (index: number) => {
    readingAnchor.current = null;
    bottomIntentUntil.current = 0;
    jumping.current = false;
    pauseRevision.current++;
    following.current = false;
    setStick(false);
    setActive(index);
    pendingTurn.current = index;
    if (!showAll) setShowAll(true);
    else {
      turnNodes()
        .find((node) => node.id === `${turnPrefix}${index}`)
        ?.scrollIntoView();
      pendingTurn.current = null;
      captureReadingAnchor();
    }
  };
  return (
    <div
      className="transcript-wrap"
      style={
        {
          "--chat-content-width": `${state.conversationWidth}px`,
        } as CSSProperties
      }
    >
      <WidthHandle side="left" />
      <WidthHandle side="right" />
      <section
        ref={scroll}
        id={readOnly ? `child-transcript-${viewId}` : "conversation-transcript"}
        className="transcript"
        data-following={stick}
        data-history-epoch={transcript.historyView?.epoch}
        aria-live="polite"
        onPointerDownCapture={(event) => recordReadingInteraction(event.target)}
        onFocusCapture={(event) => {
          recordReadingInteraction(event.target);
          if ((event.target as HTMLElement).closest(".transcript-inner"))
            pauseForReading();
        }}
        onClickCapture={(event) => {
          const target = event.target as HTMLElement;
          if (
            target.closest(
              ".transcript-inner [aria-expanded], .transcript-inner .think-header",
            )
          ) {
            bottomIntentUntil.current = 0;
            jumping.current = false;
            pauseRevision.current++;
            following.current = false;
            captureReadingAnchor();
            setStick(false);
          }
        }}
        onPointerDown={(event) => {
          // Includes dragging the native scrollbar; clicks on disclosure controls
          // are handled separately and never count as a bottom gesture.
          if (event.target === event.currentTarget)
            bottomIntentUntil.current = performance.now() + 1500;
          else if ((event.target as HTMLElement).matches(".think-content"))
            pauseForReading();
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const nextY = event.touches[0]?.clientY;
          if (nextY == null || touchY.current == null) return;
          if (nextY < touchY.current) requestBottomFollow();
          else if (nextY > touchY.current) {
            bottomIntentUntil.current = 0;
            pauseRevision.current++;
            following.current = false;
            jumping.current = false;
            setStick(false);
          }
          touchY.current = nextY;
        }}
        onKeyDown={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "input, textarea, [contenteditable=true]",
            )
          )
            return;
          if (
            ["End", "PageDown", "ArrowDown", " "].includes(event.key) &&
            !(event.key === " " && event.shiftKey)
          )
            requestBottomFollow();
          else if (
            ["Home", "PageUp", "ArrowUp"].includes(event.key) ||
            (event.key === " " && event.shiftKey)
          ) {
            bottomIntentUntil.current = 0;
            pauseRevision.current++;
            following.current = false;
            jumping.current = false;
            setStick(false);
          }
        }}
        onWheel={(e) => {
          if (e.deltaY > 0) requestBottomFollow();
          if (e.deltaY < 0) {
            bottomIntentUntil.current = 0;
            jumping.current = false;
            pauseRevision.current++;
            following.current = false;
            setStick(false);
            if (e.currentTarget.scrollTop <= 48) void loadOlder();
          }
        }}
        onScroll={(e) => {
          if (e.target !== e.currentTarget) return;
          const el = e.currentTarget;
          // Growth can deliver scroll before ResizeObserver pins the new bottom.
          // A gap is a layout fact, not a new reading gesture. Also account for
          // passive clamping when content shrinks below the old scroll position.
          const priorTop = Math.min(
            previousScrollTop.current,
            Math.max(0, el.scrollHeight - el.clientHeight),
          );
          const moved = el.scrollTop !== priorTop;
          const movingUp = el.scrollTop < priorTop;
          previousScrollTop.current = el.scrollTop;
          if (movingUp && el.scrollTop <= 48) void loadOlder();
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (jumping.current) {
            if (gap <= 1) {
              jumping.current = false;
              following.current = true;
              setStick(true);
            }
            updateActive();
            return;
          }
          const atBottom = gap <= 35;
          const userBottom =
            atBottom &&
            !movingUp &&
            performance.now() < bottomIntentUntil.current;
          if (userBottom) bottomIntentUntil.current = 0;
          const nextFollow = userBottom || (following.current && !movingUp);
          if (following.current && !nextFollow) pauseRevision.current++;
          following.current = nextFollow;
          setStick(following.current);
          captureReadingAnchor(!moved);
          updateActive();
        }}
      >
        <div className="transcript-inner">
          {historyChanged && (
            <ExpandableNotice
              className="child-content-notice"
              tone="neutral"
              marker="none"
              role="status"
              data-testid="history-reading-changed"
              text={t("conversation.inspectionChanged")}
            />
          )}
          {notices}
          {(transcript.displayCoverage === "unavailable" ||
            transcript.displayCoverage === "missing") && (
            <ExpandableNotice
              className="transcript-history-fold-banner transcript-status-notice"
              tone={
                transcript.displayCoverage === "unavailable"
                  ? "warn"
                  : "neutral"
              }
              role="status"
              data-testid="conversation-display-coverage"
              text={t(
                transcript.displayCoverage === "unavailable"
                  ? "conversation.displayUnavailable"
                  : "conversation.displayMissing",
              )}
            />
          )}
          {transcript.historyGap && (
            <ExpandableNotice
              className="transcript-history-fold-banner transcript-status-notice"
              tone="neutral"
              role="status"
              data-testid="conversation-history-gap"
              text={t("conversation.historyGap")}
            />
          )}
          {startTurn === 0 && canLoadRemote && (
            <div className="transcript-history-fold-banner">
              <button
                className="transcript-history-fold-btn"
                type="button"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
                data-testid="conversation-load-earlier"
              >
                <Icon name="clock" />
                <span>
                  {t(
                    loadingOlder
                      ? "conversation.loadingEarlier"
                      : "conversation.loadEarlier",
                  )}
                </span>
              </button>
            </div>
          )}
          {startTurn > 0 && (
            <div className="transcript-history-fold-banner">
              <button
                className="transcript-history-fold-btn"
                type="button"
                onClick={() => void loadOlder()}
              >
                <Icon name="clock" />
                <span>
                  {t("conversation.showEarlierTurns", {
                    count: startTurn,
                    total: navTurns.length,
                  })}
                </span>
              </button>
            </div>
          )}
          {stream.map((chunk, index) => {
            const flat = chunk.items.flatMap((i) => i.blocks);
            const key =
              chunkKeys.get(chunk) ??
              groupKeys.get(chunk.items[0]) ??
              flat[0].id;
            const anchor = flat.map((b) => anchors.get(b.id)).find(Boolean);
            if (chunk.assistant) {
              return (
                <div
                  className="message-turn-container assistant-turn"
                  key={key}
                  id={anchor}
                  data-history-id={key}
                  data-canonical-messages={canonicalMessages(flat)}
                >
                  <PluginAnswerVariants blocks={flat} readOnly={readOnly}>
                    {chunk.items.map((item) => (
                      <div
                        key={groupKeys.get(item) ?? item.blocks[0].id}
                        className="assistant-piece-anchor"
                        data-interaction-key={
                          item.type === "single"
                            ? blockKey(item.blocks[0])
                            : undefined
                        }
                        data-history-id={
                          groupKeys.get(item) ?? item.blocks[0].id
                        }
                      >
                        {renderPiece(
                          item,
                          undefined,
                          readOnly,
                          toolPresentation(item),
                        )}
                      </div>
                    ))}
                    <ConversationActionBar
                      blocks={flat}
                      historyView={transcript.historyView}
                      readOnly={readOnly}
                      retryOperationId={state.retryOperationId}
                      lifecycle={transcript.turnLifecycle}
                      inboxActive={transcript.inboxActive}
                      hasLaterOutput={(operationId) =>
                        stream.some(
                          (next, nextIndex) =>
                            nextIndex > index &&
                            next.assistant &&
                            next.items.some((item) =>
                              item.blocks.some(
                                (block) => assistantOutputOperation(block) === operationId,
                              ),
                            ),
                        )
                      }
                    />
                  </PluginAnswerVariants>
                </div>
              );
            }
            const item = chunk.items[0],
              b = item.blocks[0];
            return item.type === "single" && b.role === "user" ? (
              <div
                className="message-turn-container user-turn"
                key={key}
                id={anchor}
                data-message-source={
                  isDirectUserSource(b.payload.source) ? "user" : "carrier"
                }
                data-history-id={key}
                data-canonical-messages={canonicalMessages(item.blocks)}
              >
                {userLabel && isDirectUserSource(b.payload.source) && (
                  <span className="muted" data-testid="parent-input-label">
                    {userLabel}
                  </span>
                )}
                <PluginBlockSlots
                  blocks={item.blocks}
                  readOnly={readOnly}
                  placement="before"
                />
                <BlockView block={b} readOnly={readOnly} />
                <PluginBlockSlots blocks={item.blocks} readOnly={readOnly} />
                <ConversationActionBar
                  blocks={item.blocks}
                  user
                  readOnly={readOnly}
                />
              </div>
            ) : (
              <Fragment key={key}>
                {renderPiece(item, anchor, readOnly, toolPresentation(item))}
              </Fragment>
            );
          })}
          {!readOnly && state.isCreatingSession ? (
            <ExpandableNotice
              className="session-waiting-banner"
              tone="neutral"
              role={null}
              marker={
                <Icon
                  name="spinner"
                  size={16}
                  className="animate-spin"
                  strokeWidth="2.5"
                />
              }
              text={t("conversation.connecting")}
            />
          ) : !readOnly &&
            isBusy(transcript) &&
            !visible.some((b) => b.role === "assistant" && b.payload.text) ? (
            <div className="session-waiting-banner">
              <div className="generating-dots">
                <span />
                <span />
                <span />
              </div>
              <span>{t("conversation.generating")}</span>
            </div>
          ) : null}
        </div>
      </section>
      <div className="conversation-input-outer-wrap">
        <div className="conversation-input-anchor">
          <FloatingScrollButton
            following={stick}
            targetRef={scroll}
            threshold={85}
            className="floating-scroll-bottom"
            onScrollToBottom={toBottom}
            tooltip={t("conversation.scrollLatest")}
          />
          {!readOnly && !footer && (
            <ComposerNotificationDock
              showHostNotice={!transcript.pendingPermission}
            />
          )}
          {footer ??
            (!readOnly &&
              (transcript.pendingPermission ? (
                <div className="composer-stack conversation-permission-footer">
                  <PermissionCard value={transcript.pendingPermission} />
                </div>
              ) : (
                <ComposerStack
                  onSubmitIntent={submissionIntent}
                  hostNoticeInDock
                />
              )))}
        </div>
      </div>
      {/* 轮次导航 */}
      <TurnNavigator
        turns={navTurns}
        active={active}
        onNavigate={navigate}
        busy={isBusy(transcript)}
        canLoadOlder={canLoadRemote}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
      />
    </div>
  );
}
const NativeStateViewer = lazy(() =>
  import("./state-viewer/NativeStateViewer").then(({ NativeStateViewer }) => ({
    default: NativeStateViewer,
  })),
);

const NativePromptViewer = lazy(() => import("./prompt-viewer/NativePromptViewer"));

export const ConversationPage = memo(function ConversationPage({
  active = true,
}: {
  active?: boolean;
}) {
  const plugins = useClientPlugins();
  const selected = useAppSelector((state) =>
    JSON.stringify({
      viewMode: state.viewMode,
      sessionId: state.sessionId,
      sessionPluginTab: state.sessionPluginTab,
      conversationWidth: state.conversationWidth,
      childOpen:
        state.popup.type === "subagentDetail" &&
        state.popup.parentId === state.sessionId,
    }),
  );
  const state = useMemo(() => JSON.parse(selected), [selected]);
  const tabs = sessionTabPlugins(
    plugins.registry?.getSnapshot() ?? [],
    (id) => plugins.registry?.isEnabled(id, state.sessionId) ?? false,
  );
  const activePlugin = selectedSessionPlugin(
    state.sessionPluginTab,
    state.sessionId,
    tabs,
  );
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (state.sessionPluginTab && !activePlugin && !plugins.initializing)
      void dispatch({ type: "SelectViewTab", value: "chat" });
  }, [state.sessionPluginTab, activePlugin, plugins.initializing, dispatch]);
  const chat = !activePlugin && state.viewMode === "chat";
  const childOpen = state.childOpen;
  return (
    <div
      className="conversation-viewport"
      style={
        {
          "--chat-content-width": `${state.conversationWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className="conversation-chat-pane"
        data-active={chat && !childOpen}
        style={
          chat && !childOpen
            ? {
                display: "flex",
                flexDirection: "column",
                height: "100%",
                flex: 1,
                minHeight: 0,
              }
            : { display: "none" }
        }
      >
        <Conversation />
      </div>
      {!activePlugin && state.viewMode === "trajectory" && (
        <div style={{ display: childOpen ? "none" : "contents" }}>
          <TrajectoryView active={active && !childOpen} />
        </div>
      )}
      {!activePlugin && !childOpen && state.viewMode === "state" && (
        <Suspense fallback={null}>
          <NativeStateViewer sessionId={state.sessionId} active={active} />
        </Suspense>
      )}
      {!activePlugin && !childOpen && state.viewMode === "prompt" && (
        <Suspense fallback={null}>
          <NativePromptViewer sessionId={state.sessionId} active={active} />
        </Suspense>
      )}
      {activePlugin && !childOpen && (
        <section
          className="client-plugin-panel"
          data-testid="session-plugin-panel"
        >
          <PluginSurface
            key={`${state.sessionId}:${activePlugin}`}
            pluginId={activePlugin}
            target="session-tab"
            visible={active}
          />
        </section>
      )}
      {childOpen && <SubAgentDetailDialog />}
    </div>
  );
});
