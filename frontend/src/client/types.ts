import type { NativeWireError } from "./failure";
import type { ResolvedTheme, ThemePreference } from "./theme";
import type { LocalePreference, ResolvedLocale } from "../i18n/locale";
import type { BrowserAuthSession } from "./auth";
import type { Question } from "./client-tools";

export interface NativeModelSelection {
  provider_id: string;
  model: string;
  variant?: string | null;
}

export type ModelProtocol =
  "openai-compatible" | "openai" | "anthropic" | "google";

export interface NativeModelCatalog {
  default_model_selection?: NativeModelSelection;
  metadata_status?: {
    fetched_at_ms: number | null;
    models: number;
    last_error: string | null;
    enabled: boolean;
    refresh_interval_secs: number;
  };
  items: {
    id: string;
    name: string;
    provider_id: string;
    protocol: ModelProtocol;
    variants: string[];
    context_window_tokens?: number | null;
  }[];
}

export type ConversationHostFlavor = "chat_only" | "browser_sandbox";

export interface NativeSession {
  /** Present only when an actual conversation Host grant exists. */
  host_flavor?: ConversationHostFlavor;
  kind?: "interactive" | "delegated" | "one_shot";
  parent_session_id?: string | null;
  id: string;
  title: string;
  project_id: string | null;
  status: "idle" | "running" | "faulted" | "closed";
  agent: string | null;
  mode: string | null;
  model: string;
  model_selection?: NativeModelSelection;
  applied_model_selection?: NativeModelSelection | null;
  turn_model_selection?: NativeModelSelection | null;
  pending_model_change?: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  revision: number;
  archived: boolean;
  retry_ready?: boolean;
  agent_init_retry_required?: boolean;
  agent_initialization_deferred?: boolean;
  auto_compaction_retry_available?: boolean;
  retry_operation_id?: string | null;
  /** Workspace reachability when the host/backend reports it. */
  reachable?: boolean | null;
}
export interface NativeToolDiagnostic {
  code: string;
  layer: string;
  phase: string;
  effects: string;
  operation_effects?: string | null;
  message?: string;
  reason?: string | null;
  json_line?: number | null;
  json_column?: number | null;
  evidence_id?: string | null;
  retryable?: boolean;
  operation?: string | null;
  requested_timeout_ms?: number | null;
  effective_timeout_ms?: number | null;
  elapsed_ms?: number | null;
  limit_owner?: string | null;
  causes?: string[];
}
export interface NativeExecutionOutput {
  channels: string[];
  bytes: number;
  start_cursor: number;
  end_cursor: number;
  closed: boolean;
}
export interface NativeExecutionOutputPage {
  execution_id: number;
  chunks: {
    channel: string | null;
    content: string;
    cursor: number;
    next_cursor: number;
  }[];
  cursor: number;
  next_cursor: number;
  end_cursor: number;
  start_cursor: number;
  closed: boolean;
  revision: number;
}
export interface NativeExecutionContentPage {
  source_hash: string | null;
  session_id: string;
  execution_id: number;
  call_id: string;
  field: "arguments" | "result";
  content: string;
  cursor: number;
  next_cursor: number;
  end_cursor: number;
  revision: number;
  available: boolean;
}
export interface NativeExecution {
  subject?: PermissionRequest["subject"];
  delegate_child?: { session_id: string; target: string } | null;
  output_availability?: "none" | "retained" | "released";
  arguments_available?: boolean;
  result_available?: boolean;
  capabilities: { input: boolean };
  execution_id: number;
  session_id: string;
  call_id: string;
  tool: string;
  agent: string;
  mode: string | null;
  status:
    | "running"
    | "waiting"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  failure?: {
    kind: "failed" | "timeout" | "cancelled";
    code: string;
    message: string;
    retryable: boolean;
  };
  diagnostic?: NativeToolDiagnostic;
  output?: NativeExecutionOutput;
  started_at_unix_ms?: number;
  elapsed_ms?: number;
  result?: string;
}
export interface NativePart {
  type: "text" | "image";
  text?: string;
  media_type?: string | null;
  source_omitted?: boolean;
  source?:
    | { type: "data"; media_type: string; data: number[] }
    | { type: "attachment"; attachment_id: string }
    | { type: "url"; url: string };
}
export interface HistoryPosition {
  epoch: number;
  turn: number;
  round: number;
}
export interface NativeMessage {
  /** Exact trusted submission admission certificate; absent in historical bytes. */
  submission_operation_id?: string;
  canonical_source_id?: string;
  /** Display-only usage for this exact selected assistant response; absent means unknown. */
  usage?: NativeUsage | null;
  content_truncated?: boolean;
  compaction?: {
    id: string;
    epoch: number;
    summary: string;
    message_id: string;
    summary_truncated?: boolean;
  };
  source?: "framework";
  content_omitted?: boolean;
  client_invocation_id?: string | null;
  position?: HistoryPosition | null;
  id: string;
  role: "user" | "assistant" | "tool";
  text: string | null;
  parts: NativePart[];
  tool_calls: {
    id: string;
    name: string;
    arguments: unknown;
    builtin?: "delegate" | null;
  }[];
  tool_builtin?: "delegate" | null;
  call_id?: string;
  tool_name?: string;
}
export interface NativeChildSummary {
  id: string;
  name: string;
  status: string;
  availability: "persisted" | "pending" | "unavailable";
}
export interface NativeChildren {
  parent_session_id: string;
  children: NativeChildSummary[];
  next_cursor: string | null;
  limit: number;
}
export interface NativeChildDetail extends NativeChildSummary {
  display?: NativeSnapshot["display"];
  /** Client-only display hydration; never serialized into a model message. */
  display_records?: NativeDisplayRecord[];
  display_graph_pages?: import("./display-graph").DisplayGraphEnvelope[];
  display_coverage?: NativeDisplayPage["coverage"];
  history_view?: NativeHistoryView;
  parent_session_id: string;
  messages: NativeMessage[];
  next_cursor: number | null;
  messages_truncated: boolean;
  receipt: Record<string, unknown> | null;
  usage: unknown;
  executions: NativeExecution[];
  executions_truncated?: boolean;
  history: unknown;
}
export interface PermissionProposal {
  proposal_id: string;
  parent_session_id: string;
  session_id: string;
  controller_id: number;
  revision: number;
  agent: string;
  mode: string;
  tool: string;
  args: ArgumentPredicate[];
  created_at_ms: number;
  expires_at_ms: number;
}
export interface PermissionProposalView extends PermissionProposal {
  disabled: boolean;
  observer: boolean;
  submitting: boolean;
}
export interface PermissionRequest {
  phase?: "waiting_user" | "review_grace";
  controller_id?: number;
  owning_session_id?: string;
  review?: { action: "allow" | "deny"; reason: string };
  request_id: string;
  parent_session_id: string;
  session_id: string;
  call_id: string;
  agent: string;
  mode: string;
  tool: string;
  subject?:
    | { kind: "tool" }
    | {
        kind: "agent_init";
        component: string;
        generation: number;
        attempt: number;
      };
  arguments: unknown;
  revision: number;
  created_at_ms: number;
  expires_at_ms: number;
}
export interface PermissionProposalResult {
  proposal_id: string;
  status:
    "persisting" | "accepted" | "declined" | "expired" | "stale" | "failed";
  remembered: boolean;
  reason?: string;
}
export interface PermissionSettled {
  request_id: string;
  parent_session_id: string;
  session_id?: string;
  call_id?: string;
  revision?: number;
  agent?: string;
  mode?: string;
  tool?: string;
  owning_session_id?: string;
  controller_id?: number;
  decision: "allow" | "deny";
  source?: "user" | "review" | "unavailable" | "cancelled" | "timeout";
  review_reason?: string | null;
  reason?: string | null;
  remembered?: boolean;
}
export interface PermissionRequests {
  decisions?: PermissionSettled[];
  parent_session_id: string;
  requests: PermissionRequest[];
  proposals?: PermissionProposal[];
  proposal_results?: PermissionProposalResult[];
  interactive_ask: boolean;
  remembered_grants: false;
  executor_connected: boolean;
}
export interface PermissionRequestView extends PermissionRequest {
  disabled: boolean;
  observer: boolean;
  submitting: boolean;
}
export interface RoundLimitRequest {
  request_id: string;
  parent_session_id: string;
  session_id: string;
  epoch: number;
  turn_id: string;
  /** Which renewable consumption checkpoint asked. */
  kind: "rounds" | "tool_calls" | "context_bytes";
  /** Used quantity in the unit named by `kind`. */
  used: number;
  /** Additional quantity a Continue decision grants. */
  block: number;
  created_at_ms: number;
}
export interface RoundLimitRequests {
  parent_session_id: string;
  requests: RoundLimitRequest[];
  executor_connected: boolean;
}
export interface RoundLimitRequestView extends RoundLimitRequest {
  disabled: boolean;
  observer: boolean;
  submitting: boolean;
}
export type PermissionAction = "allow" | "ask" | "deny";
export interface PermissionMatcher {
  kind: "exact" | "glob" | "regex";
  value: string;
}
export interface ArgumentPredicate {
  pointer: string;
  matcher: PermissionMatcher;
}
export interface Permission {
  agent?: string | null;
  mode?: string | null;
  tool?: PermissionMatcher | null;
  args?: ArgumentPredicate[];
  action: PermissionAction;
}
export type CompiledToolPolicy =
  | { kind: "static"; action: PermissionAction }
  | {
      kind: "conditional";
      branches: {
        args: ArgumentPredicate[];
        action: PermissionAction;
        source?: string;
      }[];
      default_action: PermissionAction;
    }
  | { kind: "all_of"; policies: CompiledToolPolicy[] };
