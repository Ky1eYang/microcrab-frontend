import { isDirectUserSource } from "./input-source";
import { messageBlocks } from "./native-message-blocks";
import { createBlock } from "./create-block";
import type { Block, NativeDisplayObservation, Transcript } from "./types";

/** Immutable display identity. Bodies grow through byte-addressed observations;
 * Context publication and provider completion never revoke this ownership. */
export interface DisplayBlockIdentity {
  block_id: string;
  parent_block_id: string | null;
  block_type: string;
  content_ref: string;
  sequence: number;
  attempt_id: string;
  stream_key: string;
  timestamp_ms?: number;
}
export interface DisplayGraphNode {
  identity: DisplayBlockIdentity;
  /** Replaced before observation mutation; includes content, metadata and terminal facts. */
  revision?: number;
  block: Block;
  chunks: Record<number, string>;
  toolCallId?: string;
  toolName?: string;
  contentObserved?: boolean;
  canonical?: {
    canonical_message_id: string;
    canonical_source_id: string;
    message: import("./types").NativeMessage;
  };
  terminal?: "validated" | "invalidated";
  invalid?: boolean;
}
export interface DisplayGraphState {
  sessionId: string;
  nodes: Record<string, DisplayGraphNode>;
  bindings?: Record<
    string,
    {
      canonical_message_id: string;
      canonical_source_id: string;
      tool_call_ids: string[];
      producer_block_ids: string[];
      message: import("./types").NativeMessage;
    }
  >;
  remaps?: Record<
    string,
    { canonical_message_id: string; message: import("./types").NativeMessage }
  >;
  terminalSequences?: Record<string, number>;
  terminalTotals?: Record<string, { reasoning?: number; text?: number }>;
  stopReasons?: Record<string, { reason?: string; detail?: string }>;
  terminals?: Record<string, "validated" | "invalidated">;
  selectedHead?: string | null;
  selectionKnown?: boolean;
  selectionSequence: number;
  incomplete: boolean;
  windowApplied?: boolean;
}
export interface DisplayGraphEnvelope {
  selected_head: string | null;
  selection_known?: boolean;
  revision: number;
  nodes: DisplayBlockIdentity[];
  complete: boolean;
}

interface Body {
  text: string;
  bytes: number;
  contiguous: boolean;
  present: boolean;
}
interface GraphWork {
  dirty: Set<string>;
  structural: boolean;
  blocks?: Block[];
  indexes: Map<string, number>;
  attempts: Map<string, Set<string>>;
  selected: Set<string>;
  connected?: boolean;
  status?: Transcript["sessionStatus"];
}
const work = new WeakMap<DisplayGraphState, GraphWork>();
const bodies = new WeakMap<DisplayGraphNode, Body>();
const canonicalRows = new WeakMap<
  import("./types").NativeMessage,
  Map<string, Block[]>
>();
function cachedMessageBlocks(
  sessionId: string,
  message: import("./types").NativeMessage,
  apiBase: string,
): Block[] {
  let scopes = canonicalRows.get(message);
  if (!scopes) canonicalRows.set(message, (scopes = new Map()));
  const key = JSON.stringify([sessionId, apiBase]);
  let rows = scopes.get(key);
  if (!rows)
    scopes.set(key, (rows = messageBlocks(sessionId, message, apiBase)));
  return rows.map((row) => ({
    ...row,
    payload: { ...row.payload },
    tool: row.tool ? { ...row.tool } : row.tool,
  }));
}
/** Deterministic work evidence, no bodies or runtime diagnostics. */
export const displayProjectionWork = {
  compositions: 0,
  full: 0,
  nodeBodies: 0,
  liveNodes: 0,
};
function dirtyGraph(graph: DisplayGraphState): GraphWork {
  let value = work.get(graph);
  if (!value) {
    value = {
      dirty: new Set(),
      structural: true,
      indexes: new Map(),
      attempts: new Map(),
      selected: new Set(),
    };
    for (const node of Object.values(graph.nodes)) {
      const id = node.identity.attempt_id;
      let ids = value.attempts.get(id);
      if (!ids) value.attempts.set(id, (ids = new Set()));
      ids.add(node.identity.block_id);
    }
    work.set(graph, value);
  }
  return value;
}
function nodeBody(node: DisplayGraphNode): Body {
  const known = bodies.get(node);
  if (known) return known;
  displayProjectionWork.nodeBodies++;
  let expected = 0;
  let contiguous = true;
  const chunks = Object.entries(node.chunks).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  for (const [offset, text] of chunks) {
    if (Number(offset) !== expected) contiguous = false;
    expected = Number(offset) + new TextEncoder().encode(text).byteLength;
  }
  const result = {
    text: chunks.map(([, text]) => text).join(""),
    bytes: expected,
    contiguous: contiguous && !node.invalid,
    present: chunks.length > 0 || node.contentObserved === true,
  };
  bodies.set(node, result);
  return result;
}
export function hasDisplayAttempt(
  graph: DisplayGraphState | undefined,
  attempt: string,
): boolean {
  return !!graph && dirtyGraph(graph).attempts.has(attempt);
}
export function copyDisplayNodeBlock(
  node: DisplayGraphNode,
  block: Block,
): DisplayGraphNode {
  const replacement = { ...node, block };
  const cached = bodies.get(node);
  if (cached) bodies.set(replacement, cached);
  return replacement;
}
export function cloneDisplayGraph(graph: DisplayGraphState): DisplayGraphState {
  return {
    ...graph,
    nodes: { ...graph.nodes },
    bindings: { ...graph.bindings },
    remaps: { ...graph.remaps },
    terminalSequences: { ...graph.terminalSequences },
    terminalTotals: { ...graph.terminalTotals },
    stopReasons: { ...graph.stopReasons },
    terminals: { ...graph.terminals },
  };
}

