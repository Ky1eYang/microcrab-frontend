import { isDirectUserSource } from "./input-source";
import { executionToolOutcome, settledToolStatus } from "./tool-outcome";
import { placeOperationNotice } from "./operation-notice";
import { operationFailureRoute } from "./operation-failure";
import {
  cloneDisplayGraph,
  composeDisplayGraph,
  copyDisplayNodeBlock,
  hasDisplayAttempt,
} from "./display-graph";
import { createBlock } from "./create-block";
export { createBlock } from "./create-block";
import {
  applyDisplayBatch,
  composeDisplayReasoning,
  flushDisplayProjection,
  replayDisplayObservations as replayDisplayRecords,
} from "./display-replay";
export function replayDisplayObservations(
  t: Transcript,
  sessionId: string,
  records: NativeDisplayRecord[],
  compose = true,
): void {
  replayDisplayRecords(t, sessionId, records, compose);
  if (compose)
    projectDelegateChildren(t, sessionId, t.executionRows ?? [], true);
}
import { observeTurnLifecycle } from "./turn-lifecycle";
import { t as translate } from "../i18n";
import { failureBlockText, wireFailure } from "./failure";
import { messageBlocks } from "./native-message-blocks";
import {
  callOccurrenceKey,
  displayExecutionId,
  mergeDisplayExecution,
  preferDisplayExecution,
  resultOccurrenceKey,
} from "./tool-execution-display";
import type {
  Block,
  DisplayExecutionCertificate,
  Transcript,
  NativeSnapshot,
  NativeSession,
  SessionView,
  NativeEvent,
  NativeSubscription,
  PreviewIdentity,
  NativeExecution,
  NativeInbox,
  NativeOperation,
  NativePartialOutput,
  NativeDisplayRecord,
} from "./types";

/** Only an authoritative retry admission can supersede its exact failed attempt. */
function retryFailureTarget(
  operation: NativeOperation,
  sessionId: string,
  hasMessage: (id: string) => boolean,
): string | undefined {
  const result = operation.result as {
    retry_of_operation_id?: unknown;
    retry_after_message_id?: unknown;
  } | null;
  if (
    operation.session_id !== sessionId ||
    operation.method !== "turn.retry" ||
    operation.status === "unknown" ||
    typeof result?.retry_of_operation_id !== "string" ||
    typeof result.retry_after_message_id !== "string" ||
    !hasMessage(result.retry_after_message_id)
  )
    return;
  return result.retry_of_operation_id;
}

function failureOperationId(block: Block): string | undefined {
  return (
    block.operationId ??
    (block.messageId.startsWith("error-")
      ? block.messageId.slice(6)
      : undefined)
  );
}

export function projectRetryReceipt(
  transcript: Transcript,
  operation: NativeOperation,
): boolean {
  const target = retryFailureTarget(operation, operation.session_id, (id) =>
    transcript.blocks.some(
      (block) =>
        block.sessionId === operation.session_id &&
        block.messageId === id &&
        !block.temporary &&
        !block.preview,
    ),
  );
  if (!target) return false;
  transcript.blocks = transcript.blocks.filter(
    (block) =>
      !(
        block.sessionId === operation.session_id &&
        block.role === "assistant" &&
        ((block.stream === "error" && failureOperationId(block) === target) ||
          (block.preview?.operationId === target &&
            !block.preview.canonicalMessageId))
      ),
  );
  if (["accepted", "running"].includes(operation.status))
    transcript.sessionStatus = "busy";
  return true;
}

/** An explicit round-cap stop is distinct from a normally completed model turn. */
function roundLimitNotice(
  transcript: Transcript,
  sessionId: string,
  operation: { id: string; result?: unknown },
) {
  const result = operation.result as {
    stop_reason?: string;
    after_message_id?: string;
    position?: { epoch: number; turn: number; round: number };
  } | null;
  if (result?.stop_reason !== "round_limit") return;
  const id = `round-limit-${operation.id}`;
  if (transcript.blocks.some((block) => block.id === id)) return;
  const block = createBlock(sessionId, id, "text", "text", "assistant");
  block.payload.text = translate("roundLimit.stopped");
  block.operationId = operation.id;
  block.stream = "complete";
  if (
    result.position &&
    [result.position.epoch, result.position.turn, result.position.round].every(
      Number.isSafeInteger,
    )
  )
    block.position = result.position;
  const anchor = result.after_message_id
    ? transcript.blocks.reduce(
        (found, item, index) =>
          item.messageId === result.after_message_id ? index : found,
        -1,
      )
    : -1;
  if (anchor >= 0) transcript.blocks.splice(anchor + 1, 0, block);
  else {
    const position = block.position;
    const following = position
      ? transcript.blocks.findIndex(
          (item) =>
            item.position &&
            (item.position.epoch > position.epoch ||
              (item.position.epoch === position.epoch &&
                (item.position.turn > position.turn ||
                  (item.position.turn === position.turn &&
                    item.position.round > position.round)))),
        )
      : -1;
    if (following >= 0) transcript.blocks.splice(following, 0, block);
    else transcript.blocks.push(block);
  }
}

/** Only this module translates native DTOs into the existing presentation models. */
function selectedModel(session: {
  model: string;
  model_selection?: {
    provider_id: string;
    model: string;
    variant?: string | null;
  };
}) {
  const selection = session.model_selection;
  return selection
    ? {
        id: selection.model,
        providerId: selection.provider_id,
        variant: selection.variant ?? null,
      }
    : { id: session.model };
}
/** Execution-facing labels follow the admitted route, independently of the configured picker. */
function executionModel(session: NativeSession) {
  const selection =
    session.turn_model_selection ??
    session.applied_model_selection ??
    session.model_selection;
  return selectedModel({ model: session.model, model_selection: selection });
}
export function sessionView(session: NativeSession): SessionView {
  return {
    id: session.id,
    kind: session.kind,
    parentID: session.parent_session_id,
    title: session.title,
    projectID: session.project_id,
    hostFlavor: session.host_flavor,
    status: session.status === "running" ? "busy" : session.status,
    agent: session.agent ?? undefined,
    mode: session.mode,
    model: selectedModel(session),
    appliedModelSelection: session.applied_model_selection,
    turnModelSelection: session.turn_model_selection,
    pendingModelChange: session.pending_model_change === true,
    revision: session.revision,
    archived: session.archived,
    time: { created: session.created_at_ms, updated: session.updated_at_ms },
    reachable: session.reachable ?? null,
  };
}
export function applyInbox(
  t: Transcript,
  sessionId: string,
  inbox?: NativeInbox,
) {
  const items = (inbox?.items ?? []).map((item) => ({
    id: String(item.id),
    inboxId: inbox?.inbox_id,
    revision: item.revision,
    claimed: item.claimed,
    input: item.input,
    sessionID: sessionId,
    mode: item.mode,
    parts: item.input.parts,
    prompt: item.input.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  }));
  t.inboxId = inbox?.inbox_id;
  const queue = [];
  const steer = [];
  for (const item of items) {
    if (item.mode === "queue") queue.push(item);
    else if (item.mode === "steer") steer.push(item);
  }
  t.queue = queue;
  t.steer = steer;
  t.inboxPaused = inbox?.paused ?? false;
  t.inboxActive = inbox?.active ?? false;
}
export function createTranscript(): Transcript {
  return {
    turnLifecycle: {
      sessionId: "",
      operations: {},
      activeOperationIds: [],
      completionRevision: 0,
    },
    blocks: [],
    sessionStatus: null,
    connected: false,
    pendingPermission: null,
    pendingQuestions: [],
    agent: null,
    model: null,
    compactionActive: false,
    todos: [],
    queue: [],
    steer: [],
    usage: null,
    turnStartTime: null,
    turnFolds: {},
    roundFolds: {},
    roundAccordion: {},
    revertedForward: [],
    revertBoundaryMessageId: null,
    revertDiffFiles: [],
    revertedCount: 0,
    messageShells: {},
    stickToBottom: true,
    scroll: "followingBottom",
    anchoredUserId: null,
  };
}
/** Link only typed registry bindings witnessed by the selected framework receipt.
 * Output/result text cannot manufacture a typed child identity. */