export interface PermissionOwner {
  controller: number;
  revision: number;
  agent: string;
  mode: string;
}
export type CompiledToolPolicyRow = CompiledToolPolicy & {
  tool: { kind: "exact"; value: string };
  owners?: PermissionOwner[];
};
export interface SessionPermissionConfig {
  overrides: Permission[];
  review: boolean;
  review_model?: NativeModelSelection | null;
  initialization: PermissionAction;
  agent?: string;
  mode?: string;
  defaults?: Permission[];
  provider_defaults?: Permission[];
}
export interface SessionToolInventory {
  agent: string;
  modes: {
    name: string;
    current: boolean;
    tools: {
      name: string;
      description: string;
      parameters?: unknown;
      [key: string]: unknown;
    }[];
    policy: SessionPermissionConfig;
    compiled: CompiledToolPolicyRow[];
    /** Optional controller/revision evidence; never used as local authority. */
    owners?: {
      controller: number;
      revision: number;
      agent: string;
      mode: string;
    }[];
  }[];
}
export interface PolicySnapshot {
  revision: number;
  config: SessionPermissionConfig;
  tool_inventory?: SessionToolInventory;
}
export interface NativeOperation {
  version: number;
  id: string;
  session_id: string;
  owner: string;
  method: string;
  payload_hash: string;
  status:
    | "accepted"
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "interrupted"
    | "unknown";
  result: unknown;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}