function identity(value: unknown): DisplayBlockIdentity | null {
  if (!value || typeof value !== "object") return null;
  const node = value as DisplayBlockIdentity;
  return typeof node.block_id === "string" &&
    !!node.block_id &&
    (node.parent_block_id === null ||
      typeof node.parent_block_id === "string") &&
    node.parent_block_id !== node.block_id &&
    typeof node.block_type === "string" &&
    !!node.block_type &&
    typeof node.attempt_id === "string" &&
    !!node.attempt_id &&
    typeof node.stream_key === "string" &&
    !!node.stream_key &&
    node.content_ref === `display:${node.block_id}` &&
    Number.isSafeInteger(node.sequence) &&
    node.sequence > 0
    ? node
    : null;
}

/** Consume only producer-assigned identity. Legacy observations retain their
 * separate fallback; no canonical identity is inferred from request coordinates. */
export function observeDisplayGraph(
  transcript: Transcript,
  sessionId: string,
  event: NativeDisplayObservation,
  sequence: number,
  attemptId?: string,
  compose = true,
): boolean {
  const source = identity(event.display_block);
  const head = event.display_head as
    | {
        previous_block_id?: string | null;
        selected_block_id?: string | null;
      }
    | undefined;
  if (
    !source &&
    !head &&
    !transcript.displayGraph &&
    !["display_binding", "display_fork_remap"].includes(event.phase) &&
    !(
      attemptId &&
      (event.phase === "validated" || event.phase === "invalidated")
    )
  )
    return false;
  let graph = transcript.displayGraph;
  if (!graph || graph.sessionId !== sessionId) {
    graph = { sessionId, nodes: {}, selectionSequence: 0, incomplete: false };
    transcript.displayGraph = graph;
  }
  if (event.phase === "display_fork_remap") {
    if (
      event.target_session_id === sessionId &&
      Array.isArray(event.mappings)
    ) {
      for (const value of event.mappings) {
        if (!value || typeof value !== "object") continue;
        const mapping = value as {
          canonical_source_id?: string;
          canonical_message_id?: string;
          message?: import("./types").NativeMessage;
        };
        if (
          typeof mapping.canonical_source_id === "string" &&
          typeof mapping.canonical_message_id === "string" &&
          mapping.message?.id === mapping.canonical_message_id &&
          mapping.message.canonical_source_id === mapping.canonical_source_id
        )
          (graph.remaps ??= {})[mapping.canonical_source_id] = {
            canonical_message_id: mapping.canonical_message_id,
            message: mapping.message,
          };
      }
    }
    dirtyGraph(graph).structural = true;
    if (compose) composeDisplayGraph(transcript);
    return true;
  }
  if (event.phase === "display_binding") {
    if (
      typeof event.producer_call_id === "string" &&
      typeof event.canonical_message_id === "string" &&
      typeof event.canonical_source_id === "string" &&
      Array.isArray(event.tool_call_ids) &&
      event.tool_call_ids.every((id) => typeof id === "string") &&
      Array.isArray(event.producer_block_ids) &&
      event.producer_block_ids.every((id) => typeof id === "string") &&
      event.message &&
      typeof event.message === "object"
    ) {
      const binding = {
        canonical_message_id: event.canonical_message_id,
        canonical_source_id: event.canonical_source_id,
        tool_call_ids: event.tool_call_ids as string[],
        producer_block_ids: event.producer_block_ids as string[],
        message: event.message as import("./types").NativeMessage,
      };
      const prior = graph.bindings?.[event.producer_call_id];
      if (!prior || JSON.stringify(prior) === JSON.stringify(binding))
        (graph.bindings ??= {})[event.producer_call_id] = binding;
    }
    dirtyGraph(graph).structural = true;
    if (compose) composeDisplayGraph(transcript);
    return true;
  }
  if (source) {
    if (!graph.nodes[source.block_id]) {
      const withoutPlaceholders = transcript.blocks.filter(
        (block) =>
          !(
            block.temporary &&
            block.preview &&
            block.preview.operationId === event.operation_id &&
            block.preview.callId === event.call_id &&
            !block.payload.text &&
            !block.payload.attachments.length &&
            block.kind === "text"
          ),
      );
      if (withoutPlaceholders.length !== transcript.blocks.length) {
        transcript.blocks = withoutPlaceholders;
        dirtyGraph(graph).structural = true;
      }
    }
    let node = graph.nodes[source.block_id];
    const priorBody = node
      ? nodeBody(node)
      : { text: "", bytes: 0, contiguous: true, present: false };
    if (
      node &&
      [
        "parent_block_id",
        "block_type",
        "content_ref",
        "sequence",
        "timestamp_ms",
        "attempt_id",
        "stream_key",
      ].some(
        (key) =>
          node!.identity[key as keyof DisplayBlockIdentity] !==
          source[key as keyof DisplayBlockIdentity],
      )
    )
      return true;
    if (node) {
      node = graph.nodes[source.block_id] = {
        ...node,
        revision: (node.revision ?? 0) + 1,
        block: { ...node.block },
        chunks: { ...node.chunks },
      };
    } else dirtyGraph(graph).structural = true;
    const owner = dirtyGraph(graph);
    let ids = owner.attempts.get(source.attempt_id);
    if (!ids) owner.attempts.set(source.attempt_id, (ids = new Set()));
    ids.add(source.block_id);
    owner.dirty.add(source.block_id);
    if (event.phase === "display_canonical")
      dirtyGraph(graph).structural = true;
    if (!node) {
      const kind = source.block_type.startsWith("tool")
        ? "tool"
        : source.block_type;
      const block = createBlock(
        sessionId,
        source.block_id,
        source.block_id,
        kind,
      );
      block.id = source.block_id;
      block.displayGraphId = source.block_id;
      block.callId = typeof event.id === "string" ? event.id : event.call_id;
      block.operationId = event.operation_id;
      block.position = [event.epoch, event.turn, event.round].every(
        Number.isSafeInteger,
      )
        ? { epoch: event.epoch, turn: event.turn!, round: event.round! }
        : null;
      block.stream = "streaming";
      block.temporary = false;
      node = graph.nodes[source.block_id] = {
        identity: {
          block_id: source.block_id,
          parent_block_id: source.parent_block_id,
          block_type: source.block_type,
          content_ref: source.content_ref,
          sequence: source.sequence,
          attempt_id: source.attempt_id,
          stream_key: source.stream_key,
          timestamp_ms: source.timestamp_ms,
        },
        block,
        chunks: {},
      };
    }
    if (
      event.phase === "display_canonical" &&
      event.content &&
      typeof event.content === "object"
    ) {
      const content = event.content as NonNullable<
        DisplayGraphNode["canonical"]
      >;
      if (
        typeof content.canonical_message_id === "string" &&
        typeof content.canonical_source_id === "string" &&
        content.message &&
        typeof content.message.id === "string"
      ) {
        if (
          node.canonical &&
          JSON.stringify(node.canonical) !== JSON.stringify(content)
        )
          node.invalid = true;
        else node.canonical = content;
      } else node.invalid = true;
    }
    node.terminal ??= graph.terminals?.[source.attempt_id];
    if (event.operation_id) node.block.operationId = event.operation_id;
    if ([event.epoch, event.turn, event.round].every(Number.isSafeInteger))
      node.block.position = {
        epoch: event.epoch,
        turn: event.turn!,
        round: event.round!,
      };
    const offset = (
      event.display_block as DisplayBlockIdentity & { content_offset?: number }
    ).content_offset;
    const text =
      event.phase === "tool_call_delta" ? event.arguments : event.text;
    if (typeof text === "string") {
      const encodedBytes = new TextEncoder().encode(text).byteLength;
      const bytes = (
        event.display_block as DisplayBlockIdentity & { content_bytes?: number }
      ).content_bytes;
      if (
        bytes !== encodedBytes ||
        !Number.isSafeInteger(offset) ||
        offset! < 0
      )
        node.invalid = true;
      else if (text.length === 0) node.contentObserved = true;
      else if (node.chunks[offset!] != null && node.chunks[offset!] !== text)
        node.invalid = true;
      else if (
        !(priorBody?.contiguous && offset! >= priorBody.bytes) &&
        Object.entries(node.chunks).some(
          ([start, chunk]) =>
            Number(start) !== offset &&
            Number(start) < offset! + encodedBytes &&
            Number(start) + new TextEncoder().encode(chunk).byteLength >
              offset!,
        )
      )
        node.invalid = true;
      else {
        node.chunks[offset!] = text;
        if (
          priorBody?.contiguous &&
          offset === priorBody.bytes &&
          !node.invalid
        )
          bodies.set(node, {
            text: priorBody.text + text,
            bytes: priorBody.bytes + encodedBytes,
            contiguous: true,
            present: true,
          });
      }
    }
    if (source.block_type.startsWith("tool")) {
      if (typeof event.id === "string" && event.id) node.toolCallId = event.id;
      if (typeof event.name === "string" && event.name)
        node.toolName = event.name;
      node.block.callId = node.toolCallId;
      node.block.tool = {
        ...node.block.tool,
        name: event.name ?? node.block.tool?.name ?? "tool",
        callId: node.block.callId,
        input: node.block.tool?.input ?? {},
      };
    }
  }
  if (
    head &&
    (head.selected_block_id === null ||
      typeof head.selected_block_id === "string") &&
    Number.isSafeInteger(sequence) &&
    sequence > graph.selectionSequence
  ) {
    if (graph.selectedHead !== head.selected_block_id)
      dirtyGraph(graph).structural = true;
    graph.selectedHead = head.selected_block_id;
    if (event.phase === "display_head_selected") {
      if (graph.selectionKnown !== (event.selected_head_known !== false))
        dirtyGraph(graph).structural = true;
      graph.selectionKnown = event.selected_head_known !== false;
    }
    graph.selectionSequence = sequence;
  }
  // Terminal receipt applies to known segments from the exact producer only.
  if (
    (event.phase === "validated" || event.phase === "invalidated") &&
    attemptId &&
    sequence > (graph.terminalSequences?.[attemptId] ?? 0)
  ) {
    dirtyGraph(graph).structural = true;
    (graph.terminalSequences ??= {})[attemptId] = sequence;
    (graph.terminals ??= {})[attemptId] = event.phase;
    if (event.phase === "invalidated")
      (graph.stopReasons ??= {})[attemptId] = {
        reason: typeof event.reason === "string" ? event.reason : undefined,
        detail: typeof event.detail === "string" ? event.detail : undefined,
      };
    (graph.terminalTotals ??= {})[attemptId] = {
      reasoning:
        Number.isSafeInteger(event.reasoning_bytes) &&
        (event.reasoning_bytes as number) >= 0
          ? (event.reasoning_bytes as number)
          : undefined,
      text:
        Number.isSafeInteger(event.text_bytes) &&
        (event.text_bytes as number) >= 0
          ? (event.text_bytes as number)
          : undefined,
    };
    for (const id of dirtyGraph(graph).attempts.get(attemptId) ?? []) {
      const node = graph.nodes[id];
      const replacement = (graph.nodes[id] = {
        ...node,
        revision: (node.revision ?? 0) + 1,
        terminal: event.phase,
      });
      const cached = bodies.get(node);
      if (cached) bodies.set(replacement, cached);
    }
  }
  if (compose) composeDisplayGraph(transcript);
  return !!source || !!head;
}