const childProjection = new WeakMap<
  Block[],
  { sessionId: string; rows: NativeExecution[] }
>();
function projectDelegateChildren(
  t: Transcript,
  sessionId: string,
  rows: NativeExecution[],
  reuse = false,
) {
  const previous = childProjection.get(t.blocks);
  if (reuse && previous?.sessionId === sessionId && previous.rows === rows)
    return;
  childProjection.set(t.blocks, { sessionId, rows });
  t.executionRows = rows;
  const byId = new Map(
    rows.filter((row) => row.session_id === sessionId).map((row) => [row.execution_id, row]),
  );
  for (const block of t.blocks) {
    if (block.sessionId !== sessionId || !block.tool) continue;
    const execution = block.executionId == null ? undefined : byId.get(block.executionId);
    const outcome = execution && execution.call_id === block.callId
      ? executionToolOutcome(execution.status)
      : undefined;
    if (outcome) {
      block.payload.observedToolOutcome = outcome;
      block.tool.status = outcome;
    }
    if (block.tool.childBinding === "execution") {
      block.kind = "tool";
      delete block.tool.childSessionId;
      delete block.tool.childTarget;
      delete block.tool.childBinding;
    }
    const receipt = block.payload.structured;
    const row = rows.find(
      (row) =>
        row.session_id === sessionId &&
        row.call_id === block.callId &&
        row.delegate_child &&
        (block.displayExecutionId == null ||
          block.displayExecutionId === row.execution_id) &&
        row.execution_id === receipt?.execution_id &&
        receipt?.session_id === sessionId,
    );
    const binding = row?.delegate_child;
    if (
      row &&
      binding &&
      typeof binding.session_id === "string" &&
      binding.session_id &&
      typeof binding.target === "string"
    ) {
      block.kind = "child";
      block.executionId = row.execution_id;
      block.execution = row;
      block.tool.childSessionId = binding.session_id;
      block.tool.childTarget = binding.target;
      block.tool.childBinding = "execution";
      // Display projection only: keep cancelling/cancelled/interrupted
      // distinct; never map an unrecognised execution status to failure.
      block.tool.status = ["running", "waiting"].includes(row.status)
        ? "running"
        : row.status === "succeeded"
          ? "completed"
          : ["failed", "cancelling", "cancelled", "interrupted"].includes(
                row.status,
              )
            ? row.status
            : "unknown";
      block.stream = "complete";
    } else if (
      block.tool.builtin === "delegate" &&
      typeof receipt?.child_id === "string" &&
      receipt.child_id &&
      typeof receipt?.subagent === "string" &&
      receipt.outcome != null
    ) {
      // Historical builtin inline receipts remain readable. Ordinary tool names
      // and JSON-looking payloads have no framework presentation authority.
      block.kind = "child";
      block.tool.childSessionId = receipt.child_id;
      block.tool.childTarget = receipt.subagent;
      block.tool.childBinding = "legacy";
      block.tool.status = "completed";
    }
  }
}
/** Reinsert observed-only feedback using surviving identities, never guessed clocks. */
function retainInAppearanceOrder(
  blocks: Block[],
  retained: Block,
  prior: Block[],
  aliases: Map<string, string>,
  fallback: number,
) {
  const origin = prior.findIndex((block) => block.id === retained.id);
  if (origin < 0) {
    blocks.splice(fallback, 0, retained);
    return;
  }
  for (let index = origin - 1; index >= 0; index--) {
    const id = aliases.get(prior[index].id) ?? prior[index].id;
    const predecessor = blocks.findIndex((block) => block.id === id);
    if (predecessor >= 0) {
      blocks.splice(predecessor + 1, 0, retained);
      return;
    }
  }
  for (let index = origin + 1; index < prior.length; index++) {
    const id = aliases.get(prior[index].id) ?? prior[index].id;
    const successor = blocks.findIndex((block) => block.id === id);
    if (successor >= 0) {
      blocks.splice(successor, 0, retained);
      return;
    }
  }
  blocks.splice(fallback, 0, retained);
}
export function applySnapshot(
  snapshot: NativeSnapshot,
  prior = createTranscript(),
  apiBase = typeof location === "undefined"
    ? "http://127.0.0.1:4096/"
    : location.origin,
  canonicalUnchanged = false,
): Transcript {
  const displayPrior = prior;
  const t = createTranscript();
  t.displayApiBase = apiBase;
  t.historyResetRevision = prior.historyResetRevision;
  t.displayWindowBounded =
    snapshot.messages_truncated === true ||
    (snapshot.history_view?.start_cursor ?? 0) > 0;
  t.displayWindowSources = snapshot.messages.flatMap((message) =>
    message.canonical_source_id ? [message.canonical_source_id] : [],
  );
  // A rewind/replacement cannot borrow invocation identity or live observations.
  const sameHistory =
    !prior.historyView || !snapshot.history_view
      ? true
      : prior.historyView.lineage === snapshot.history_view.lineage &&
        prior.historyView.epoch === snapshot.history_view.epoch;
  if (!sameHistory) prior = createTranscript();
  const lifecyclePrior =
    displayPrior.displayGraph?.sessionId === snapshot.session.id
      ? displayPrior
      : prior;
  if (lifecyclePrior.turnLifecycle?.sessionId === snapshot.session.id)
    t.turnLifecycle = structuredClone(lifecyclePrior.turnLifecycle);
  for (const operation of snapshot.operations ?? [])
    observeTurnLifecycle(t, snapshot.session.id, operation);
  t.historyView = snapshot.history_view;
  t.historyGap = snapshot.history_gap === true;
  t.historyTruncated = snapshot.messages_truncated === true;
  t.blocks = snapshot.messages.flatMap((message) =>
    messageBlocks(snapshot.session.id, message, apiBase),
  );
  // A metadata refresh may rebuild canonical rows after a live handoff. Keep
  // only the producer previously bound to this exact canonical row and position.
  const canonicalOutputKey = (block: Block) =>
    JSON.stringify([block.messageId, block.partId, block.kind, block.position]);
  const priorCanonicalOutputs = new Map(
    prior.blocks
      .filter(
        (block) =>
          block.sessionId === snapshot.session.id &&
          block.role === "assistant" &&
          !block.preview &&
          !block.temporary &&
          block.operationId &&
          block.position,
      )
      .map((block) => [canonicalOutputKey(block), block]),
  );
  for (const block of t.blocks) {
    if (block.role !== "assistant" || !block.position) continue;
    const previous = priorCanonicalOutputs.get(canonicalOutputKey(block));
    if (!previous) continue;
    block.operationId = previous.operationId;
  }

  // Only explicit durable metadata identifies a compact baseline; user text is never a marker.
  const markers = new Map(
    [
      ...(snapshot.compactions ?? []),
      ...snapshot.messages.flatMap((message) =>
        message.compaction ? [message.compaction] : [],
      ),
    ].map((marker) => [marker.message_id, marker]),
  );
  for (const block of t.blocks) {
    const marker = markers.get(block.messageId);
    if (!marker || block.kind !== "text") continue;
    block.kind = "compaction";
    block.role = "system";
    block.isCompact = true;
    block.payload.text = marker.summary;
    block.compaction = marker;
  }

  // Only admission certificates identify a composer submission. Equal text,
  // order, image bodies and terminal queue receipts cannot certify consumption.
  const userAliases = new Map<string, string>();
  const canonicalUsers = t.blocks.filter((b) => b.role === "user" && isDirectUserSource(b.payload.source));
  for (const user of prior.blocks.filter((b) => b.role === "user" && isDirectUserSource(b.payload.source))) {
    if (user.sessionId !== snapshot.session.id && user.sessionId !== "draft")
      continue;
    const exact = canonicalUsers.find((b) => b.messageId === user.messageId);
    const admitted =
      user.temporary && user.operationId
        ? canonicalUsers.find(
            (b) =>
              isDirectUserSource(b.payload.source) &&
              b.operationId === user.operationId,
          )
        : undefined;
    if (exact || admitted) {
      userAliases.set(user.messageId, (exact ?? admitted)!.messageId);
    } else if (user.temporary) {
      const admitted =
        !!user.operationId &&
        (snapshot.inbox?.items.some(
          (item) => item.submission_operation_id === user.operationId,
        ) ||
          snapshot.operations?.some(
            (operation) =>
              operation.id === user.operationId &&
              operation.session_id === snapshot.session.id &&
              operation.method === "turn.queue" &&
              operation.status === "completed",
          ));
      const pending = {
        ...user,
        sessionId: snapshot.session.id,
        ...(admitted ? { submissionStatus: "admitted" as const } : {}),
      };
      const witnesses = prior.blocks.flatMap((block) => {
        const scope = block.preview;
        return scope &&
          typeof user.operationId === "string" &&
          scope.operationId === user.operationId &&
          scope.userMessageId === user.messageId &&
          Number.isSafeInteger(scope.epoch) &&
          Number.isSafeInteger(scope.turn) &&
          scope.epoch! >= 0 &&
          scope.turn! >= 0
          ? [scope]
          : [];
      });
      const scope = witnesses[0];
      const boundary =
        scope &&
        witnesses.every(
          (item) => item.epoch === scope.epoch && item.turn === scope.turn,
        )
          ? t.blocks.findIndex(
              (block) =>
                !block.temporary &&
                block.position != null &&
                block.position.epoch === scope.epoch &&
                block.position.turn >= scope.turn!,
            )
          : -1;
      // Live model observations already identify this submission's turn. They
      // can place its pending input before a bounded response suffix without
      // inventing an input position or matching text in unrelated older turns.
      if (boundary >= 0) t.blocks.splice(boundary, 0, pending);
      else t.blocks.push(pending);
      userAliases.set(user.messageId, user.messageId);
    }
  }

  const blockAliases = new Map<string, string>();
  for (const block of prior.blocks) {
    const userId = userAliases.get(block.messageId);
    const canonical =
      userId && t.blocks.find((item) => item.messageId === userId);
    if (canonical) blockAliases.set(block.id, canonical.id);
  }
  const observed: { block: Block; fallback: number }[] = [];
  const supersededFailures = new Set([
    ...(snapshot.superseded_failure_operation_ids ?? []).filter(
      (id) => typeof id === "string",
    ),
    ...(snapshot.operations ?? []).flatMap((operation) => {
      const target = retryFailureTarget(operation, snapshot.session.id, (id) =>
        snapshot.messages.some((message) => message.id === id),
      );
      return target ? [target] : [];
    }),
  ]);
  // Server receipts own durable failed output. It is display evidence only and
  // never becomes a canonical message, a Context item, or browser persistence.
  const retained = prior.blocks
    .map((block) => {
      const preview = block.preview;
      if (
        block.sessionId !== snapshot.session.id ||
        !preview ||
        preview.canonicalMessageId ||
        ![preview.epoch, preview.turn, preview.round].every(
          Number.isSafeInteger,
        ) ||
        preview.operationId !== `inbox:${preview.epoch}:${preview.turn}`
      )
        return block;
      // Autonomous inbox observations precede their durable UUID receipt. Rebind
      // only an exact selected failed attempt; preserve the live body, block ID and
      // appearance evidence rather than replacing it with the bounded prefix.
      const matches = snapshot.operations.filter((operation) => {
        const output = (
          operation.result as { partial_output?: NativePartialOutput } | null
        )?.partial_output;
        return (
          operation.session_id === snapshot.session.id &&
          operation.method === "turn.inbox" &&
          ["failed", "cancelled"].includes(operation.status) &&
          output &&
          output.call_id === preview.callId &&
          output.epoch === preview.epoch &&
          output.turn === preview.turn &&
          output.round === preview.round
        );
      });
      if (matches.length !== 1) return block;
      const operationId = matches[0].id;
      return {
        ...block,
        preview: {
          ...preview,
          operationId,
          key: JSON.stringify([
            snapshot.session.id,
            operationId,
            preview.epoch,
            preview.turn,
            preview.round,
            preview.callId,
          ]),
        },
      };
    })
    .filter(
      (b) =>
        b.sessionId === snapshot.session.id &&
        b.preview &&
        (b.preview.canonicalMessageId ||
          !supersededFailures.has(b.preview.operationId ?? "")),
    );
  for (const operation of snapshot.operations ?? []) {
    if (
      !["failed", "cancelled"].includes(operation.status) ||
      supersededFailures.has(operation.id)
    )
      continue;
    const result = operation.result as {
      partial_output?: NativePartialOutput;
    } | null;
    const output = result?.partial_output;
    if (
      !output ||
      typeof output.call_id !== "string" ||
      !Number.isSafeInteger(output.epoch) ||
      ![output.turn, output.round].every(
        (value) => value === null || Number.isSafeInteger(value),
      )
    )
      continue;
    const origin: PreviewIdentity = {
      key: JSON.stringify([
        snapshot.session.id,
        operation.id,
        output.epoch,
        output.turn,
        output.round,
        output.call_id,
      ]),
      operationId: operation.id,
      callId: output.call_id,
      epoch: output.epoch,
      turn: output.turn ?? undefined,
      round: output.round ?? undefined,
      userMessageId: "",
      assistantOrdinal: 0,
      truncated: output.truncated === true,
    };
    for (const kind of ["reasoning", "text"] as const) {
      if (
        retained.some(
          (block) => block.preview?.key === origin.key && block.kind === kind,
        )
      )
        continue;
      const text = output[kind];
      if (typeof text !== "string" || !text.trim()) continue;
      const block = createBlock(
        snapshot.session.id,
        `preview:${origin.key}:${kind}`,
        `${output.call_id}:${kind}`,
        kind,
      );
      block.id = `preview:${origin.key}:${kind}`;
      block.preview = origin;
      block.payload.text = text;
      block.stream = "stopped";
      retained.push(block);
    }
  }
  for (const block of retained) {
    if (block.displayAttemptId) {
      observed.push({
        block: { ...block, payload: { ...block.payload } },
        fallback: t.blocks.length,
      });
      continue;
    }
    const origin = block.preview!;
    // A metadata patch carries no new canonical evidence. Keep each unbound
    // observation under its existing native identity and appearance order;
    // an idle status alone cannot erase or hand it to an older answer.
    if (canonicalUnchanged && !origin.canonicalMessageId) {
      observed.push({
        block: {
          ...block,
          preview: { ...origin },
          payload: { ...block.payload },
        },
        fallback: t.blocks.length,
      });
      continue;
    }
    const userId =
      userAliases.get(origin.userMessageId) ?? origin.userMessageId;
    const userIndex = t.blocks.findIndex(
      (b) => b.role === "user" && b.messageId === userId,
    );
    const failedReceipt = (snapshot.operations ?? []).find(
      (operation) =>
        !origin.canonicalMessageId &&
        operation.id === origin.operationId &&
        ["failed", "cancelled"].includes(operation.status) &&
        operation.session_id === snapshot.session.id &&
        (() => {
          const p = (
            operation.result as {
              position?: { epoch: number; turn: number; round: number };
            } | null
          )?.position;
          return (
            !p ||
            ![origin.epoch, origin.turn, origin.round].every(
              Number.isSafeInteger,
            ) ||
            (p.epoch === origin.epoch &&
              p.turn === origin.turn &&
              p.round === origin.round)
          );
        })(),
    );
    const failedResult = failedReceipt?.result as {
      after_message_id?: string;
      position?: { epoch: number; turn: number; round: number };
    } | null;
    const boundaryIndex = t.blocks.reduce(
      (last, item, index) =>
        item.messageId === failedResult?.after_message_id ? index : last,
      -1,
    );
    const scope = failedResult?.position;
    const exactScope =
      scope &&
      scope.epoch === origin.epoch &&
      scope.turn === origin.turn &&
      scope.round === origin.round;
    // A paged-out user is not an invented anchor. Only the selected failed receipt
    // and its exact prepared scope may place output among ordered canonical rows.
    const orderedIndex = exactScope
      ? t.blocks.reduce((last, item, index) => {
          const p = item.position;
          return p &&
            p.epoch === scope.epoch &&
            p.turn === scope.turn &&
            p.round <= scope.round
            ? index
            : last;
        }, -1)
      : -1;
    // A bounded page or a terminal receipt cannot prove absence of content in an
    // uncovered round. Keep positioned observations under the selected history
    // witness until their own canonical response settles them.
    const positionedPreview =
      (block.kind === "tool" ||
        (["reasoning", "text"].includes(block.kind) &&
          block.payload.text.length > 0)) &&
      prior.historyView != null &&
      snapshot.history_view != null &&
      [origin.epoch, origin.turn, origin.round].every(Number.isSafeInteger);
    if (
      userIndex < 0 &&
      !positionedPreview &&
      (!failedReceipt || (boundaryIndex < 0 && orderedIndex < 0))
    )
      continue;
    const nextUser = t.blocks.findIndex(
      (b, i) => i > userIndex && b.role === "user",
    );
    const laterToolRow =
      positionedPreview && userIndex < 0
        ? t.blocks.findIndex((item) => {
            const scope = item.position;
            return (
              scope &&
              (scope.epoch > origin.epoch! ||
                (scope.epoch === origin.epoch &&
                  (scope.turn > origin.turn! ||
                    (scope.turn === origin.turn &&
                      scope.round > origin.round!))))
            );
          })
        : -1;
    const end =
      userIndex < 0
        ? positionedPreview && !failedReceipt
          ? laterToolRow < 0
            ? t.blocks.length
            : laterToolRow
          : Math.max(boundaryIndex, orderedIndex) + 1
        : nextUser < 0
          ? t.blocks.length
          : nextUser;
    const assistants = positionedPreview
      ? snapshot.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id)
      : [
          ...new Set([
            ...t.blocks
              .slice(userIndex + 1, end)
              .filter(
                (b) =>
                  b.role === "assistant" &&
                  !b.temporary &&
                  b.kind !== "reasoning" &&
                  !b.preview,
              )
              .map((b) => b.messageId),
            // An admitted reasoning-only response can have an empty canonical
            // body and therefore no rendered block. Its message still owns the
            // exact positioned observation; do not infer absence from rendering.
            ...snapshot.messages
              .filter(
                (message) =>
                  block.kind === "reasoning" &&
                  message.role === "assistant" &&
                  message.position != null &&
                  message.position.epoch === origin.epoch &&
                  message.position.turn === origin.turn &&
                  message.position.round === origin.round,
              )
              .map((message) => message.id),
          ]),
        ];
    const failedOperation = failedReceipt != null;
    const positioned = assistants.filter((id) => {
      const position =
        snapshot.messages.find((message) => message.id === id)?.position ??
        t.blocks.find((item) => item.messageId === id)?.position;
      return (
        position != null &&
        position.epoch === origin.epoch &&
        position.turn === origin.turn &&
        position.round === origin.round
      );
    });
    const comparablePositions =
      [origin.epoch, origin.turn, origin.round].every(Number.isSafeInteger) &&
      assistants.some((id) => {
        const position =
          snapshot.messages.find((message) => message.id === id)?.position ??
          t.blocks.find((item) => item.messageId === id)?.position;
        return (
          position != null &&
          [position.epoch, position.turn, position.round].every(
            Number.isSafeInteger,
          )
        );
      });
    // One round can contain multiple output messages. A tool's exact invocation
    // outranks another output's abbreviated metadata; otherwise both rows would
    // receive the same live identity during the later handoff pass.
    const exactToolMessage =
      block.kind === "tool"
        ? positioned.find((id) =>
            snapshot.messages
              .find((message) => message.id === id)
              ?.tool_calls?.some((call) => call.id === block.callId),
          )
        : undefined;
    // A bounded suffix can omit this preview's round. Known positions must not
    // alias it onto another round; ordinal matching is only a legacy fallback.
    const target = failedOperation
      ? undefined
      : exactToolMessage
        ? exactToolMessage
        : origin.canonicalMessageId
          ? assistants.includes(origin.canonicalMessageId) &&
            (!comparablePositions ||
              positioned.includes(origin.canonicalMessageId))
            ? origin.canonicalMessageId
            : undefined
          : (positioned[0] ??
            (comparablePositions
              ? undefined
              : assistants[origin.assistantOrdinal]));
    const canonical = target
      ? t.blocks.find(
          (item) =>
            item.messageId === target &&
            (block.kind === "tool"
              ? item.callId === block.callId
              : item.kind === "text"),
        )
      : undefined;
    const abbreviated =
      target != null &&
      snapshot.messages.some(
        (message) => message.id === target && message.content_truncated,
      );
    // Abbreviation is authority over its prefix only. Carry the longer observed
    // body on the canonical row without duplicating that prefix. A conflicting or
    // complete canonical body still wins; streamed text never overrides it.
    if (
      canonical &&
      block.kind === "text" &&
      abbreviated &&
      block.payload.text.length > canonical.payload.text.length &&
      block.payload.text.startsWith(canonical.payload.text)
    ) {
      canonical.payload.text = block.payload.text;
      canonical.id = block.id;
      canonical.preview = {
        ...origin,
        userMessageId: userId,
        canonicalMessageId: target,
      };
    }
    if (canonical && block.kind !== "reasoning") {
      blockAliases.set(block.id, canonical.id);
      // Preserve the producer only when its canonical round/identity agrees;
      // legacy ordinal matching alone cannot certify an active answer.
      if (
        origin.operationId &&
        target &&
        (origin.canonicalMessageId === target || positioned.includes(target))
      )
        canonical.operationId = origin.operationId;
    }
    if (
      block.kind !== "reasoning" &&
      (block.kind === "tool"
        ? canonical
        : canonical || (target && !abbreviated))
    )
      continue;
    const abbreviatedTool =
      block.kind === "tool" &&
      target != null &&
      snapshot.messages.some(
        (message) => message.id === target && message.content_truncated,
      );
    if (block.kind === "tool" && target && !canonical && !abbreviatedTool)
      continue;
    if (
      !target &&
      snapshot.session.status !== "running" &&
      !positionedPreview &&
      !(failedOperation && ["text", "reasoning"].includes(block.kind))
    )
      continue;
    if (block.kind === "reasoning" && !block.payload.text) continue;
    const copy = {
      ...block,
      preview: {
        ...origin,
        userMessageId: userId,
        canonicalMessageId: target ?? origin.canonicalMessageId,
      },
      ...(failedOperation ? { temporary: false, stream: "stopped" } : {}),
      ...(target
        ? {
            messageId: target,
            temporary: false,
            stream:
              block.kind === "reasoning" && origin.truncated
                ? "stopped"
                : "complete",
          }
        : {}),
    };
    const targetIndex =
      failedReceipt && boundaryIndex >= 0
        ? boundaryIndex + 1
        : target
          ? (() => {
              const index = t.blocks.findIndex((b) => b.messageId === target);
              return index < 0 ? end : index;
            })()
          : end;
    observed.push({ block: copy, fallback: targetIndex });
  }
  // Position and call identity must both agree; reused call ids on another branch
  // cannot inherit live timings/content. Snapshot bodies remain authoritative.
  const invocationKey = (block: Block) => {
    const position = block.preview ?? block.position;
    return position &&
      block.callId &&
      [position.epoch, position.turn, position.round].every(
        Number.isSafeInteger,
      )
      ? JSON.stringify([
          block.sessionId,
          block.callId,
          position.epoch,
          position.turn,
          position.round,
        ])
      : null;
  };
  const identityRemap = new Map<string, string>();
  const invocationRows = new Map(
    prior.blocks
      .filter(
        (block) =>
          block.kind === "tool" &&
          block.role === "assistant" &&
          invocationKey(block),
      )
      .map((block) => [invocationKey(block), block]),
  );
  for (const block of t.blocks) {
    if (block.kind !== "tool" || block.role !== "assistant") continue;
    const previous = invocationRows.get(invocationKey(block));
    if (!previous || previous.sessionId !== snapshot.session.id) continue;
    // Canonical rows additionally agree on message identity; live rows must have
    // either exact selected-lineage evidence or their original user anchor.
    const anchored =
      previous.preview &&
      t.blocks.some(
        (item) =>
          item.role === "user" &&
          item.messageId ===
            (userAliases.get(previous.preview!.userMessageId) ??
              previous.preview!.userMessageId),
      );
    if (
      (!previous.preview && previous.messageId === block.messageId) ||
      (previous.preview &&
        ((snapshot.history_view && prior.historyView) || anchored))
    ) {
      identityRemap.set(block.id, previous.id);
      block.id = previous.id;
    }
  }
  for (const [id, target] of blockAliases)
    blockAliases.set(id, identityRemap.get(target) ?? target);
  // Native assistant messages store text and calls in separate fields. Live
  // identities retain their appearance order within that same canonical message.
  const appearance = new Map<string, number>();
  prior.blocks.forEach((block, index) => {
    const id = blockAliases.get(block.id) ?? block.id;
    if (!appearance.has(id)) appearance.set(id, index);
  });
  const messageSlots = new Map<string, number[]>();
  t.blocks.forEach((block, index) => {
    const slots = messageSlots.get(block.messageId) ?? [];
    slots.push(index);
    messageSlots.set(block.messageId, slots);
  });
  for (const slots of messageSlots.values()) {
    const ordered = slots
      .map((index) => t.blocks[index])
      .sort(
        (left, right) =>
          (appearance.get(left.id) ?? Infinity) -
          (appearance.get(right.id) ?? Infinity),
      );
    slots.forEach((slot, index) => {
      t.blocks[slot] = ordered[index];
    });
  }
  for (const { block, fallback } of observed)
    retainInAppearanceOrder(
      t.blocks,
      block,
      prior.blocks,
      blockAliases,
      fallback +
        observed
          .slice(
            0,
            observed.findIndex((item) => item.block === block),
          )
          .filter((item) => item.fallback === fallback).length,
    );

  // Retain feedback at its observed neighbors. A refresh must not move an old
  // failure underneath a later turn, and must not mutate the prior transcript.
  const errorBlocks = prior.blocks.filter(
    (block) =>
      block.role === "assistant" &&
      ["error", "cancelled"].includes(block.stream) &&
      !supersededFailures.has(failureOperationId(block) ?? "") &&
      !snapshot.operations.some(
        (operation) =>
          operation.id === failureOperationId(block) &&
          operationFailureRoute(operation) !== "conversation",
      ) &&
      (block.sessionId === snapshot.session.id ||
        block.sessionId === "draft") &&
      // Undo removes the selected suffix. Its absent durable witness must not be
      // reconstructed from the previous projection as if it were still selected.
      (typeof block.failureAfterMessageId !== "string" ||
        snapshot.messages.some(
          (message) => message.id === block.failureAfterMessageId,
        )),
  );
  for (const block of errorBlocks) {
    const copy = {
      ...block,
      payload: { ...block.payload },
      sessionId: snapshot.session.id,
    };
    if (!t.blocks.some((existing) => existing.id === copy.id))
      retainInAppearanceOrder(t.blocks, copy, prior.blocks, blockAliases, 0);
  }

  for (const operation of snapshot.operations ?? [])
    roundLimitNotice(t, snapshot.session.id, operation);

  // A failed attempt can share its turn AND round with a successful retry.
  // Its durable message boundary, rather than the end of that scope, owns placement.
  const failures = (snapshot.operations ?? [])
    .filter(
      (op) =>
        ["failed", "cancelled"].includes(op.status) &&
        !supersededFailures.has(op.id) &&
        operationFailureRoute(op) === "conversation",
    )
    .sort((left, right) => left.updated_at_ms - right.updated_at_ms);
  const boundaryTails = new Map<string, Block>();
  for (const op of failures) {
    const errorId = `error-${op.id}`;
    let block = t.blocks.find(
      (item) =>
        ["error", "cancelled"].includes(item.stream) &&
        (item.operationId === op.id || item.messageId === errorId),
    );
    const observed = block != null;
    if (!block) {
      block = createBlock(
        snapshot.session.id,
        errorId,
        "text",
        "text",
        "assistant",
      );
      block.stream = op.status === "cancelled" ? "cancelled" : "error";
      // An unseen terminal receipt has no authority to prepend itself before
      // observed content. Exact operation or receipt anchors refine placement below.
      t.blocks.push(block);
    }
    block.payload.failure = wireFailure(
      (op.result as Record<string, any> | null)?.error,
    );
    block.payload.text = failureBlockText(block.payload.failure);
    block.operationId = op.id;
    const result = op.result as Record<string, any> | null;
    const position = result?.position;
    const validPosition =
      position &&
      Number.isSafeInteger(position.epoch) &&
      Number.isSafeInteger(position.turn) &&
      Number.isSafeInteger(position.round);
    if (validPosition) block.position = position;
    const afterMessageId = result?.after_message_id;
    if (typeof afterMessageId === "string")
      block.failureAfterMessageId = afterMessageId;
    const boundary =
      typeof afterMessageId === "string"
        ? [...t.blocks]
            .reverse()
            .find((item) => item !== block && item.messageId === afterMessageId)
        : undefined;
    if (boundary) {
      let anchor = boundaryTails.get(afterMessageId) ?? boundary;
      // Keep each failed request's unadmitted suffix beside its own feedback,
      // even when several failures share one accepted Context boundary.
      const suffix = t.blocks.filter(
        (item) =>
          item.preview?.operationId === op.id &&
          !item.preview.canonicalMessageId,
      );
      for (const item of suffix) {
        t.blocks.splice(t.blocks.indexOf(item), 1);
        t.blocks.splice(t.blocks.indexOf(anchor) + 1, 0, item);
        anchor = item;
      }
      t.blocks.splice(t.blocks.indexOf(block), 1);
      t.blocks.splice(t.blocks.indexOf(anchor) + 1, 0, block);
      boundaryTails.set(afterMessageId, block);
      continue;
    }
    // Legacy receipts have no exact retry boundary. Preserve an observed location;
    // otherwise full position still keeps feedback before later rounds and turns.
    if (observed || !validPosition) continue;
    const matching = t.blocks.filter((item) => {
      const scope = item.position ?? item.preview;
      return (
        item !== block &&
        scope?.epoch === position.epoch &&
        scope?.turn === position.turn &&
        typeof scope?.round === "number" &&
        scope.round <= position.round
      );
    });
    const anchor = matching.at(-1);
    if (!anchor) continue;
    t.blocks.splice(t.blocks.indexOf(block), 1);
    t.blocks.splice(t.blocks.indexOf(anchor) + 1, 0, block);
  }

  // Reconcile tool calls and results in chronological order:
  // Instead of replacing the call card with result card at the end, merge the result into
  // the call card IN-PLACE so the block order (Text 1 -> Tool -> Text 2) is strictly preserved!
  const pendingCalls = new Map<string, Block>();
  const exactCalls = new Map<string, Block>();
  const toRemove = new Set<string>();
  for (const block of t.blocks) {
    if (!block.callId) continue;
    if (block.role === "assistant" && block.kind === "tool") {
      pendingCalls.set(block.callId, block);
      const exact = callOccurrenceKey(block);
      if (exact) exactCalls.set(exact, block);
    } else if (block.role === "tool") {
      const exact = resultOccurrenceKey(block);
      const call = exact
        ? exactCalls.get(exact)
        : block.displayExecutionId == null
          ? pendingCalls.get(block.callId)
          : undefined;
      if (call) {
        if (exact)
          mergeDisplayExecution(call, block.displayExecutionId, block.displayExecutionStatus);
        const occurrence = callOccurrenceKey(call);
        if (occurrence) exactCalls.delete(occurrence);
        call.payload.text = block.payload.text;
        call.payload.structured = block.payload.structured;
        call.payload.attachments = block.payload.attachments;
        call.clientInvocationId = block.clientInvocationId;
        call.tool = {
          ...call.tool!,
          status: settledToolStatus(call),
        };
        toRemove.add(block.id);
        if (pendingCalls.get(block.callId) === call)
          pendingCalls.delete(block.callId);
      }
    }
  }
  t.blocks = t.blocks.filter((block) => !toRemove.has(block.id));
  const canonicalPriorTools = new Map(
    prior.blocks.flatMap((block) => {
      const key = callOccurrenceKey(block);
      return block.sessionId === snapshot.session.id &&
        key &&
        block.displayExecutionId != null
        ? [[key, { id: block.displayExecutionId, status: block.displayExecutionStatus }] as const]
        : [];
    }),
  );
  const displayExecutionCertificates = new Map<string, DisplayExecutionCertificate>();
  for (const block of t.blocks) {
    const key = callOccurrenceKey(block);
    if (!key) continue;
    const previous = canonicalPriorTools.get(key);
    if (previous) preferDisplayExecution(block, previous);
    if (block.displayExecutionId !== undefined)
      displayExecutionCertificates.set(key, { id: block.displayExecutionId, status: block.displayExecutionStatus });
  }
  t.displayExecutionCertificates = displayExecutionCertificates;
  const executions = new Map(
    prior.blocks
      .filter(
        (block) =>
          block.sessionId === snapshot.session.id &&
          block.role === "assistant" &&
          (block.executionId != null || block.payload.observedToolOutcome) &&
          invocationKey(block),
      )
      .map((block) => [invocationKey(block), block]),
  );
  for (const block of t.blocks) {
    const key = invocationKey(block);
    const priorBlock = key ? executions.get(key) : undefined;
    if (
      !priorBlock ||
      block.kind !== "tool" ||
      block.role !== "assistant" ||
      (block.displayExecutionId != null &&
        priorBlock.executionId != null &&
        block.displayExecutionId !== priorBlock.executionId) ||
      (block.executionId != null &&
        block.executionId !== priorBlock.executionId)
    )
      continue;
    // Canonical messages retain stable identity; previews must prove their user anchor.
    if (!priorBlock.preview && block.messageId !== priorBlock.messageId)
      continue;
    if (priorBlock.preview) {
      const origin = priorBlock.preview;
      const userId =
        userAliases.get(origin.userMessageId) ?? origin.userMessageId;
      if (
        origin.canonicalMessageId &&
        origin.canonicalMessageId !== block.messageId
      )
        continue;
      if (
        !(prior.historyView && snapshot.history_view) &&
        !t.blocks.some(
          (item) =>
            item.role === "user" &&
            item.messageId === userId &&
            item.position?.epoch === origin.epoch &&
            item.position?.turn === origin.turn,
        )
      )
        continue;
    }
    block.executionId = priorBlock.executionId;
    block.execution = priorBlock.execution;
    block.canonicalContent = priorBlock.canonicalContent;
    block.startedMs = priorBlock.startedMs;
    block.endedMs = priorBlock.endedMs;
    if (priorBlock.payload.observedToolOutcome && block.tool) {
      block.payload.observedToolOutcome = priorBlock.payload.observedToolOutcome;
      block.tool.status = priorBlock.payload.observedToolOutcome;
    }
  }

  projectDelegateChildren(
    t,
    snapshot.session.id,
    snapshot.executions ??
      (snapshot.executions_omitted && prior?.executionRows
        ? prior.executionRows
        : []),
  );
  applyInbox(t, snapshot.session.id, snapshot.inbox);
  t.sessionStatus =
    snapshot.session.status === "running" ? "busy" : snapshot.session.status;
  t.connected = true;
  t.agent = snapshot.session.agent;
  t.model = executionModel(snapshot.session);
  t.usage = snapshot.usage;
  t.compactionActive = snapshot.operations.some(
    (operation) =>
      operation.method === "session.compact" &&
      ["accepted", "running"].includes(operation.status),
  );
  const presentationPrior =
    displayPrior.displayGraph?.sessionId === snapshot.session.id
      ? displayPrior
      : prior;
  t.turnFolds = presentationPrior.turnFolds;
  t.roundFolds = presentationPrior.roundFolds;
  t.roundAccordion = presentationPrior.roundAccordion;
  t.scroll = presentationPrior.scroll;
  t.stickToBottom = presentationPrior.stickToBottom;
  t.anchoredUserId = presentationPrior.anchoredUserId;
  if (
    prior.displayReplay?.sessionId === snapshot.session.id &&
    prior.displayReplay.lineage === snapshot.history_view?.lineage
  ) {
    t.displayReplay = {
      ...prior.displayReplay,
      seen: { ...prior.displayReplay.seen },
      attempts: { ...prior.displayReplay.attempts },
    };
    composeDisplayReasoning(t);
  }
  if (displayPrior.displayGraph?.sessionId === snapshot.session.id) {
    t.displayGraph = cloneDisplayGraph(displayPrior.displayGraph);
    for (const block of displayPrior.blocks) {
      const node =
        block.displayGraphId && t.displayGraph.nodes[block.displayGraphId];
      if (node)
        t.displayGraph.nodes[node.identity.block_id] = copyDisplayNodeBlock(
          node,
          structuredClone(block),
        );
    }
    composeDisplayGraph(t, displayPrior.blocks);
    projectDelegateChildren(t, snapshot.session.id, t.executionRows ?? []);
  }
  // Same-lineage reconciliation keeps the object a live delta already updated.
  // A changed body replaces that object; an unchanged one keeps its identity, so
  // a later snapshot cannot rebuild text the stream already published.
  const reusable = new Map(prior.blocks.map((block) => [block.id, block]));
  t.blocks = t.blocks.map((block) => {
    const previous = reusable.get(block.id);
    if (!previous || previous.sessionId !== block.sessionId) return block;
    return sameBlockContent(previous, block) ? previous : block;
  });
  return t;
}