export interface ComposerImage {
  id: string;
  name: string;
  mediaType: string;
  data?: number[];
  file?: File;
  attachment?: { id: string; sessionId: string; bytes?: number };
  previewUrl: string;
}
export interface NativeCompaction {
  id: string;
  epoch: number;
  summary: string;
  message_id: string;
  instruction?: string;
  created_at_ms?: number;
}
export interface CompactLifecycle {
  operation_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  error?: { code: string; message: string };
}
export interface NativeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  total_tokens?: number | null;
  uncached_input_tokens?: number | null;
  non_reasoning_output_tokens?: number | null;
  samples?: number;
  [key: string]: unknown;
}
export interface NativeReportedCache {
  scope: "reported_samples";
  attempted_samples: number;
  paired_samples: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_hit_rate: number | null;
}
export interface NativeStatistics {
  context: {
    scope: "current_selected_context";
    provenance: "context_budget_json_v1";
    epoch: number;
    pending_epoch: boolean;
    bytes: number;
    limit_bytes: number;
    remaining_bytes: number;
    categories: Record<
      | "system"
      | "tools"
      | "state"
      | "user"
      | "assistant"
      | "tool_result"
      | "framing",
      number
    >;
    counts: {
      items: number;
      tool_definitions: number;
      pending_tool_calls: number;
      state_frames: number;
      user_messages: number;
      assistant_messages: number;
      tool_results: number;
      tool_calls: number;
      turns: number | null;
      steps: number;
    };
    fingerprint: string;
  };
  activity: {
    scope: "selected_context_history";
    turns: number | null;
    steps: number;
    tool_calls: number;
    execution?: {
      active: boolean;
      started_at_ms: number | null;
      ended_at_ms: number | null;
      elapsed_ms: number | null;
    };
    operation: {
      id: string;
      kind: string;
      status: string;
      started_at_ms: number;
      ended_at_ms: number | null;
      elapsed_ms: number | null;
    } | null;
  };
  usage: {
    scope: "append_only_consumption";
    main: NativeUsage;
    aggregate: NativeUsage;
    main_cache_hit_rate: number | null;
    aggregate_cache_hit_rate: number | null;
    main_reported_cache?: NativeReportedCache;
    aggregate_reported_cache?: NativeReportedCache;
  };
  provider: {
    scope: "latest_main_provider_attempt";
    latest_prompt: {
      request_hash: string;
      call_id: string;
      epoch: number;
      turn: number | null;
      round: number | null;
      input_tokens: number | null;
      started_at_ms: number | null;
      ended_at_ms: number | null;
      freshness: "current" | "stale" | "unknown";
      freshness_reason: string;
    } | null;
    timing: {
      request_hash: string;
      call_id: string;
      started_at_ms: number | null;
      ended_at_ms: number | null;
      elapsed_ms: number | null;
      generation_ms: number | null;
      first_token_ms: number | null;
      output_tokens: number | null;
      tokens_per_second: number | null;
      rate_basis: "request_average" | "generation_interval" | null;
      timing_source?: "transport_stream" | null;
      request_tokens_per_second?: number | null;
    } | null;
    audit_sequence: number | null;
    available: boolean;
  };
  model: {
    context_window_tokens: number | null;
    measured_headroom_tokens: number | null;
    headroom_reason: string;
  };
}
export interface NativeInbox {
  inbox_id?: string;
  items: {
    id: number;
    revision?: number;
    claimed?: boolean;
    mode: "queue" | "steer";
    submission_operation_id?: string;
    input: { parts: NativePart[]; variables?: unknown };
  }[];
  paused: boolean;
  active: boolean;
}
/** Bounded display-only evidence owned by a selected failed operation receipt. */
export interface NativePartialOutput {
  call_id: string;
  epoch: number;
  turn: number | null;
  round: number | null;
  text: string;
  reasoning?: string;
  truncated?: boolean;
}
export interface NativeHistoryView {
  lineage: string;
  epoch: number;
  message_count: number;
  start_cursor: number;
  end_cursor: number;
  turns: {
    epoch: number;
    turn: number;
    tool_calls: number;
    ordinary_tool_calls: number;
    delegate_calls: number;
    usage?: {
      input_tokens: number | null;
      output_tokens: number | null;
      audit_sequence: number | null;
    };
  }[];
}
export interface NativeDisplayObservation {
  phase: string;
  call_id: string;
  epoch: number;
  turn: number | null;
  round: number | null;
  subagent?: string | null;
  operation_id?: string;
  text?: string;
  reason?: string;
  [key: string]: unknown;
}
export interface NativeDisplayRecord {
  sequence: number;
  attempt_id: string;
  event: NativeDisplayObservation;
}
export interface NativeDisplayPage {
  graph?: import("./display-graph").DisplayGraphEnvelope;
  records: NativeDisplayRecord[];
  high_water: number;
  next_cursor: number | null;
  history_lineage: string;
  coverage: "available" | "missing" | "unavailable";
}
export interface NativeDisplayBatch extends NativeDisplayPage {
  after: number;
  scanned_through: number;
  child_session_id?: string | null;
  error?: { code: string; message: string };
}
export interface DisplayReplayAttempt {
  event: NativeDisplayObservation;
  chunks: Record<number, string>;
  offsets?: Record<number, number>;
  reasoningBytes?: number;
  terminal?: "validated" | "invalidated";
  terminalSequence?: number;
  firstSequence: number;
}
export interface DisplayReplayState {
  /** Contiguous committed scan coverage, including intentionally filtered rows. */
  watermark: number;
  sessionId: string;
  lineage?: string;
  seen: Record<number, true>;
  attempts: Record<string, DisplayReplayAttempt>;
}
export interface NativeSnapshot {
  display?: {
    high_water: number;
    coverage: "available" | "missing" | "unavailable";
  };
  history_view?: NativeHistoryView;
  /** Local reconciliation marker; never provider or canonical Context data. */
  history_gap?: boolean;
  inbox?: NativeInbox;
  restored_input?: { message_id: string; parts: NativePart[] };
  statistics?: NativeStatistics;
  compactions?: NativeCompaction[];
  session: NativeSession;
  messages: NativeMessage[];
  messages_truncated?: boolean;
  next_cursor?: number | null;
  permission: PolicySnapshot;
  operations: NativeOperation[];
  /** Retained invocation history; independent of current model-facing State. */
  executions?: NativeExecution[] | null;
  executions_omitted?: boolean;
  executions_truncated?: boolean;
  superseded_failure_operation_ids?: string[];
  history: unknown;
  history_available?: { undo: boolean; redo: boolean } | null;
  usage: unknown;
  state?: unknown;
  state_omitted?: boolean;
  client_tools?: unknown;
}
/** Closed wire vocabulary matching server manager/hub.rs SessionRuntimeEvent.
 * Payloads without a frontend DTO remain unknown, as the server owns their facts. */