/** A page carries selected-head authority separately from bounded identities.
 * `complete` certifies archive format coverage, never that this page is the graph. */
export function applyDisplayGraphEnvelope(
  transcript: Transcript,
  sessionId: string,
  envelope: DisplayGraphEnvelope,
  compose = true,
): boolean {
  if (
    !envelope ||
    !Number.isSafeInteger(envelope.revision) ||
    envelope.revision < 0 ||
    !(
      envelope.selected_head === null ||
      typeof envelope.selected_head === "string"
    ) ||
    !Array.isArray(envelope.nodes) ||
    envelope.nodes.some((node) => !identity(node))
  )
    return false;
  let graph = transcript.displayGraph;
  if (!graph || graph.sessionId !== sessionId)
    graph = transcript.displayGraph = {
      sessionId,
      nodes: {},
      selectionSequence: 0,
      incomplete: false,
    };
  if (
    envelope.revision === graph.selectionSequence &&
    graph.selectedHead !== undefined &&
    graph.selectedHead !== envelope.selected_head
  )
    return false;
  const immutableKeys: (keyof DisplayBlockIdentity)[] = [
    "block_id",
    "parent_block_id",
    "block_type",
    "content_ref",
    "sequence",
    "timestamp_ms",
    "attempt_id",
    "stream_key",
  ];
  if (
    envelope.nodes.some((source) => {
      const known = graph!.nodes[source.block_id];
      return (
        known &&
        immutableKeys.some((key) => known.identity[key] !== source[key])
      );
    })
  )
    return false;
  for (const source of envelope.nodes) {
    if (graph.nodes[source.block_id]) continue;
    const block = createBlock(
      sessionId,
      source.block_id,
      source.block_id,
      source.block_type.startsWith("tool") ? "tool" : source.block_type,
    );
    block.id = source.block_id;
    block.displayGraphId = source.block_id;
    block.temporary = false;
    let ids = dirtyGraph(graph).attempts.get(source.attempt_id);
    if (!ids)
      dirtyGraph(graph).attempts.set(source.attempt_id, (ids = new Set()));
    ids.add(source.block_id);
    graph.nodes[source.block_id] = {
      identity: { ...source },
      block,
      chunks: {},
    };
  }
  if (envelope.revision >= graph.selectionSequence) {
    graph.selectedHead = envelope.selected_head;
    graph.selectionKnown = envelope.selection_known !== false;
    graph.selectionSequence = envelope.revision;
  }
  dirtyGraph(graph).structural = true;
  if (compose) composeDisplayGraph(transcript);
  return true;
}