/** Compare every field, including nested wire-cloned evidence, before reusing a
 * block. Object key insertion order is not content; array order is content.
 * Non-JSON objects are reused only by identity, never guessed structurally equal. */
function sameBlockContent(previous: Block, next: Block): boolean {
  return sameContent(previous, next);
}

function sameContent(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return false;
  if (Array.isArray(previous) || Array.isArray(next)) {
    return (
      Array.isArray(previous) &&
      Array.isArray(next) &&
      previous.length === next.length &&
      previous.every((value, index) => sameContent(value, next[index]))
    );
  }
  if (
    Object.getPrototypeOf(previous) !== Object.prototype ||
    Object.getPrototypeOf(next) !== Object.prototype
  )
    return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  // Optional wire fields have the same meaning when absent or undefined. A
  // reconciliation spread may materialize that key without changing content.
  const keys = Object.keys(before).filter((key) => before[key] !== undefined);
  const nextKeys = Object.keys(after).filter((key) => after[key] !== undefined);
  return (
    keys.length === nextKeys.length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(after, key) &&
        sameContent(before[key], after[key]),
    )
  );
}

export function dropPreviews(t: Transcript) {
  t.blocks = t.blocks.filter((b) => !(b.temporary && b.role === "assistant"));
  t.connected = false;
  composeDisplayGraph(t);
}
/** A transport gap retains tool evidence only with exact execution authority.
 * Pending Context handoff alone is insufficient; the execution id, actual call,
 * operation and full position must identify the same admitted invocation. */