export type SessionEventFrame =
  | { event: "session.meta"; data: Partial<NativeSnapshot> }
  | { event: "blocks.page"; data: import("./increments").BlocksEvent }
  | { event: "blocks.upsert"; data: import("./increments").BlocksEvent }
  | {
      event: "history.reset";
      data: { lineage?: string; epoch?: number; reason?: string };
    }
  | { event: "session"; data: NativeSession }
  | { event: "turn"; data: NativeOperation }
  | { event: "tool"; data: Record<string, unknown> }
  | { event: "model_observation"; data: NativeDisplayObservation }
  | { event: "display.batch"; data: NativeDisplayBatch }
  | { event: "display.settled"; data: NativeDisplayBatch }
  | {
      event: "display.fragment";
      data: {
        id: string;
        index: number;
        last: boolean;
        text: string;
        event: "display.batch" | "display.settled";
        history_lineage: string;
        child_session_id?: string | null;
      };
    }
  | { event: "display.unavailable"; data: unknown }
  | { event: "executions.updated"; data: { items: NativeExecution[] } }
  | { event: "statistics.updated"; data: NativeStatistics }
  | { event: "compaction"; data: CompactLifecycle }
  | { event: "permission.requested"; data: { request: PermissionRequest } }
  | { event: "permission.updated"; data: { request: PermissionRequest } }
  | {
      event: "permission.proposal.requested";
      data: { proposal: PermissionProposal };
    }
  | {
      event: "permission.proposal.settled";
      data: {
        proposal_id: string;
        status: "accepted" | "declined" | "expired" | "stale" | "failed";
        reason: string;
        remembered: boolean;
      };
    }
  | {
      event: "permission.settled";
      data: PermissionSettled;
    }
  | { event: "round_limit.requested"; data: { request: RoundLimitRequest } }
  | {
      event: "round_limit.settled";
      data: {
        request_id: string;
        parent_session_id?: string;
      };
    }
  | {
      event: "client_tool.requested";
      data: { call: import("./client-tool-controller").ClientInvocation };
    }
  | {
      event: "client_tool.prepared";
      data: { call: import("./client-tool-controller").ClientInvocation };
    }
  | {
      event: "client_tool.paused";
      data: { call: import("./client-tool-controller").ClientInvocation };
    }
  | {
      event: "client_tool.settled";
      data: { call: import("./client-tool-controller").ClientInvocation };
    }
  | {
      event: "client_tool.cancel_requested";
      data: { call: import("./client-tool-controller").ClientInvocation };
    }
  | { event: "audit.available"; data: unknown }
  | { event: "child.display.available"; data: unknown }
  | { event: "child.display.unavailable"; data: unknown }
  | { event: "host_detached"; data: { readiness?: NativeHostReadiness } }
  | { event: "host_connection"; data: unknown }
  | {
      event: "resync_required";
      data: {
        reason:
          | "slow_consumer"
          | "receipt_publication_failed"
          | "snapshot_failed"
          | "inbox_receipt_failed"
          | "inbox_snapshot_failed"
          | "naming_receipt_failed";
      };
    };