/** Rebuild selected ancestry without deleting retained sibling bodies. Missing
 * parents leave coverage unknown; a bounded page cannot certify exclusion. */
export function composeDisplayGraph(
  transcript: Transcript,
  placement: readonly Block[] = transcript.blocks,
): void {
  const graph = transcript.displayGraph;
  if (!graph) return;
  displayProjectionWork.compositions++;
  const pending = dirtyGraph(graph);
  const canUpdate =
    !pending.structural &&
    pending.blocks === transcript.blocks &&
    pending.connected === transcript.connected &&
    pending.status === transcript.sessionStatus &&
    [...pending.dirty].every((id) => {
      const node = graph.nodes[id];
      return (
        node &&
        (node.identity.block_type === "text" ||
          node.identity.block_type === "reasoning") &&
        !node.canonical &&
        !node.terminal &&
        !graph.bindings?.[node.identity.attempt_id] &&
        pending.indexes.has(id) &&
        pending.selected.has(id)
      );
    });
  if (canUpdate) {
    for (const id of pending.dirty) {
      const node = graph.nodes[id];
      const index = pending.indexes.get(id)!;
      const prior = transcript.blocks[index];
      const content = nodeBody(node);
      const streaming =
        content.contiguous &&
        transcript.connected &&
        transcript.sessionStatus === "busy";
      transcript.blocks[index] = {
        ...prior,
        operationId: node.block.operationId,
        position: node.block.position,
        payload: {
          ...prior.payload,
          text: content.text,
          stopReason: graph.stopReasons?.[node.identity.attempt_id],
        },
        validated: false,
        stream: streaming ? "streaming" : "stopped",
        displayIncomplete: !streaming || !content.contiguous || !!node.invalid,
      };
      displayProjectionWork.liveNodes++;
    }
    pending.dirty.clear();
    return;
  }
  displayProjectionWork.full++;
  if (graph.selectionKnown === false) {
    // The current canonical page owns readable Context rows. An uncertified
    // historical target cannot select any retained graph sibling or prove root.
    graph.incomplete = true;
    transcript.blocks = transcript.blocks.filter(
      (block) => !block.displayGraphId,
    );
    return;
  }
  const apiBase =
    transcript.displayApiBase ??
    (typeof location === "undefined"
      ? "http://127.0.0.1:4096/"
      : location.origin);
  for (const block of transcript.blocks) {
    const node = block.displayGraphId && graph.nodes[block.displayGraphId];
    if (node) {
      const replacement = (graph.nodes[node.identity.block_id] = {
        ...node,
        block: {
          ...node.block,
          executionId: block.executionId,
          execution: block.execution,
          clientInvocationId: block.clientInvocationId,
          tool:
            node.block.tool || block.tool
              ? {
                  ...node.block.tool,
                  ...block.tool,
                  name: node.block.tool?.name ?? block.tool?.name,
                }
              : null,
          payload: { ...block.payload },
        },
      });
      const cached = bodies.get(node);
      if (cached) bodies.set(replacement, cached);
    }
  }
  const selected: DisplayGraphNode[] = [];
  const visited = new Set<string>();
  let cursor = graph.selectedHead;
  let complete = cursor !== undefined;
  while (cursor) {
    const node = graph.nodes[cursor];
    if (!node || visited.has(cursor)) {
      complete = false;
      break;
    }
    visited.add(cursor);
    selected.push(node);
    cursor = node.identity.parent_block_id;
  }
  graph.incomplete = !complete;
  const prior = transcript.blocks;
  // An input certificate can precede RoundStarted. Hydrate its later recorded
  // position only through the exact canonical source, preserving unknown until then.
  const canonicalPositions = new Map(
    prior.flatMap((block) =>
      block.role === "user" && block.canonicalSourceId && block.position
        ? [[block.canonicalSourceId as string, block.position] as const]
        : [],
    ),
  );
  const retained = complete
    ? []
    : placement.filter(
        (block) => block.displayGraphId && !visited.has(block.displayGraphId),
      );
  const projected: Block[] = [];
  const coveredSources = new Set<string>(
    retained.flatMap((block) =>
      block.canonicalSourceId ? [block.canonicalSourceId as string] : [],
    ),
  );
  const coveredMessages: import("./types").NativeMessage[] = [];
  const body = nodeBody;
  const coverage = new Map<string, { bytes: number; complete: boolean }>();
  for (const node of Object.values(graph.nodes)) {
    if (
      node.identity.block_type !== "reasoning" &&
      node.identity.block_type !== "text"
    )
      continue;
    const key = JSON.stringify([
      node.identity.attempt_id,
      node.identity.block_type,
    ]);
    const priorCoverage = coverage.get(key) ?? { bytes: 0, complete: true };
    const content = body(node);
    coverage.set(key, {
      bytes: priorCoverage.bytes + content.bytes,
      complete: priorCoverage.complete && content.present && content.contiguous,
    });
  }
  const attemptCovered = (node: DisplayGraphNode) => {
    if (
      node.identity.block_type !== "reasoning" &&
      node.identity.block_type !== "text"
    )
      return false;
    const total =
      graph.terminalTotals?.[node.identity.attempt_id]?.[
        node.identity.block_type
      ];
    const received = coverage.get(
      JSON.stringify([node.identity.attempt_id, node.identity.block_type]),
    );
    return (
      total != null && received?.complete === true && received.bytes === total
    );
  };
  const chronological = selected.reverse();
  const toolSegments = new Map<string, DisplayGraphNode[]>();
  const toolKey = (node: DisplayGraphNode) =>
    JSON.stringify([node.identity.attempt_id, node.identity.stream_key]);
  for (const node of chronological) {
    if (!node.identity.block_type.startsWith("tool")) continue;
    const key = toolKey(node);
    const group = toolSegments.get(key) ?? [];
    group.push(node);
    toolSegments.set(key, group);
  }
  for (const group of toolSegments.values())
    group.sort((a, b) => a.identity.sequence - b.identity.sequence);
  for (const node of chronological) {
    if (node.canonical) {
      coveredSources.add(node.canonical.canonical_source_id);
      const canonicalMessage =
        graph.remaps?.[node.canonical.canonical_source_id]?.message ??
        node.canonical.message;
      coveredMessages.push(canonicalMessage);
      const rows = cachedMessageBlocks(
        graph.sessionId,
        canonicalMessage,
        apiBase,
      );
      for (const [index, row] of rows.entries()) {
        row.id =
          index === 0
            ? node.identity.block_id
            : `${node.identity.block_id}:${row.partId}`;
        row.displayGraphId = node.identity.block_id;
        row.canonicalSourceId = node.canonical.canonical_source_id;
        row.position =
          canonicalPositions.get(row.canonicalSourceId) ?? row.position;
        if (row.role === "tool") {
          const call = [...projected]
            .reverse()
            .find(
              (candidate) =>
                (candidate.kind === "tool" || candidate.kind === "child") &&
                candidate.callId === row.callId &&
                candidate.role === "assistant",
            );
          if (call) {
            call.payload = {
              ...call.payload,
              text: row.payload.text,
              structured: row.payload.structured,
            };
            call.tool = { ...call.tool, status: "completed" };
            call.displaySourceIds = [
              ...new Set([
                ...(call.displaySourceIds ?? []),
                node.canonical.canonical_source_id,
              ]),
            ];
            call.clientInvocationId = row.clientInvocationId;
            continue;
          }
        }
        projected.push(row);
      }
      continue;
    }
    const toolNode = node.identity.block_type.startsWith("tool");
    const segments = toolNode ? toolSegments.get(toolKey(node))! : [node];
    if (segments[0] !== node) continue;
    const content = toolNode
      ? {
          text: segments.map((segment) => body(segment).text).join(""),
          bytes: segments.reduce(
            (sum, segment) => sum + body(segment).bytes,
            0,
          ),
          present: segments.some((segment) => body(segment).present),
          contiguous: segments.every((segment) => body(segment).contiguous),
        }
      : body(node);
    // Graph identity without a received body is coverage evidence, not a tool card.
    if (!content.present) continue;
    const block: Block = { ...node.block, payload: { ...node.block.payload } };
    if (toolNode) {
      const explicitId = segments.find(
        (segment) => segment.toolCallId,
      )?.toolCallId;
      const explicitName = segments.find(
        (segment) => segment.toolName,
      )?.toolName;
      block.callId = explicitId;
      block.tool = {
        ...block.tool,
        callId: explicitId,
        name: explicitName ?? block.tool?.name ?? "tool",
      };
      block.displaySegmentIds = segments.map(
        (segment) => segment.identity.block_id,
      );
    }
    const candidateBinding = graph.bindings?.[node.identity.attempt_id];
    const sourceBinding = candidateBinding?.producer_block_ids.includes(
      node.identity.block_id,
    )
      ? candidateBinding
      : undefined;
    const remap =
      sourceBinding && graph.remaps?.[sourceBinding.canonical_source_id];
    const binding =
      sourceBinding && remap ? { ...sourceBinding, ...remap } : sourceBinding;
    if (binding) {
      if (toolNode) {
        const index = /^tool:(\d+)$/.exec(node.identity.stream_key)?.[1];
        const acceptedCall =
          index == null ? undefined : binding.message.tool_calls[Number(index)];
        if (
          acceptedCall &&
          (!block.callId || block.callId === acceptedCall.id)
        ) {
          block.callId = acceptedCall.id;
          block.tool = {
            ...block.tool,
            callId: acceptedCall.id,
            name: acceptedCall.name,
          };
        }
      }
      coveredMessages.push(binding.message);
      coveredSources.add(binding.canonical_source_id);
      block.messageId = binding.canonical_message_id;
      block.canonicalSourceId = binding.canonical_source_id;
      const canonical = cachedMessageBlocks(
        graph.sessionId,
        binding.message,
        apiBase,
      ).find(
        (candidate) =>
          candidate.kind === (toolNode ? "tool" : block.kind) &&
          (!toolNode || candidate.callId === block.callId),
      );
      if (canonical) {
        block.position = canonical.position;
        block.payload.providerMetadata = canonical.payload.providerMetadata;
        if (toolNode && binding.tool_call_ids.includes(block.callId ?? "")) {
          block.tool = { ...block.tool, ...canonical.tool };
          block.payload = {
            ...block.payload,
            providerMetadata: canonical.payload.providerMetadata,
          };
          block.executionId = canonical.executionId ?? block.executionId;
          block.execution = canonical.execution ?? block.execution;
          block.clientInvocationId =
            canonical.clientInvocationId ?? block.clientInvocationId;
        }
      }
    }
    const admittedTool =
      toolNode && binding?.tool_call_ids.includes(block.callId ?? "") === true;
    if (toolNode) {
      if (!admittedTool) {
        block.tool = { ...block.tool };
        try {
          block.tool.input = JSON.parse(content.text);
        } catch {
          block.tool.input = content.text;
        }
      }
    } else block.payload.text = content.text;
    const invalidContent = segments.some((segment) => segment.invalid === true);
    block.validated =
      !invalidContent &&
      (admittedTool ||
        (node.terminal === "validated" &&
          content.contiguous &&
          attemptCovered(node)));
    block.stream = block.validated
      ? "complete"
      : node.terminal ||
          !content.contiguous ||
          !transcript.connected ||
          transcript.sessionStatus !== "busy"
        ? "stopped"
        : "streaming";
    block.payload.stopReason = graph.stopReasons?.[node.identity.attempt_id];
    block.displayIncomplete =
      !block.validated &&
      (block.stream === "stopped" || !content.contiguous || !!node.invalid);
    projected.push(block);
  }
  const loadedSources = new Set<string>(transcript.displayWindowSources ?? []);
  const windowStart = transcript.displayWindowBounded
    ? projected.findIndex(
        (block) =>
          loadedSources.has(block.canonicalSourceId) ||
          (block.displaySourceIds ?? []).some((source: string) =>
            loadedSources.has(source),
          ),
      )
    : -1;
  if (windowStart >= 0) {
    const visible = graph.windowApplied
      ? new Set(
          placement
            .filter(
              (block) => block.displayGraphId && !block.displayWindowHidden,
            )
            .map((block) => block.id),
        )
      : new Set<string>();
    projected.forEach((block, index) => {
      block.displayWindowHidden = index < windowStart && !visible.has(block.id);
    });
    graph.windowApplied = true;
  } else if (!transcript.displayWindowBounded) {
    projected.forEach((block) => {
      block.displayWindowHidden = false;
    });
    graph.windowApplied = true;
  } else {
    const previousVisibility = new Map(
      placement.map((block) => [block.id, block.displayWindowHidden]),
    );
    projected.forEach((block) => {
      block.displayWindowHidden = previousVisibility.get(block.id) === true;
    });
  }
  const selectedSources = new Set<string>();
  const ownedSources = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    if (node.canonical) {
      ownedSources.add(node.canonical.canonical_source_id);
      if (visited.has(node.identity.block_id))
        selectedSources.add(node.canonical.canonical_source_id);
    }
  }
  for (const binding of Object.values(graph.bindings ?? {})) {
    ownedSources.add(binding.canonical_source_id);
    if (binding.producer_block_ids.some((id) => visited.has(id)))
      selectedSources.add(binding.canonical_source_id);
  }
  const admittedSubmissions = new Set(
    coveredMessages.flatMap((message) =>
      message.role === "user" &&
      isDirectUserSource(message.source) &&
      message.submission_operation_id
        ? [message.submission_operation_id]
        : [],
    ),
  );
  const fallback = prior.filter(
    (block) =>
      !block.displayGraphId &&
      !(
        block.temporary &&
        block.role === "user" && isDirectUserSource(block.payload.source) &&
        block.sessionId === graph.sessionId &&
        admittedSubmissions.has(block.operationId ?? "")
      ) &&
      !(
        complete &&
        block.canonicalSourceId &&
        ownedSources.has(block.canonicalSourceId) &&
        !selectedSources.has(block.canonicalSourceId)
      ) &&
      !(block.canonicalSourceId
        ? coveredSources.has(block.canonicalSourceId)
        : coveredMessages.some(
            (message) =>
              message.id === block.messageId &&
              message.position?.epoch === block.position?.epoch &&
              message.position?.turn === block.position?.turn &&
              message.position?.round === block.position?.round,
          )),
  );
  const anchorIndex = (block: Block) => {
    const exact = placement.findIndex((candidate) => candidate.id === block.id);
    if (exact >= 0) return exact;
    return block.canonicalSourceId
      ? placement.findIndex(
          (candidate) =>
            candidate.canonicalSourceId === block.canonicalSourceId,
        )
      : -1;
  };
  const anchors = projected.map((block, index) => {
    const observed = anchorIndex(block);
    return observed < 0
      ? placement.length + prior.length + index + 1
      : observed;
  });
  const buckets: Block[][] = Array.from(
    { length: projected.length + 1 },
    () => [],
  );
  for (const block of fallback) {
    // Exact operation ownership places error/limit feedback after its observed
    // output even when a later Turn has already appended new graph segments.
    const operationTail = block.operationId
      ? projected.reduce(
          (tail, candidate, index) =>
            candidate.operationId === block.operationId ? index : tail,
          -1,
        )
      : -1;
    if (operationTail >= 0) {
      buckets[operationTail + 1].push(block);
      continue;
    }
    const observed = anchorIndex(block);
    const original =
      observed < 0 ? placement.length + prior.indexOf(block) : observed;
    const next = anchors.findIndex((anchor) => anchor > original);
    buckets[next < 0 ? projected.length : next].push(block);
  }
  transcript.blocks = [...retained];
  projected.forEach((block, index) =>
    transcript.blocks.push(...buckets[index], block),
  );
  transcript.blocks.push(...buckets[projected.length]);
  pending.selected = visited;
  pending.structural = false;
  pending.dirty.clear();
  pending.blocks = transcript.blocks;
  pending.connected = transcript.connected;
  pending.status = transcript.sessionStatus;
  pending.indexes = new Map(
    transcript.blocks.flatMap((block, index) =>
      block.displayGraphId ? [[block.displayGraphId, index] as const] : [],
    ),
  );
}