function admittedExecutionTool(block: Block): boolean {
  const origin = block.preview;
  const execution = block.execution;
  return (
    block.kind === "tool" &&
    origin != null &&
    !!origin.operationId &&
    typeof block.callId === "string" &&
    block.callId.length > 0 &&
    [origin.epoch, origin.turn, origin.round].every(Number.isSafeInteger) &&
    typeof block.executionId === "number" &&
    Number.isSafeInteger(block.executionId) &&
    block.executionId > 0 &&
    execution?.execution_id === block.executionId &&
    execution.call_id === block.callId &&
    execution.operation_id === origin.operationId &&
    execution.epoch === origin.epoch &&
    execution.turn === origin.turn &&
    execution.round === origin.round
  );
}

/** A transport gap removes live authority, not witnessed response observations.
 * Unvalidated reasoning remains stopped/incomplete display evidence. The
 * replacement snapshot owns selected lineage and canonical response coverage;
 * nothing retained here is promoted to a canonical message or resumed stream. */
export function suspendPreviews(t: Transcript) {
  t.blocks = t.blocks.filter((block) => {
    if (!block.temporary || block.role !== "assistant") return true;
    const origin = block.preview;
    if (
      !origin ||
      !t.historyView ||
      origin.epoch !== t.historyView.epoch ||
      ![origin.epoch, origin.turn, origin.round].every(Number.isSafeInteger) ||
      !origin.operationId ||
      !origin.callId
    )
      return false;
    const admittedTool = admittedExecutionTool(block);
    const validatedContent =
      ["reasoning", "text"].includes(block.kind) &&
      block.payload.text.length > 0 &&
      block.validated === true;
    const observedReasoning =
      block.kind === "reasoning" && block.payload.text.trim().length > 0;
    if (
      !origin.canonicalMessageId &&
      !validatedContent &&
      !admittedTool &&
      !observedReasoning
    )
      return false;
    if (observedReasoning && !block.validated && !origin.canonicalMessageId) {
      // Response validation carries no reasoning body. Lost observation coverage
      // cannot be repaired by a later text/call snapshot or provider receipt.
      // Clone this witness: text and reasoning can share the original identity.
      block.preview = { ...origin, truncated: true };
      block.stream = "stopped";
    }
    if (block.stream === "streaming") block.stream = "stopped";
    return true;
  });
  t.connected = false;
  composeDisplayGraph(t);
}
function previewIdentity(t: Transcript, event: NativeEvent): PreviewIdentity {
  const data = event.data as Record<string, any>;
  const key = JSON.stringify([
    event.session_id,
    data.operation_id ?? null,
    data.epoch ?? null,
    data.turn ?? null,
    data.round ?? null,
    data.call_id ?? null,
  ]);
  const existing = t.blocks.find((b) => b.preview?.key === key)?.preview;
  if (existing) return existing;
  const user = [...t.blocks].reverse().find((b) => b.role === "user");
  const start = user ? t.blocks.indexOf(user) + 1 : 0;
  const assistants = new Set(
    t.blocks
      .slice(start)
      .filter((b) => b.role === "assistant" && !b.preview && !b.temporary)
      .map((b) => b.messageId),
  );
  const pendingCalls = new Set(
    t.blocks
      .slice(start)
      .filter((b) => b.preview && !b.preview.canonicalMessageId)
      .map((b) => b.preview!.key),
  );
  return {
    key,
    operationId: data.operation_id,
    callId: data.call_id,
    epoch: data.epoch,
    turn: data.turn,
    round: data.round,
    userMessageId: user?.messageId ?? "",
    assistantOrdinal:
      data.round != null
        ? Math.max(0, data.round - 1)
        : assistants.size + pendingCalls.size,
  };
}
/** Final display barrier also reapplies exact typed execution/child authority. */
export function flushProjectedDisplay(t: Transcript, sessionId: string): void {
  flushDisplayProjection(t);
  projectDelegateChildren(t, sessionId, t.executionRows ?? [], true);
}
export function applyEvent(t: Transcript, event: NativeEvent, compose = true) {
  const data = event.data as Record<string, any>;
  if (event.event === "display.batch" || event.event === "display.settled") {
    if (!data.child_session_id) {
      applyDisplayBatch(
        t,
        event.session_id,
        event.data as import("./types").NativeDisplayBatch,
        compose,
      );
      if (compose)
        projectDelegateChildren(
          t,
          event.session_id,
          t.executionRows ?? [],
          true,
        );
    }
    return;
  }
  if (
    event.event === "model_observation" &&
    Number.isSafeInteger(data.archive_sequence) &&
    typeof data.attempt_id === "string"
  ) {
    const record: NativeDisplayRecord = {
      sequence: data.archive_sequence,
      attempt_id: data.attempt_id,
      event: data as NativeDisplayRecord["event"],
    };
    replayDisplayObservations(t, event.session_id, [record], compose);
    const graphOwnedAttempt = hasDisplayAttempt(
      t.displayGraph,
      data.attempt_id,
    );
    if (
      data.display_graph_version === 1 ||
      graphOwnedAttempt ||
      data.phase === "reasoning_delta" ||
      data.phase === "display_binding" ||
      data.phase === "display_fork_remap" ||
      data.display_block ||
      data.display_head
    )
      return;
  }
  if (event.event === "turn") {
    observeTurnLifecycle(t, event.session_id, event.data as NativeOperation);
    if (data.method === "turn.queue" && data.status === "completed") {
      t.blocks = t.blocks.map((block) =>
        block.temporary &&
        block.role === "user" && isDirectUserSource(block.payload.source) &&
        block.sessionId === event.session_id &&
        block.operationId === data.id
          ? { ...block, submissionStatus: "admitted" as const }
          : block,
      );
    }
    projectRetryReceipt(t, event.data as NativeOperation);
    roundLimitNotice(t, event.session_id, { id: data.id, result: data.result });
  }
  if (event.event === "session") {
    t.sessionStatus = data.status === "running" ? "busy" : data.status;
    if (["idle", "closed", "faulted"].includes(data.status)) {
      // Session termination closes previews without inventing a model end clock
      // or a successful provider response for interrupted generations.
      for (const block of t.blocks) {
        if (block.preview && block.stream === "streaming")
          block.stream = "stopped";
      }
    }
    t.agent = data.agent;
    t.model = executionModel(data as NativeSession);
    composeDisplayGraph(t);
  }
  if (
    event.event === "turn" &&
    ["failed", "cancelled"].includes(data.status) &&
    operationFailureRoute(event.data) === "conversation"
  ) {
    for (const preview of t.blocks) {
      if (
        preview.preview != null &&
        preview.preview.operationId === data.id &&
        !preview.preview.canonicalMessageId &&
        ["text", "reasoning"].includes(preview.kind)
      ) {
        preview.stream = "stopped";
        preview.temporary = false;
      }
    }
    const errorId = `error-${data.id}`;
    let block = t.blocks.find(
      (item) =>
        ["error", "cancelled"].includes(item.stream) &&
        item.operationId === data.id,
    );
    if (!block) {
      block = createBlock(
        event.session_id,
        errorId,
        "text",
        "text",
        "assistant",
      );
      block.stream = data.status === "cancelled" ? "cancelled" : "error";
      block.operationId = data.id;
      t.blocks.push(block);
    }
    block.payload.failure = wireFailure(data.result?.error);
    block.payload.text = failureBlockText(block.payload.failure);
    if (typeof data.result?.after_message_id === "string")
      block.failureAfterMessageId = data.result.after_message_id;
    const position = data.result?.position;
    if (
      position &&
      [position.epoch, position.turn, position.round].every(
        Number.isSafeInteger,
      )
    )
      block.position = position;
    placeOperationNotice(t, block);
  }
  if (event.event === "model_observation") {
    const origin = previewIdentity(t, event);
    const prefix = `preview:${origin.key}`;
    if (data.phase === "invalidated") {
      t.blocks = t.blocks.filter((block) => {
        if (
          block.preview?.key !== origin.key ||
          block.preview.canonicalMessageId
        )
          return true;
        if (!["text", "reasoning"].includes(block.kind)) return true;
        block.payload.stopReason = { reason: data.reason, detail: data.detail };
        block.stream = "stopped";
        block.temporary = false;
        return true;
      });
      return;
    }

    if (data.phase === "reasoning_delta") {
      const id = `${prefix}:reasoning`;
      let b = t.blocks.find((block) => block.id === id);
      if (!b) {
        b = createBlock(
          event.session_id,
          id,
          `${data.call_id}:reasoning`,
          "reasoning",
          "assistant",
        );
        b.id = id;
        b.preview = origin;
        b.temporary = true;
        b.stream = "streaming";
        t.blocks.push(b);
      }
      b.payload.text += data.text ?? "";
    } else if (data.phase === "text_delta" || data.phase === "started") {
      const id = `${prefix}:text`;
      let b = t.blocks.find((block) => block.id === id);
      if (!b) {
        b = createBlock(
          event.session_id,
          id,
          `${data.call_id}:text`,
          "text",
          "assistant",
        );
        b.id = id;
        b.preview = origin;
        b.temporary = true;
        b.stream = "streaming";
        t.blocks.push(b);
      }
      if (data.phase === "text_delta") {
        if (!b.payload.text && data.text) {
          t.blocks.splice(t.blocks.indexOf(b), 1);
          t.blocks.push(b);
        }
        b.payload.text += data.text ?? "";
      }
    } else if (data.phase === "tool_call_delta") {
      const toolCallId = data.id || `${prefix}:tool:${data.index}`;
      let b = t.blocks.find(
        (block) =>
          block.temporary &&
          block.kind === "tool" &&
          block.preview?.key === origin.key &&
          block.preview.toolIndex === data.index,
      );
      if (!b) {
        b = createBlock(
          event.session_id,
          `tool:${toolCallId}`,
          toolCallId,
          "tool",
          "assistant",
        );
        b.id = `${prefix}:tool:${data.index}`;
        b.preview = { ...origin, toolIndex: data.index };
        b.callId = toolCallId;
        b.temporary = true;
        b.stream = "streaming";
        b.tool = {
          name: data.name ?? "tool",
          callId: toolCallId,
          input: {},
          status: "running",
        };
        t.blocks.push(b);
      }
      if (data.id) {
        b.callId = data.id;
        b.tool!.callId = data.id;
      }
      if (data.name && (!b.tool!.name || b.tool!.name === "tool")) {
        b.tool!.name = data.name;
      }
      if (data.arguments) {
        (b as any).inputBuffer =
          ((b as any).inputBuffer ?? "") + data.arguments;
        try {
          b.tool!.input = JSON.parse((b as any).inputBuffer);
        } catch {
          b.tool!.input = (b as any).inputBuffer;
        }
      }
    } else if (data.phase === "validated") {
      const textId = `${prefix}:text`;
      const b = t.blocks.find((block) => block.id === textId);
      if (b) {
        if (data.text !== undefined && data.text !== null) {
          if (!b.payload.text && data.text) {
            t.blocks.splice(t.blocks.indexOf(b), 1);
            t.blocks.push(b);
          }
          b.payload.text = data.text;
        }
        b.stream = "complete";
        b.validated = true;
      }
      const reasoningId = `${prefix}:reasoning`;
      const rb = t.blocks.find((block) => block.id === reasoningId);
      // A preserved live ID can now belong to archive evidence. Its terminal
      // coverage is owned by composeDisplayReasoning, not this legacy handoff.
      if (rb && !rb.displayAttemptId) {
        rb.stream = rb.preview?.truncated ? "stopped" : "complete";
        rb.validated = true;
      }
    }
  }
  if (event.event === "executions.updated") {
    const items = (event.data as { items?: NativeExecution[] }).items;
    if (Array.isArray(items))
      projectDelegateChildren(t, event.session_id, items);
  }
  if (event.event === "tool") {
    const origin = previewIdentity(t, event);
    let b = [...t.blocks].reverse().find((block) => {
      const position = block.preview ?? block.position;
      return (
        (block.temporary ||
          [origin.epoch, origin.turn, origin.round].every(
            Number.isSafeInteger,
          )) &&
        block.sessionId === event.session_id &&
        block.role === "assistant" &&
        block.kind === "tool" &&
        block.callId === data.call_id &&
        position?.epoch === origin.epoch &&
        position?.turn === origin.turn &&
        position?.round === origin.round &&
        (!block.preview || block.preview.operationId === origin.operationId)
      );
    });
    if (!b) {
      b = createBlock(
        event.session_id,
        `tool:${data.call_id}`,
        data.call_id,
        "tool",
        "assistant",
      );
      b.id = `tool:${origin.key}`;
      b.preview = origin;
      b.callId = data.call_id;
      b.temporary = true;
      t.blocks.push(b);
    }
    const incomingExecutionId = displayExecutionId(data.execution_id);
    if (
      incomingExecutionId !== undefined &&
      ((b.displayExecutionId != null &&
        b.displayExecutionId !== incomingExecutionId) ||
        (b.executionId != null && b.executionId !== incomingExecutionId))
    )
      return;
    const terminal = ["completed", "success", "failed", "result"].includes(
      data.phase,
    );
    if (incomingExecutionId !== undefined) {
      b.executionId = incomingExecutionId;
      b.execution = {
        ...b.execution,
        ...data,
        execution_id: data.execution_id,
        call_id: data.call_id,
      };
    }
    if (typeof data.started_at_unix_ms === "number")
      b.startedMs = data.started_at_unix_ms;
    if (typeof data.elapsed_ms === "number" && b.startedMs != null)
      b.endedMs = b.startedMs + data.elapsed_ms;
    b.tool = {
      name: data.name ?? b.tool?.name ?? "tool",
      callId: data.call_id,
      input: data.arguments ?? b.tool?.input ?? {},
      // Cancellation/interruption phases keep their own meaning; they are
      // never shown as running forever or mapped to success.
      status: terminal
        ? data.phase === "failed"
          ? "error"
          : "completed"
        : ["cancelled", "canceled", "interrupted", "cancelling"].includes(
              data.phase,
            )
          ? data.phase === "canceled"
            ? "cancelled"
            : data.phase
          : "running",
    };
    const outcome =
      data.phase === "failed" ||
      ["cancelled", "interrupted"].includes(b.tool.status)
        ? b.tool.status
        : executionToolOutcome(b.execution?.status);
    if (outcome) b.payload.observedToolOutcome = outcome;
    if (b.payload.observedToolOutcome)
      b.tool.status = b.payload.observedToolOutcome;
    b.payload.text =
      typeof data.result === "string"
        ? data.result
        : data.result === undefined
          ? b.payload.text
          : JSON.stringify(data.result);
    if (data.result !== undefined) {
      try {
        b.payload.structured =
          typeof data.result === "string"
            ? JSON.parse(data.result)
            : data.result;
      } catch {
        b.payload.structured = null;
      }
    }
    b.stream = terminal
      ? data.phase === "failed"
        ? "failed"
        : "complete"
      : "streaming";
    projectDelegateChildren(t, event.session_id, t.executionRows ?? []);
  }
}
/** Sequence is connection-local, independently of each object's durable revision. */
export function subscriptionOrder(
  subscription: NativeSubscription,
  event: NativeEvent,
): "next" | "duplicate" | "gap" | "other" {
  if (
    subscription.subscription_id !== event.subscription_id ||
    subscription.snapshot.session.id !== event.session_id
  )
    return "other";
  if (subscription.generation !== event.generation) return "gap";
  if (event.sequence <= subscription.sequence) return "duplicate";
  return event.sequence === subscription.sequence + 1 ? "next" : "gap";
}
export function computeTurns(input: Block[] | Transcript): any[] {
  const blocks = Array.isArray(input) ? input : input.blocks;
  const turns: any[] = [];
  let current: any = null,
    hasText = false,
    afterTool = false;
  blocks.forEach((b, index) => {
    if (b.role === "user" || b.kind === "compaction") {
      current = {
        id: `turn:${b.id}`,
        userIndex: b.role === "user" && isDirectUserSource(b.payload.source) ? index : null,
        extraIndices: b.role === "user" && isDirectUserSource(b.payload.source) ? [] : [index],
        rounds: [],
        fold: "expanded",
      };
      turns.push(current);
      hasText = false;
      afterTool = false;
      return;
    }
    if (!current) {
      current = {
        id: `turn:orphan:${b.id}`,
        userIndex: null,
        extraIndices: [],
        rounds: [],
        fold: "expanded",
      };
      turns.push(current);
    }
    if (b.role === "system" || b.kind === "child") {
      current.extraIndices.push(index);
      return;
    }
    if (
      !current.rounds.length ||
      (["text", "reasoning"].includes(b.kind) &&
        (afterTool || (b.kind === "text" && hasText)))
    ) {
      hasText = false;
      current.rounds.push({
        id: `round:${current.id}:${current.rounds.length}`,
        blockIndices: [],
        fold: "expanded",
      });
    }
    current.rounds.at(-1).blockIndices.push(index);
    if (b.kind === "text") hasText = true;
    afterTool = b.kind === "tool";
  });
  if (!Array.isArray(input))
    for (const turn of turns) {
      turn.fold = input.turnFolds[turn.id] ?? turn.fold;
      for (const round of turn.rounds)
        round.fold = input.roundFolds[round.id] ?? round.fold;
    }
  return turns;
}