export type NativeEvent = SessionEventFrame & {
  v: 1;
  type: "event";
  subscription_id: string;
  generation: string;
  sequence: number;
  session_id: string;
};
export interface NativeSessionList {
  items: NativeSession[];
  unavailable: { id: string; reason: string }[];
  complete: boolean;
}
/** Owner-list notifications belong exclusively to the global socket. */
export type NativeOwnerEvent = {
  v: 1;
  type: "event";
  subscription_id: string;
  generation: string;
  sequence: number;
  session_id: string;
} & (
  | {
      event: "sessions.changed";
      data:
        | { op: "upsert"; session: NativeSession }
        | { op: "remove"; session_id: string; state?: string }
        | {
            op: "unavailable";
            session_id: string;
            error: {
              code: "session_configuration_unavailable";
              message: string;
            };
          };
    }
  | {
      event: "session.cleanup_failed";
      data: { session_id: string; stage: string; cause: unknown };
    }
  | { event: "resync_required"; data: { reason: string } }
);
export interface NativeSubscription {
  subscription_id: string;
  generation: string;
  sequence: number;
  snapshot: NativeSnapshot;
  pending?: {
    permissions?: PermissionRequests | null;
    round_limits?: RoundLimitRequests | null;
  } | null;
  resume?: { mode: "fresh" | "reset" };
}
export interface Capabilities {
  protocol: number;
  methods: string[];
  features: Record<string, unknown>;
  limits: Record<string, number>;
}
export interface NativeProject {
  id: string;
  name: string;
  root: string;
  host_id?: string;
  workspace_id?: string;
  host_connected?: boolean;
  status?: "online" | "offline" | string;
}
export interface AgentInfo {
  component?: string;
  name: string;
  modes: {
    name: string;
    description?: string;
    prompt?: string;
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}
export interface ModelChoice {
  id: string;
  name: string;
  providerId: string;
  /** Current catalog metadata; historical requests retain their own route evidence. */
  protocol?: ModelProtocol;
  contextWindowTokens?: number | null;
  variant?: string | null;
  variants: string[];
}
export interface DraftWorkspace {
  kind: ConversationHostFlavor | "local" | "remote" | "direct-remote";
  path?: string;
  host?: string;
  label?: string;
  endpoint?: any;
  projectId?: string;
}
export interface SessionWorkspace {
  root?: string;
  kind?: string;
  host?: string;
  port?: number;
  user?: string;
  [key: string]: any;
}
export interface SessionView {
  hostFlavor?: ConversationHostFlavor;
  kind?: "interactive" | "delegated" | "one_shot";
  id: string;
  title: string;
  parentID?: string | null;
  projectID: string | null;
  directory?: string | null;
  hostKind?: string;
  reachable?: boolean | null;
  status: string;
  agent?: string;
  model?: any;
  appliedModelSelection?: NativeModelSelection | null;
  turnModelSelection?: NativeModelSelection | null;
  pendingModelChange?: boolean;
  time?: { created?: number | null; updated?: number | null } | null;
  queueDepth?: number;
  lastActiveAt?: number;
  workspace?: SessionWorkspace;
  [key: string]: any;
}
export interface QueuedItem {
  inboxId?: string;
  revision?: number;
  claimed?: boolean;
  input?: { parts: NativePart[]; variables?: unknown };
  id: string;
  sessionID: string;
  prompt: string;
  displayPrompt?: string;
  mode: "queue" | "steer";
  parts: NativePart[];
  createdAt?: number;
  [key: string]: any;
}
export interface BoardState {
  [key: string]: any;
}
export interface PreviewIdentity {
  truncated?: boolean;
  key: string;
  operationId?: string;
  callId?: string;
  epoch?: number;
  turn?: number;
  round?: number;
  userMessageId: string;
  assistantOrdinal: number;
  canonicalMessageId?: string;
  toolIndex?: number;
}
export interface Block {
  submissionStatus?: "submitting" | "admitted" | "unknown";
  position?: HistoryPosition | null;
  preview?: PreviewIdentity;
  id: string;
  sessionId: string;
  messageId: string;
  partId: string;
  clientInvocationId?: string | null;
  callId?: string;
  role: string;
  kind: string;
  isCompact: boolean;
  tool: any;
  payload: {
    failure?: NativeWireError;
    text: string;
    mime: string;
    formatHint: string;
    attachments: any[];
    structured: any;
    content: any[];
    outputPaths: string[];
    providerMetadata: any;
    [key: string]: any;
  };
  stream: string;
  fold: string;
  startedMs?: number;
  endedMs?: number;
  [key: string]: any;
}
/** Durable scope is required; position may be absent while its history witness is in flight. */
export interface QuestionIdentity {
  id: string;
  sessionId: string;
  parentSessionId?: string;
  callId?: string;
  epoch?: number;
  turnId?: number | null;
  roundId?: number | null;
  createdAt?: number;
}
export interface PendingQuestion extends QuestionIdentity {
  questions: Question[];
  deadline: number;
  blockingMode: "blocking" | "deferred";
  paused: boolean;
  observer: boolean;
  awaitingConfirmation: boolean;
  /** Cleanup request revokes preview resources before the terminal receipt. */
  imageRevoked?: boolean;
  disabled: boolean;
}
export interface Transcript {
  /** Presentation revocation only; independent from transport/permission epochs. */
  historyResetRevision?: number;
  turnLifecycle?: {
    sessionId: string;
    operations: Record<string, "active" | "terminal">;
    activeOperationIds: string[];
    completionRevision: number;
  };
  displayGraph?: import("./display-graph").DisplayGraphState;
  displayReplay?: DisplayReplayState;
  displayCoverage?: "available" | "missing" | "unavailable";
  historyView?: NativeHistoryView;
  historyGap?: boolean;
  historyTruncated?: boolean;
  /** A stop was requested; the composer is input-ready while it settles. */
  interrupting?: boolean;
  blocks: Block[];
  sessionStatus: string | null;
  connected: boolean;
  pendingPermission: any;
  pendingQuestions: PendingQuestion[];
  agent: string | null;
  model: any;
  compactionActive: boolean;
  todos: any[];
  inboxPaused?: boolean;
  inboxActive?: boolean;
  queue: QueuedItem[];
  steer: QueuedItem[];
  usage: any;
  turnStartTime: number | null;
  turnFolds: Record<string, string>;
  roundFolds: Record<string, string>;
  roundAccordion: Record<string, number>;
  revertedForward: string[];
  revertBoundaryMessageId: string | null;
  revertDiffFiles: any[];
  revertedCount: number;
  messageShells: Record<string, any>;
  [key: string]: any;
}
export interface AppAction {
  type: string;
  [key: string]: any;
}
import type {
  HostReadiness as NativeHostReadiness,
  HostReadinessCause as NativeHostCause,
} from "./host";
export type {
  HostReadiness as NativeHostReadiness,
  HostReadinessCause as NativeHostCause,
  HostStateDetails as NativeHostStateDetails,
} from "./host";

export interface NativeHostState {
  connected: boolean;
  ready: boolean;
  reconciling?: boolean;
  readiness?: NativeHostReadiness;
  reconciliation_error?: NativeHostCause | null;
}

export interface AppState {
  statistics: NativeStatistics | null;
  roundLimitRequests?: RoundLimitRequestView[];
  childList?: NativeChildren | null;
  childListLoading?: boolean;
  childListError?: string | null;
  hostConnection?: {
    state: string;
    reason?: string;
    cause?: NativeHostCause | null;
    readiness?: NativeHostReadiness;
    projectId?: string;
    conversationId?: string;
    hostFlavor?: ConversationHostFlavor;
    endpoint?: string;
    transport?: "relay" | "grpc";
    effectiveTransport?: "relay" | "grpc" | "outbound";
    workspace?: string;
    connected?: boolean;
    catalogError?: string;
    catalogReady?: boolean;
    restoringSession?: boolean;
    recoverAddress?: boolean;
    operations?: {
      operation_id: string;
      payload_digest: string;
      state: unknown;
      reason?: { code: string; message: string };
      effects_may_have_occurred?: boolean;
    }[];
    debugError?: string;
  };
  authSession?: BrowserAuthSession | null;
  authRequired?: boolean;
  connection: string;
  page: string;
  pluginId?: string | null;
  pluginReturnPath?: string | null;
  pluginWorkspace?: { type: "view"; pluginId: string } | null;
  sessionId: string | null;
  sessionAttachingId?: string | null;
  sessions: SessionView[];
  filter: string;
  transcript: Transcript;
  composer: string;
  composerFocusRequest?: { sessionId: string; sequence: number };
  composerImages: ComposerImage[];
  retryOperationId?: string | null;
  inboxRetrieved?: Record<
    string,
    { operationId: string; input: NativeInbox["items"][number]["input"] }
  >;
  inboxMutations?: Record<
    string,
    {
      operationId: string;
      status: string;
      error?: string;
      expectedRevision: number;
    }
  >;
  inboxPending?: boolean;
  retryPending?: boolean;
  historyMutationPending?: boolean;
  imageIntakePending: boolean;
  modeSelectionPending: boolean;
  compactOperation:
    | (CompactLifecycle & {
        sessionId: string;
        instruction: string;
        outcomeUnknown?: boolean;
      })
    | null;
  toast: any;
  popup: any;
  menuSession: string | null;
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  locale: LocalePreference;
  resolvedLocale: ResolvedLocale;
  compactInflight: boolean;
  agentInitRetryRequired?: boolean;
  autoCompactionRetryAvailable?: boolean;
  sessionRecoveryPending?: boolean;
  sessionRecoveryUnknown?: boolean;
  railCollapsed: boolean;
  rightRailCollapsed: boolean;
  /** Narrow layout only: the Plugins rail is open as an overlay (not persisted). */
  rightOverlayOpen: boolean;
  rightRailWidth: number;
  conversationWidth: number;
  apiBase: string;
  sandboxSession: string | null;
  currentWorkspace: string;
  draftWorkspace: DraftWorkspace;
  /** Non-null only after an explicit composer choice. */
  draftModel: ModelChoice | null;
  userSessionDefaults: Pick<
    import("./settings").SettingsValues,
    "model_selection" | "agent" | "mode"
  > | null;
  projectSessionDefaults: {
    projectId: string;
    effective: import("./settings").SettingsValues;
  } | null;
  modelSelectionPending: boolean;
  availableModels: ModelChoice[];
  board: BoardState;
  showWorkspaceDropdown: boolean;
  menuProject: string | null;
  isCreatingSession: boolean;
  viewMode: "chat" | "trajectory";
  sessionPluginTab?: SessionPluginTab | null;
  showRunningToolsMenu: boolean;
  showSubagentsMenu: boolean;
  toastSeq: number;
  knownProjects: any[];
  conversationIds: string[];
  capabilities: Capabilities | null;
  agents: AgentInfo[];
  projects: NativeProject[];
  draftAgent: string;
  draftMode: string;
  policy: PolicySnapshot | null;
  history: unknown;
  historyAvailable?: { undo: boolean; redo: boolean } | null;
  forkPending?: string | null;
  forkUnknown?: Record<string, string>;
  forkTargets?: Record<string, string>;
  [key: string]: any;
}

export interface SessionPluginTab {
  sessionId: string;
  pluginId: string;
}
