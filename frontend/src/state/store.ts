import { ChildInputDocuments } from "../client/child-input-documents";
import { isDirectUserSource } from "../client/input-source";
import {
  requestDocumentLeave,
  retainDocumentDrafts,
  verifyRecoveredDraftOwner,
} from "../client/document-leave";
import { documentLeaveSelector } from "../client/document-leave-actions";
import type { ConversationHostFlavor } from "../client/types";
import { ClientPlugins, type PluginInput } from "./client-plugins";
import { retainPermissionDecisions } from "../client/permission-decisions";
import { userTaskInputAllowed } from "../client/session-kind";
import type { PermissionProposal } from "../client/types";
import type { NativeSessionList } from "../client/types";
import { diagnosticMessage, reportDiagnostic } from "../client/diagnostics";
import {
  historicalImages,
  restoredImages,
  uploadInputImages,
  uploadDraftImages,
  validateImageBatch,
  validateImageFile,
} from "./image-attachments";
import { createConversationRegistry } from "../client/conversation/registry";
import { publishTranscript } from "../client/conversation/assembler";
import { RoundLimitController } from "./round-limit";
import type { HostLifecycleTrigger } from "../client/api";
import { failureText } from "../client/failure";
import { traceEvent } from "../client/trace";
import {
  coherentHistoryRange,
  mergeHistoryPage,
  retainLoadedMessages,
  sameSelectedHistory,
  type HistoryPage,
} from "../client/loaded-messages";
import { inlineImage } from "../client/images";
import { draftParts, parseSlash, turnFitsBudget } from "./composer-draft";
import {
  inboxItemKey,
  inboxInputEditable,
  inboxMutationBusy,
  sessionInboxMutationBusy,
} from "./inbox-draft";
import { hostReadiness, hostStatePatch } from "./host-readiness";
import {
  prepareHostCandidate,
  preparedHostCandidate,
  quarantinedHost,
  quarantineHost,
  clearHostQuarantine,
  forgetProjectQuarantine,
  hostTerminalCode,
} from "../client/host-quarantine";
import { isNativeStatistics } from "../client/statistics";
import { t } from "../i18n";
import type {
  ComposerImage,
  CompactLifecycle,
  NativeExecutionContentPage,
} from "../client/types";
import {
  hostCarrier,
  hostPreferenceScope,
  hostLocator,
  rememberHost,
} from "../client/host-locators";

/** Visited sessions rendered from memory on return (v0.1.14 Q5). */
const SESSION_CACHE_LIMIT = 8;
const OPEN_RECEIPT = new Set(["unknown", "accepted", "running"]);
const LIVE_PHASES = new Set([
  "started",
  "text_delta",
  "reasoning_delta",
  "tool_call_delta",
]);
const FAILED_RECEIPT = new Set(["failed", "cancelled", "interrupted"]);

function sameImageIds(images: { id: string }[], ids: string[]) {
  return (
    images.length === ids.length &&
    images.every((image, index) => image.id === ids[index])
  );
}
import { DisplayFragments } from "../client/display-replay";
import { ApiClient, CommandError } from "../client/api";
import { materialize } from "../client/increments";

import {
  CLIENT_TOOL_DEFINITIONS,
  parseTodos,
  todosFromHistory,
  type ClientToolDefinition,
} from "../client/client-tools";
import {
  ClientToolController,
  type ClientBinding,
  type ClientCatalog,
} from "../client/client-tool-controller";
import {
  navigateLoginPage,
  rememberAuthReturn,
  takeAuthReturn,
  claimAutomaticLogin,
  clearAutomaticLogin,
} from "../client/auth";
import {
  applySnapshot,
  applyEvent,
  flushProjectedDisplay,
  projectRetryReceipt,
  createTranscript,
  createBlock,
  suspendPreviews,
  sessionView,
  subscriptionOrder,
} from "../client/projector";
import { SessionSocket } from "../client/socket/session";
import type {
  AppState,
  AppAction,
  NativeEvent,
  NativeOwnerEvent,
  NativeSession,
  NativeSnapshot,
  NativeDisplayBatch,
  NativeSubscription,
  NativeProject,
  NativeHostState,
  NativeHostReadiness,
  NativeHostCause,
  NativeOperation,
  Capabilities,
  AgentInfo,
  PolicySnapshot,
  NativeModelCatalog,
  NativeChildren,
  NativeChildDetail,
  PermissionRequest,
  PermissionRequests,
  Transcript,
  Block,
} from "../client/types";
import type { SettingsSnapshot } from "../client/settings";
import {
  initialState,
  effectiveDraftDefaults,
  parseLocation,
  sessionPath,
  selectedModel,
  modelChoices,
} from "./model";
import { savePreference } from "../client/storage";
import {
  applyTheme,
  normalizeThemePreference,
  watchSystemTheme,
} from "../client/theme";
import { normalizeLocalePreference, syncLocaleFromPreference } from "../i18n";

export class AppStore {
  state: AppState = initialState();
  readonly conversation = createConversationRegistry();
  readonly childInputs = new ChildInputDocuments();
  api = new ApiClient(this.state.apiBase);
  private expandedPluginReturn: {
    sessionId: string | null;
    path: string;
  } | null = null;
  readonly plugins = new ClientPlugins(
    () => this.api,
    (value, sessionId) => {
      if (sessionId === this.state.sessionId)
        this.update({ publicState: value, publicStateOmitted: false });
    },
    (message) => this.toast(message, "error"),
  );
  constructor() {
    publishTranscript(this.conversation, this.state.transcript);
    this.api.setSessionTransport(() => this.sessionSocket);
  }
  private defaultsRead = 0;
  private catalogRead = 0;
  private draftAgentExplicit = false;
  private draftModeExplicit = false;

  private applyDraftAgentDefaults() {
    if (this.state.sessionId || this.state.isCreatingSession) return;
    const defaults = effectiveDraftDefaults(this.state);
    if (
      !defaults ||
      !Object.hasOwn(defaults, "agent") ||
      !Object.hasOwn(defaults, "mode")
    ) {
      this.update({
        draftAgent: this.draftAgentExplicit ? this.state.draftAgent : "",
        draftMode: this.draftModeExplicit ? this.state.draftMode : "",
      });
      return;
    }
    const name = this.draftAgentExplicit
      ? this.state.draftAgent
      : defaults?.agent;
    const agent = name
      ? this.state.agents.find((item) => item.name === name)
      : this.state.agents[0];
    const modes =
      agent?.modes.filter((mode) => mode.role !== "sub_agent") ?? [];
    this.update({
      draftAgent: name ?? agent?.name ?? "",
      draftMode: this.draftModeExplicit
        ? this.state.draftMode
        : ((!this.draftAgentExplicit ? defaults?.mode : null) ??
          modes[0]?.name ??
          ""),
    });
  }

  private async refreshDraftDefaults() {
    const ticket = ++this.defaultsRead;
    const cycle = this.lifecycle;
    const api = this.api;
    const owner = this.state.authSession?.principal?.owner;
    const projectId = this.state.draftWorkspace.projectId;
    const current = () =>
      ticket === this.defaultsRead &&
      cycle === this.lifecycle &&
      api === this.api &&
      owner === this.state.authSession?.principal?.owner;
    const requests = [api.request<SettingsSnapshot>("settings.get")];
    if (projectId)
      requests.push(
        api.request<SettingsSnapshot>("project.settings.get", {
          project_id: projectId,
        }),
      );
    const results = await Promise.allSettled(requests);
    if (!current()) return;
    if (results[0].status === "fulfilled")
      this.update({ userSessionDefaults: results[0].value.effective });
    if (
      projectId &&
      projectId === this.state.draftWorkspace.projectId &&
      results[1]?.status === "fulfilled"
    )
      this.update({
        projectSessionDefaults: {
          projectId,
          effective: results[1].value.effective,
        },
      });
    this.applyDraftAgentDefaults();
    for (const result of results)
      if (result.status === "rejected") this.toast(String(result.reason));
  }

  private async refreshModelCatalog() {
    const ticket = ++this.catalogRead;
    const cycle = this.lifecycle;
    const api = this.api;
    const owner = this.state.authSession?.principal?.owner;
    const catalog = await api.request<NativeModelCatalog>("model.list");
    if (
      ticket !== this.catalogRead ||
      cycle !== this.lifecycle ||
      api !== this.api ||
      owner !== this.state.authSession?.principal?.owner
    )
      return;
    this.update({
      availableModels: modelChoices(catalog),
      modelMetadataStatus: catalog.metadata_status ?? null,
    });
  }

  private clientTools = new ClientToolController(
    this.api,
    () => this.projectClientTools(),
    (error) => this.toast(String(error)),
    (name, args, signal, invocation) =>
      this.plugins.execute(name, args, signal, invocation),
  );
  private roundLimits = new RoundLimitController(
    this.api,
    () => this.state,
    (patch) => this.update(patch),
    () =>
      this.clientTools.sessionId === this.state.sessionId &&
      this.clientTools.binding?.role === "executor"
        ? (this.clientTools.binding.lease_id ?? null)
        : null,
    async () => {},
    () => this.clientTools.sessionId === this.state.sessionId && this.clientTools.canInteract,
  );
  private projectClientTools() {
    const binding = this.clientTools.binding;
    const durableResults = new Map(
      (binding?.calls ?? [])
        .filter((call) => call.status === "completed")
        .map((call) => [call.invocation_id, call.result]),
    );
    let todos = todosFromHistory(this.state.transcript.blocks, durableResults);
    const selectedIds: string[] | undefined =
      this.state.selectedClientInvocationIds;
    if (selectedIds && binding && !binding.calls_truncated) {
      todos = [];
      const records = new Map(
        binding.calls.map((call) => [call.invocation_id, call]),
      );
      for (const id of selectedIds) {
        const call = records.get(id);
        if (call?.tool === "update_todo_list" && call.status === "completed")
          try {
            todos = parseTodos(call.result);
          } catch {
            /* Invalid historical results never replace a successful list. */
          }
      }
    }
    for (const block of this.state.transcript.blocks) {
      if (!block.temporary || block.tool?.name !== "update_todo_list") continue;
      const origin = block.preview;
      const call = binding?.calls.find(
        (call) =>
          call.session_id === this.state.sessionId &&
          call.call_id === block.callId &&
          call.epoch === origin?.epoch &&
          call.turn_id === origin?.turn &&
          call.round_id === origin?.round &&
          call.status === "completed",
      );
      if (call)
        try {
          todos = parseTodos(call.result);
        } catch {
          /* Missing results do not replace history. */
        }
    }
    this.update({
      clientTools: binding,
      permissionProposals: this.proposalProjection(),
      transcript: {
        ...this.state.transcript,
        pendingPermission: this.permissionProjection(),
        pendingQuestions: this.clientTools.questions,
        todos,
      },
    });
    this.roundLimits?.project();
  }
  private executionHistoryRead = 0;
  private executionHistoryRevision = 0;
  private async refreshExecutionHistory(sessionId: string) {
    const ticket = ++this.executionHistoryRead;
    const revision = this.executionHistoryRevision;
    const lifecycle = this.lifecycle;
    const subscription = this.subscription;
    const current = () =>
      ticket === this.executionHistoryRead &&
      lifecycle === this.lifecycle &&
      subscription === this.subscription &&
      this.state.sessionId === sessionId &&
      revision === this.executionHistoryRevision;
    const items: import("../client/types").NativeExecution[] = [];
    let cursor = 0;
    try {
      for (let page = 0; page < 64; page++) {
        const next = await this.api.request<{
          items: import("../client/types").NativeExecution[];
          next_cursor: number | null;
        }>("executions.list", { cursor, limit: 64 }, sessionId);
        if (!current()) return;
        items.push(...next.items);
        if (next.next_cursor === null) {
          if (subscription)
            subscription.snapshot = {
              ...subscription.snapshot,
              executions: items,
              executions_omitted: false,
            };
          this.update({
            executionHistory: items,
            executionHistoryTruncated: false,
          });
          return;
        }
        if (next.next_cursor <= cursor)
          throw Error("Execution history cursor did not advance");
        cursor = next.next_cursor;
      }
      if (current())
        this.update({
          executionHistory: items,
          executionHistoryTruncated: true,
        });
    } catch (failure) {
      if (current())
        this.toast(
          failure instanceof Error ? failure.message : String(failure),
        );
    }
  }
  private permissionParent: string | null = null;
  private permissionRequests = new Map<string, PermissionRequest>();
  private permissionSettled = new Set<string>();
  private permissionProposals = new Map<string, PermissionProposal>();
  private proposalSettled = new Set<string>();
  private proposalSubmitting = new Set<string>();
  private permissionSubmitting = new Set<string>();
  private permissionSync = 0;
  private childRead = 0;
  private childrenRead = 0;
  private permissionProjection() {
    const executor =
      this.state.connection === "ws" &&
      this.clientTools.canInteract &&
      this.clientTools.sessionId === this.state.sessionId;
    const requests = [...this.permissionRequests.values()].filter(
      (request) =>
        request.parent_session_id === this.state.sessionId &&
        !this.permissionSettled.has(request.request_id),
    );
    return requests.length
      ? {
          requests: requests.map((request) => ({
            ...request,
            observer: !executor,
            submitting: this.permissionSubmitting.has(request.request_id),
            disabled:
              !executor ||
              this.permissionSubmitting.has(request.request_id) ||
              request.expires_at_ms <= Date.now(),
          })),
        }
      : null;
  }
  private proposalProjection() {
    const executor =
      this.state.connection === "ws" &&
      this.clientTools.canInteract &&
      this.clientTools.sessionId === this.state.sessionId;
    return [...this.permissionProposals.values()]
      .filter(
        (proposal) =>
          proposal.parent_session_id === this.state.sessionId &&
          !this.proposalSettled.has(proposal.proposal_id),
      )
      .map((proposal) => ({
        ...proposal,
        observer: !executor,
        submitting: this.proposalSubmitting.has(proposal.proposal_id),
        disabled:
          !executor ||
          this.proposalSubmitting.has(proposal.proposal_id) ||
          proposal.expires_at_ms <= Date.now(),
      }));
  }
  private projectPermissions() {
    this.update({
      permissionProposals: this.proposalProjection(),
      transcript: {
        ...this.state.transcript,
        pendingPermission: this.permissionProjection(),
      },
    });
  }
  private resetPermissions(parent: string | null = null) {
    this.update({ permissionDecisions: [] });
    this.roundLimits.reset(parent);
    this.permissionParent = parent;
    this.permissionRequests.clear();
    this.permissionProposals.clear();
    this.proposalSettled.clear();
    this.proposalSubmitting.clear();
    this.permissionSettled.clear();
    this.permissionSubmitting.clear();
    this.permissionSync++;
  }
  /** Install the pending set delivered by the selected Session socket. An
   * argument-free call is the explicit RefreshPermissions control: reconnect
   * with its watermark and await the new subscribed pending set. */
  private refreshPermissions(
    snapshot?: PermissionRequests | null,
  ): Promise<void> {
    const parent = this.state.sessionId;
    if (!parent) return Promise.resolve();
    if (snapshot === undefined)
      return this.sessionSocket?.refresh().then(() => {}) ?? Promise.resolve();
    if (snapshot === null) {
      this.permissionRequests.clear();
      this.permissionProposals.clear();
      this.projectPermissions();
      return Promise.resolve();
    }
    if (this.state.connection !== "ws" || snapshot.parent_session_id !== parent)
      return Promise.resolve();
    this.permissionSync++;
    const decisions = retainPermissionDecisions(
      this.state.permissionDecisions ?? [],
      snapshot.decisions ?? [],
      parent,
    );
    this.update({ permissionDecisions: decisions });
    for (const decision of decisions)
      this.permissionSettled.add(decision.request_id);
    this.permissionRequests.clear();
    this.permissionProposals.clear();
    for (const result of snapshot.proposal_results ?? []) {
      if (result.status === "persisting" || result.status === "outcome_unknown")
        this.proposalSubmitting.add(result.proposal_id);
      else {
        this.proposalSettled.add(result.proposal_id);
        this.proposalSubmitting.delete(result.proposal_id);
      }
    }
    for (const proposal of snapshot.proposals ?? []) {
      if (
        proposal.parent_session_id === parent &&
        !this.proposalSettled.has(proposal.proposal_id)
      )
        this.permissionProposals.set(proposal.proposal_id, proposal);
    }
    // Settled tombstones fence a pending set captured before its live settlement.
    for (const request of snapshot.requests ?? []) {
      if (
        request.parent_session_id === parent &&
        !this.permissionSettled.has(request.request_id)
      )
        this.permissionRequests.set(request.request_id, request);
    }
    this.projectPermissions();
    return Promise.resolve();
  }
  private permissionEventVersion = 0;
  private async replyPermission(requestId: string, decision: string) {
    if (decision !== "allow" && decision !== "deny")
      throw Error(t("error.permission.onceOnly"));
    const parent = this.state.sessionId;
    const request = this.permissionRequests.get(requestId);
    const binding = this.clientTools.binding;
    if (
      !parent ||
      !request ||
      request.parent_session_id !== parent ||
      this.permissionSettled.has(requestId)
    )
      throw Error(t("error.permission.ended"));
    if (this.permissionSubmitting.has(requestId)) return;
    if (
      this.state.connection !== "ws" ||
      !this.clientTools.canInteract ||
      this.clientTools.sessionId !== parent
    )
      throw Error(t("error.permission.observer"));
    if (request.expires_at_ms <= Date.now())
      throw Error(t("error.permission.expired"));
    const lease = binding?.lease_id;
    const cycle = this.lifecycle;
    this.permissionSubmitting.add(requestId);
    this.projectPermissions();
    let outcomeUnknown = false;
    try {
      const result = await this.api.request<{
        request_id: string;
        decision: string;
        remembered: boolean;
      }>(
        "permission.reply",
        { request_id: requestId, ...(lease ? { lease_id: lease } : {}), decision },
        parent,
      );
      if (
        result.request_id !== requestId ||
        !["allow", "deny"].includes(result.decision) ||
        result.remembered !== false
      )
        throw new CommandError(
          "invalid_result",
          t("error.permission.unconfirmed"),
          false,
          true,
        );
      // Keep the request disabled until authoritative settlement/snapshot arrives.
      if (cycle === this.lifecycle && parent === this.state.sessionId) {
        this.permissionSettled.add(requestId);
        this.permissionRequests.delete(requestId);
        this.projectPermissions();
      }
    } catch (error) {
      outcomeUnknown = error instanceof CommandError && error.outcomeUnknown;
      if (outcomeUnknown) {
        const receipt = await this.api.request<{ request_id: string; decision: string; remembered: boolean }>(
          "client_tools.decision", { kind: "permission", request_id: requestId }, parent).catch(() => null);
        if (cycle === this.lifecycle && parent === this.state.sessionId && receipt?.request_id === requestId &&
            ["allow", "deny"].includes(receipt.decision) && receipt.remembered === false) {
          outcomeUnknown = false;
          this.permissionSettled.add(requestId);
          this.permissionRequests.delete(requestId);
          this.projectPermissions();
          return;
        }
      }
      if (cycle === this.lifecycle && parent === this.state.sessionId) {
        // No auto resend: refresh current authority after conflict/timeout/disconnect.
        this.projectPermissions();
      }
      throw error;
    } finally {
      if (!outcomeUnknown) this.permissionSubmitting.delete(requestId);
      if (cycle === this.lifecycle && parent === this.state.sessionId)
        this.projectPermissions();
    }
  }
  private async replyProposal(proposalId: string, accept: boolean) {
    const parent = this.state.sessionId;
    const proposal = this.permissionProposals.get(proposalId);
    const binding = this.clientTools.binding;
    if (
      !parent ||
      !proposal ||
      proposal.parent_session_id !== parent ||
      this.proposalSettled.has(proposalId)
    )
      throw Error(t("error.permission.ended"));
    if (this.proposalSubmitting.has(proposalId)) return;
    if (
      this.state.connection !== "ws" ||
      !this.clientTools.canInteract ||
      this.clientTools.sessionId !== parent
    )
      throw Error(t("error.permission.observer"));
    if (proposal.expires_at_ms <= Date.now()) {
      this.permissionProposals.delete(proposalId);
      this.projectPermissions();
      return;
    }
    const cycle = this.lifecycle;
    this.proposalSubmitting.add(proposalId);
    this.projectPermissions();
    let unknown = false;
    try {
      const result = await this.api.request<
        import("../client/types").PermissionProposalResult
      >(
        "permission.proposal.reply",
        { proposal_id: proposalId, ...(binding?.lease_id ? { lease_id: binding.lease_id } : {}), accept },
        parent,
      );
      if (cycle === this.lifecycle && parent === this.state.sessionId) {
        if (result.status === "persisting" || result.status === "outcome_unknown") unknown = true;
        else {
          this.proposalSettled.add(proposalId);
          this.permissionProposals.delete(proposalId);
        }
      }
    } catch (error) {
      unknown = error instanceof CommandError && error.outcomeUnknown;
      if (unknown) {
        const receipt = await this.api.request<import("../client/types").PermissionProposalResult>(
          "client_tools.decision", { kind: "permission_proposal", request_id: proposalId }, parent).catch(() => null);
        if (cycle === this.lifecycle && parent === this.state.sessionId && receipt?.proposal_id === proposalId &&
            ["accepted", "declined", "expired", "stale", "failed"].includes(receipt.status)) {
          unknown = false;
          this.proposalSettled.add(proposalId);
          this.permissionProposals.delete(proposalId);
          return;
        }
      }
      throw error;
    } finally {
      if (!unknown) this.proposalSubmitting.delete(proposalId);
      if (cycle === this.lifecycle && parent === this.state.sessionId)
        this.projectPermissions();
    }
  }
  submitSecret(requestId: string, values: Record<string, string>) {
    return this.clientTools.submitSecret(requestId, values);
  }
  declineSecret(requestId: string) {
    return this.clientTools.declineSecret(requestId);
  }
  observeSecret(requestId: string) {
    return this.clientTools.observeSecret(requestId);
  }
  private toolDefinitions(): ClientToolDefinition[] {
    return [...CLIENT_TOOL_DEFINITIONS];
  }
  private listeners = new Set<() => void>();
  private subscription: NativeSubscription | null = null;
  /**
   * Owner-level `sessions.watch`. While the initial list loads, increments are
   * buffered (`buffer`) and applied on top of it in order.
   */
  private sessionWatch: {
    id: string;
    generation: string;
    sequence: number;
    buffer: NativeOwnerEvent[] | null;
  } | null = null;
  /** List events that raced ahead of their watch result (bounded). */
  private earlyListEvents: NativeOwnerEvent[] = [];
  private sessionWatchTicket = 0;
  /** The committed Session socket. A replacement is installed only after its
   * barrier snapshot arrives, and the previous socket is closed after that. */
  private sessionSocket: SessionSocket | null = null;
  private deferredSessionRecovery: SessionSocket | null = null;
  /** Closes the committed Session socket. Closing releases its subscription and
   * every executor lease it bound, so a caller that still needs the executor
   * rebinds on the replacement socket afterwards. */
  private stopSessionSocket() {
    if (this.receiveTimer !== null) clearTimeout(this.receiveTimer);
    this.receiveTimer = null;
    this.receiveQueue = [];
    this.receiveQueueBytes = 0;
    this.pendingDisplayProjection = null;
    this.displayFragments = new DisplayFragments();
    const socket = this.sessionSocket;
    this.sessionSocket = null;
    this.deferredSessionRecovery = null;
    socket?.stop();
  }
  private lifecycle = 0;
  private attaching = 0;
  // Same-session subscription resyncs do not invalidate draft operations.
  private composerRoute = 0;
  private hostAttempt = 0;
  private hostRefresh = 0;
  private hostStateRevision = 0;
  private hostAttachment: { attempt: number; projectId: string } | null = null;
  private started = false;
  private bootstrapping = 0;
  private uncertainCreation = false;
  private unwatchTheme: () => void = () => {};
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  /** A requested stop: the live blocks were finished locally, later deltas
   * of the stopped operations are dropped, and the composer is input-ready
   * until the runtime reports the turn settled. */
  private interruptFence: {
    sessionId: string;
    operations: Set<string>;
    stopped: Block[];
    any: boolean;
    settled: Promise<void>;
    release: () => void;
  } | null = null;
  update(value: Partial<AppState>) {
    const previous = this.state;
    this.state = { ...previous, ...value };
    if (
      previous.sessionId !== this.state.sessionId ||
      previous.authSession?.principal?.owner !==
        this.state.authSession?.principal?.owner
    )
      this.state.sessionPluginTab = null;
    this.plugins.sync(this.state);
    if (Object.hasOwn(value, "transcript"))
      publishTranscript(this.conversation, this.state.transcript);
    for (const listener of this.listeners) listener();
  }
  toast(text: string, kind = "warn") {
    this.update({ toast: { text, kind, generation: ++this.state.toastSeq } });
  }
  supports(method: string) {
    return this.state.capabilities?.methods.includes(method) === true;
  }
  private async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId = this.state.sessionId ?? undefined,
    interactionId?: string,
  ): Promise<T> {
    // TODO(native-capabilities): wire missing operations without removing their UI.
    if (!this.supports(method))
      throw new CommandError(
        "unsupported",
        t("error.unsupported", { name: method, todo: method }),
      );
    const attempt = this.hostAttempt;
    const cycle = this.lifecycle;
    const projectId =
      typeof params.project_id === "string"
        ? params.project_id
        : this.state.sessions.find((session) => session.id === sessionId)
            ?.projectID;
    try {
      return await this.api.request<T>(
        method,
        params,
        sessionId,
        undefined,
        interactionId,
      );
    } catch (error) {
      if (error instanceof CommandError && error.code === "host_detached") {
        if (attempt === this.hostAttempt && cycle === this.lifecycle) {
          const readiness = error.details?.readiness as
            NativeHostReadiness | undefined;
          this.suspendHost(
            projectId ?? undefined,
            { code: error.code, message: error.message },
            readiness,
            true,
          );
          if (!readiness && this.state.hostConnection?.projectId === projectId)
            void this.refreshHost();
        }
      }
      throw error;
    }
  }
  private rememberHostTerminal(projectId: string, code: unknown, reason?: unknown) {
    if (!hostTerminalCode(code)) return;
    const project = this.state.projects.find((item) => item.id === projectId);
    const connection = this.state.hostConnection;
    if (!project || connection?.projectId !== projectId) return;
    const candidate = preparedHostCandidate(
      this.hostScope(), projectId,
      connection.endpoint || hostLocator(this.hostScope(), project),
      project.root || ".",
    );
    if (candidate) quarantineHost(candidate, code, reason);
  }
  /** Execution fences retain a live relay; only known transport loss retires its attempt. */
  private suspendHost(
    projectId?: string,
    cause?: NativeHostCause,
    readiness?: NativeHostReadiness,
    preserveTransport = false,
  ) {
    if (!projectId) return;
    const connection = this.state.hostConnection;
    const matched = connection?.projectId === projectId;
    if (
      matched &&
      readiness &&
      connection.readiness &&
      readiness.connection_generation !==
        connection.readiness.connection_generation
    )
      return;
    const connected =
      readiness?.connected ??
      (preserveTransport && matched && connection.connected === true);
    if (matched) {
      const terminalCause = readiness?.cause ?? cause;
      this.rememberHostTerminal(projectId, terminalCause?.code);
      ++this.hostStateRevision;
      if (!connected) this.hostAttempt++;
    }
    this.update({
      ...(matched
        ? {
            agents: [],
            hostConnection: {
              ...connection,
              ...(readiness
                ? hostStatePatch({
                    readiness,
                    connected: readiness.connected,
                    ready: readiness.ready,
                  })
                : {
                    state: connected ? "unready" : "suspended",
                    connected,
                    readiness: undefined,
                    cause: cause ?? connection.cause,
                    reason: cause?.code ?? "host_detached",
                  }),
              catalogReady: false,
              catalogError: undefined,
            },
          }
        : {}),
      projects: this.state.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              host_connected: connected,
              status: connected ? "online" : "offline",
            }
          : project,
      ),
      knownProjects: this.state.knownProjects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              host_connected: connected,
              status: connected ? "online" : "offline",
            }
          : project,
      ),
    });
  }
  private returnedComposer: string | null = null;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private authCheck: Promise<void> | null = null;
  private scheduleAuthCheck() {
    clearTimeout(this.authTimer);
    const expires = this.state.authSession?.principal?.expires_at;
    if (!this.state.authSession?.authenticated || !Number.isFinite(expires))
      return;
    // Browsers clamp long timers to a signed 32-bit delay. Recheck the current
    // cookie at the deadline; another tab may have explicitly signed in again.
    const remaining = expires! * 1000 - Date.now();
    this.authTimer = setTimeout(
      () => void this.checkAuth(),
      Math.min(2147483647, remaining > 0 ? remaining : 30000),
    );
  }
  private requireAuth(verifiedOwner?: string) {
    const owner = this.state.authSession?.principal?.owner;
    const changedOwner = verifiedOwner !== undefined && verifiedOwner !== owner;
    if (changedOwner) {
      // A verified identity switch is not an expired same-owner session. Never
      // retain old-owner editor text or invoke its discarded leave continuation.
      verifyRecoveredDraftOwner(verifiedOwner);
      takeAuthReturn(verifiedOwner);
    }
    if (this.state.authRequired) return;
    if (owner && !changedOwner) {
      rememberAuthReturn(
        owner,
        location.pathname + location.hash,
        this.state.composer,
      );
      retainDocumentDrafts(owner, () => this.navigateAfterAuthReceipts(cycle));
    }
    clearTimeout(this.authTimer);
    this.lifecycle++;
    this.bootstrapping++;
    this.attaching++;
    this.childRead++;
    this.childrenRead++;
    this.hostAttempt++;
    this.subscription = null;
    this.stopSessionSocket();
    this.browserPrepared = null;
    this.api.clearHostCredentials();
    this.api.stop();
    this.clientTools.reset();
    this.resetPermissions();
    // Expiry suspends authority, not the user's selected view or unsent input.
    this.update({
      authSession: { authenticated: false },
      authRequired: true,
      connection: "disconnected",
      sessionAttachingId: null,
      hostConnection: {
        ...this.state.hostConnection,
        state: "detached",
        connected: false,
        catalogReady: false,
      },
    });
    const cycle = this.lifecycle;
    this.navigateAfterAuthReceipts(cycle);
  }
  private navigateAfterAuthReceipts(cycle: number) {
    void this.api.finishAuthReceipts().then(() => {
      if (this.started && cycle === this.lifecycle && this.state.authRequired)
        navigateLoginPage(this.api.base, location.search);
    });
  }
  private checkAuth = (): Promise<void> => {
    if (!this.started || !this.state.authSession?.authenticated)
      return Promise.resolve();
    if (this.authCheck) return this.authCheck;
    const cycle = this.lifecycle;
    const owner = this.state.authSession.principal?.owner;
    const check = this.api
      .browserSession()
      .then((value) => {
        if (!this.started || cycle !== this.lifecycle) return;
        if (!value.authenticated || value.principal?.owner !== owner) {
          this.requireAuth(
            value.authenticated ? value.principal?.owner : undefined,
          );
          return;
        }
        this.update({ authSession: value });
        this.scheduleAuthCheck();
      })
      .catch(() => {
        if (!this.started || cycle !== this.lifecycle) return;
        this.authTimer = setTimeout(() => void this.checkAuth(), 30000);
      })
      .finally(() => {
        if (this.authCheck === check) this.authCheck = null;
      });
    this.authCheck = check;
    return check;
  };
  private foregroundAuth = () => {
    if (document.visibilityState !== "hidden") void this.checkAuth();
  };
  start() {
    if (this.started) return;
    this.started = true;
    this.applyTheme(this.state.theme);
    const resolvedLocale = syncLocaleFromPreference(this.state.locale);
    if (resolvedLocale !== this.state.resolvedLocale) {
      this.state = { ...this.state, resolvedLocale };
    }
    this.unwatchTheme = watchSystemTheme(() => {
      if (this.state.theme === "system") this.applyTheme("system");
    });
    window.addEventListener("hashchange", this.route);
    window.addEventListener("focus", this.foregroundAuth);
    document.addEventListener("visibilitychange", this.foregroundAuth);
    window.addEventListener("pageshow", this.authPageShow);
    void this.connect();
  }
  stop() {
    this.clearSessionMemory();
    this.clearComposer();
    this.plugins.dispose();
    this.clientTools.reset();
    this.started = false;
    this.lifecycle++;
    this.attaching++;
    this.stopSessionSocket();
    this.api.stop();
    this.unwatchTheme();
    window.removeEventListener("hashchange", this.route);
    window.removeEventListener("focus", this.foregroundAuth);
    document.removeEventListener("visibilitychange", this.foregroundAuth);
    clearTimeout(this.authTimer);
    window.removeEventListener("pageshow", this.authPageShow);
  }
  private closeMenus() {
    const s = this.state;
    if (
      s.menuSession ||
      s.menuProject ||
      s.showWorkspaceDropdown ||
      s.showRunningToolsMenu ||
      s.showSubagentsMenu
    )
      this.update({
        menuSession: null,
        menuProject: null,
        showWorkspaceDropdown: false,
        showRunningToolsMenu: false,
        showSubagentsMenu: false,
      });
  }
  /** Resolve and publish the theme; only the preference is persisted. */
  private applyTheme(preference: AppState["theme"]) {
    const resolvedTheme = applyTheme(preference);
    if (
      preference !== this.state.theme ||
      resolvedTheme !== this.state.resolvedTheme
    )
      this.update({ theme: preference, resolvedTheme });
  }
  private route = (event?: HashChangeEvent) => {
    const destination = parseLocation(location.pathname, location.hash);
    const changesView =
      destination.page !== this.state.page ||
      (destination.sessionId &&
        destination.sessionId !== this.state.sessionId) ||
      (destination.pluginId ?? null) !== this.state.pluginId;
    if (event?.oldURL && changesView) {
      const target = location.href;
      const previous = event.oldURL;
      const cycle = this.lifecycle;
      const owner = this.state.authSession?.principal?.owner;
      const session = this.state.sessionId;
      let synchronous = true;
      let allowed = false;
      requestDocumentLeave(() => {
        if (
          cycle !== this.lifecycle ||
          owner !== this.state.authSession?.principal?.owner ||
          session !== this.state.sessionId
        )
          return;
        if (synchronous) allowed = true;
        else {
          history.replaceState(null, "", target);
          this.route();
        }
      });
      synchronous = false;
      if (!allowed) {
        history.replaceState(null, "", previous);
        return;
      }
    }
    // A route change (Back, Forward, a typed hash) leaves every app menu and
    // its click-outside backdrop behind, so close them before anything else.
    this.closeMenus();
    const route = parseLocation(location.pathname, location.hash);
    if (route.page === "plugins" || route.page === "plugin") {
      const target = location.hash;
      const show = () => {
        if (location.hash === target)
          this.update({
            page: route.page,
            pluginId: route.pluginId ?? null,
            rightOverlayOpen: false,
          });
      };
      if (
        route.sessionId &&
        route.sessionId !== this.state.sessionId &&
        this.state.connection === "ws"
      )
        void this.attach(route.sessionId, false)
          .then(show)
          .catch((error) => this.toast(String(error)));
      else show();
      return;
    }
    if (
      route.sessionId &&
      route.sessionId === this.state.sessionId &&
      this.subscription
    ) {
      this.update({ page: "conversation", pluginId: null });
      return;
    }
    if (route.sessionId && this.state.connection === "ws")
      void this.attach(route.sessionId).catch((e) => this.toast(String(e)));
    else if (route.page === "dashboard") this.update({ page: "dashboard" });
    else if (route.page === "home")
      this.update({
        page: "home",
        pluginId: null,
        pluginWorkspace: null,
        rightOverlayOpen: false,
      });
  };
  private authPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      if (this.state.authRequired)
        navigateLoginPage(this.api.base, location.search);
      else void this.checkAuth();
    }
  };
  private async connect() {
    if (this.state.authRequired) return;
    const cycle = ++this.lifecycle;
    this.resetPermissions();
    this.childRead++;
    this.childrenRead++;
    this.update({
      childList: null,
      sessionAttachingId: null,
      childListError: null,
      childListLoading: false,
      modelMetadataPending: false,
      modelMetadataError: null,
      popup: { type: "none" },
    });
    this.stopSessionSocket();
    this.api.stop();
    this.subscription = null;
    suspendPreviews(this.state.transcript);
    this.update({
      connection: "connecting",
      transcript: { ...this.state.transcript },
    });
    try {
      const auth = await this.api.browserSession();
      if (cycle !== this.lifecycle || !this.started) return;
      const ownerScope =
        auth.authenticated && auth.principal?.owner
          ? JSON.stringify([this.api.base, auth.principal.owner])
          : null;
      if (ownerScope && this.memoryScope !== ownerScope) {
        const changedOwner = this.memoryScope !== null;
        this.clearSessionMemory();
        if (changedOwner) {
          this.draftAgentExplicit = false;
          this.draftModeExplicit = false;
          this.clearComposer();
          this.update({
            draftModel: null,
            userSessionDefaults: null,
            projectSessionDefaults: null,
            draftAgent: "",
            draftMode: "",
            sessionId: null,
            transcript: createTranscript(),
            sessions: [],
            statistics: null,
            publicState: null,
            executionHistory: [],
            executionHistorySessionId: null,
            executionHistoryTruncated: false,
            policy: null,
            history: null,
          });
        }
        this.memoryScope = ownerScope;
      }
      if (!auth.authenticated) {
        this.requireAuth();
        return;
      }
      this.update({ authSession: auth, authRequired: false });
      if (auth.principal) {
        verifyRecoveredDraftOwner(auth.principal.owner);
        const returned = takeAuthReturn(auth.principal.owner);
        if (returned) {
          history.replaceState(null, "", returned.route);
          this.returnedComposer = returned.composer;
        }
      }
      this.scheduleAuthCheck();
      clearAutomaticLogin(this.api.base);
      this.api.connect({
        event: (event) => {
          if (cycle === this.lifecycle) this.receiveSessionList(event);
        },
        authRequired: () => {
          if (cycle === this.lifecycle) this.requireAuth();
        },
        open: () => {
          if (cycle === this.lifecycle)
            void this.bootstrap(cycle).catch((e) => this.toast(String(e)));
        },
        close: () => {
          if (cycle !== this.lifecycle) return;
          this.stopSessionSocket();
          this.subscription = null;
          this.sessionWatch = null;
          this.earlyListEvents = [];
          this.sessionWatchTicket++;
          this.browserPrepared = null;
          if (this.state.hostConnection?.conversationId) this.hostAttempt++;
          this.resetPermissions();
          this.childRead++;
          this.childrenRead++;
          this.clientTools.reset();
          this.bootstrapping++;
          this.attaching++;
          suspendPreviews(this.state.transcript);
          traceEvent("connection.closed", {
            outcome: "cancelled",
            sessionId: this.state.sessionId ?? undefined,
          });
          this.update({
            connection: "disconnected",
            sessionAttachingId: null,
            transcript: { ...this.state.transcript },
          });
          void this.checkAuth();
        },
        error: (error) => {
          if (cycle === this.lifecycle) this.toast(error.message);
        },
      });
    } catch (error) {
      if (cycle === this.lifecycle) {
        this.update({ connection: "disconnected" });
        if (!this.state.authSession?.authenticated)
          navigateLoginPage(this.api.base, location.search);
        else this.toast(String(error));
      }
    }
  }
  private async bootstrap(cycle: number) {
    const ticket = ++this.bootstrapping;
    const navigation = this.attaching;
    const current = () =>
      cycle === this.lifecycle && ticket === this.bootstrapping;
    let capabilities: Capabilities;
    try {
      capabilities = await this.api.request<Capabilities>(
        "server.capabilities",
      );
    } catch (error) {
      if (current()) {
        this.update({ connection: "disconnected", sessionAttachingId: null });
        traceEvent("bootstrap.capabilities", {
          outcome: "failed",
          code: error instanceof CommandError ? error.code : "client_error",
        });
      }
      throw error;
    }
    if (!current()) return;
    this.api.configureLimits(capabilities.limits);
    this.update({ capabilities, connection: "ws" });
    const interactionId = crypto.randomUUID();
    const route = parseLocation(location.pathname, location.hash);
    traceEvent("bootstrap", { interactionId, outcome: "started" });
    let initialAttach: Promise<void> | undefined;
    const results = await Promise.allSettled([
      this.call<{ items: NativeProject[] }>(
        "project.list",
        {},
        undefined,
        interactionId,
      ),
      this.call<NativeModelCatalog>("model.list", {}, undefined, interactionId),
      // Watch first: every change after the watch is registered is either in
      // the list below or delivered as an increment on top of it.
      this.watchSessions(current)
        .then(() =>
          this.call<NativeSessionList>(
            "session.list",
            {},
            undefined,
            interactionId,
          ),
        )
        .then((value) => {
          if (current()) {
            this.update({
              sessions: value.items.filter((s) => !s.archived).map(sessionView),
            });
            this.reportUnavailableSessions(value.unavailable);
            this.flushSessionWatch();
            traceEvent("sessions.published", {
              interactionId,
              outcome: "succeeded",
              count: value.items.length,
            });
            const id = this.state.sessionId ?? route.sessionId;
            if (
              id &&
              this.attaching === navigation &&
              value.items.some((s) => s.id === id)
            )
              initialAttach = this.attach(id).catch((error) =>
                this.toast(String(error)),
              );
          }
          return value;
        }),
    ]);
    if (!current()) return;
    for (const result of results) {
      if (result.status === "rejected") this.toast(String(result.reason));
    }
    const projects =
      results[0].status === "fulfilled"
        ? results[0].value
        : { items: this.state.projects };
    // Quarantine is a browser-local hint; prepare exact candidate witnesses for
    // project presentation without persisting locators or credentials.
    const hostScope = this.hostScope();
    if (hostScope)
      await Promise.all(projects.items.map(async (project) => {
        const endpoint = hostLocator(hostScope, project);
        if (endpoint)
          await prepareHostCandidate(hostScope, project.id, endpoint, project.root || ".");
      }));
    if (!current()) return;
    const models =
      results[1].status === "fulfilled"
        ? results[1].value
        : ({ items: [] } as NativeModelCatalog);
    const sessions =
      results[2].status === "fulfilled" ? results[2].value : null;
    traceEvent("bootstrap.catalogs", {
      interactionId,
      outcome: results.every((r) => r.status === "fulfilled")
        ? "succeeded"
        : "failed",
      count: results.filter((r) => r.status === "fulfilled").length,
    });
    const agents = { items: [] as AgentInfo[] };
    const activeId = this.state.sessionId ?? route.sessionId;
    let savedProject: string | null = null;
    try {
      savedProject = localStorage.getItem(
        "microcrab.host-project.v2:" +
          hostPreferenceScope(this.api.base, this.state.authSession),
      );
    } catch {}
    const requestedProject =
      sessions?.items.find((session) => session.id === activeId)?.project_id ??
      this.state.sessions.find((session) => session.id === activeId)
        ?.projectID ??
      savedProject ??
      this.state.draftWorkspace.projectId;
    const activeRecord = sessions?.items.find(
      (session) => session.id === activeId,
    );
    const browserSelected =
      activeRecord?.project_id === null ||
      this.state.sessions.find((session) => session.id === activeId)
        ?.projectID === null ||
      (!activeId && (savedProject === "" || this.draftConversationId !== null));
    // Catalog order is not a workspace choice. Only a pinned Session or an
    // explicitly remembered/draft Project may select the native Host path.
    const chosen = browserSelected
      ? undefined
      : projects.items.find((project) => project.id === requestedProject);
    const availableModels =
      results[1].status === "fulfilled"
        ? modelChoices(models)
        : this.state.availableModels;
    const host = this.state.hostConnection;
    const catalogCurrent =
      !!host &&
      chosen?.id === host.projectId &&
      host.connected &&
      host.state === "ready" &&
      host.catalogReady === true &&
      this.state.agents.length > 0 &&
      this.state.agents.every(
        (item) => typeof item.component === "string" && !!item.component,
      );
    this.update({
      projects: projects.items,
      knownProjects: projects.items.map((p) => ({ ...p, path: p.root })),
      availableModels,
      modelMetadataStatus:
        results[1].status === "fulfilled"
          ? (models.metadata_status ?? null)
          : this.state.modelMetadataStatus,
      userSessionDefaults:
        results[1].status === "fulfilled"
          ? {
              ...this.state.userSessionDefaults,
              model_selection: models.default_model_selection ?? null,
            }
          : this.state.userSessionDefaults,
      agents: catalogCurrent ? this.state.agents : agents.items,
      sessions: sessions
        ? sessions.items.filter((s) => !s.archived).map(sessionView)
        : this.state.sessions,
      draftAgent: this.state.draftAgent || agents.items[0]?.name || "",
      draftWorkspace: chosen
        ? {
            kind: "local",
            projectId: chosen.id,
            path: chosen.root,
            label: chosen.name,
          }
        : { kind: this.savedDraftFlavor() },
    });
    await this.refreshDraftDefaults();
    if (!current()) return;
    if (route.page === "dashboard") this.update({ page: "dashboard" });
    const id = this.state.sessionId ?? route.sessionId;
    if (initialAttach) await initialAttach;
    else if (id && this.attaching === navigation) {
      if (!sessions || sessions.items.some((session) => session.id === id))
        await this.attach(id).catch((error) => this.toast(String(error)));
      else this.newChat();
    }
    if (!current()) return;
    const currentRoute = parseLocation(location.pathname, location.hash);
    if (
      (currentRoute.page === "plugins" || currentRoute.page === "plugin") &&
      (!currentRoute.sessionId ||
        currentRoute.sessionId === this.state.sessionId)
    )
      this.update({
        page: currentRoute.page,
        pluginId: currentRoute.pluginId ?? null,
      });
    if (this.returnedComposer !== null) {
      this.update({ composer: this.returnedComposer });
      this.returnedComposer = null;
    }
    if (chosen && !this.hostReadyFor(chosen.id))
      await this.resumeProject(chosen.id, "resume_project:bootstrap");
    else if (chosen && !catalogCurrent) await this.loadHostCatalog(chosen.id);
    else if (!chosen && !id) {
      this.draftConversationId ??= crypto.randomUUID();
      await this.connectBrowserConversation(
        this.draftConversationId,
        true,
      ).catch((error) => this.toast(String(error)));
    }
  }
  private savedDraftFlavor(): ConversationHostFlavor {
    try {
      const saved = localStorage.getItem(
        "microcrab.conversation-flavor.v1:" + this.hostScope(),
      );
      return saved === "browser_sandbox" ? "browser_sandbox" : "chat_only";
    } catch {
      return "chat_only";
    }
  }
  private draftFlavor(): ConversationHostFlavor | undefined {
    const kind = this.state.draftWorkspace.kind;
    return kind === "chat_only" || kind === "browser_sandbox"
      ? kind
      : undefined;
  }
  private hostScope() {
    return hostPreferenceScope(this.api.base, this.state.authSession);
  }
  private hostReadyFor(projectId: string) {
    const host = this.state.hostConnection;
    // Locator schemes describe preference; only the negotiated, project-scoped
    // carrier decides whether readiness depends on this browser's relay socket.
    const transport =
      (this.api.currentHostProject() === projectId
        ? this.api.currentHostTransport()
        : null) ??
      host?.effectiveTransport ??
      host?.transport;
    return (
      host?.projectId === projectId &&
      host.state === "ready" &&
      host.connected === true &&
      (transport !== "relay" || this.api.hasOpenRelayFor(projectId))
    );
  }
  private async resumeProject(
    projectId: string,
    trigger: HostLifecycleTrigger,
    restoreSession = true,
  ) {
    if (this.hostReadyFor(projectId)) {
      if (!this.state.agents.length) await this.loadHostCatalog(projectId);
      return;
    }
    const attempt = ++this.hostAttempt;
    const cycle = this.lifecycle;
    if (
      attempt !== this.hostAttempt ||
      cycle !== this.lifecycle ||
      !this.state.authSession?.authenticated
    )
      return;
    const project = this.state.projects.find((p) => p.id === projectId);
    const endpoint = hostLocator(this.hostScope(), project);
    if (!endpoint) {
      await this.api.releaseHostObservation(trigger);
      if (attempt !== this.hostAttempt || cycle !== this.lifecycle) return;
    }
    this.update({
      agents: [],
      hostConnection: {
        state: "detached",
        projectId,
        endpoint,
        recoverAddress: !endpoint,
      },
    });
    if (endpoint) {
      try {
        await this.connectHost(
          projectId,
          endpoint,
          undefined,
          false,
          undefined,
          trigger,
          restoreSession,
          true,
        );
      } catch {
        /* Fresh pairing/address recovery is explicit; effects are never replayed. */
      }
    }
  }
  private draftConversationId: string | null = null;
  private draftConversationOwner: string | null = null;
  private browserPreparation: {
    id: string;
    flavor: ConversationHostFlavor;
    attempt: number;
    cycle: number;
    owner?: string;
    promise: Promise<void>;
  } | null = null;
  private browserPrepared: {
    id: string;
    flavor: ConversationHostFlavor;
    cycle: number;
    owner: string;
  } | null = null;
  private connectBrowserConversation(id: string, draft = false): Promise<void> {
    const flavor = draft
      ? this.draftFlavor()
      : this.state.sessions.find((session) => session.id === id)?.hostFlavor;
    if (!flavor) return Promise.reject(Error(t("browserHost.bindingChanged")));
    const pending = this.browserPreparation;
    const owner = this.state.authSession?.principal?.owner;
    if (draft && owner) {
      if (
        this.draftConversationOwner &&
        this.draftConversationOwner !== owner
      ) {
        id = crypto.randomUUID();
        this.draftConversationId = id;
      }
      this.draftConversationOwner = owner;
    }
    if (
      pending?.id === id &&
      pending.flavor === flavor &&
      pending.attempt === this.hostAttempt &&
      pending.cycle === this.lifecycle &&
      pending.owner === owner
    )
      return pending.promise;
    const host = this.state.hostConnection;
    if (
      this.browserPrepared?.id === id &&
      this.browserPrepared.flavor === flavor &&
      this.browserPrepared.cycle === this.lifecycle &&
      this.browserPrepared.owner === owner &&
      host?.conversationId === id &&
      host.hostFlavor === flavor &&
      host.state === "ready" &&
      host.connected &&
      host.catalogReady &&
      this.state.agents.length
    )
      return Promise.resolve();
    const promise = this.prepareBrowserConversation(id, draft, flavor);
    const preparation = {
      id,
      flavor,
      attempt: this.hostAttempt,
      cycle: this.lifecycle,
      owner,
      promise,
    };
    this.browserPreparation = preparation;
    const settled = () => {
      if (this.browserPreparation === preparation)
        this.browserPreparation = null;
    };
    void promise.then(settled, settled);
    return promise;
  }
  private async prepareBrowserConversation(
    id: string,
    draft: boolean,
    flavor: ConversationHostFlavor,
  ) {
    const owner = this.state.authSession?.principal?.owner;
    if (!owner) throw Error(t("browserHost.authenticationRequired"));
    const attempt = ++this.hostAttempt;
    const cycle = this.lifecycle;
    const current = () =>
      attempt === this.hostAttempt &&
      cycle === this.lifecycle &&
      this.state.authSession?.principal?.owner === owner &&
      (draft
        ? this.state.sessionId === null &&
          this.draftFlavor() === flavor &&
          this.draftConversationId === id
        : this.state.sessionId === id &&
          this.state.sessions.find((session) => session.id === id)
            ?.hostFlavor === flavor);
    this.update({
      hostConnection: {
        state: "connecting",
        conversationId: id,
        hostFlavor: flavor,
        connected: false,
      },
      agents: [],
    });
    try {
      const browser = flavor === "chat_only" && !draft
        ? { serverOwned: true, participant: false }
        : await this.api.connectBrowserConversation(id, owner, flavor);
      if (!current()) return;
      const catalog = await this.call<{ items: AgentInfo[] }>(
        "agent.catalog",
        { conversation_id: id },
        undefined,
      );
      if (!current()) return;
      if (!catalog.items.length)
        throw Error(t("browserHost.catalogUnavailable"));
      this.update({
        agents: catalog.items,
        hostConnection: {
          state: "ready",
          connected: true,
          catalogReady: true,
          serverOwned: browser.serverOwned === true,
          browserParticipant: browser.participant === true,
          conversationId: id,
          hostFlavor: flavor,
        },
      });
      this.applyDraftAgentDefaults();
      this.browserPrepared = { id, flavor, cycle, owner };
      if (draft) this.draftConversationId = id;
    } catch (error) {
      if (current())
        this.update({
          hostConnection: {
            state: "suspended",
            connected: false,
            conversationId: id,
            hostFlavor: flavor,
            catalogError: String(error),
          },
        });
      throw error;
    }
  }
  private async loadHostCatalog(projectId: string) {
    const attempt = this.hostAttempt;
    const cycle = this.lifecycle;
    const current = () =>
      attempt === this.hostAttempt &&
      cycle === this.lifecycle &&
      !!this.state.authSession?.authenticated;
    try {
      const catalog = await this.call<{ items: AgentInfo[] }>(
        "agent.catalog",
        { project_id: projectId },
        undefined,
      );
      if (
        !current() ||
        this.state.hostConnection?.projectId !== projectId ||
        !this.state.hostConnection.connected
      )
        return;
      if (!catalog.items.length)
        throw Error("当前项目没有可用的 Agent 组件，请检查服务端组件配置");
      if (
        catalog.items.some(
          (item) => typeof item.component !== "string" || !item.component,
        )
      )
        throw Error("服务端组件目录缺少组件标识，请更新服务端后重试加载目录");
      this.update({
        agents: catalog.items,
        hostConnection: {
          ...this.state.hostConnection,
          catalogError: undefined,
          catalogReady: true,
        },
      });
      this.applyDraftAgentDefaults();
    } catch (error) {
      if (
        current() &&
        this.state.hostConnection?.projectId === projectId &&
        this.state.hostConnection.connected
      )
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            catalogError:
              error instanceof Error ? error.message : String(error),
            catalogReady: false,
          },
        });
    }
  }
  private async refreshHost(reconcile = false) {
    const ticket = ++this.hostRefresh;
    const revision = this.hostStateRevision;
    const attempt = this.hostAttempt;
    const cycle = this.lifecycle;
    const owner = this.state.authSession?.principal?.owner;
    const current = () =>
      ticket === this.hostRefresh &&
      revision === this.hostStateRevision &&
      owner === this.state.authSession?.principal?.owner &&
      attempt === this.hostAttempt &&
      cycle === this.lifecycle &&
      !!this.state.authSession?.authenticated;
    const projectId = this.state.hostConnection?.projectId;
    if (!projectId) return;
    try {
      const view = await this.api.request<NativeHostState>(
        reconcile ? "project.host_reconcile" : "project.host_state",
        { project_id: projectId },
      );
      if (!current() || this.state.hostConnection?.projectId !== projectId)
        return;
      const patch = hostStatePatch(view);
      this.rememberHostTerminal(projectId, patch.cause?.code);
      this.update({
        hostConnection: {
          ...this.state.hostConnection,
          ...patch,
          debugError: undefined,
        },
      });
      const records = await this.api.request<any>("project.operations", {
        project_id: projectId,
        limit: 100,
      });
      if (current() && this.state.hostConnection?.projectId === projectId)
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            operations: records.operations,
          },
        });
      if (current() && patch.state === "ready") {
        await this.loadHostCatalog(projectId);
        if (
          current() &&
          this.state.hostConnection?.restoringSession === true &&
          !this.hostAttachment
        ) {
          const attachment = { attempt, projectId };
          this.hostAttachment = attachment;
          try {
            if (await this.restoreHostSession(projectId, current))
              if (this.state.hostConnection?.projectId === projectId)
                this.update({
                  hostConnection: {
                    ...this.state.hostConnection,
                    restoringSession: false,
                  },
                });
          } finally {
            if (this.hostAttachment === attachment) this.hostAttachment = null;
          }
        }
      }
    } catch (error) {
      if (current() && this.state.hostConnection?.projectId === projectId)
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            debugError: error instanceof Error ? error.message : String(error),
          },
        });
    }
  }
  private async connectHost(
    projectId: string,
    requestedEndpoint?: string,
    pairingToken?: string,
    allowLegacyBinding = false,
    transport?: "relay" | "grpc",
    trigger: HostLifecycleTrigger = "action:connect_host",
    restoreSession = true,
    automatic = false,
  ): Promise<any> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) throw Error("请选择已授权项目");
    const scope = this.hostScope();
    if (!scope) throw Error("请先登录");
    const endpoint = requestedEndpoint?.trim() || hostLocator(scope, project);
    if (!endpoint) {
      this.update({
        hostConnection: { state: "detached", projectId, recoverAddress: true },
      });
      throw Error("此浏览器尚未保存该 Host 地址，请设置连接地址");
    }
    const carrier = hostCarrier(endpoint);
    if (!carrier)
      throw new CommandError("invalid_request", t("hostDlg.badAddress"));
    if (transport && transport !== carrier)
      throw new CommandError("invalid_request", t("hostDlg.carrierMismatch"));
    const attempt = ++this.hostAttempt;
    const cycle = this.lifecycle;
    const directory = project.root || ".";
    const savedLocator = hostLocator(scope, project);
    let verified = false;
    const current = () => {
      const latest = this.state.projects.find((item) => item.id === projectId);
      return attempt === this.hostAttempt && cycle === this.lifecycle &&
        scope === this.hostScope() && !!this.state.authSession?.authenticated &&
        !!latest && (verified || ((latest.root || ".") === directory &&
          hostLocator(scope, latest) === savedLocator));
    };
    const candidate = await prepareHostCandidate(scope, projectId, endpoint, directory);
    if (!current()) return;
    if (
      this.state.sessionId &&
      this.state.sessions.find((s) => s.id === this.state.sessionId)
        ?.projectID !== projectId
    ) {
      const popup = this.state.popup;
      this.newChat(false);
      this.update({ popup });
    }
    const blocked = automatic ? quarantinedHost(candidate) : undefined;
    if (blocked) {
      this.update({
        agents: [],
        hostConnection: {
          state: "suspended", projectId, endpoint, transport: carrier,
          connected: false, reason: blocked.code,
          cause: { code: blocked.code, message: t(`host.reason.${blocked.reason ?? blocked.code}`) },
        },
      });
      return;
    }
    this.update({
      agents: [],
      hostConnection: {
        state: "connecting",
        projectId,
        endpoint,
        transport: carrier,
        connected: false,
        restoringSession: !!this.state.sessionId,
      },
    });
    const attachment = { attempt, projectId };
    this.hostAttachment = attachment;
    try {
      let descriptor;
      let relayState = "connecting";
      try {
        descriptor = await this.api.connectHost(
          projectId,
          endpoint,
          pairingToken?.trim() || undefined,
          (state, reason, details) => {
            if (!current()) return;
            ++this.hostStateRevision;
            const patch = details?.readiness
              ? hostStatePatch({
                  ...details,
                  connected: details.readiness.connected,
                  ready: details.readiness.ready,
                })
              : {
                  state,
                  connected: state === "ready" || state === "reconciling",
                  readiness: undefined,
                  reason: details?.code ?? reason,
                  cause:
                    details?.reconciliation_error ??
                    (details?.message
                      ? {
                          code: details.code ?? reason ?? "connection_failed",
                          message: details.message,
                        }
                      : state === "ready"
                        ? null
                        : this.state.hostConnection?.cause),
                };
            if (details?.message && !patch.cause) {
              patch.cause = {
                code: details.code ?? reason ?? "connection_failed",
                message: details.message,
              };
              patch.reason = patch.cause.code;
            }
            relayState = patch.state;
            const terminalCode = patch.cause?.code;
            if (hostTerminalCode(terminalCode))
              quarantineHost(candidate, terminalCode);
            this.update({
              hostConnection: {
                ...this.state.hostConnection,
                projectId,
                endpoint,
                ...patch,
                effectiveTransport:
                  state === "ready" || state === "reconciling"
                    ? (this.api.currentHostTransport() ?? undefined)
                    : undefined,
                debugError: undefined,
              },
            });
          },
          {
            directory: project.root || ".",
            expectedHostId: project.host_id || undefined,
            expectedWorkspaceId: project.workspace_id || undefined,
            allowLegacyBinding,
            trigger,
          },
        );
        if (!current()) return;
        if (
          (project.host_id && descriptor.host_id !== project.host_id) ||
          (project.workspace_id &&
            descriptor.workspace_id !== project.workspace_id)
        )
          throw new CommandError(
            "binding_mismatch",
            "桥接身份与项目固定的 Host/Workspace 不一致",
          );
      } catch (error) {
        let failure = error;
        const duplicate = error as {
          code?: string;
          details?: {
            existing_project_id?: string;
            descriptor?: {
              host_id: string;
              workspace_id: string;
              workspace_root: string;
            };
            pairing_token_consumed?: boolean;
          };
        };
        const existingId = duplicate.details?.existing_project_id;
        if (duplicate.code === "existing_project" && existingId && current()) {
          try {
            const projects = await this.call<{ items: NativeProject[] }>(
              "project.list",
              {},
              undefined,
            );
            if (!current()) return;
            const canonical = projects.items.find((p) => p.id === existingId);
            const verified = duplicate.details?.descriptor;
            if (
              !canonical ||
              !verified ||
              canonical.host_id !== verified.host_id ||
              canonical.workspace_id !== verified.workspace_id ||
              canonical.root !== verified.workspace_root
            )
              throw new CommandError(
                "binding_mismatch",
                "服务端项目绑定与当前用户可见的项目目录不一致，请刷新项目列表",
              );
            this.update({
              projects: projects.items,
              knownProjects: projects.items.map((p) => ({
                ...p,
                path: p.root,
              })),
              draftWorkspace: {
                kind: "remote",
                projectId: canonical.id,
                path: canonical.root,
                label: canonical.name,
              },
            });
            // Only a proven unconsumed bootstrap token may be sent to its canonical scope.
            return this.connectHost(
              existingId,
              endpoint,
              duplicate.details?.pairing_token_consumed === false
                ? pairingToken
                : undefined,
              false,
              transport,
              trigger,
              restoreSession,
              automatic,
            );
          } catch (verificationError) {
            failure = verificationError;
          }
        }
        if (current()) {
          if (failure instanceof CommandError && hostTerminalCode(failure.code))
            quarantineHost(candidate, failure.code, failure.details?.reason);
          // Api owns generation-scoped relay cleanup. Observation failures must
          // not disconnect a healthy server-owned gRPC route.
          if (current())
            this.update({
              hostConnection: {
                ...this.state.hostConnection,
                state: "suspended",
                connected: false,
                cause: {
                  code:
                    (failure as { code?: string }).code ?? "connection_failed",
                  message:
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                },
                reason:
                  (failure as { code?: string }).code ?? "connection_failed",
                recoverAddress:
                  !!requestedEndpoint ||
                  [
                    "disconnected",
                    "connection_failed",
                    "connection_timeout",
                    "timed_out",
                    "outcome_unknown",
                  ].includes(duplicate.code ?? "connection_failed"),
              },
            });
        }
        throw failure;
      }
      if (!descriptor || !current()) return;
      verified = true;
      if (!hostTerminalCode(this.state.hostConnection?.cause?.code))
        clearHostQuarantine(candidate);
      rememberHost(scope, descriptor.host_id, projectId, endpoint);
      const ready = relayState === "ready";
      const draftProjectChanged = this.state.draftWorkspace.projectId !== projectId;
      this.update({
        draftWorkspace: {
          kind: "remote",
          projectId,
          path: descriptor.workspace_root,
          label: project.name,
        },
        hostConnection: {
          ...this.state.hostConnection,
          state: ready
            ? "ready"
            : relayState === "reconciling"
              ? "reconciling"
              : "unready",
          connected: true,
          projectId,
          endpoint,
          effectiveTransport: this.api.currentHostTransport() ?? undefined,
          workspace: descriptor.workspace_root,
          recoverAddress: false,
        },
        projects: this.state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                host_id: descriptor.host_id,
                workspace_id: descriptor.workspace_id,
                root: descriptor.workspace_root,
                host_connected: true,
                status: "online",
              }
            : p,
        ),
        knownProjects: this.state.knownProjects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                path: descriptor.workspace_root,
                host_connected: true,
                status: "online",
              }
            : p,
        ),
      });
      // A newly connected Project has its own inherited Agent/model scope.
      // Resolve it before catalog readiness enables first send; explicit draft
      // choices remain authoritative in refreshDraftDefaults.
      if (draftProjectChanged) {
        await this.refreshDraftDefaults();
        if (!current()) return descriptor;
      }
      if (ready) {
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            state: "ready",
            reason: "loading_catalog",
          },
        });
        await this.loadHostCatalog(projectId);
        if (!current() || this.state.hostConnection?.state !== "ready")
          return descriptor;
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            state: "ready",
            reason: undefined,
          },
        });
        if (
          restoreSession &&
          !(await this.restoreHostSession(projectId, current))
        )
          return;
      }
      if (
        restoreSession &&
        ready &&
        current() &&
        this.state.hostConnection?.projectId === projectId
      )
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            restoringSession: false,
          },
        });
      return descriptor;
    } finally {
      if (this.hostAttachment === attachment) this.hostAttachment = null;
    }
  }
  private async openHostSession(
    projectId: string,
    sessionId: string,
    current: () => boolean,
  ): Promise<NativeSnapshot | null> {
    try {
      return await this.api.request<NativeSnapshot>(
        "session.open",
        {},
        sessionId,
      );
    } catch (error) {
      if (!(error instanceof CommandError) || error.code !== "host_detached")
        throw error;
      // Replaced routes may leave one pending suspension. Only fresh readiness
      // authorizes one activation retry; this never retries a user mutation.
      if (!current()) return null;
      const route = await this.api.request<NativeHostState>(
        "project.host_state",
        { project_id: projectId },
        undefined,
      );
      if (!current()) return null;
      if (!route.connected || !route.ready) {
        this.suspendHost(projectId);
        throw error;
      }
      return await this.call<NativeSnapshot>("session.open", {}, sessionId);
    }
  }
  private async restoreHostSession(
    projectId: string,
    current: () => boolean,
  ): Promise<boolean> {
    const sessionId = this.state.sessionId;
    const navigation = this.attaching;
    const selected = () =>
      current() &&
      this.state.sessionId === sessionId &&
      this.attaching === navigation;
    if (
      !sessionId ||
      this.state.sessions.find((s) => s.id === sessionId)?.projectID !==
        projectId
    )
      return current();
    try {
      await this.openHostSession(projectId, sessionId, selected);
      if (!selected()) return false;
      await this.attach(sessionId, false, false, false, false);
      return current() && this.state.sessionId === sessionId;
    } catch (error) {
      if (
        selected() &&
        error instanceof CommandError &&
        error.code === "workspace_conflict"
      ) {
        // The pinned Host is live; only Session admission is refused. Preserve
        // its existing inspect/reconcile workflow and observable history.
        this.toast(error.message);
        return true;
      }
      if (selected()) {
        this.update({
          hostConnection: {
            ...this.state.hostConnection,
            state: "suspended",
            catalogReady: false,
            cause: {
              code: (error as { code?: string }).code ?? "connection_failed",
              message: error instanceof Error ? error.message : String(error),
            },
            reason: (error as { code?: string }).code ?? "connection_failed",
          },
        });
        this.toast(error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  }
  private async loadChildren(append = false) {
    const parent = this.state.sessionId;
    if (!parent || !this.supports("session.children")) return;
    const ticket = ++this.childrenRead;
    const cycle = this.lifecycle;
    const cursor = append ? this.state.childList?.next_cursor : undefined;
    if (append && !cursor) return;
    this.update({ childListLoading: true, childListError: null });
    try {
      const result = await this.api.request<NativeChildren>(
        "session.children",
        { limit: 100, cursor },
        parent,
      );
      if (
        ticket !== this.childrenRead ||
        cycle !== this.lifecycle ||
        parent !== this.state.sessionId
      )
        return;
      if (result.parent_session_id !== parent)
        throw Error("子代理列表身份不匹配");
      const children = append
        ? [...(this.state.childList?.children ?? []), ...result.children]
        : result.children;
      this.update({
        childList: {
          ...result,
          children: [
            ...new Map(children.map((child) => [child.id, child])).values(),
          ],
        },
      });
    } catch (error) {
      if (
        ticket === this.childrenRead &&
        cycle === this.lifecycle &&
        parent === this.state.sessionId
      )
        this.update({
          childListError:
            error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (ticket === this.childrenRead && parent === this.state.sessionId)
        this.update({ childListLoading: false });
    }
  }
  private async loadChild(child: string, append = false, enter = false) {
    const parent = this.state.sessionId;
    if (!parent || !child) throw Error("缺少父会话或子代理身份");
    if (append && this.state.popup.type !== "subagentDetail") return;
    const ticket = ++this.childRead;
    const cycle = this.lifecycle;
    const prior =
      this.state.popup.type === "subagentDetail" &&
      this.state.popup.parentId === parent &&
      this.state.popup.childId === child
        ? (this.state.popup.detail as NativeChildDetail | undefined)
        : undefined;
    if (append && prior?.next_cursor == null) return;
    this.update({
      popup: {
        type: "subagentDetail",
        parentId: parent,
        childId: child,
        detail: prior,
        loading: true,
        error: null,
      },
    });
    try {
      let detail = await this.api.request<NativeChildDetail>(
        "session.child",
        {
          child_id: child,
          limit: 100,
          before_cursor: append ? prior?.next_cursor : undefined,
          ...(append && prior?.history_view && prior.messages[0]
            ? {
                lineage: prior.history_view.lineage,
                before_message_id: prior.messages[0].id,
              }
            : {}),
        },
        parent,
      );
      if (
        ticket !== this.childRead ||
        cycle !== this.lifecycle ||
        parent !== this.state.sessionId ||
        this.state.popup.type !== "subagentDetail" ||
        this.state.popup.childId !== child
      )
        return;
      if (detail.parent_session_id !== parent || detail.id !== child)
        throw Error("子代理详情身份不匹配");
      if (enter && detail.interaction === "persistent") {
        if (!this.state.authSession?.authenticated || this.state.authRequired || this.state.connection !== "ws")
          throw new CommandError("child_entry_unavailable", t("childInput.disconnected"));
        detail = await this.api.enterChild({ parentId: parent, childId: child }, new AbortController().signal);
        if (ticket !== this.childRead || cycle !== this.lifecycle || parent !== this.state.sessionId || this.state.popup.type !== "subagentDetail" || this.state.popup.childId !== child)
          return;
      }
      if (prior && append) {
        const merged = mergeHistoryPage(
          { ...prior, session: { id: child } },
          {
            items: detail.messages,
            history_view: detail.history_view,
            truncated: detail.messages_truncated === true,
            next_cursor: detail.next_cursor,
          },
        );
        if (!merged) throw Error(t("conversation.historyChanged"));
        detail.messages = merged.messages;
        detail.history_view = merged.history_view;
        detail.messages_truncated = merged.messages_truncated === true;
        detail.next_cursor = merged.next_cursor ?? null;
      } else if (prior) {
        const retained = retainLoadedMessages(
          { ...detail, session: { id: child }, history_gap: false },
          { ...prior, session: { id: child } },
        );
        if (retained.history_gap) throw Error(t("conversation.historyGap"));
        detail.messages = retained.messages;
        detail.history_view = retained.history_view;
        detail.messages_truncated = retained.messages_truncated === true;
        detail.next_cursor = retained.next_cursor ?? null;
      }
      this.update({ popup: { ...this.state.popup, detail, loading: false } });
      if (detail.display) void this.hydrateChildDisplay(detail, ticket, cycle);
    } catch (error) {
      if (
        ticket === this.childRead &&
        cycle === this.lifecycle &&
        parent === this.state.sessionId &&
        this.state.popup.type === "subagentDetail"
      )
        this.update({
          popup: {
            ...this.state.popup,
            loading: false,
            entryUnknown: enter && error instanceof CommandError && error.outcomeUnknown,
            error: error instanceof CommandError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error),
          },
        });
    }
  }
  /** Start (or restart) the owner-level list watch; false when unavailable. */
  private async watchSessions(current: () => boolean = () => true) {
    const ticket = ++this.sessionWatchTicket;
    this.sessionWatch = null;
    if (!this.supports("sessions.watch")) return false;
    try {
      const result = await this.api.request<{
        subscription_id: string;
        generation: string;
        sequence: number;
      }>("sessions.watch", {}, undefined);
      if (!current() || ticket !== this.sessionWatchTicket) return false;
      this.sessionWatch = {
        id: result.subscription_id,
        generation: result.generation,
        sequence: result.sequence,
        buffer: [],
      };
      const early = this.earlyListEvents.filter(
        (event) => event.subscription_id === result.subscription_id,
      );
      this.earlyListEvents = [];
      for (const event of early) this.receiveSessionList(event);
      return true;
    } catch (error) {
      if (current() && ticket === this.sessionWatchTicket)
        reportDiagnostic("store", "sessions.watch", error, undefined, "warn");
      return false;
    }
  }
  /** Apply increments that arrived while the initial list was loading. */
  private flushSessionWatch() {
    const watch = this.sessionWatch;
    if (!watch?.buffer) return;
    const buffered = watch.buffer;
    watch.buffer = null;
    for (const event of buffered) this.applySessionChange(event);
  }
  /** Full list reload: only on demand or when the watch must resync. */
  private async reloadSessions() {
    const lifecycle = this.lifecycle;
    await this.watchSessions(() => lifecycle === this.lifecycle);
    const result = await this.call<NativeSessionList>(
      "session.list",
      {},
      undefined,
    );
    if (lifecycle !== this.lifecycle) return;
    this.update({
      sessions: result.items.filter((s) => !s.archived).map(sessionView),
    });
    this.reportUnavailableSessions(result.unavailable);
    this.flushSessionWatch();
  }
  /** Route an owner-level list event; true when it was one. */
  private receiveSessionList(event: NativeOwnerEvent) {
    const watch = this.sessionWatch;
    if (!watch || event.subscription_id !== watch.id) {
      if (
        event.event === "sessions.changed" ||
        event.event === "session.cleanup_failed" ||
        (event.event === "resync_required" && event.session_id === "")
      ) {
        if (!watch && this.earlyListEvents.length < 256)
          this.earlyListEvents.push(event);
        return true;
      }
      return false;
    }
    if (
      event.generation !== watch.generation ||
      event.sequence !== watch.sequence + 1 ||
      event.event === "resync_required"
    ) {
      this.sessionWatch = null;
      void this.reloadSessions().catch((error) => this.toast(String(error)));
      return true;
    }
    watch.sequence = event.sequence;
    if (watch.buffer) watch.buffer.push(event);
    else this.applySessionChange(event);
    return true;
  }
  private unavailableSessions = new Map<string, string>();
  private unavailableLifecycle = -1;
  private reportUnavailableSessions(
    entries: NativeSessionList["unavailable"],
    replace = true,
  ) {
    if (this.unavailableLifecycle !== this.lifecycle) {
      this.unavailableSessions.clear();
      this.unavailableLifecycle = this.lifecycle;
    }
    const changed = entries.filter(
      (entry) => this.unavailableSessions.get(entry.id) !== entry.reason,
    );
    if (replace) this.unavailableSessions.clear();
    for (const entry of entries)
      this.unavailableSessions.set(entry.id, entry.reason);
    if (changed.length)
      this.toast(
        t("toast.sessionsUnavailable", {
          count: this.unavailableSessions.size,
          details: changed
            .map((entry) => `${entry.id}: ${entry.reason}`)
            .join("\n"),
        }),
        "error",
      );
  }
  private applySessionChange(event: NativeOwnerEvent) {
    if (event.event === "session.cleanup_failed") {
      this.toast(t("toast.sessionCleanupFailed"));
      return;
    }
    if (event.event !== "sessions.changed") return;
    const data = event.data;
    if (data.op === "unavailable") {
      this.reportUnavailableSessions(
        [{ id: data.session_id, reason: data.error.message }],
        false,
      );
      this.update({
        sessions: this.state.sessions.filter((s) => s.id !== data.session_id),
      });
      return;
    }
    if (data.op === "remove") {
      this.unavailableSessions.delete(data.session_id);
      if (!this.state.sessions.some((s) => s.id === data.session_id)) return;
      this.update({
        sessions: this.state.sessions.filter((s) => s.id !== data.session_id),
      });
      return;
    }
    if (data.op !== "upsert" || typeof data.session?.id !== "string") return;
    this.unavailableSessions.delete(data.session.id);
    const existing = this.state.sessions.find((s) => s.id === data.session.id);
    // A list item never moves backwards; equal revisions carry status changes.
    if (existing && existing.revision > data.session.revision) return;
    this.upsert(data.session);
    this.update({ sessions: [...this.state.sessions] });
  }
  private upsert(session: NativeSession) {
    const view = sessionView(session);
    this.state.sessions = this.state.sessions.filter(
      (s) => s.id !== session.id,
    );
    if (!session.archived) this.state.sessions.unshift(view);
  }
  private historyReads = new WeakSet<NativeSubscription>();
  private loadedSubscriptions = new WeakSet<NativeSubscription>();
  private historyGaps = new WeakSet<NativeSubscription>();
  private historyTargets = new WeakMap<NativeSubscription, NativeSnapshot>();
  private async recoverHistoryGap(
    current: NativeSubscription,
    target: NativeSnapshot,
  ) {
    if (this.historyGaps.has(current)) return;
    this.historyGaps.add(current);
    try {
      while (
        current === this.subscription &&
        current.snapshot.history_gap &&
        sameSelectedHistory(current.snapshot, target)
      ) {
        const previous = current.snapshot;
        const boundary = previous.messages.at(-1)?.id;
        if (!boundary || !previous.history_view) return;
        const page = await this.call<HistoryPage>(
          "session.blocks",
          {
            after_message_id: boundary,
            lineage: previous.history_view.lineage,
            limit: 64,
          },
          previous.session.id,
        );
        if (
          current !== this.subscription ||
          !page.items.length ||
          !page.history_view ||
          !sameSelectedHistory(previous, current.snapshot) ||
          page.history_view.lineage !== previous.history_view.lineage ||
          page.history_view.epoch !== previous.history_view.epoch ||
          page.history_view.end_cursor <= previous.history_view.end_cursor ||
          page.history_view.start_cursor !== previous.history_view.end_cursor
        )
          return;
        const joined = mergeHistoryPage(current.snapshot, page);
        if (!joined) return;
        const latest = this.historyTargets.get(current) ?? target;
        if (!sameSelectedHistory(previous, latest)) return;
        // A range witness is not authority to replay stale Session metadata.
        const targetView: NativeSnapshot = {
          ...current.snapshot,
          messages: latest.messages,
          messages_truncated: latest.messages_truncated,
          next_cursor: latest.next_cursor,
          history_view: latest.history_view,
          history_gap: false,
        };
        this.snapshot(retainLoadedMessages(targetView, joined), joined, latest);
      }
    } catch (error) {
      if (current === this.subscription)
        reportDiagnostic(
          "store",
          "recoverHistoryGap",
          error,
          undefined,
          "warn",
        );
      // Keep the explicit gap and the last proven content; a later snapshot can retry.
    } finally {
      this.historyGaps.delete(current);
      const latest = this.historyTargets.get(current);
      if (
        current === this.subscription &&
        current.snapshot.history_gap &&
        latest &&
        !sameSelectedHistory(target, latest)
      )
        void this.recoverHistoryGap(current, latest);
    }
  }
  private snapshot(
    snapshot: NativeSnapshot,
    previous = this.subscription?.snapshot,
    target = snapshot,
    canonicalUnchanged = false,
  ) {
    snapshot = retainLoadedMessages(snapshot, previous);
    if (
      snapshot.session.id === this.state.sessionId &&
      snapshot.session.revision <
        (this.state.sessions.find((item) => item.id === snapshot.session.id)
          ?.revision ?? 0)
    )
      return;
    this.upsert(snapshot.session);
    if (this.subscription?.snapshot.session.id === snapshot.session.id) {
      const outstanding = this.historyTargets.get(this.subscription);
      const latest =
        outstanding &&
        sameSelectedHistory(outstanding, target) &&
        coherentHistoryRange(outstanding) &&
        coherentHistoryRange(target) &&
        outstanding.history_view!.end_cursor > target.history_view!.end_cursor
          ? outstanding
          : target;
      this.historyTargets.set(this.subscription, latest);
      if (
        sameSelectedHistory(snapshot, latest) &&
        coherentHistoryRange(snapshot) &&
        coherentHistoryRange(latest)
      )
        snapshot = {
          ...snapshot,
          history_gap:
            snapshot.history_view!.end_cursor < latest.history_view!.end_cursor,
        };
      this.subscription.snapshot = snapshot;
      // Metadata carries no new range evidence and cannot retry a failed read.
      if (snapshot.history_gap && !canonicalUnchanged)
        void this.recoverHistoryGap(this.subscription, latest);
    }
    this.update({
      transcript: {
        ...applySnapshot(
          snapshot,
          this.state.transcript,
          this.api.base,
          canonicalUnchanged,
        ),
        ...(snapshot.display
          ? { displayCoverage: snapshot.display.coverage }
          : {}),
        pendingPermission: this.permissionProjection(),
        interrupting:
          this.interruptFence?.sessionId === snapshot.session.id &&
          snapshot.session.status === "running",
      },
      policy: snapshot.permission,
      history: snapshot.history,
      historyAvailable: snapshot.history_available ?? null,
      retryOperationId: snapshot.session.retry_ready
        ? (snapshot.session.retry_operation_id ?? null)
        : null,
      inboxPending: this.inboxRequests.has(snapshot.session.id),
      retryPending: this.retryRequests.has(snapshot.session.id),
      agentInitRetryRequired:
        snapshot.session.agent_init_retry_required === true,
      autoCompactionRetryAvailable:
        snapshot.session.auto_compaction_retry_available === true,
      sessionRecoveryUnknown: this.recoveryRequests.has(snapshot.session.id),
      sessionRecoveryPending: this.recoveryActive.has(snapshot.session.id),
      sessions: [...this.state.sessions],
      draftMode: snapshot.session.mode ?? "",
      draftAgent: snapshot.session.agent ?? "",
      historyTruncated: snapshot.messages_truncated === true,
      publicState: snapshot.state ?? null,
      executionHistory:
        snapshot.executions ??
        (this.state.executionHistorySessionId === snapshot.session.id
          ? (this.state.executionHistory ?? [])
          : []),
      executionHistorySessionId: snapshot.session.id,
      executionHistoryTruncated: snapshot.executions_truncated === true,
      statistics: snapshot.statistics ?? null,
      publicStateOmitted: snapshot.state_omitted === true,
      selectedClientInvocationIds: (
        snapshot.client_tools as ClientCatalog | undefined
      )?.selected_invocation_ids,
    });
    if (snapshot.executions_omitted === true)
      void this.refreshExecutionHistory(snapshot.session.id);
    if (
      this.interruptFence?.sessionId === snapshot.session.id &&
      snapshot.session.status !== "running"
    )
      this.releaseInterrupt();
    if (snapshot.client_tools && this.clientTools.binding) {
      const incoming = snapshot.client_tools as ClientBinding;
      const records = new Map(
        this.clientTools.binding.calls.map((call) => [
          call.invocation_id,
          call,
        ]),
      );
      for (const call of incoming.calls) {
        const prior = records.get(call.invocation_id);
        if (
          prior &&
          !["pending", "paused"].includes(prior.status) &&
          ["pending", "paused"].includes(call.status)
        )
          continue;
        records.set(call.invocation_id, call);
      }
      this.clientTools.binding.calls = [...records.values()];
      this.clientTools.binding.calls_truncated =
        !!incoming.calls_truncated &&
        records.size < (incoming.total_calls ?? Infinity);
    }
    this.projectClientTools();
    this.syncCompact(snapshot);
    for (const receipt of snapshot.operations)
      this.reconcileSubmission(receipt);
    if (this.unknownSubmissions.has(snapshot.session.id))
      this.update({ isCreatingSession: true });
  }
  /** Visited sessions, least recent first. Memory only: never browser storage. */
  private memoryScope: string | null = null;
  /** Private cached views and image URLs never cross an owner/server boundary. */
  private clearSessionMemory() {
    this.releaseInterrupt();
    this.sessionCache.clear();
    for (const draft of this.drafts.values())
      for (const image of draft.composerImages)
        URL.revokeObjectURL(image.previewUrl);
    this.drafts.clear();
    this.memoryScope = null;
  }
  private sessionCache = new Map<
    string,
    { snapshot: NativeSnapshot; transcript: Transcript }
  >();
  /** Per-session composer drafts, images included. Memory only. */
  private drafts = new Map<
    string,
    { composer: string; composerImages: ComposerImage[] }
  >();
  private cacheSession() {
    const current = this.subscription;
    const id = this.state.sessionId;
    if (
      !this.memoryScope ||
      !current ||
      !id ||
      current.snapshot.session.id !== id
    )
      return;
    this.sessionCache.delete(id);
    this.sessionCache.set(id, {
      snapshot: structuredClone(current.snapshot),
      transcript: structuredClone(this.state.transcript),
    });
    while (this.sessionCache.size > SESSION_CACHE_LIMIT)
      this.sessionCache.delete(this.sessionCache.keys().next().value!);
  }
  private forgetSession(id: string) {
    this.sessionCache.delete(id);
    const draft = this.drafts.get(id);
    if (draft)
      for (const image of draft.composerImages)
        URL.revokeObjectURL(image.previewUrl);
    this.drafts.delete(id);
  }
  /** Keep the outgoing session's draft and show the incoming one's. */
  private swapComposer(from: string | null, to: string | null) {
    ++this.draftEpoch;
    this.intakeCount = 0;
    if (from && (this.state.composer || this.state.composerImages.length))
      this.drafts.set(from, {
        composer: this.state.composer,
        composerImages: this.state.composerImages,
      });
    else {
      if (from) this.drafts.delete(from);
      for (const image of this.state.composerImages)
        URL.revokeObjectURL(image.previewUrl);
    }
    const draft = to ? this.drafts.get(to) : undefined;
    if (to) this.drafts.delete(to);
    this.update({
      composer: draft?.composer ?? "",
      composerImages: draft?.composerImages ?? [],
      imageIntakePending: false,
    });
  }
  private recordFirstFrame(id: string, started: number, source: string) {
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      const elapsed = performance.now() - started;
      const target = globalThis as unknown as {
        __mcSwitchFrames?: { id: string; source: string; ms: number }[];
      };
      (target.__mcSwitchFrames ??= []).push({ id, source, ms: elapsed });
      traceEvent("session.first_frame", {
        sessionId: id,
        outcome: "succeeded",
        elapsedMs: elapsed,
        code: source,
      });
    });
  }
  /** A reopened socket arrives with a fresh barrier. Adopt it in place and
   * rebind the executor: the closed socket released its lease. */
  private resubscribed(
    socket: SessionSocket,
    subscription: NativeSubscription,
  ) {
    if (
      socket !== this.sessionSocket ||
      socket.sessionId !== this.state.sessionId
    )
      return;
    const previous = this.subscription;
    this.subscription = subscription;
    if (
      previous &&
      this.loadedSubscriptions.has(previous) &&
      previous.snapshot.session.id === subscription.snapshot.session.id &&
      sameSelectedHistory(previous.snapshot, subscription.snapshot)
    )
      this.loadedSubscriptions.add(subscription);
    this.snapshot(subscription.snapshot, previous?.snapshot);
    this.refreshPermissions(subscription.pending?.permissions ?? null);
    this.roundLimits.refresh(subscription.pending?.round_limits ?? null);
    if (this.clientTools.sessionId === subscription.snapshot.session.id)
      void this.bindClientTools(
        subscription.snapshot.session.id,
        subscription.snapshot,
        this.attaching,
      ).catch((error) => this.toast(String(error)));
  }
  private async bindClientTools(
    id: string,
    snapshot: NativeSnapshot,
    ticket: number,
  ) {
    if (!this.supports("client_tools.bind")) return;
    const catalog = snapshot.client_tools as ClientCatalog | undefined;
    if (!catalog) return;
    if (ticket === this.attaching && this.state.sessionId === id)
      await this.clientTools.bind(id, catalog);
  }
  async attach(
    id: string,
    preserveComposer = false,
    historyOnly = false,
    requireOpen = false,
    activateRuntime = true,
  ) {
    const ticket = ++this.attaching;
    const pluginRoute = () => {
      const route = parseLocation(location.pathname, location.hash);
      return route.sessionId === id &&
        (route.page === "plugins" || route.page === "plugin")
        ? { page: route.page, pluginId: route.pluginId ?? null }
        : { page: "conversation", pluginId: null };
    };
    const interactionId = crypto.randomUUID();
    const started = performance.now();
    traceEvent("session.attach", {
      interactionId,
      sessionId: id,
      outcome: "started",
    });
    const changing = id !== this.state.sessionId;
    const popupAtAttach = this.state.popup;
    const projectId = this.state.sessions.find(
      (session) => session.id === id,
    )?.projectID;
    if (!this.state.authSession?.authenticated) return;
    const scope = JSON.stringify([
      this.api.base,
      this.state.authSession.principal?.owner,
    ]);
    if (scope !== this.memoryScope) this.clearSessionMemory();
    this.memoryScope = scope;
    if (changing) this.releaseInterrupt();
    const previous = this.subscription;
    const outgoing = this.state.sessionId;
    // A visited session renders from memory before any I/O. Its attachment
    // then resumes from the cached boundary and applies only what changed.
    const cached = changing ? this.sessionCache.get(id) : undefined;
    let shown: {
      sessionId: string | null;
      page: AppState["page"];
      transcript: Transcript;
      subscription: NativeSubscription | null;
      swapped: boolean;
      view: Partial<AppState>;
    } | null = null;
    if (cached) {
      this.cacheSession();
      shown = {
        sessionId: this.state.sessionId,
        page: this.state.page,
        transcript: this.state.transcript,
        subscription: previous,
        swapped: !preserveComposer,
        view: {
          statistics: this.state.statistics,
          historyTruncated: this.state.historyTruncated,
          publicState: this.state.publicState,
          executionHistory: this.state.executionHistory,
          executionHistorySessionId: this.state.executionHistorySessionId,
          executionHistoryTruncated: this.state.executionHistoryTruncated,
          policy: this.state.policy,
          history: this.state.history,
        },
      };
      // The outgoing subscription's events no longer describe the view.
      this.subscription = null;
      this.composerRoute++;
      if (!preserveComposer) this.swapComposer(outgoing, id);
      const transcript = {
        ...structuredClone(cached.transcript),
        pendingPermission: null,
      };
      suspendPreviews(transcript);
      this.update({
        sessionId: id,
        ...pluginRoute(),
        transcript,
        statistics: cached.snapshot.statistics ?? null,
        historyTruncated: cached.snapshot.messages_truncated === true,
        publicState: cached.snapshot.state ?? null,
        executionHistory: cached.snapshot.executions ?? [],
        executionHistorySessionId: cached.snapshot.session.id,
        executionHistoryTruncated:
          cached.snapshot.executions_truncated === true,
        policy: cached.snapshot.permission,
        history: cached.snapshot.history,
      });
      this.recordFirstFrame(id, started, "cache");
    } else if (changing) this.cacheSession();
    // Install the replacement only after its coherent view arrives. A failed
    // attachment keeps the previous conversation available for an explicit retry.
    this.update({ sessionAttachingId: id });
    const base =
      previous?.snapshot.session.id === id
        ? previous.snapshot
        : cached?.snapshot;
    const socket = new SessionSocket(
      (path) => this.api.url(path),
      () =>
        this.displaySubscriptionParams(id) as {
          display_watermark: number;
          history_lineage?: string;
        },
    );
    let subscription: NativeSubscription;
    try {
      subscription = await socket.open(
        id,
        this.displaySubscriptionParams(id) as {
          display_watermark: number;
          history_lineage?: string;
        },
        {
          event: (event) => this.receive(event),
          resubscribed: (next) => this.resubscribed(socket, next),
          authRequired: () => this.requireAuth(),
        },
      );
    } catch (error) {
      socket.stop();
      traceEvent("session.attach", {
        interactionId,
        sessionId: id,
        outcome: ticket !== this.attaching ? "stale" : "failed",
        code: error instanceof CommandError ? error.code : "client_error",
      });
      if (ticket !== this.attaching) return;
      if (shown) {
        if (shown.swapped) this.swapComposer(id, shown.sessionId);
        this.composerRoute++;
        this.subscription = shown.subscription;
        this.update({
          ...shown.view,
          sessionId: shown.sessionId,
          page: shown.page,
          transcript: shown.transcript,
        });
        // Events of the restored attachment were not applied while away.
        if (shown.subscription) this.sessionSocket?.reconnect();
      }
      const recovery = this.deferredSessionRecovery;
      this.deferredSessionRecovery = null;
      if (recovery && recovery === this.sessionSocket) recovery.reconnect();
      throw error;
    } finally {
      if (ticket === this.attaching) this.update({ sessionAttachingId: null });
    }
    if (ticket !== this.attaching) {
      traceEvent("session.attach", {
        interactionId,
        sessionId: id,
        outcome: "stale",
      });
      // A newer attach already replaced this socket. Closing it releases the
      // subscription the server opened for the stale selection.
      socket.stop();
      return;
    }
    // The visible conversation retains its executor and questions until the
    // replacement view commits. In particular, an old executor release must
    // not precede the target attachment on the socket's control lane.
    if (changing) {
      this.update({
        historyMutationPending: false,
        inboxPending: this.inboxRequests.has(id),
        retryPending: this.retryRequests.has(id),
        retryOperationId: null,
      });
      this.resetPermissions(id);
      this.childRead++;
      this.childrenRead++;
      this.update({
        childList: null,
        childListError: null,
        childListLoading: false,
        popup:
          this.state.popup !== popupAtAttach &&
          ["search", "settings"].includes(this.state.popup.type)
            ? this.state.popup
            : { type: "none" },
      });
      this.clientTools.reset();
    }
    this.subscription = subscription;
    if (
      previous &&
      this.loadedSubscriptions.has(previous) &&
      previous.snapshot.session.id === subscription.snapshot.session.id &&
      sameSelectedHistory(previous.snapshot, subscription.snapshot)
    )
      this.loadedSubscriptions.add(subscription);
    // Commit before releasing the old socket: its close frees the executor
    // lease, and the replacement claims it afterwards.
    const retired = this.sessionSocket;
    this.sessionSocket = socket;
    this.deferredSessionRecovery = null;
    retired?.stop();
    if (changing && !shown) {
      this.composerRoute++;
      if (!preserveComposer) this.swapComposer(outgoing, id);
    }
    this.update({
      sessionId: id,
      ...pluginRoute(),
      connection: "ws",
      ...(changing
        ? { modeSelectionPending: false, modelSelectionPending: false }
        : {}),
      ...(changing && !preserveComposer ? { isCreatingSession: false } : {}),
    });
    this.snapshot(subscription.snapshot, base ?? previous?.snapshot);
    if (changing && !shown) this.recordFirstFrame(id, started, "server");
    if (this.state.popup.type === "subagentDetail" && this.state.popup.detail)
      void this.hydrateChildDisplay(
        this.state.popup.detail,
        this.childRead,
        this.lifecycle,
      );
    traceEvent("session.snapshot.applied", {
      interactionId,
      sessionId: id,
      outcome: "succeeded",
      count: subscription.snapshot.messages.length,
    });
    // Paging reconciliation only replaces the observation subscription. It must
    // not claim the client executor or open/resume a runtime as a side effect.
    // Closing the previous socket already released its executor lease, so the
    // same selection rebinds on the replacement without reopening the runtime.
    if (historyOnly) {
      if (ticket === this.attaching && this.clientTools.sessionId === id)
        await this.bindClientTools(id, subscription.snapshot, ticket);
      return;
    }
    await this.bindClientTools(id, subscription.snapshot, ticket);
    if (ticket !== this.attaching || this.state.sessionId !== id) return;
    if (this.permissionParent !== id) this.resetPermissions(id);
    // Pending requests arrive with the attachment; no follow-up queries.
    this.refreshPermissions(
      (subscription.pending?.permissions ?? null) as PermissionRequests | null,
    );
    this.roundLimits.refresh(subscription.pending?.round_limits ?? null);
    if (!activateRuntime) return;
    const freshInitialization =
      subscription.snapshot.session.agent_initialization_deferred === true;
    if (pluginRoute().page === "conversation") location.hash = sessionPath(id);
    if (subscription.snapshot.session.host_flavor) {
      try {
        await this.connectBrowserConversation(id);
        if (ticket === this.attaching) {
          const opened = await this.call<NativeSnapshot>(
            "session.open",
            {},
            id,
          );
          if (freshInitialization && ticket === this.attaching)
            this.snapshot(opened);
        }
      } catch (error) {
        if (requireOpen) throw error;
        if (ticket === this.attaching) this.toast(String(error));
      }
    } else if (projectId) {
      const recovered = !this.hostReadyFor(projectId);
      if (recovered)
        // This attachment owns activation and its initialization snapshot. Host
        // bootstrap must not restore the same Session by recursively attaching.
        await this.resumeProject(projectId, "resume_project:attach", false);
      if (ticket !== this.attaching || this.state.sessionId !== id) return;
      if (!this.hostReadyFor(projectId)) {
        if (requireOpen)
          throw new CommandError(
            this.state.hostConnection?.cause?.code ?? "host_detached",
            this.state.hostConnection?.cause?.message ??
              t("host.readiness.reconnectRequired"),
          );
        return;
      }
      if (changing || recovered) {
        try {
          const cycle = this.lifecycle;
          const attempt = this.hostAttempt;
          const current = () =>
            ticket === this.attaching &&
            this.state.sessionId === id &&
            cycle === this.lifecycle &&
            attempt === this.hostAttempt;
          const opened = await this.openHostSession(projectId, id, current);
          if (opened && freshInitialization && current()) this.snapshot(opened);
          if (
            opened &&
            current() &&
            this.state.hostConnection?.projectId === projectId
          )
            this.update({
              hostConnection: {
                ...this.state.hostConnection,
                restoringSession: false,
              },
            });
        } catch (error) {
          if (requireOpen) throw error;
          if (ticket === this.attaching)
            this.toast(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
  private executionContentReads = new Set<string>();
  private async hydrateExecution(event: NativeEvent) {
    const data = event.data as any;
    const executionId = data.execution_id,
      callId = data.call_id;
    if (
      !Number.isSafeInteger(executionId) ||
      executionId < 1 ||
      !callId ||
      !this.supports("executions.content")
    )
      return;
    const id = event.session_id,
      route = this.attaching,
      cycle = this.lifecycle;
    const fields: ("arguments" | "result")[] = ["arguments"];
    if (["completed", "failed", "success", "result"].includes(data.phase))
      fields.push("result");
    await Promise.all(
      fields.map(async (field) => {
        const key = JSON.stringify([
          cycle,
          route,
          id,
          executionId,
          callId,
          field,
          data.phase,
        ]);
        if (this.executionContentReads.has(key)) return;
        this.executionContentReads.add(key);
        try {
          let page = await this.api.request<NativeExecutionContentPage>(
            "executions.content",
            { execution_id: executionId, field, cursor: 0, max_bytes: 65536 },
            id,
          );
          const active = () =>
            cycle === this.lifecycle &&
            route === this.attaching &&
            id === this.state.sessionId;
          const valid = (value: NativeExecutionContentPage, cursor: number) =>
            value.session_id === id &&
            value.execution_id === executionId &&
            value.call_id === callId &&
            value.field === field &&
            value.cursor === cursor;
          if (!active() || !valid(page, 0)) return;
          // Cap background hydration; never present an incomplete prefix as the full payload.
          const first = page;
          let content = page.content;
          for (
            let count = 1;
            page.available && page.next_cursor < first.end_cursor && count < 64;
            count++
          ) {
            const cursor = page.next_cursor;
            if (cursor <= page.cursor) return;
            page = await this.api.request<NativeExecutionContentPage>(
              "executions.content",
              { execution_id: executionId, field, cursor, max_bytes: 65536 },
              id,
            );
            if (
              !active() ||
              !valid(page, cursor) ||
              !page.available ||
              page.source_hash !== first.source_hash ||
              page.end_cursor !== first.end_cursor
            )
              return;
            content += page.content;
          }
          page = { ...page, cursor: 0, content };
          const blocks = this.state.transcript.blocks.map((block) => {
            if (
              block.sessionId !== id ||
              block.callId !== callId ||
              block.kind !== "tool"
            )
              return block;
            if (block.executionId != null && block.executionId !== executionId)
              return block;
            const position = block.preview ?? block.position;
            if (
              !position ||
              position.epoch !== data.epoch ||
              position.turn !== data.turn ||
              position.round !== data.round
            )
              return block;
            if (
              block.preview &&
              block.preview.operationId !== (data.operation_id ?? null)
            )
              return block;
            const next = {
              ...block,
              executionId,
              canonicalContent: { ...block.canonicalContent, [field]: page },
            };
            if (page.available && page.next_cursor < page.end_cursor) {
              if (block.temporary) {
                if (field === "arguments")
                  next.tool = {
                    ...block.tool!,
                    input: t("execution.previewBounded"),
                  };
                else
                  next.payload = {
                    ...block.payload,
                    text: t("execution.previewBounded"),
                    structured: null,
                  };
              }
            } else if (
              page.available &&
              (block.temporary || (field === "result" && !block.payload.text))
            ) {
              let value: unknown = page.content;
              if (page.next_cursor >= page.end_cursor) {
                try {
                  value = JSON.parse(page.content);
                } catch {
                  /* Plain text is canonical too. */
                }
              }
              if (field === "arguments")
                next.tool = { ...block.tool!, input: value };
              else
                next.payload = {
                  ...block.payload,
                  text: page.content,
                  structured: typeof value === "string" ? null : value,
                };
            }
            return next;
          });
          this.update({ transcript: { ...this.state.transcript, blocks } });
        } catch {
          /* Live cards retain their truthful omitted preview; the detail reader can explicitly retry. */
        } finally {
          this.executionContentReads.delete(key);
        }
      }),
    );
  }
  private displaySubscriptionParams(id: string): Record<string, unknown> {
    const replay = this.state.transcript.displayReplay;
    const lineage =
      (this.state.sessionId === id
        ? this.state.transcript.historyView?.lineage
        : undefined) ??
      (this.subscription?.snapshot.session.id === id
        ? this.subscription.snapshot.history_view?.lineage
        : this.sessionCache.get(id)?.snapshot.history_view?.lineage);
    return replay?.sessionId === id && replay.lineage === lineage
      ? { display_watermark: replay.watermark, history_lineage: lineage }
      : {
          display_watermark: 0,
          ...(lineage ? { history_lineage: lineage } : {}),
        };
  }
  private childDisplay?: {
    parent: string;
    child: string;
    owner?: string;
    lineage?: string;
    watermark: number;
    records: NonNullable<NativeChildDetail["display_records"]>;
    graphs?: NonNullable<NativeChildDetail["display_graph_pages"]>;
  };
  private async hydrateChildDisplay(
    detail: NativeChildDetail,
    ticket: number,
    cycle: number,
  ) {
    const parent = detail.parent_session_id,
      child = detail.id;
    const lineage = detail.history_view?.lineage;
    const subscription = this.subscription;
    const active = () =>
      this.childRead === ticket &&
      this.lifecycle === cycle &&
      this.subscription === subscription &&
      this.state.sessionId === parent &&
      this.state.popup.type === "subagentDetail" &&
      this.state.popup.childId === child &&
      this.state.popup.detail?.history_view?.lineage === lineage;
    if (!detail.display || !subscription || !active()) return;
    const owner = this.state.authSession?.principal?.owner;
    if (
      this.childDisplay?.parent !== parent ||
      this.childDisplay.child !== child ||
      this.childDisplay.owner !== owner ||
      this.childDisplay.lineage !== lineage
    )
      this.childDisplay = {
        parent,
        child,
        owner,
        lineage,
        watermark: 0,
        records: [],
      };
    const replay = this.childDisplay;
    this.update({
      popup: {
        ...this.state.popup,
        detail: {
          ...detail,
          display_records: replay.records,
          display_graph_pages: replay.graphs,
          display_coverage: detail.display.coverage,
        },
      },
    });
    if (replay.watermark >= detail.display.high_water) return;
    try {
      await this.call(
        "display.subscribe",
        {
          child_session_id: child,
          history_lineage: lineage,
          high_water: detail.display.high_water,
          display_watermark: replay.watermark,
        },
        parent,
      );
    } catch {
      if (active())
        this.update({
          popup: {
            ...this.state.popup,
            detail: {
              ...this.state.popup.detail,
              display_coverage: "unavailable",
            },
          },
        });
    }
  }
  private receiveChildDisplay(page: NativeDisplayBatch) {
    const replay = this.childDisplay;
    if (
      !replay ||
      replay.owner !== this.state.authSession?.principal?.owner ||
      this.state.popup.type !== "subagentDetail" ||
      this.state.sessionId !== replay.parent ||
      page.child_session_id !== replay.child ||
      this.state.popup.childId !== replay.child ||
      page.history_lineage !== replay.lineage ||
      this.state.popup.detail?.history_view?.lineage !== replay.lineage ||
      ![page.after, page.scanned_through, page.high_water].every(
        Number.isSafeInteger,
      ) ||
      page.after < 0 ||
      page.after > replay.watermark ||
      page.scanned_through < page.after ||
      page.scanned_through > page.high_water ||
      !Array.isArray(page.records) ||
      page.records.some(
        (record) =>
          !Number.isSafeInteger(record.sequence) ||
          record.sequence <= page.after ||
          record.sequence > page.scanned_through,
      )
    )
      return;
    const records = new Map(
      replay.records.map((record) => [record.sequence, record]),
    );
    for (const record of page.records) records.set(record.sequence, record);
    replay.records = [...records.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    if (page.graph) (replay.graphs ??= []).push(page.graph);
    if (!page.error)
      replay.watermark = Math.max(replay.watermark, page.scanned_through);
    this.update({
      popup: {
        ...this.state.popup,
        detail: {
          ...this.state.popup.detail,
          display_records: replay.records,
          display_graph_pages: replay.graphs,
          display_coverage: page.coverage,
        },
      },
    });
  }
  private displayFragments = new DisplayFragments();
  private receiveQueue: {
    event: NativeEvent;
    subscription: NativeSubscription;
    bytes: number;
  }[] = [];
  private receiveQueueBytes = 0;
  private receiveTimer: ReturnType<typeof setTimeout> | null = null;
  private drainingReceive = false;
  private receiveSuspended: NativeSubscription | null = null;
  private suspendReceive(reconnect = true) {
    const subscription = this.subscription;
    if (!subscription || this.receiveSuspended === subscription) return;
    this.flushReceivedDisplay();
    this.receiveSuspended = subscription;
    if (this.receiveTimer !== null) clearTimeout(this.receiveTimer);
    this.receiveTimer = null;
    this.receiveQueue = [];
    this.receiveQueueBytes = 0;
    this.displayFragments = new DisplayFragments();
    if (reconnect) this.sessionSocket?.reconnect();
  }
  private pendingDisplayProjection: {
    transcript: Transcript;
    sessionId: string;
  } | null = null;
  private flushReceivedDisplay() {
    const pending = this.pendingDisplayProjection;
    this.pendingDisplayProjection = null;
    if (!pending || pending.transcript !== this.state.transcript) return;
    flushProjectedDisplay(pending.transcript, pending.sessionId);
    this.update({ transcript: { ...pending.transcript } });
  }
  private receive(event: NativeEvent) {
    const subscription = this.subscription;
    if (!subscription || this.receiveSuspended === subscription) return;
    if (
      !this.drainingReceive &&
      (this.receiveQueue.length ||
        event.event === "display.batch" ||
        event.event === "display.settled" ||
        event.event === "display.fragment")
    ) {
      // Account every decoded payload, including large tool/execution events
      // queued behind catch-up; never underestimate them as fixed-size notices.
      const bytes = JSON.stringify(event).length * 2;
      if (
        this.receiveQueue.length >= 512 ||
        this.receiveQueueBytes + bytes > 128 * 1024 * 1024
      ) {
        this.receiveQueue = [];
        this.receiveQueueBytes = 0;
        this.displayFragments = new DisplayFragments();
        reportDiagnostic(
          "session_socket",
          "catchup_queue",
          {
            code: "catchup_overflow",
            message: "Display catch-up queue exceeded its byte budget",
          },
          undefined,
          "warn",
        );
        this.suspendReceive();
        return;
      }
      this.receiveQueue.push({ event, subscription, bytes });
      this.receiveQueueBytes += bytes;
      if (this.receiveTimer === null)
        this.receiveTimer = setTimeout(() => this.drainReceive(), 0);
      return;
    }
    this.receiveNow(event);
  }
  private drainReceive() {
    this.receiveTimer = null;
    const started = performance.now();
    this.drainingReceive = true;
    try {
      do {
        const next = this.receiveQueue.shift();
        if (!next) break;
        this.receiveQueueBytes -= next.bytes;
        // A replacement subscribe owns its own ordered stream. Unprocessed old
        // bytes never certify receipt on that replacement's watermark.
        if (next.subscription === this.subscription)
          this.receiveNow(next.event);
      } while (this.receiveQueue.length && performance.now() - started < 8);
    } finally {
      this.flushReceivedDisplay();
      this.drainingReceive = false;
      if (this.receiveQueue.length && this.receiveTimer === null)
        this.receiveTimer = setTimeout(() => this.drainReceive(), 0);
    }
  }
  private receiveNow(event: NativeEvent) {
    if (!this.subscription || this.receiveSuspended === this.subscription)
      return;
    const order = subscriptionOrder(this.subscription, event);
    if (order === "other" || order === "duplicate") return;
    if (event.event === "turn")
      this.plugins.registry?.observe("runtime-event", {
        event: "turn",
        operation_id: event.data.id ?? null,
        status: event.data.status ?? null,
        method: event.data.method ?? null,
      });
    if (event.event === "session")
      this.plugins.registry?.observe("runtime-event", {
        event: "session",
        session_id: event.data.id,
        status: event.data.status,
      });
    if (
      event.event === "host_detached" &&
      event.generation === this.subscription.generation
    ) {
      const projectId = this.state.sessions.find(
        (session) => session.id === event.session_id,
      )?.projectID;
      // project.attach deliberately suspends the previous Session admission.
      // Its generation-less notice must not revoke the replacement attempt.
      // Attachment identity and explicit session.open + subscribe below still
      // have to succeed; relay failures and detached API responses remain fatal.
      const establishing =
        this.hostAttachment?.attempt === this.hostAttempt &&
        this.hostAttachment?.projectId === projectId;
      if (!establishing) {
        const data = event.data as { readiness?: NativeHostReadiness };
        this.suspendHost(projectId ?? undefined, undefined, data.readiness);
      }
    }
    if (order === "gap" || event.event === "resync_required") {
      // A transport gap suspends advisory updates, not already witnessed model
      // responses or execution details. The replacement barrier arrives through
      // `resubscribed` and reconciles retained identities in place.
      this.flushReceivedDisplay();
      suspendPreviews(this.state.transcript);
      this.update({ transcript: { ...this.state.transcript } });
      if (
        this.state.sessionAttachingId &&
        this.state.sessionAttachingId !== this.state.sessionId
      ) {
        // The explicit target owns the next selection. Retain this recovery
        // only for a failed target; a successful commit releases the old socket.
        this.deferredSessionRecovery = this.sessionSocket;
        this.suspendReceive(false);
      } else this.suspendReceive();
      return;
    }
    this.subscription.sequence = event.sequence;
    const assembled = this.displayFragments.receive(event);
    if (!assembled) {
      const failure = this.displayFragments.takeFailure();
      if (failure) {
        reportDiagnostic(
          "session_socket",
          "display_fragment",
          {
            code: "display_fragment_invalid",
            message: failure,
          },
          undefined,
          "warn",
        );
        this.suspendReceive();
      }
      return;
    }
    event = assembled;
    const deferredDisplay =
      this.drainingReceive &&
      (event.event === "display.batch" || event.event === "display.settled") &&
      !event.data.child_session_id;
    if (!deferredDisplay) this.flushReceivedDisplay();
    if (this.fenced(event)) return;
    if (deferredDisplay) {
      applyEvent(this.state.transcript, event, false);
      this.pendingDisplayProjection = {
        transcript: this.state.transcript,
        sessionId: event.session_id,
      };
      return;
    }
    switch (event.event) {
      case "display.batch":
      case "display.settled":
        if (event.data.child_session_id) {
          this.receiveChildDisplay(event.data);
          return;
        }
        break;
      case "round_limit.requested":
      case "round_limit.settled":
        this.roundLimits.receive(event);
        break;
      case "permission.updated":
      case "permission.requested": {
        const request = event.data.request;
        if (
          request?.parent_session_id === this.state.sessionId &&
          !this.permissionSettled.has(request.request_id)
        ) {
          this.permissionEventVersion++;
          this.permissionRequests.set(request.request_id, request);
          this.projectPermissions();
        }
        break;
      }
      case "permission.proposal.requested": {
        const proposal = event.data.proposal;
        if (
          proposal.parent_session_id === this.state.sessionId &&
          !this.proposalSettled.has(proposal.proposal_id)
        ) {
          this.permissionProposals.set(proposal.proposal_id, proposal);
          this.projectPermissions();
        }
        break;
      }
      case "permission.proposal.settled": {
        this.proposalSettled.add(event.data.proposal_id);
        this.permissionProposals.delete(event.data.proposal_id);
        this.proposalSubmitting.delete(event.data.proposal_id);
        this.projectPermissions();
        this.toast(
          t(`permission.proposal.${event.data.status}`) +
            (event.data.reason ? ` · ${event.data.reason}` : ""),
        );
        break;
      }
      case "permission.settled": {
        const settled = event.data;
        if (settled.parent_session_id === this.state.sessionId) {
          this.update({
            permissionDecisions: retainPermissionDecisions(
              this.state.permissionDecisions ?? [],
              [settled],
              this.state.sessionId,
            ),
          });
          this.permissionEventVersion++;
          if (settled.source === "review")
            this.toast(
              t("permission.autoDecision", {
                action: t(`permission.action.${settled.decision}`),
                reason: settled.review_reason ?? settled.reason ?? "",
              }),
            );
          this.permissionSettled.add(settled.request_id);
          this.permissionRequests.delete(settled.request_id);
          this.permissionSubmitting.delete(settled.request_id);
          this.projectPermissions();
        }
        break;
      }
      case "client_tools.lease_changed":
        this.clientTools.leaseChanged(event.data.executor_connected);
        break;
      case "client_tool.requested":
      case "client_tool.prepared":
      case "client_tool.paused":
      case "client_tool.settled":
      case "client_tool.cancel_requested":
        this.clientTools.receive(event.event, event.data.call);
        break;
      case "statistics.updated":
        if (isNativeStatistics(event.data)) {
          this.subscription.snapshot = {
            ...this.subscription.snapshot,
            statistics: event.data,
          };
          this.update({ statistics: event.data });
        }
        return;
      case "compaction":
        this.compactLifecycle(event.session_id, event.data);
        break;
      case "executions.updated": {
        this.executionHistoryRevision++;
        const items = event.data.items;
        this.update({
          executionHistory: items,
        });
        this.subscription.snapshot = {
          ...this.subscription.snapshot,
          executions: items,
          executions_omitted: false,
        };
        break;
      }
      case "audit.available":
        this.update({ auditRevision: (this.state.auditRevision ?? 0) + 1 });
        return;
      case "session.meta":
      case "blocks.page":
      case "blocks.upsert": {
        const next = materialize(
          this.subscription.snapshot,
          event.event,
          event.data,
        );
        if (next.incomplete) this.sessionSocket?.reconnect();
        else
          this.snapshot(
            next.view,
            undefined,
            next.view,
            event.event === "session.meta",
          );
        return;
      }
      case "history.reset":
        this.update({
          transcript: {
            ...this.state.transcript,
            historyResetRevision:
              (this.state.transcript.historyResetRevision ?? 0) + 1,
          },
        });
        this.plugins.resetHistory();
        return; // The authoritative blocks.page follows on this subscription.
      case "tool":
        applyEvent(this.state.transcript, event);
        void this.hydrateExecution(event);
        break;
      case "session":
        applyEvent(this.state.transcript, event);
        this.upsert(event.data);
        break;
      case "turn":
        applyEvent(this.state.transcript, event);
        this.reconcileSubmission(event.data);
        break;
      case "model_observation":
      case "display.fragment":
      case "display.unavailable":
      case "child.display.available":
      case "child.display.unavailable":
      case "host_detached":
      case "host_connection":
      case "resync_required":
        // Fragment and resync frames are normally consumed above. Remaining
        // advisory facts retain their existing projector/update path.
        break;
      default: {
        const unhandled: never = event;
        return unhandled;
      }
    }
    // Tool, Session and Turn require projection before their side effects above.
    if (
      event.event !== "tool" &&
      event.event !== "session" &&
      event.event !== "turn"
    )
      applyEvent(this.state.transcript, event);
    this.update({
      transcript: { ...this.state.transcript },
    });
  }
  /** Finish the generating blocks where they are, without waiting for the
   * runtime: text already shown is kept verbatim and nothing is re-rendered
   * but those live blocks. */
  private stopLocally(sessionId: string) {
    this.releaseInterrupt();
    const transcript = this.state.transcript;
    const operations = new Set<string>(
      transcript.turnLifecycle?.sessionId === sessionId
        ? transcript.turnLifecycle.activeOperationIds
        : [],
    );
    const stopped: Block[] = [];
    for (const block of transcript.blocks) {
      if (block.stream !== "streaming") continue;
      block.stream = "stopped";
      stopped.push(block);
      if (block.preview) operations.add(block.preview.operationId ?? "");
    }
    let release = () => {};
    const settled = new Promise<void>((resolve) => (release = resolve));
    const fence = {
      sessionId,
      operations,
      stopped,
      any: operations.size === 0,
      settled,
      release,
    };
    this.interruptFence = fence;
    this.update({ transcript: { ...transcript, interrupting: true } });
    return fence;
  }
  private releaseInterrupt() {
    const fence = this.interruptFence;
    if (!fence) return;
    this.interruptFence = null;
    fence.release();
    if (this.state.transcript.interrupting)
      this.update({
        transcript: { ...this.state.transcript, interrupting: false },
      });
  }
  /** Drops the stopped turn's late live deltas; lifts once it settles or a
   * new turn starts. */
  private fenced(event: NativeEvent) {
    const fence = this.interruptFence;
    if (!fence) return false;
    if (fence.sessionId !== this.state.sessionId) {
      this.releaseInterrupt();
      return false;
    }
    if (event.session_id !== fence.sessionId) return false;
    const data = (event.data ?? {}) as Record<string, any>;
    if (event.event === "model_observation") {
      const operation = data.operation_id ?? "";
      return (
        LIVE_PHASES.has(data.phase) &&
        (fence.any || fence.operations.has(operation))
      );
    }
    if (event.event === "session" && data.status !== "running")
      queueMicrotask(
        () => this.interruptFence === fence && this.releaseInterrupt(),
      );
    if (event.event === "turn" && typeof data.id === "string") {
      const active = data.status === "accepted" || data.status === "running";
      if (active && !fence.operations.has(data.id) && !fence.any)
        this.releaseInterrupt();
    }
    return false;
  }
  private unknownSubmissions = new Map<
    string,
    {
      operationId: string;
      text: string;
      imageIds: string[];
      epoch: number;
      route: number;
      status?: NativeOperation["status"];
    }
  >();
  private inboxRequests = new Map<
    string,
    {
      operationId: string;
      method: "turn.queue" | "turn.steer";
      text: string;
      imageIds: string[];
      epoch: number;
      route: number;
    }
  >();
  private retryRequests = new Map<
    string,
    { operationId: string; route: number; history: string }
  >();
  private inboxEdits = new Map<
    string,
    {
      key: string;
      sessionId: string;
      inboxId: string;
      method: string;
      route: number;
      expectedRevision: number;
      take: boolean;
      epoch: number;
      observed?: boolean;
      terminalPayloadRead?: boolean;
    }
  >();
  private async observeInboxEdit(operationId: string, terminalPayload = false) {
    const request = this.inboxEdits.get(operationId);
    if (
      !request ||
      (terminalPayload ? request.terminalPayloadRead : request.observed)
    )
      return;
    if (terminalPayload) request.terminalPayloadRead = true;
    else request.observed = true;
    const cycle = this.lifecycle;
    try {
      const receipt = await this.call<NativeOperation>(
        "turn.get",
        { operation_id: operationId },
        request.sessionId,
      );
      if (cycle === this.lifecycle) this.reconcileSubmission(receipt);
    } catch {
      /* One observation only; later full terminal receipts may still settle. */
    }
  }
  private reconcileSubmission(receipt: NativeOperation) {
    if (!OPEN_RECEIPT.has(receipt.status)) this.plugins.forget(receipt.id);
    const edit = this.inboxEdits.get(receipt.id);
    if (
      edit &&
      receipt.session_id === edit.sessionId &&
      receipt.method === edit.method &&
      !OPEN_RECEIPT.has(receipt.status)
    ) {
      const result = receipt.result as {
        item?: {
          input?: NonNullable<AppState["inboxRetrieved"]>[string]["input"];
        };
        error?: { message?: string };
      } | null;
      if (
        edit.take &&
        receipt.status === "completed" &&
        !result?.item?.input?.parts
      ) {
        void this.observeInboxEdit(receipt.id, true);
        return;
      }
      this.inboxEdits.delete(receipt.id);
      if (edit.take && receipt.status === "completed") {
        const input = result?.item?.input;
        if (input?.parts) {
          this.update({
            inboxRetrieved: {
              ...this.state.inboxRetrieved,
              [edit.sessionId]: { operationId: receipt.id, input },
            },
          });
          if (
            edit.route === this.composerRoute &&
            edit.epoch === this.draftEpoch &&
            edit.sessionId === this.state.sessionId &&
            edit.inboxId === this.state.transcript.inboxId
          )
            this.restoreInboxInput();
        }
      }
      const prior = this.state.inboxMutations?.[edit.key];
      if (prior?.operationId === receipt.id) {
        const reason = result?.error?.message;
        if (
          receipt.status !== "completed" &&
          edit.sessionId === this.state.sessionId &&
          edit.route === this.composerRoute
        )
          this.toast(
            t("composer.inbox.mutationFailed", {
              reason: reason ?? receipt.status,
            }),
            "error",
          );
        this.update({
          inboxMutations: {
            ...this.state.inboxMutations,
            [edit.key]: {
              ...prior,
              status: receipt.status,
              error:
                receipt.status === "completed"
                  ? undefined
                  : t("composer.inbox.mutationFailed", {
                      reason: reason ?? receipt.status,
                    }),
            },
          },
        });
      }
    }
    const inbox = this.inboxRequests.get(receipt.session_id);
    if (
      inbox &&
      receipt.id === inbox.operationId &&
      receipt.method === inbox.method &&
      !OPEN_RECEIPT.has(receipt.status)
    ) {
      this.inboxRequests.delete(receipt.session_id);
      if (receipt.session_id === this.state.sessionId) {
        if (
          receipt.status === "completed" &&
          inbox.epoch === this.draftEpoch &&
          inbox.route === this.composerRoute &&
          this.state.composer === inbox.text &&
          !this.state.imageIntakePending &&
          sameImageIds(this.state.composerImages, inbox.imageIds)
        )
          this.clearComposer();
        this.update({ inboxPending: false });
        if (FAILED_RECEIPT.has(receipt.status)) {
          const reason =
            (receipt.result as { error?: { message?: string } } | null)?.error
              ?.message ?? receipt.status;
          this.toast(t("composer.inbox.failed", { reason }), "error");
        }
      }
    }
    const retry = this.retryRequests.get(receipt.session_id);
    if (
      receipt.method === "turn.retry" &&
      retry &&
      receipt.id === retry.operationId &&
      receipt.status !== "unknown"
    ) {
      if (
        receipt.session_id === this.state.sessionId &&
        retry.route === this.composerRoute &&
        retry.history === JSON.stringify(this.state.history)
      )
        projectRetryReceipt(this.state.transcript, receipt);
      this.retryRequests.delete(receipt.session_id);
      if (receipt.session_id === this.state.sessionId)
        this.update({
          retryPending: false,
          retryOperationId:
            receipt.status === "failed" &&
            this.state.retryOperationId === receipt.id
              ? receipt.id
              : null,
        });
    }
    const pending = this.unknownSubmissions.get(receipt.session_id);
    if (
      !pending ||
      receipt.id !== pending.operationId ||
      !["turn.submit", "turn.queue"].includes(receipt.method) ||
      receipt.status === "unknown" ||
      (receipt.method === "turn.queue" &&
        ["accepted", "running"].includes(receipt.status))
    )
      return;
    pending.status = receipt.status;
    // Queue completion certifies retention in the inbox, never model completion.
    if (
      receipt.session_id === this.state.sessionId &&
      receipt.method === "turn.queue" &&
      receipt.status === "completed"
    ) {
      this.state.transcript = {
        ...this.state.transcript,
        blocks: this.state.transcript.blocks.map((block) =>
          block.temporary &&
          block.role === "user" && isDirectUserSource(block.payload.source) &&
          block.operationId === receipt.id
            ? { ...block, submissionStatus: "admitted" as const }
            : block,
        ),
      };
    }
    this.unknownSubmissions.delete(receipt.session_id);
    if (receipt.session_id !== this.state.sessionId) return;
    if (
      ["accepted", "running", "completed"].includes(receipt.status) &&
      pending.epoch === this.draftEpoch &&
      pending.route === this.composerRoute &&
      this.state.composer === pending.text &&
      sameImageIds(this.state.composerImages, pending.imageIds)
    )
      this.clearComposer();
    if (
      FAILED_RECEIPT.has(receipt.status) &&
      pending.route === this.composerRoute
    ) {
      const error = (
        receipt.result as { error?: { code?: string; message?: string } } | null
      )?.error;
      const reason =
        error?.code === "continuation_pending"
          ? failureText(error)
          : (error?.message ?? t(`execution.status.${receipt.status}`));
      this.update({
        transcript: {
          ...this.state.transcript,
          blocks: this.state.transcript.blocks.filter(
            (block) =>
              !(
                block.temporary &&
                block.role === "user" && isDirectUserSource(block.payload.source) &&
                block.operationId === receipt.id
              ),
          ),
        },
      });
      this.toast(t("composer.submit.failed", { reason }), "error");
    }
    this.update({ isCreatingSession: false });
  }
  private draftEpoch = 0;
  private intakeCount = 0;
  private compactTerminal = new Set<string>();
  private compactDraft: {
    operationId: string;
    text: string;
    epoch: number;
  } | null = null;
  private clearComposer() {
    ++this.draftEpoch;
    this.intakeCount = 0;
    for (const image of this.state.composerImages)
      URL.revokeObjectURL(image.previewUrl);
    this.update({
      composer: "",
      composerImages: [],
      imageIntakePending: false,
    });
  }
  private editableComposer() {
    const selected = this.state.sessions.find(
      (item) => item.id === this.state.sessionId,
    );
    return (
      this.state.connection === "ws" &&
      !!this.state.authSession?.authenticated &&
      userTaskInputAllowed(selected, this.state.publicState)
    );
  }
  private async pasteImages(files: File[]) {
    if (!this.editableComposer() || !files.length) return;
    if (this.state.capabilities?.features.image_data !== true)
      throw Error(t("composer.images.unsupported"));
    const epoch = this.draftEpoch,
      route = this.composerRoute,
      cycle = this.lifecycle;
    const id = this.state.sessionId,
      project = this.state.draftWorkspace.projectId;
    const current = () =>
      epoch === this.draftEpoch &&
      route === this.composerRoute &&
      cycle === this.lifecycle &&
      id === this.state.sessionId &&
      project === this.state.draftWorkspace.projectId;
    const budget = this.state.capabilities?.limits.command_bytes ?? 1024 * 1024;
    this.intakeCount++;
    this.update({ imageIntakePending: true });
    const prepared: ComposerImage[] = [];
    try {
      validateImageBatch(
        [
          ...this.state.composerImages,
          ...files.map((file) => ({
            id: "",
            name: file.name,
            mediaType: file.type,
            file,
            previewUrl: "",
          })),
        ],
        this.state.capabilities?.limits,
      );
      for (const file of files) {
        await validateImageFile(file, this.state.capabilities?.limits);
        if (!current()) return;
        prepared.push({
          id: crypto.randomUUID(),
          name: file.name,
          mediaType: file.type,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }
      if (!current()) return;
      validateImageBatch(
        [...this.state.composerImages, ...prepared],
        this.state.capabilities?.limits,
      );
      if (
        !turnFitsBudget(
          this.state.composer,
          [...this.state.composerImages, ...prepared],
          budget,
        )
      )
        throw Error(t("composer.images.tooLarge"));
      this.update({
        composerImages: [...this.state.composerImages, ...prepared],
      });
      prepared.length = 0; // Current draft now owns every object URL.
    } finally {
      for (const image of prepared) URL.revokeObjectURL(image.previewUrl);
      if (current()) {
        this.intakeCount--;
        this.update({ imageIntakePending: this.intakeCount > 0 });
      }
    }
  }
  /** Configuration acknowledgement carries no canonical/history range authority.
   * Merge only configured facts into the latest subscription; never roll back a
   * newer live operation, statistics or retained display suffix with an HTTP view. */
  private configurationReceipt(session: NativeSession) {
    const existing = this.state.sessions.find((item) => item.id === session.id);
    if (
      session.id !== this.state.sessionId ||
      session.revision < (existing?.revision ?? 0)
    )
      return;
    const current = this.subscription?.snapshot;
    if (!current || current.session.id !== session.id) return;
    if (session.revision < current.session.revision) return;
    const newerConfiguration = session.revision > current.session.revision;
    // null is an ordered fact (unknown applied route / no unfinished Turn).
    // Only an absent field can use the initial receipt as its first evidence.
    const applied =
      current.session.applied_model_selection !== undefined
        ? current.session.applied_model_selection
        : session.applied_model_selection;
    const turn =
      current.session.turn_model_selection !== undefined
        ? current.session.turn_model_selection
        : session.turn_model_selection;
    const configured = newerConfiguration
      ? session.model_selection
      : current.session.model_selection;
    const normalize = (selection: NativeSession["model_selection"]) =>
      selection
        ? JSON.stringify([
            selection.provider_id,
            selection.model,
            selection.variant ?? null,
          ])
        : null;
    const pending =
      !newerConfiguration && current.session.pending_model_change !== undefined
        ? current.session.pending_model_change
        : applied
          ? normalize(configured) !== normalize(applied)
          : session.pending_model_change;
    const metadata = {
      ...current.session,
      revision: session.revision,
      updated_at_ms: newerConfiguration
        ? session.updated_at_ms
        : current.session.updated_at_ms,
      model: newerConfiguration ? session.model : current.session.model,
      model_selection: configured,
      applied_model_selection: applied,
      turn_model_selection: turn,
      pending_model_change: pending,
      mode: newerConfiguration ? session.mode : current.session.mode,
    };
    this.subscription!.snapshot = { ...current, session: metadata };
    this.upsert(metadata);
    this.update({
      sessions: [...this.state.sessions],
      draftMode: metadata.mode ?? "",
    });
  }

  private async setMode(mode: string, requestedAgent?: string) {
    const state = this.state;
    const selected = state.sessions.find((item) => item.id === state.sessionId);
    const name = selected?.agent ?? state.draftAgent;
    const agent = state.agents.find(
      (item) => item.name === (requestedAgent ?? name),
    );
    if (
      !this.editableComposer() ||
      selected?.archived ||
      state.isCreatingSession ||
      state.modeSelectionPending ||
      state.modelSelectionPending ||
      !hostReadiness(state).ready ||
      (!!state.sessionId && !this.supports("session.set_mode"))
    )
      throw Error(t("composer.mode.unavailable"));
    if (
      !agent ||
      !agent.modes.some(
        (item) => item.name === mode && item.role !== "sub_agent",
      )
    )
      throw Error(t("composer.mode.empty"));
    if (!state.sessionId) {
      this.draftAgentExplicit = true;
      this.draftModeExplicit = true;
      this.update({ draftAgent: agent.name, draftMode: mode });
      return;
    }
    if (agent.name !== name) throw Error(t("composer.mode.pinned"));
    const id = state.sessionId,
      route = this.composerRoute,
      cycle = this.lifecycle;
    this.update({ modeSelectionPending: true });
    try {
      const snapshot = await this.call<NativeSnapshot>(
        "session.set_mode",
        { mode, expected_revision: selected?.revision },
        id,
      );
      if (
        cycle !== this.lifecycle ||
        route !== this.composerRoute ||
        this.state.sessionId !== id
      )
        return;
      const current = this.state.sessions.find((item) => item.id === id);
      if (snapshot.session.revision < (current?.revision ?? 0)) return;
      this.configurationReceipt(snapshot.session);
    } finally {
      if (
        cycle === this.lifecycle &&
        route === this.composerRoute &&
        this.state.sessionId === id
      )
        this.update({ modeSelectionPending: false });
    }
  }
  private syncCompact(snapshot: NativeSnapshot) {
    const current = this.state.compactOperation;
    const operations = snapshot.operations.filter(
      (operation) => operation.method === "session.compact",
    );
    const active = operations.find(
      (operation) =>
        ["accepted", "running"].includes(operation.status) &&
        !this.compactTerminal.has(operation.id),
    );
    if (active) {
      this.update({
        compactInflight: true,
        compactOperation: {
          operation_id: active.id,
          sessionId: snapshot.session.id,
          instruction:
            current?.operation_id === active.id ? current.instruction : "",
          status: "running",
        },
      });
    } else if (current?.sessionId === snapshot.session.id) {
      const receipt = operations.find(
        (operation) => operation.id === current.operation_id,
      );
      if (
        receipt &&
        !["accepted", "running", "unknown"].includes(receipt.status)
      )
        this.compactLifecycle(snapshot.session.id, {
          operation_id: receipt.id,
          status:
            receipt.status === "completed"
              ? "completed"
              : receipt.status === "cancelled"
                ? "cancelled"
                : "failed",
          error: (receipt.result as any)?.error,
        });
    } else this.update({ compactInflight: false, compactOperation: null });
  }
  private compactLifecycle(sessionId: string, event: CompactLifecycle) {
    if (sessionId !== this.state.sessionId) return;
    const prior = this.state.compactOperation;
    if (
      event.status === "running" &&
      this.compactTerminal.has(event.operation_id)
    )
      return;
    if (
      prior?.sessionId === sessionId &&
      prior.operation_id !== event.operation_id &&
      prior.status === "running"
    )
      return;
    const terminal = event.status !== "running";
    if (terminal) this.compactTerminal.add(event.operation_id);
    this.update({
      compactInflight: !terminal,
      compactOperation: {
        ...event,
        sessionId,
        instruction:
          prior?.operation_id === event.operation_id ? prior.instruction : "",
      },
      transcript: { ...this.state.transcript, compactionActive: !terminal },
    });
    if (
      event.status === "completed" &&
      this.compactDraft?.operationId === event.operation_id &&
      this.compactDraft.epoch === this.draftEpoch &&
      this.state.composer === this.compactDraft.text
    )
      this.clearComposer();
    if (terminal && this.compactDraft?.operationId === event.operation_id)
      this.compactDraft = null;
  }
  private recoveryActive = new Set<string>();
  private recoveryRequests = new Map<
    string,
    { operationId: string; method: string }
  >();
  private async recoverSession(
    method: "session.retry_agent_init" | "session.retry_auto_compaction",
  ) {
    const id = this.state.sessionId,
      snapshot = this.subscription?.snapshot;
    if (
      !id ||
      snapshot?.session.id !== id ||
      snapshot.session.archived ||
      this.recoveryActive.has(id) ||
      this.state.transcript.sessionStatus === "running"
    )
      throw Error(t("sessionRecovery.unavailable"));
    const previous = this.recoveryRequests.get(id);
    if (previous && previous.method !== method)
      throw Error(t("sessionRecovery.checkFirst"));
    const operationId = previous?.operationId ?? crypto.randomUUID(),
      cycle = this.lifecycle;
    this.recoveryRequests.set(id, { operationId, method });
    this.recoveryActive.add(id);
    this.update({
      sessionRecoveryPending: true,
      sessionRecoveryUnknown: !!previous,
    });
    try {
      if (previous) {
        const receipt = await this.call<NativeOperation>(
          "turn.get",
          { operation_id: operationId },
          id,
        );
        if (
          receipt.session_id !== id ||
          receipt.id !== operationId ||
          receipt.method !== method
        )
          throw Error(t("sessionRecovery.checkFirst"));
        if (["accepted", "running", "unknown"].includes(receipt.status)) return;
      } else {
        const result = await this.call<NativeSnapshot | { compacted: boolean }>(
          method,
          {
            operation_id: operationId,
            expected_revision: snapshot.session.revision,
          },
          id,
        );
        if (
          method === "session.retry_agent_init" &&
          "session" in result &&
          cycle === this.lifecycle &&
          this.state.sessionId === id
        )
          this.snapshot(result);
      }
      this.recoveryRequests.delete(id);
    } catch (error) {
      if (!previous && !(error instanceof CommandError && error.outcomeUnknown))
        this.recoveryRequests.delete(id);
      throw error;
    } finally {
      this.recoveryActive.delete(id);
      if (cycle === this.lifecycle && this.state.sessionId === id)
        this.update({
          sessionRecoveryPending: false,
          sessionRecoveryUnknown: this.recoveryRequests.has(id),
        });
    }
  }
  private async compact(instruction: string, sourceDraft?: string) {
    const id = this.state.sessionId,
      selected = this.state.sessions.find((item) => item.id === id);
    if (
      !id ||
      !this.supports("session.compact") ||
      !this.editableComposer() ||
      selected?.archived ||
      this.state.transcript.sessionStatus !== "idle" ||
      this.state.transcript.inboxActive ||
      this.state.compactInflight ||
      this.state.isCreatingSession ||
      this.state.modeSelectionPending
    )
      throw Error(t("composer.compact.unavailable"));
    if (new TextEncoder().encode(instruction).byteLength > 32768)
      throw Error(t("composer.compact.tooLarge"));
    const operationId = crypto.randomUUID(),
      cycle = this.lifecycle,
      route = this.composerRoute;
    if (sourceDraft !== undefined)
      this.compactDraft = {
        operationId,
        text: sourceDraft,
        epoch: this.draftEpoch,
      };
    this.update({
      compactInflight: true,
      compactOperation: {
        sessionId: id,
        operation_id: operationId,
        instruction,
        status: "running",
      },
    });
    try {
      const snapshot = await this.call<NativeSnapshot>(
        "session.compact",
        { instruction, operation_id: operationId },
        id,
      );
      if (
        cycle !== this.lifecycle ||
        route !== this.composerRoute ||
        id !== this.state.sessionId
      )
        return;
      const current = this.state.sessions.find((item) => item.id === id);
      if (snapshot.session.revision >= (current?.revision ?? 0))
        this.snapshot(snapshot);
    } catch (error) {
      if (
        cycle === this.lifecycle &&
        route === this.composerRoute &&
        id === this.state.sessionId
      ) {
        if (this.compactTerminal.has(operationId)) return;
        if (error instanceof CommandError && error.outcomeUnknown) {
          this.update({
            compactOperation: {
              ...this.state.compactOperation!,
              outcomeUnknown: true,
            },
          });
          void this.call<NativeOperation>(
            "turn.get",
            { operation_id: operationId },
            id,
          )
            .then((receipt) => {
              if (
                cycle !== this.lifecycle ||
                route !== this.composerRoute ||
                id !== this.state.sessionId ||
                receipt.session_id !== id ||
                receipt.id !== operationId ||
                receipt.method !== "session.compact"
              )
                return;
              if (
                ["accepted", "running"].includes(receipt.status) &&
                !this.compactTerminal.has(operationId)
              )
                this.update({
                  compactOperation: {
                    ...this.state.compactOperation!,
                    outcomeUnknown: false,
                  },
                });
              if (!["accepted", "running", "unknown"].includes(receipt.status))
                this.compactLifecycle(id, {
                  operation_id: receipt.id,
                  status:
                    receipt.status === "completed"
                      ? "completed"
                      : receipt.status === "cancelled"
                        ? "cancelled"
                        : "failed",
                  error: (receipt.result as any)?.error,
                });
            })
            .catch(() => {
              /* Uncertain admission remains blocked until snapshot/receipt reconciliation. */
            });
        } else
          this.compactLifecycle(id, {
            operation_id: operationId,
            status: "failed",
            error: {
              code: error instanceof CommandError ? error.code : "failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
      }
      throw error;
    }
  }
  private restoreInboxInput() {
    const id = this.state.sessionId;
    const staged = id ? this.state.inboxRetrieved?.[id] : undefined;
    if (
      !id ||
      !staged ||
      !this.editableComposer() ||
      this.state.composer.length ||
      this.state.composerImages.length ||
      this.state.imageIntakePending ||
      !inboxInputEditable(staged.input)
    )
      return;
    this.clearComposer();
    const remaining = { ...this.state.inboxRetrieved };
    delete remaining[id];
    this.update({
      inboxRetrieved: remaining,
      composerFocusRequest: {
        sessionId: id,
        sequence: (this.state.composerFocusRequest?.sequence ?? 0) + 1,
      },
      composer: staged.input.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      composerImages: restoredImages(staged.input.parts, id, this.api),
    });
  }
  private async mutateInbox(action: AppAction) {
    const state = this.state,
      id = state.sessionId;
    const take = action.type === "TakeInboxInput";
    const resume = action.type === "ResumeInboxInput";
    const method = resume
      ? "inbox.resume"
      : action.type === "RemoveInboxInput" || take
        ? "inbox.remove"
        : "inbox.update";
    const itemId = String(action.itemId),
      inboxId = action.inboxId;
    const key = inboxItemKey(id ?? "", inboxId, itemId);
    const item = [...state.transcript.queue, ...state.transcript.steer].find(
      (entry) => entry.id === itemId,
    );
    const prior = state.inboxMutations?.[key];
    if (
      !id ||
      state.sessions.find((session) => session.id === id)?.archived ||
      !this.editableComposer() ||
      !hostReadiness(state).ready ||
      !state.capabilities?.methods.includes(method) ||
      state.historyMutationPending ||
      state.retryPending ||
      state.isCreatingSession ||
      state.compactInflight ||
      !inboxId ||
      inboxId !== state.transcript.inboxId ||
      !item ||
      item.inboxId !== inboxId ||
      item.claimed ||
      !Number.isSafeInteger(action.expectedRevision) ||
      action.expectedRevision !== item.revision ||
      inboxMutationBusy(prior?.status)
    )
      throw Error(t("composer.inbox.stale"));
    // [!important] Preserve pause and the existing queue/composer designs: only
    // an explicit witnessed resume may claim pending bytes; never copy or resend them.
    if (resume) {
      const oldest = [
        ...state.transcript.queue,
        ...state.transcript.steer,
      ].sort((a, b) => Number(a.id) - Number(b.id))[0];
      if (
        !state.sessions.some((session) => session.id === id) ||
        state.sessionAttachingId ||
        state.inboxPending ||
        item.sessionID !== id ||
        oldest?.id !== itemId ||
        !Number.isSafeInteger(Number(itemId)) ||
        Number(itemId) < 0 ||
        !state.transcript.inboxPaused ||
        state.transcript.inboxActive ||
        state.transcript.sessionStatus !== "idle" ||
        state.retryOperationId ||
        sessionInboxMutationBusy(state.inboxMutations, id)
      )
        throw Error(
          t(
            state.retryOperationId
              ? "composer.inbox.resumeRetry"
              : "composer.inbox.stale",
          ),
        );
    }
    if (
      take &&
      (state.composer.length ||
        state.composerImages.length ||
        state.imageIntakePending ||
        state.inboxRetrieved?.[id ?? ""] ||
        [...this.inboxEdits.values()].some(
          (request) => request.sessionId === id && request.take,
        ) ||
        !item?.input ||
        !inboxInputEditable(item.input))
    )
      throw Error(t("composer.inbox.takeUnavailable"));
    // Idle steer stays on the next turn and still consumes a revision. Refuse
    // it here so a queued row cannot report a force-send that did not happen.
    if (
      !resume &&
      action.mode === "steer" &&
      (!state.transcript.inboxActive || item.mode !== "queue")
    )
      throw Error(t("composer.inbox.forceSendUnavailable"));
    const params = {
      operation_id: crypto.randomUUID(),
      expected_inbox_id: inboxId,
      item_id: Number(itemId),
      expected_revision: action.expectedRevision,
      ...(!resume && action.input ? { input: action.input } : {}),
      ...(!resume && action.mode ? { mode: action.mode } : {}),
    };
    const cycle = this.lifecycle,
      route = this.composerRoute;
    this.inboxEdits.set(params.operation_id, {
      key,
      sessionId: id,
      inboxId,
      method,
      route,
      expectedRevision: action.expectedRevision,
      take,
      epoch: this.draftEpoch,
    });
    const setStatus = (status: string, error?: string) =>
      this.update({
        inboxMutations: {
          ...this.state.inboxMutations,
          [key]: {
            operationId: params.operation_id,
            status,
            error,
            expectedRevision: action.expectedRevision,
          },
        },
      });
    setStatus("pending");
    const current = () =>
      cycle === this.lifecycle &&
      route === this.composerRoute &&
      id === this.state.sessionId;
    try {
      if (!resume && action.input) {
        const input = await uploadInputImages(
          this.api,
          id,
          action.input,
          state.capabilities?.limits ?? {},
          current,
        );
        if (!input || !current()) {
          this.inboxEdits.delete(params.operation_id);
          return;
        }
        const transformed = await this.plugins.preprocess(
          input as PluginInput,
          params.operation_id,
          id,
          current,
        );
        if (!transformed || !current()) {
          this.inboxEdits.delete(params.operation_id);
          setStatus("cancelled");
          return;
        }
        params.input = transformed;
      }
      const receipt = await this.call<NativeOperation>(method, params, id);
      if (cycle !== this.lifecycle) return;
      this.reconcileSubmission(receipt);
    } catch (error) {
      if (cycle !== this.lifecycle || !this.inboxEdits.has(params.operation_id))
        return;
      if (error instanceof CommandError && error.outcomeUnknown) {
        setStatus("unknown", t("composer.inbox.mutationUnknown"));
        if (current()) this.toast(t("composer.inbox.mutationUnknown"), "error");
        await this.observeInboxEdit(params.operation_id);
        return;
      }
      this.plugins.forget(params.operation_id);
      this.inboxEdits.delete(params.operation_id);
      const message = t("composer.inbox.mutationFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      setStatus("failed", message);
      if (current()) this.toast(message, "error");
    }
  }
  private async submitInbox(mode: "queue" | "steer") {
    const state = this.state;
    const id = state.sessionId;
    const method = mode === "queue" ? "turn.queue" : "turn.steer";
    const selected = state.sessions.find((item) => item.id === id);
    if (
      !id ||
      !this.editableComposer() ||
      selected?.archived ||
      !state.capabilities?.methods.includes(method) ||
      this.inboxRequests.has(id) ||
      state.isCreatingSession ||
      state.modelSelectionPending ||
      state.modeSelectionPending ||
      state.imageIntakePending ||
      state.historyMutationPending ||
      state.inboxPending ||
      state.retryPending ||
      state.compactInflight
    )
      throw Error(t("composer.inbox.unavailable"));
    if (!hostReadiness(state).ready) {
      this.update({
        popup: {
          type: "remoteConnect",
          projectId: hostReadiness(this.state).projectId,
        },
      });
      throw Error(t("host.readiness.unavailable"));
    }
    const text = state.composer;
    let images = [...state.composerImages];
    if (!text.trim() && !images.length) return;
    if (images.length && state.capabilities?.features.image_data !== true)
      throw Error(t("composer.images.unsupported"));
    if (parseSlash(text)) throw Error(t("composer.inbox.unavailable"));
    if (
      !turnFitsBudget(
        text,
        images,
        state.capabilities?.limits.command_bytes ?? 1024 * 1024,
      )
    )
      throw Error(t("composer.images.tooLarge"));
    const operationId = crypto.randomUUID();
    const cycle = this.lifecycle;
    const route = this.composerRoute;
    this.inboxRequests.set(id, {
      operationId,
      method,
      text,
      imageIds: images.map((image) => image.id),
      epoch: this.draftEpoch,
      route,
    });
    this.update({ inboxPending: true });
    const current = () =>
      cycle === this.lifecycle &&
      route === this.composerRoute &&
      id === this.state.sessionId;
    try {
      const prepared = await uploadDraftImages(
        this.api,
        id,
        images,
        state.capabilities?.limits ?? {},
        () =>
          current() &&
          this.state.composer === text &&
          this.state.composerImages.length === images.length &&
          this.state.composerImages.every(
            (image, index) => image.id === images[index].id,
          ),
      );
      if (
        !prepared ||
        !current() ||
        this.state.composer !== text ||
        this.state.composerImages.length !== images.length ||
        !this.state.composerImages.every(
          (image, index) => image.id === images[index].id,
        )
      ) {
        if (this.inboxRequests.get(id)?.operationId === operationId)
          this.inboxRequests.delete(id);
        this.update({
          inboxPending: this.inboxRequests.has(this.state.sessionId ?? ""),
        });
        return;
      }
      images = prepared;
      const input = await this.plugins.preprocess(
        { parts: draftParts(text, images) },
        operationId,
        id,
        () =>
          current() &&
          this.state.composer === text &&
          sameImageIds(
            this.state.composerImages,
            images.map((image) => image.id),
          ),
      );
      if (!input || !current()) {
        this.inboxRequests.delete(id);
        this.update({
          inboxPending: this.inboxRequests.has(this.state.sessionId ?? ""),
        });
        return;
      }
      const receipt = await this.call<NativeOperation>(
        method,
        {
          operation_id: operationId,
          input,
        },
        id,
      );
      if (cycle !== this.lifecycle) return;
      this.reconcileSubmission(receipt);
      if (
        current() &&
        receipt.id === operationId &&
        receipt.session_id === id &&
        receipt.method === method &&
        receipt.status === "completed"
      )
        return { status: "completed" as const, sessionId: id };
    } catch (error) {
      if (cycle !== this.lifecycle) return;
      if (error instanceof CommandError && error.outcomeUnknown) {
        if (current()) this.toast(t("composer.inbox.unknown"), "error");
        // Observe the same identity once. Neither disconnect nor missing receipt
        // permits replaying an inbox mutation or constructing local queue state.
        try {
          const receipt = await this.call<NativeOperation>(
            "turn.get",
            { operation_id: operationId },
            id,
          );
          if (cycle !== this.lifecycle) return;
          const accepted =
            current() &&
            receipt.id === operationId &&
            receipt.session_id === id &&
            receipt.method === method &&
            receipt.status === "completed";
          this.reconcileSubmission(receipt);
          if (accepted) return { status: "completed" as const, sessionId: id };
        } catch {
          /* A later terminal receipt resolves uncertain admission. */
        }
        return;
      }
      this.plugins.forget(operationId);
      if (this.inboxRequests.get(id)?.operationId === operationId)
        this.inboxRequests.delete(id);
      if (current()) {
        this.update({ inboxPending: false });
        const reason = error instanceof Error ? error.message : String(error);
        this.toast(t("composer.inbox.failed", { reason }), "error");
      }
    }
  }
  private waitingSubmit = false;
  private async submit() {
    if (this.waitingSubmit) return;
    if (
      this.state.modelSelectionPending ||
      this.state.modeSelectionPending ||
      this.state.imageIntakePending ||
      this.state.historyMutationPending ||
      this.state.retryPending ||
      this.state.inboxPending
    )
      throw Error(t("composer.mode.unavailable"));
    if (!this.editableComposer()) throw Error(t("composer.mode.unavailable"));
    const slash = parseSlash(this.state.composer);
    if (slash) {
      if (slash.kind === "unknown")
        throw Error(t("composer.slash.unknown", { name: slash.name }));
      if (this.state.composerImages.length)
        throw Error(t("composer.slash.images"));
      return this.compact(slash.instruction, this.state.composer);
    }
    if (
      (!this.state.composer.trim() && !this.state.composerImages.length) ||
      this.state.isCreatingSession
    )
      return;
    if (this.state.compactInflight)
      throw Error(t("composer.compact.unavailable"));
    if (!this.state.sessionId && this.uncertainCreation)
      throw Error(
        "会话创建结果未知。请刷新会话列表并选择已创建的会话；确认后可显式新建会话。",
      );
    const stopping = this.interruptFence;
    // Capture the Send intent before yielding. A navigation, draft edit or
    // authority change cancels this continuation; it never submits a new draft.
    if (stopping && stopping.sessionId === this.state.sessionId) {
      const intent = {
        session: this.state.sessionId,
        cycle: this.lifecycle,
        route: this.composerRoute,
        epoch: this.draftEpoch,
        text: this.state.composer,
        images: [...this.state.composerImages],
      };
      this.waitingSubmit = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          stopping.settled.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 10_000);
          }),
        ]);
        if (
          intent.session !== this.state.sessionId ||
          intent.cycle !== this.lifecycle ||
          intent.route !== this.composerRoute ||
          intent.epoch !== this.draftEpoch ||
          intent.text !== this.state.composer ||
          !sameImageIds(
            this.state.composerImages,
            intent.images.map((image) => image.id),
          )
        )
          return;
        if (
          !settled ||
          this.interruptFence === stopping ||
          this.state.transcript.sessionStatus === "busy"
        ) {
          this.toast(t("composer.stopPending"));
          return;
        }
      } finally {
        clearTimeout(timer);
        this.waitingSubmit = false;
      }
    }
    const cycle = this.lifecycle;
    const host = hostReadiness(this.state);
    if (!host.ready) {
      this.update({
        popup: {
          type: "remoteConnect",
          projectId: hostReadiness(this.state).projectId,
        },
      });
      throw Error(t("host.readiness.unavailable"));
    }
    const text = this.state.composer;
    let images = [...this.state.composerImages];
    const epoch = this.draftEpoch;
    let route = this.composerRoute;
    const explicitModel = this.state.draftModel
      ? {
          provider_id: this.state.draftModel.providerId,
          model: this.state.draftModel.id,
          variant: this.state.draftModel.variant ?? null,
        }
      : null;
    const agentName = this.state.draftAgent,
      modeName = this.state.draftMode;
    const selectedAgent = this.state.agents.find(
      (item) => item.name === agentName,
    );
    if (
      !this.state.sessionId &&
      !selectedAgent?.modes.some(
        (mode) => mode.name === modeName && mode.role !== "sub_agent",
      )
    )
      throw Error(t("composer.mode.empty"));
    if (
      !turnFitsBudget(
        text,
        images,
        this.state.capabilities?.limits.command_bytes ?? 1024 * 1024,
      )
    )
      throw Error(t("composer.images.tooLarge"));
    const opId = crypto.randomUUID();
    let id = this.state.sessionId;
    let submitted = false;
    let admission:
      | {
          operationId: string;
          text: string;
          imageIds: string[];
          epoch: number;
          route: number;
          status?: NativeOperation["status"];
        }
      | undefined;

    // Preview is independent of draft object URLs; failed admission keeps the draft.
    const optimisticBlock = {
      ...createBlock(
        id || "draft",
        `user-optimistic-${opId}`,
        "text",
        "text",
        "user",
      ),
      payload: {
        text,
        mime: "text/markdown",
        formatHint: "markdown",
        attachments: images.map((image) => ({
          partId: image.id,
          name: image.name,
          mime: image.mediaType,
          url: image.data
            ? inlineImage(image.mediaType, image.data)
            : image.previewUrl,
        })),
        structured: null,
        content: [],
        outputPaths: [],
        providerMetadata: null,
      },
      temporary: true,
      submissionStatus: "submitting" as const,
      operationId: opId,
      stream: "complete",
    };

    this.update({
      isCreatingSession: true,
      transcript: {
        ...this.state.transcript,
        blocks: [...this.state.transcript.blocks, optimisticBlock],
        stickToBottom: true,
      },
    });

    try {
      if (!id) {
        const flavor = this.draftFlavor();
        const browser = !!flavor;
        const project = browser ? null : this.state.draftWorkspace.projectId;
        const conversationId = browser
          ? (this.draftConversationId ??= crypto.randomUUID())
          : null;
        if (conversationId) {
          await this.connectBrowserConversation(conversationId, true);
        } else if (!project) throw Error(t("browserHost.projectRequired"));
        if (
          cycle !== this.lifecycle ||
          route !== this.composerRoute ||
          epoch !== this.draftEpoch ||
          this.state.sessionId !== null ||
          flavor !== this.draftFlavor() ||
          (browser && conversationId !== this.draftConversationId) ||
          project !==
            (this.draftFlavor() ? null : this.state.draftWorkspace.projectId)
        )
          return;
        const component = selectedAgent?.component;
        if (typeof component !== "string" || !component)
          throw Error("项目组件目录尚未就绪，请重新连接工作区桥接");
        const session = await this.call<NativeSession>(
          "session.create",
          {
            project_id: project,
            ...(browser ? { conversation_id: conversationId } : {}),
            client_tools: this.toolDefinitions(),
            component,
            agent: agentName,
            mode: modeName,
            ...(explicitModel ? { model_selection: explicitModel } : {}),
            operation_id: crypto.randomUUID(),
          },
          undefined,
        );
        if (
          cycle !== this.lifecycle ||
          route !== this.composerRoute ||
          epoch !== this.draftEpoch ||
          this.state.sessionId !== null
        )
          return;
        id = session.id;
        this.upsert(session);
        const attachment = this.attaching + 1;
        try {
          await this.attach(id, true, false, true);
        } finally {
          // Attachment commits a new composer route before runtime activation.
          // A rejected activation still belongs to this draft; navigation does not.
          if (
            cycle === this.lifecycle &&
            epoch === this.draftEpoch &&
            id === this.state.sessionId &&
            attachment === this.attaching
          )
            route = this.composerRoute;
        }
      }
      if (
        cycle !== this.lifecycle ||
        route !== this.composerRoute ||
        id !== this.state.sessionId ||
        epoch !== this.draftEpoch
      )
        return;
      const prepared = await uploadDraftImages(
        this.api,
        id,
        images,
        this.state.capabilities?.limits ?? {},
        () =>
          cycle === this.lifecycle &&
          route === this.composerRoute &&
          id === this.state.sessionId &&
          epoch === this.draftEpoch &&
          this.state.composer === text &&
          this.state.composerImages.length === images.length &&
          this.state.composerImages.every(
            (image, index) => image.id === images[index].id,
          ),
      );
      if (
        !prepared ||
        cycle !== this.lifecycle ||
        route !== this.composerRoute ||
        id !== this.state.sessionId ||
        epoch !== this.draftEpoch ||
        this.state.composer !== text ||
        this.state.composerImages.length !== images.length ||
        !this.state.composerImages.every(
          (image, index) => image.id === images[index].id,
        )
      ) {
        if (
          cycle === this.lifecycle &&
          route === this.composerRoute &&
          id === this.state.sessionId
        )
          this.update({
            isCreatingSession: false,
            transcript: {
              ...this.state.transcript,
              blocks: this.state.transcript.blocks.filter(
                (block) => block.operationId !== opId,
              ),
            },
          });
        return;
      }
      images = prepared;
      const input = await this.plugins.preprocess(
        { parts: draftParts(text, images) },
        opId,
        id,
        () =>
          cycle === this.lifecycle &&
          route === this.composerRoute &&
          epoch === this.draftEpoch &&
          id === this.state.sessionId &&
          this.state.composer === text &&
          sameImageIds(
            this.state.composerImages,
            images.map((image) => image.id),
          ),
      );
      if (!input) {
        if (
          cycle === this.lifecycle &&
          route === this.composerRoute &&
          id === this.state.sessionId
        )
          this.update({
            transcript: {
              ...this.state.transcript,
              blocks: this.state.transcript.blocks.filter(
                (block) => block.operationId !== opId,
              ),
            },
          });
        return;
      }
      admission = {
        operationId: opId,
        text,
        imageIds: images.map((image) => image.id),
        epoch,
        route,
      };
      this.unknownSubmissions.set(id, admission);
      submitted = true;
      const receipt = await this.call<NativeOperation>(
        "turn.queue",
        {
          input,
          operation_id: opId,
          activate_if_idle: true,
        },
        id,
      );
      admission.status = receipt.status;
      if (!OPEN_RECEIPT.has(receipt.status)) this.plugins.forget(opId);
      if (FAILED_RECEIPT.has(receipt.status)) {
        this.reconcileSubmission(receipt);
        return;
      }
      if (receipt.status !== "completed") {
        admission.status = undefined;
        throw new CommandError(
          "outcome_unknown",
          "Awaiting terminal input admission receipt",
          true,
          true,
        );
      }
      if (this.unknownSubmissions.get(id)?.operationId === opId)
        this.unknownSubmissions.delete(id);
      if (
        cycle !== this.lifecycle ||
        route !== this.composerRoute ||
        id !== this.state.sessionId ||
        epoch !== this.draftEpoch
      )
        return;
      if (
        this.state.composer === text &&
        this.state.composerImages.length === images.length &&
        this.state.composerImages.every(
          (image, index) => image.id === images[index].id,
        )
      )
        this.clearComposer();
      if (
        receipt.id === opId &&
        receipt.session_id === id &&
        receipt.method === "turn.queue"
      ) {
        this.update({
          transcript: {
            ...this.state.transcript,
            blocks: this.state.transcript.blocks.map((block) =>
              block.temporary &&
              block.role === "user" && isDirectUserSource(block.payload.source) &&
              block.operationId === opId
                ? { ...block, submissionStatus: "admitted" as const }
                : block,
            ),
          },
        });
        return { status: "completed" as const, sessionId: id };
      }
    } catch (error) {
      // A terminal turn event can arrive before its command result. Losing that
      // result cannot make an already observed durable admission unknown again.
      if (submitted && admission?.status && admission.status !== "unknown") {
        if (id && this.unknownSubmissions.get(id)?.operationId === opId)
          this.unknownSubmissions.delete(id);
        traceEvent("input.admission", {
          sessionId: id ?? undefined,
          operationId: opId,
          outcome: ["accepted", "running", "completed"].includes(
            admission.status,
          )
            ? "succeeded"
            : "failed",
          code: admission.status,
        });
        return;
      }
      if (
        submitted &&
        id &&
        error instanceof CommandError &&
        error.outcomeUnknown &&
        cycle === this.lifecycle
      ) {
        if (admission) this.unknownSubmissions.set(id, admission);
        if (route === this.composerRoute && id === this.state.sessionId) {
          this.update({
            isCreatingSession: true,
            transcript: {
              ...this.state.transcript,
              blocks: this.state.transcript.blocks.map((block) =>
                block.temporary &&
                block.role === "user" && isDirectUserSource(block.payload.source) &&
                block.operationId === opId
                  ? { ...block, submissionStatus: "unknown" as const }
                  : block,
              ),
            },
          });
          this.toast(t("composer.submit.unknown"), "error");
        }
        try {
          const receipt = await this.call<NativeOperation>(
            "turn.get",
            { operation_id: opId },
            id,
          );
          const accepted =
            cycle === this.lifecycle &&
            route === this.composerRoute &&
            id === this.state.sessionId &&
            receipt.id === opId &&
            receipt.session_id === id &&
            receipt.method === "turn.queue" &&
            receipt.status === "completed";
          if (cycle === this.lifecycle) this.reconcileSubmission(receipt);
          if (accepted) return { status: "completed" as const, sessionId: id };
        } catch {
          /* Missing/unknown receipt is not evidence of failed admission. */
        }
        return;
      }
      this.plugins.forget(opId);
      if (id && this.unknownSubmissions.get(id)?.operationId === opId)
        this.unknownSubmissions.delete(id);
      let feedbackPublished = false;
      if (
        cycle === this.lifecycle &&
        route === this.composerRoute &&
        epoch === this.draftEpoch &&
        (id === this.state.sessionId || (!id && !this.state.sessionId))
      ) {
        const reason =
          error instanceof CommandError
            ? failureText(error)
            : error instanceof Error
              ? error.message
              : String(error);
        // A rejected command is not a failed model response. Only a terminal
        // operation receipt can create retryable conversation feedback.
        this.update({
          isCreatingSession: false,
          transcript: {
            ...this.state.transcript,
            blocks: this.state.transcript.blocks.filter(
              (block) =>
                !(
                  block.temporary &&
                  block.role === "user" && isDirectUserSource(block.payload.source) &&
                  block.operationId === opId
                ),
            ),
          },
        });
        this.toast(t("composer.submit.failed", { reason }), "error");
        feedbackPublished = true;
      }
      if (
        !id &&
        cycle === this.lifecycle &&
        error instanceof CommandError &&
        error.outcomeUnknown
      ) {
        this.uncertainCreation = true;
        try {
          const result = await this.call<NativeSessionList>(
            "session.list",
            {},
            undefined,
          );
          if (cycle === this.lifecycle) {
            this.update({
              sessions: result.items
                .filter((session) => !session.archived)
                .map(sessionView),
            });
            this.reportUnavailableSessions(result.unavailable);
          }
        } catch {
          /* Leave creation blocked until an explicit user decision. */
        }
        throw new CommandError(
          error.code,
          "会话创建结果未知。请检查会话列表并选择已创建的会话；确认后可显式新建会话。",
          error.retryable,
          true,
        );
      }
      // The active-route rejection was already reported with its error severity;
      // dispatch's generic catch must not immediately replace that feedback.
      if (!feedbackPublished) throw error;
    } finally {
      if (cycle === this.lifecycle && route === this.composerRoute)
        this.update({
          isCreatingSession: !!id && this.unknownSubmissions.has(id),
        });
    }
  }
  private newChat(activateBrowser = true) {
    this.draftAgentExplicit = false;
    this.draftModeExplicit = false;
    this.update({ draftModel: null });
    this.releaseInterrupt();
    this.composerRoute++;
    this.cacheSession();
    // The outgoing session keeps its draft for when the user returns.
    this.swapComposer(this.state.sessionId, null);
    this.update({
      historyMutationPending: false,
      inboxPending: false,
      retryPending: false,
      retryOperationId: null,
      modeSelectionPending: false,
      modelSelectionPending: false,
      compactInflight: false,
      compactOperation: null,
      agentInitRetryRequired: false,
      autoCompactionRetryAvailable: false,
      sessionRecoveryPending: false,
      sessionRecoveryUnknown: false,
      statistics: null,
      isCreatingSession: false,
    });
    this.resetPermissions();
    this.childRead++;
    this.childrenRead++;
    this.update({
      childList: null,
      childListError: null,
      childListLoading: false,
    });
    this.clientTools.reset();
    this.uncertainCreation = false;
    this.subscription = null;
    this.attaching++;
    this.stopSessionSocket();
    this.update({
      page: "home",
      sessionId: null,
      sessionAttachingId: null,
      transcript: createTranscript(),
      policy: null,
      history: null,
      popup: { type: "none" },
      menuSession: null,
    });
    location.hash = "";
    this.applyDraftAgentDefaults();
    void this.refreshDraftDefaults();
    if (
      activateBrowser &&
      !!this.draftFlavor() &&
      this.state.authSession?.authenticated
    ) {
      this.draftConversationId = crypto.randomUUID();
      return this.connectBrowserConversation(
        this.draftConversationId,
        true,
      ).catch((error) => this.toast(String(error)));
    }
  }
  private approvedDocumentLeaves = new WeakSet<AppAction>();
  async dispatch(action: AppAction): Promise<any> {
    const bypass = this.approvedDocumentLeaves.delete(action);
    const leaveSelector = bypass
      ? undefined
      : documentLeaveSelector(action, this.state);
    if (leaveSelector !== undefined) {
      const cycle = this.lifecycle;
      const owner = this.state.authSession?.principal?.owner;
      const session = this.state.sessionId;
      let synchronous = true;
      let allowed = false;
      requestDocumentLeave(() => {
        if (
          cycle !== this.lifecycle ||
          owner !== this.state.authSession?.principal?.owner ||
          session !== this.state.sessionId
        )
          return;
        if (synchronous) allowed = true;
        else {
          this.approvedDocumentLeaves.add(action);
          void this.dispatch(action);
        }
      }, leaveSelector ?? undefined);
      synchronous = false;
      if (!allowed) return;
    }
    const value = action.value;
    const state = this.state;
    try {
      switch (action.type) {
        case "SettingsRequest": {
          const allowed = [
            "settings.get",
            "settings.set",
            "project.settings.get",
            "project.settings.set",
            "session.settings.get",
            "session.settings.set",
            "project.references.get",
            "project.references.set",
            "session.references.refresh",
            "provider.list",
            "provider.get",
            "provider.set",
            "provider.delete",
            "provider.discover",
          ];
          if (!allowed.includes(action.method))
            throw Error("Unsupported settings operation");
          const owner = this.state.authSession?.principal?.owner;
          const cycle = this.lifecycle;
          const api = this.api;
          const result = await api.request(
            action.method,
            action.params ?? {},
            action.sessionId,
          );
          if (
            owner !== this.state.authSession?.principal?.owner ||
            cycle !== this.lifecycle ||
            api !== this.api
          )
            throw Error("Settings owner changed during request");
          if (
            ["settings.set", "project.settings.set"].includes(action.method)
          ) {
            const saved = result as SettingsSnapshot;
            if (action.method === "settings.set") {
              this.update({
                userSessionDefaults: saved.effective ?? null,
                projectSessionDefaults: null,
              });
            } else if (
              action.params?.project_id === this.state.draftWorkspace.projectId
            ) {
              this.update({
                projectSessionDefaults: saved.effective
                  ? {
                      projectId: action.params.project_id,
                      effective: saved.effective,
                    }
                  : null,
              });
            }
            this.applyDraftAgentDefaults();
            await this.refreshDraftDefaults();
          }
          if (
            ["provider.set", "provider.delete", "provider.discover"].includes(
              action.method,
            )
          ) {
            try {
              await this.refreshModelCatalog();
              if (cycle === this.lifecycle && api === this.api)
                await this.refreshDraftDefaults();
            } catch (failure) {
              if (owner === this.state.authSession?.principal?.owner)
                this.toast(
                  t("ownerSettings.catalogRefreshFailed", {
                    reason:
                      failure instanceof Error
                        ? failure.message
                        : String(failure),
                  }),
                );
            }
          }
          return result;
        }
        case "ReplyRoundLimit":
          return await this.roundLimits.reply(
            action.requestId,
            action.decision,
          );
        case "ReplyPermissionProposal":
          return await this.replyProposal(
            action.proposalId,
            action.accept === true,
          );
        case "ReplyPermission":
          return await this.replyPermission(action.requestId, action.decision);
        case "RefreshPermissions":
          return await this.refreshPermissions();
        case "OpenSubAgentDetail":
          return await this.loadChild(String(value ?? ""), false, true);
        case "RefreshSubAgentDetail":
          return await this.loadChild(String(state.popup.childId ?? ""));
        case "LoadEarlierChildMessages":
          return await this.loadChild(String(state.popup.childId ?? ""), true);
        case "LoadMoreChildren":
          return await this.loadChildren(true);
        case "TakeOverBrowserHost": {
          const id = state.sessionId;
          const owner = state.authSession?.principal?.owner;
          if (!id || !owner || state.hostConnection?.conversationId !== id ||
              state.hostConnection.hostFlavor !== "browser_sandbox" || !state.hostConnection.browserParticipant)
            throw Error(t("browserHost.bindingChanged"));
          const browser = await this.api.connectBrowserConversation(id, owner, "browser_sandbox", true);
          if (this.state.sessionId === id) this.update({ hostConnection: { ...this.state.hostConnection!,
            serverOwned: browser.serverOwned === true, browserParticipant: browser.participant === true } });
          return;
        }
        case "TakeOverClientTools":
          return await this.clientTools.takeover();
        case "ReplyQuestion":
        case "RejectQuestion":
          return await this.clientTools.answer(
            action.requestId,
            action.answers,
            action.type === "RejectQuestion",
          );
        case "GetRequestAudit":
          return await this.api.request(
            "audit.requests",
            action.selector,
            action.sessionId ?? state.sessionId,
          );
        case "ReadExecutionContent":
          return await this.api.request<NativeExecutionContentPage>(
            "executions.content",
            {
              execution_id: action.executionId,
              field: action.field,
              cursor: action.cursor ?? 0,
              max_bytes: action.maxBytes ?? 16384,
            },
            action.sessionId ?? state.sessionId,
          );
        case "ReadExecutionOutput":
          return await this.api.request(
            "executions.read",
            {
              execution_id: action.executionId,
              cursor: action.cursor ?? 0,
              max_bytes: action.maxBytes ?? 16384,
            },
            action.sessionId ?? state.sessionId,
          );
        case "CancelExecution":
          return await this.api.request(
            "executions.cancel",
            { execution_id: action.executionId },
            action.sessionId ?? state.sessionId,
          );
        case "GetPublicState": {
          const view = await this.api.request(
            "state.get",
            {},
            state.sessionId ?? undefined,
          );
          this.update({ publicState: view, publicStateOmitted: false });
          return view;
        }
        case "CreateProject": {
          const result = await this.call<NativeProject>("project.create", {
            name: action.name,
            root: action.root || ".",
          });
          if (result) {
            this.update({
              projects: [...this.state.projects, result],
              knownProjects: [
                ...this.state.knownProjects,
                { id: result.id, name: result.name, path: result.root },
              ],
            });
            this.toast(`项目 ${result.name} 创建成功`, "info");
          }
          return result;
        }
        case "CreateConnectedProject": {
          const cycle = this.lifecycle;
          const owner = this.state.authSession?.principal?.owner;
          const current = () =>
            cycle === this.lifecycle &&
            owner === this.state.authSession?.principal?.owner &&
            this.state.authSession?.authenticated;
          const project = await this.call<NativeProject>("project.create", {
            name: action.name,
            root: action.root || ".",
          });
          if (!current()) return;
          this.update({
            projects: [...this.state.projects, project],
            knownProjects: [
              ...this.state.knownProjects,
              { ...project, path: project.root },
            ],
          });
          try {
            const descriptor = await this.connectHost(
              project.id,
              action.endpoint,
              action.pairingToken,
              false,
              action.transport,
            );
            if (!current()) return;
            if (!descriptor) throw Error(t("hostDlg.incomplete"));
            const selectedId = this.state.hostConnection?.projectId;
            if (descriptor && selectedId && selectedId !== project.id) {
              try {
                await this.api.request("project.delete_provisional", {
                  project_id: project.id,
                });
                if (!current()) return;
                this.update({
                  projects: this.state.projects.filter(
                    (p) => p.id !== project.id,
                  ),
                  knownProjects: this.state.knownProjects.filter(
                    (p) => p.id !== project.id,
                  ),
                });
              } catch {
                this.toast(
                  "已选择已有项目，未清理临时项目；可稍后重试安全清理。",
                );
              }
            }
            return descriptor
              ? this.state.projects.find((p) => p.id === selectedId)
              : undefined;
          } catch (error) {
            // Keep an uncertain provisional record visible for explicit retry.
            if (current() && error instanceof Error)
              Object.assign(error, { provisionalProjectId: project.id });
            throw error;
          }
        }
        case "RefreshHostState":
          if (
            !action.projectId ||
            action.projectId !== this.state.hostConnection?.projectId
          )
            return;
          return this.refreshHost(action.reconcile === true);
        case "ReconnectBrowserHost":
        case "RetryHostCatalog": {
          if (
            action.type === "RetryHostCatalog" &&
            (!action.projectId ||
              action.projectId !== this.state.hostConnection?.projectId)
          )
            return;
          if (state.hostConnection?.projectId)
            await this.loadHostCatalog(state.hostConnection.projectId);
          else {
            const id =
              state.sessionId ??
              (this.draftConversationId ??= crypto.randomUUID());
            await this.connectBrowserConversation(id, !state.sessionId);
            if (state.sessionId) await this.call("session.open", {}, id);
          }
          return;
        }
        case "ConnectHost":
          return await this.connectHost(
            action.projectId,
            action.endpoint,
            action.pairingToken?.trim() || undefined,
            !this.state.projects.find((p) => p.id === action.projectId)
              ?.host_id,
            action.transport,
          );
        case "DisconnectHost": {
          if (
            !action.projectId ||
            action.projectId !== this.state.hostConnection?.projectId ||
            !this.state.projects.some((p) => p.id === action.projectId)
          )
            return;
          const cycle = this.lifecycle;
          const owner = this.state.authSession?.principal?.owner;
          const attempt = ++this.hostAttempt;
          await this.api.disconnectHost();
          if (
            attempt !== this.hostAttempt ||
            cycle !== this.lifecycle ||
            owner !== this.state.authSession?.principal?.owner ||
            this.state.hostConnection?.projectId !== action.projectId
          )
            return;
          const currentProjectId = action.projectId;
          this.update({
            agents: [],
            projects: this.state.projects.map((p) =>
              p.id === currentProjectId
                ? { ...p, host_connected: false, status: "offline" }
                : p,
            ),
            knownProjects: this.state.knownProjects.map((p) =>
              p.id === currentProjectId
                ? { ...p, host_connected: false, status: "offline" }
                : p,
            ),
            hostConnection: {
              ...state.hostConnection,
              state: "detached",
              connected: false,
              reason: undefined,
            },
          });
          return;
        }
        case "Login":
          this.requireAuth();
          return;
        case "Logout":
          claimAutomaticLogin(this.api.base);
          this.update({ authSession: { authenticated: false } });
          this.clearSessionMemory();
          this.returnedComposer = null;
          clearTimeout(this.authTimer);
          this.unknownSubmissions.clear();
          this.retryRequests.clear();
          this.inboxRequests.clear();
          this.inboxEdits.clear();
          this.update({
            inboxMutations: {},
            inboxRetrieved: {},
            composerFocusRequest: undefined,
          });
          this.update({
            inboxPending: false,
            historyMutationPending: false,
            retryPending: false,
            retryOperationId: null,
          });
          this.clearComposer();
          this.resetPermissions();
          this.childRead++;
          this.childrenRead++;
          this.update({
            childList: null,
            childListError: null,
            childListLoading: false,
          });
          this.clientTools.reset();
          this.uncertainCreation = false;
          this.hostAttempt++;
          this.lifecycle++;
          this.attaching++;
          this.stopSessionSocket();
          this.subscription = null;
          this.update({ agents: [], hostConnection: { state: "detached" } });
          await this.api.disconnectHost(true, { trigger: "action:logout" });
          const endSession = await this.api.logout();
          this.stopSessionSocket();
          this.api.stop();
          this.attaching++;
          this.subscription = null;
          this.update({
            page: "home",
            popup: { type: "none" },
            authSession: { authenticated: false },
            hostConnection: { state: "detached" },
            connection: "disconnected",
            isCreatingSession: false,
            forkPending: null,
            forkUnknown: {},
            forkTargets: {},
            historyAvailable: null,
            sessions: [],
            transcript: createTranscript(),
            sessionId: null,
            policy: null,
            history: null,
            historyTruncated: false,
            capabilities: null,
            projects: [],
            knownProjects: [],
            agents: [],
            models: [],
            availableModels: [],
            modelMetadataStatus: null,
            modelMetadataPending: false,
            modelMetadataError: null,
            draftAgent: "",
            draftMode: "plan",
            draftModel: null,
            userSessionDefaults: null,
            projectSessionDefaults: null,
            draftWorkspace: { kind: "chat_only" },
            draftText: "",
            attachments: [],
          });
          history.replaceState(
            history.state,
            "",
            location.pathname + location.search,
          );
          // Finish SSO logout at the IdP so its session cannot silently sign
          // the browser back in on the next login.
          if (endSession) window.location.assign(endSession);
          else navigateLoginPage(this.api.base, "?signed_out=1");
          return;
        case "Reconnect":
          return this.connect();
        case "ProbeHealth":
          await this.api.health();
          return this.toast("服务可用", "success");
        case "NewBrowserChat":
          // Sessions (+) explicitly leaves the current Project. Keep generic
          // NewChat's remembered Project behavior for its other callers.
          this.newChat(false);
          this.draftConversationId = crypto.randomUUID();
          return this.dispatch({ type: "SelectDraftWorkspace" });
        case "NewChat":
          return this.newChat();
        case "LoadEarlier": {
          let current = this.subscription;
          if (
            !current ||
            current.snapshot.next_cursor == null ||
            this.historyReads.has(current)
          )
            return;
          const reads = [current];
          this.historyReads.add(current);
          const interactionId = crypto.randomUUID();
          traceEvent("history.load", {
            interactionId,
            sessionId: current.snapshot.session.id,
            outcome: "started",
          });
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              const selected = current.snapshot;
              const requestTicket = this.attaching;
              const history = JSON.stringify(selected.history);
              try {
                const page = await this.call<{
                  items: NativeSnapshot["messages"];
                  history_view?: NativeSnapshot["history_view"];
                  truncated: boolean;
                  next_cursor: number | null;
                }>(
                  "session.blocks",
                  {
                    before_cursor: selected.next_cursor,
                    ...(selected.history_view && selected.messages[0]
                      ? {
                          before_message_id: selected.messages[0].id,
                          lineage: selected.history_view.lineage,
                        }
                      : {}),
                    limit: 64,
                  },
                  selected.session.id,
                  interactionId,
                );
                if (
                  current !== this.subscription ||
                  requestTicket !== this.attaching ||
                  (selected.history_view
                    ? !sameSelectedHistory(selected, current.snapshot) ||
                      page.history_view?.lineage !==
                        selected.history_view.lineage
                    : history !== JSON.stringify(current.snapshot.history))
                )
                  return;
                const merged = mergeHistoryPage(current.snapshot, page);
                if (!merged) throw Error(t("conversation.historyChanged"));
                this.snapshot(
                  merged,
                  current.snapshot,
                  this.historyTargets.get(current) ?? current.snapshot,
                );
                this.loadedSubscriptions.add(current);
                traceEvent("history.load", {
                  interactionId,
                  sessionId: selected.session.id,
                  outcome: "succeeded",
                  count: page.items.length,
                });
                return;
              } catch (error) {
                if (
                  current !== this.subscription ||
                  requestTicket !== this.attaching
                )
                  return;
                if (
                  !(error instanceof CommandError) ||
                  error.code !== "stale_history"
                )
                  throw error;
                if (attempt > 0) throw Error(t("conversation.historyChanged"));
                // A boundary is meaningful only under its exact selected lineage.
                // Re-subscribe rather than remove the witness or splice an old branch.
                // attach owns the snapshot/delta handoff and retains proven loaded rows.
                const id = selected.session.id;
                const ticket = this.attaching + 1;
                await this.attach(id, true, true);
                if (
                  this.attaching !== ticket ||
                  this.state.sessionId !== id ||
                  !this.subscription ||
                  this.subscription === current
                )
                  return;
                current = this.subscription;
                if (
                  current.snapshot.next_cursor == null ||
                  this.historyReads.has(current)
                )
                  return;
                reads.push(current);
                this.historyReads.add(current);
              }
            }
          } finally {
            for (const read of reads) this.historyReads.delete(read);
          }
          return;
        }
        case "GetSessionSnapshot": {
          // Read-only preview: the session cache, else one WebSocket page.
          const id = String(value ?? "");
          const cached =
            this.subscription?.snapshot.session.id === id
              ? this.subscription.snapshot
              : this.sessionCache.get(id)?.snapshot;
          if (cached) return cached;
          // Search preview observes the exact target path without selecting it,
          // claiming an executor or touching the global Host transport.
          const observer = new SessionSocket((path) => this.api.url(path));
          const cycle = this.lifecycle;
          try {
            const preview = await observer.open(
              id,
              { display_watermark: 0 },
              {
                event: () => {},
                authRequired: () => this.requireAuth(),
              },
            );
            return cycle === this.lifecycle ? preview.snapshot : undefined;
          } finally {
            observer.stop();
          }
        }
        case "Attach": {
          if (state.sessionAttachingId === value) return;
          const targetId = String(value ?? "");
          if (state.page !== "conversation" && targetId) {
            const nextHash = `#/${sessionPath(targetId)}`;
            if (location.hash !== nextHash) {
              history.pushState(null, "", nextHash);
            }
            if (targetId === state.sessionId && this.subscription) {
              this.update({
                page: "conversation",
                pluginId: null,
                pluginWorkspace: null,
              });
              return;
            }
          }
          return await this.attach(value);
        }
        case "OpenPlugins":
        case "OpenPluginsPage": {
          const returnPath =
            state.page === "plugins" || state.page === "plugin"
              ? state.pluginReturnPath
              : location.hash ||
                (state.sessionId ? `#/${sessionPath(state.sessionId)}` : "#/");
          const nextHash = state.sessionId
            ? `#/${sessionPath(state.sessionId)}/plugins`
            : "#/plugins";
          if (location.hash !== nextHash) {
            history.pushState(null, "", nextHash);
          }
          this.update({
            page: "plugins",
            pluginId: null,
            pluginWorkspace: null,
            pluginReturnPath: returnPath ?? null,
            rightOverlayOpen: false,
            popup: { type: "none" },
          });
          return;
        }
        case "OpenPlugin": {
          this.update({
            pluginWorkspace: { type: "view", pluginId: action.id },
            popup:
              state.popup.type === "settings" ? state.popup : { type: "none" },
          });
          return;
        }
        case "ClosePluginPage": {
          if (state.pluginWorkspace) {
            this.update({ pluginWorkspace: null });
            return;
          }
          const expandedReturn =
            state.page === "plugin" &&
            this.expandedPluginReturn?.sessionId === state.sessionId
              ? this.expandedPluginReturn.path
              : null;
          const path =
            expandedReturn ||
            state.pluginReturnPath ||
            (state.sessionId ? `#/${sessionPath(state.sessionId)}` : "#/");
          this.expandedPluginReturn = null;
          const destination = parseLocation(location.pathname, path);
          history.pushState(null, "", path);
          this.update({
            page: destination.page,
            pluginId: destination.pluginId ?? null,
            pluginReturnPath:
              destination.page === "plugins" ? state.pluginReturnPath : null,
          });
          this.route();
          return;
        }
        case "OpenDashboard":
          this.update({ page: "dashboard" });
          return;
        case "Navigate":
          this.update({ page: value });
          return;
        case "RouteChanged":
          return this.route();
        case "SetComposer":
          this.update({ composer: String(value) });
          return;
        case "PasteComposerImages":
          return await this.pasteImages(action.files ?? []);
        case "RemoveComposerImage": {
          if (state.isCreatingSession) return;
          const image = state.composerImages.find((item) => item.id === value);
          if (image) URL.revokeObjectURL(image.previewUrl);
          this.update({
            composerImages: state.composerImages.filter(
              (item) => item.id !== value,
            ),
          });
          return;
        }
        case "RetryAgentInit":
          return await this.recoverSession("session.retry_agent_init");
        case "RetryAutoCompaction":
          return await this.recoverSession("session.retry_auto_compaction");
        case "CheckSessionRecovery": {
          const request = this.recoveryRequests.get(state.sessionId ?? "");
          if (request)
            return await this.recoverSession(
              request.method as
                "session.retry_agent_init" | "session.retry_auto_compaction",
            );
          return;
        }
        case "Compact":
          return await this.compact(action.instruction ?? "");
        case "SetFilter":
          this.update({ filter: value });
          return;
        case "ResumeInboxInput":
        case "TakeInboxInput":
        case "UpdateInboxInput":
        case "RemoveInboxInput":
          return await this.mutateInbox(action);
        case "RestoreInboxInput":
          return this.restoreInboxInput();
        case "DiscardInboxInput": {
          const remaining = { ...state.inboxRetrieved };
          if (state.sessionId) delete remaining[state.sessionId];
          this.update({ inboxRetrieved: remaining });
          return;
        }
        case "BypassPluginsOnce":
          this.plugins.allowBypassOnce();
          return;
        case "QueueInput":
          return await this.submitInbox("queue");
        case "SteerInput":
          return await this.submitInbox("steer");
        case "Submit":
          // Queue and steer have their own actions. A leftover mode must not
          // fall through into an ordinary turn.
          if (action.mode) throw Error(t("composer.inbox.unavailable"));
          return await this.submit();
        case "Interrupt": {
          const sessionId = this.state.sessionId;
          const stop = sessionId ? this.stopLocally(sessionId) : null;
          try {
            await this.call("session.interrupt");
          } catch (error) {
            if (stop && this.interruptFence === stop) {
              // The turn keeps running: its blocks resume streaming.
              for (const block of stop.stopped)
                if (block.stream === "stopped") block.stream = "streaming";
              this.releaseInterrupt();
            }
            throw error;
          }
          // Nothing was running (an inbox-only stop): no settlement follows.
          if (
            stop &&
            this.interruptFence === stop &&
            this.state.transcript.sessionStatus !== "busy"
          )
            this.releaseInterrupt();
          this.toast(t("toast.interruptRequested"), "success");
          return;
        }
        case "RefreshSessions": {
          await this.reloadSessions();
          return;
        }
        case "OpenMenu":
          this.update({ menuSession: value });
          return;
        case "CloseMenu":
          this.update({ menuSession: null });
          return;
        case "OpenProjectMenu":
          this.update({ menuProject: value });
          return;
        case "CloseProjectMenu":
          this.update({ menuProject: null });
          return;
        case "DeleteProjectGroup":
        case "RenameProjectGroup": {
          const project = state.projects.find((item) => item.id === value);
          if (!project) throw Error("未知的已分配项目");
          this.update({
            menuProject: null,
            popup: {
              type:
                action.type === "DeleteProjectGroup"
                  ? "deleteProject"
                  : "renameProject",
              projectId: project.id,
              title: project.name,
            },
          });
          return;
        }
        case "OpenRename":
        case "OpenDelete":
        case "OpenArchive":
        case "OpenCompact": {
          const id = value || state.sessionId;
          const session = state.sessions.find((s) => s.id === id);
          this.update({
            menuSession: null,
            popup: {
              type:
                action.type === "OpenRename"
                  ? "rename"
                  : action.type === "OpenCompact"
                    ? "compact"
                    : action.type === "OpenArchive"
                      ? "archive"
                      : "delete",
              sessionId: id,
              title: session?.title ?? "",
              revision: session?.revision,
              instruction: "",
            },
          });
          return;
        }
        case "SetPopupTitle":
          this.update({ popup: { ...state.popup, title: value } });
          return;
        case "SetCompactInstruction":
          this.update({ popup: { ...state.popup, instruction: value } });
          return;
        case "DismissPopup":
        case "CloseRemoteConnectDialog":
        case "CloseSubAgentDetail":
          if (state.popup.pending) return;
          this.childRead++;
          this.update({ popup: { type: "none" } });
          return;
        case "ConfirmPopup": {
          const popup = state.popup;
          if (popup.pending || popup.type === "none") return;
          const cycle = this.lifecycle;
          const pendingPopup = { ...popup, pending: true };
          this.update({ popup: pendingPopup });
          const current = () => cycle === this.lifecycle;
          const closePopup = () => {
            if (current() && this.state.popup === pendingPopup)
              this.update({ popup: { type: "none" } });
          };
          try {
            if (popup.type === "renameProject") {
              const project = await this.call<NativeProject>("project.rename", {
                project_id: popup.projectId,
                name: popup.title.trim(),
              });
              if (!current()) return;
              this.update({
                projects: this.state.projects.map((p) =>
                  p.id === project.id ? project : p,
                ),
                knownProjects: this.state.knownProjects.map((p) =>
                  p.id === project.id
                    ? { ...project, path: p.path ?? project.root }
                    : p,
                ),
                draftWorkspace:
                  this.state.draftWorkspace.projectId === project.id
                    ? { ...this.state.draftWorkspace, label: project.name }
                    : this.state.draftWorkspace,
              });
            } else if (popup.type === "deleteProject") {
              const selectedId = this.state.sessionId;
              const deletingSelected =
                this.state.sessions.some(
                  (session) =>
                    session.id === selectedId &&
                    session.projectID === popup.projectId,
                ) ||
                (this.subscription?.snapshot.session.id === selectedId &&
                  this.subscription?.snapshot.session.project_id ===
                    popup.projectId);
              await this.call("project.delete", {
                project_id: popup.projectId,
              });
              if (!current()) return;
              forgetProjectQuarantine(this.hostScope(), popup.projectId);
              closePopup();
              const activeDeleted =
                (deletingSelected && this.state.sessionId === selectedId) ||
                this.state.sessions.some(
                  (session) =>
                    session.id === this.state.sessionId &&
                    session.projectID === popup.projectId,
                ) ||
                (this.subscription?.snapshot.session.id ===
                  this.state.sessionId &&
                  this.subscription?.snapshot.session.project_id ===
                    popup.projectId);
              this.update({
                sessions: this.state.sessions.filter(
                  (session) => session.projectID !== popup.projectId,
                ),
              });
              if (activeDeleted) this.newChat();
              if (this.state.hostConnection?.projectId === popup.projectId) {
                ++this.hostAttempt;
                // Deletion is already durable. Fencing starts synchronously;
                // relay teardown must not hold the successful confirmation open.
                void this.api.disconnectHost(true, { backendDetached: true });
                this.update({
                  hostConnection: { state: "detached" },
                  agents: [],
                });
              }
              const projects = this.state.projects.filter(
                (p) => p.id !== popup.projectId,
              );
              this.update({
                projects,
                knownProjects: this.state.knownProjects.filter(
                  (p) => p.id !== popup.projectId,
                ),
                draftWorkspace:
                  this.state.draftWorkspace.projectId === popup.projectId
                    ? projects[0]
                      ? {
                          kind: "local",
                          projectId: projects[0].id,
                          path: projects[0].root,
                          label: projects[0].name,
                        }
                      : { kind: "chat_only" }
                    : this.state.draftWorkspace,
              });
              void this.refreshDraftDefaults();
              try {
                localStorage.removeItem(
                  "microcrab.host-endpoint:" + this.api.base + popup.projectId,
                );
                if (
                  localStorage.getItem(
                    "microcrab.host-project:" + this.api.base,
                  ) === popup.projectId
                )
                  localStorage.removeItem(
                    "microcrab.host-project:" + this.api.base,
                  );
              } catch {}
            } else if (popup.type === "rename") {
              const session = await this.call<NativeSession>(
                "session.rename",
                { title: popup.title, expected_revision: popup.revision },
                popup.sessionId,
              );
              if (!current()) return;
              this.upsert(session);
            } else if (popup.type === "archive") {
              let session: NativeSession;
              try {
                session = await this.call<NativeSession>(
                  "session.archive",
                  { expected_revision: popup.revision },
                  popup.sessionId,
                );
              } catch (error) {
                if (!(error instanceof CommandError && error.outcomeUnknown))
                  throw error;
                if (!current() || this.state.popup !== pendingPopup) return;
                // Archive is idempotent: replaying it reports the archived
                // session whether or not the lost attempt took effect.
                let replayed: NativeSession | undefined;
                try {
                  replayed = await this.call<NativeSession>(
                    "session.archive",
                    { expected_revision: popup.revision },
                    popup.sessionId,
                  );
                } catch {
                  // Failed replay cannot establish the mutation's outcome.
                }
                if (!current() || this.state.popup !== pendingPopup) return;
                if (
                  !replayed ||
                  replayed.id !== popup.sessionId ||
                  replayed.archived !== true
                ) {
                  this.toast(error.message);
                  return;
                }
                session = replayed;
              }
              if (!current() || this.state.popup !== pendingPopup) return;
              closePopup();
              this.upsert(session);
              this.update({ sessions: [...this.state.sessions] });
              if (this.state.sessionId === session.id) this.newChat();
            } else if (popup.type === "delete") {
              try {
                await this.call(
                  "session.delete",
                  { expected_revision: popup.revision },
                  popup.sessionId,
                );
              } catch (error) {
                if (
                  error instanceof CommandError &&
                  !error.outcomeUnknown &&
                  error.code === "operation_failed" &&
                  error.details?.quarantined === true
                ) {
                  if (!current() || this.state.popup !== pendingPopup) return;
                  const lines = [
                    t(
                      error.details.sticky_failure === true
                        ? "sessionDelete.quarantinedSticky"
                        : "sessionDelete.quarantined",
                    ),
                  ];
                  if (error.message.trim()) lines.push(error.message);
                  const stages: Record<string, string> = {
                    turn_owner: "sessionDelete.stage.turn_owner",
                    tool_task_events: "sessionDelete.stage.tool_task_events",
                    statistics_events: "sessionDelete.stage.statistics_events",
                    naming: "sessionDelete.stage.naming",
                    children: "sessionDelete.stage.children",
                    client_tools: "sessionDelete.stage.client_tools",
                    ledger: "sessionDelete.stage.ledger",
                    aggregate: "sessionDelete.stage.aggregate",
                    auditor: "sessionDelete.stage.auditor",
                    session: "sessionDelete.stage.session",
                    session_cleanup: "sessionDelete.stage.sessionCleanup",
                    host_reconciliation:
                      "sessionDelete.stage.hostReconciliation",
                  };
                  // Only the server's allowlisted diagnostic fields belong in this toast.
                  const sessionFailure = error.details
                    .session_cleanup_failure as
                    Record<string, unknown> | undefined;
                  const reconciliationFailure = error.details
                    .reconciliation_failure as
                    Record<string, unknown> | undefined;
                  const failures = [
                    {
                      stage: "session_cleanup",
                      code: sessionFailure?.code,
                      message: sessionFailure?.message,
                    },
                    {
                      stage: "host_reconciliation",
                      code: reconciliationFailure?.code,
                      message: reconciliationFailure?.message,
                    },
                    ...(Array.isArray(error.details.cleanup_failures)
                      ? error.details.cleanup_failures
                      : []),
                  ];
                  let shown = 0;
                  for (const failure of failures) {
                    if (
                      !failure ||
                      typeof failure.stage !== "string" ||
                      typeof failure.code !== "string" ||
                      typeof failure.message !== "string"
                    )
                      continue;
                    const stageKey = Object.hasOwn(stages, failure.stage)
                      ? stages[failure.stage]
                      : undefined;
                    lines.push(
                      t("sessionDelete.cleanupFailure", {
                        stage: stageKey ? t(stageKey) : failure.stage,
                        code: failure.code,
                        message: failure.message,
                      }),
                    );
                    if (++shown === 12) break;
                  }
                  this.toast(lines.join("\n"));
                  return;
                }
                if (!(error instanceof CommandError && error.outcomeUnknown))
                  throw error;
                // Deletion is idempotent for its owner: a replay is answered
                // from the tombstone whether or not the lost attempt landed.
                let confirmed = false;
                try {
                  const replay = await this.call<{ deleted?: boolean }>(
                    "session.delete",
                    { expected_revision: popup.revision },
                    popup.sessionId,
                  );
                  confirmed = replay?.deleted === true;
                } catch {
                  // The list stays the authority when the replay fails too.
                }
                if (!confirmed) {
                  closePopup();
                  this.toast(error.message);
                  // With a list watch the server's `remove` (or nothing, if
                  // the delete never landed) settles the row; no reload.
                  if (!this.sessionWatch)
                    void this.dispatch({ type: "RefreshSessions" });
                  return;
                }
              }
              if (!current() || this.state.popup !== pendingPopup) return;
              closePopup();
              const wasSelected = this.state.sessionId === popup.sessionId;
              this.update({
                sessions: this.state.sessions.filter(
                  (session) => session.id !== popup.sessionId,
                ),
              });
              if (wasSelected) this.newChat();
              this.forgetSession(popup.sessionId);
            } else if (popup.type === "compact") {
              if (popup.sessionId !== this.state.sessionId)
                throw Error(t("composer.compact.unavailable"));
              await this.compact(popup.instruction ?? "");
              if (
                this.state.popup !== popup &&
                this.state.popup.sessionId !== popup.sessionId
              )
                return;
            }
            if (!current()) return;
            closePopup();
            this.update({ sessions: [...this.state.sessions] });
            return;
          } catch (error) {
            if (!current()) return;
            throw error;
          } finally {
            if (current() && this.state.popup === pendingPopup)
              this.update({ popup: { ...pendingPopup, pending: false } });
          }
        }
        case "SelectKnownProject":
        case "CreateSessionInProject": {
          const project = state.projects.find((p) => p.id === value);
          if (!project) throw Error("未知的已分配项目");
          if (!state.sessionId && project.id !== state.draftWorkspace.projectId)
            this.clearComposer();
          this.draftConversationId = null;
          try {
            localStorage.setItem(
              "microcrab.host-project.v2:" +
                hostPreferenceScope(this.api.base, state.authSession),
              project.id,
            );
          } catch {
            // The current explicit selection remains authoritative without storage.
          }
          this.update({
            draftWorkspace: {
              kind: "local",
              projectId: project.id,
              path: project.root,
              label: project.name,
            },
            showWorkspaceDropdown: false,
          });
          if (action.type === "CreateSessionInProject") this.newChat();
          const cycle = this.lifecycle;
          await this.refreshDraftDefaults();
          if (
            cycle !== this.lifecycle ||
            this.state.draftWorkspace.projectId !== project.id
          )
            return;
          await this.resumeProject(
            project.id,
            action.type === "CreateSessionInProject"
              ? "resume_project:create_session"
              : "resume_project:select_project",
          );
          return;
        }
        case "RefreshModelMetadata":
        case "LoadModelMetadata": {
          if (this.state.modelMetadataPending) return;
          const cycle = this.lifecycle;
          const catalogTicket = ++this.catalogRead;
          this.update({ modelMetadataPending: true, modelMetadataError: null });
          try {
            const result = await this.call<NativeModelCatalog>(
              action.type === "RefreshModelMetadata"
                ? "model.metadata.refresh"
                : "model.list",
              {},
              undefined,
            );
            if (cycle !== this.lifecycle || catalogTicket !== this.catalogRead)
              return;
            this.update({
              availableModels: modelChoices(result),
              modelMetadataStatus: result.metadata_status ?? null,
            });
            await this.refreshDraftDefaults();
          } catch (error) {
            if (cycle === this.lifecycle)
              reportDiagnostic("store", action.type, error);
            if (cycle === this.lifecycle)
              this.update({
                modelMetadataError: `${t("models.metadata.failed")} ${diagnosticMessage(error)}`,
              });
          } finally {
            if (cycle === this.lifecycle)
              this.update({ modelMetadataPending: false });
          }
          return;
        }
        case "SelectDraftModel":
        case "SelectModelVariant": {
          if (state.modelSelectionPending)
            throw Error(t("error.model.updating"));
          if (state.isCreatingSession || state.modeSelectionPending)
            throw Error(t("error.model.busy"));
          const session = state.sessions.find(
            (item) => item.id === state.sessionId,
          );
          if (
            !this.editableComposer() ||
            session?.archived ||
            (!!state.sessionId && !this.supports("session.set_model"))
          )
            throw Error(t("composer.mode.unavailable"));
          if (session?.parentID) throw Error(t("error.model.childSession"));
          const current = selectedModel(state);
          const requested =
            action.type === "SelectDraftModel" ? value : current;
          const model = state.availableModels.find(
            (item) =>
              item.id === requested?.id &&
              item.providerId === requested?.providerId,
          );
          if (!model) throw Error(t("error.model.notConfigured"));
          const variant = action.type === "SelectModelVariant" ? value : null;
          if (variant !== null && !model.variants.includes(variant))
            throw Error(t("error.model.effortUnsupported"));
          if (!state.sessionId) {
            this.update({
              draftModel: { ...model, variant },
              popup: { type: "none" },
            });
            return;
          }
          const id = state.sessionId;
          const cycle = this.lifecycle;
          const route = this.attaching;
          this.update({ modelSelectionPending: true });
          try {
            const snapshot = await this.call<NativeSnapshot>(
              "session.set_model",
              {
                expected_revision: session?.revision,
                provider_id: model.providerId,
                model: model.id,
                variant,
              },
              id,
            );
            if (
              cycle !== this.lifecycle ||
              route !== this.attaching ||
              this.state.sessionId !== id
            )
              return;
            this.configurationReceipt(snapshot.session);
            this.update({ popup: { type: "none" } });
          } finally {
            if (
              cycle === this.lifecycle &&
              route === this.attaching &&
              this.state.sessionId === id
            )
              this.update({ modelSelectionPending: false });
          }
          return;
        }
        case "SetAgentMode":
          return await this.setMode(action.mode, action.agent);
        case "SetMode":
          return await this.setMode(value);
        case "SetAgent": {
          if (
            state.isCreatingSession ||
            state.modeSelectionPending ||
            state.compactInflight
          )
            throw Error(t("composer.mode.unavailable"));
          if (state.sessionId)
            throw Error("现有会话的 agent 固定；请创建新会话");
          const agent = state.agents.find((item) => item.name === value);
          const modes =
            agent?.modes.filter((mode) => mode.role !== "sub_agent") ?? [];
          if (!agent || !modes.length)
            throw Error("Agent 没有可用的主会话模式");
          this.draftAgentExplicit = true;
          this.draftModeExplicit = true;
          this.update({
            draftAgent: agent.name,
            draftMode: modes.some((mode) => mode.name === state.draftMode)
              ? state.draftMode
              : modes[0].name,
          });
          return;
        }
        case "OpenSessionPermissionsDialog": {
          if (!state.sessionId) return;
          this.update({
            popup: {
              type: "sessionPermissions",
              sessionId: state.sessionId,
              requestId: crypto.randomUUID(),
            },
          });
          return;
        }
        case "LoadSessionPermissions":
        case "SaveSessionPermissions": {
          const sessionId = String(action.sessionId ?? "");
          const requestId = action.requestId;
          const cycle = this.lifecycle;
          const route = this.attaching;
          const selected = state.sessions.find((item) => item.id === sessionId);
          const saving = action.type === "SaveSessionPermissions";
          if (
            !sessionId ||
            sessionId !== state.sessionId ||
            state.popup.type !== "sessionPermissions" ||
            state.popup.sessionId !== sessionId ||
            state.popup.requestId !== requestId
          )
            throw Error(t("sessionPermissions.stale"));
          if (saving && (!selected || selected.parentID || selected.archived))
            throw Error(t("sessionPermissions.readOnly"));
          const policy = await this.call<PolicySnapshot>(
            saving ? "permission.set" : "permission.get",
            saving
              ? {
                  expected_revision: action.expectedRevision,
                  overrides: action.config.overrides,
                  review: action.config.review,
                  review_model: action.config.review_model ?? null,
                  initialization: action.config.initialization ?? "allow",
                }
              : {},
            sessionId,
          );
          if (
            cycle !== this.lifecycle ||
            route !== this.attaching ||
            sessionId !== this.state.sessionId ||
            this.state.popup.type !== "sessionPermissions" ||
            this.state.popup.requestId !== requestId
          )
            throw Error(t("sessionPermissions.stale"));
          if (
            this.state.policy == null ||
            policy.revision >= this.state.policy.revision
          )
            this.update({ policy });
          return policy;
        }
        case "SetPermissions": {
          const sessionId = state.sessionId;
          const cycle = this.lifecycle;
          const route = this.attaching;
          if (!sessionId) throw Error("Session is required");
          const policy = await this.call<PolicySnapshot>(
            "permission.set",
            {
              expected_revision: action.expectedRevision,
              overrides: action.overrides,
              review: action.review,
            },
            sessionId,
          );
          if (
            cycle === this.lifecycle &&
            route === this.attaching &&
            sessionId === this.state.sessionId &&
            (this.state.policy == null ||
              policy.revision >= this.state.policy.revision)
          ) {
            this.update({ policy });
          }
          return policy;
        }
        case "ForkSession": {
          const id = String(value ?? "");
          const source = state.sessions.find((item) => item.id === id);
          if (state.forkPending) return;
          if (state.forkUnknown?.[id])
            throw Error(
              "分叉结果未知。请刷新会话列表并选择已创建的分叉，不要重复创建。",
            );
          if (
            !source ||
            source.parentID ||
            source.archived ||
            id !== state.sessionId ||
            this.subscription?.snapshot.session.id !== id ||
            state.connection !== "ws" ||
            !state.authSession?.authenticated ||
            state.transcript.sessionStatus !== "idle" ||
            state.isCreatingSession ||
            state.compactInflight ||
            state.modeSelectionPending ||
            state.modelSelectionPending
          )
            throw Error("请先打开并等待源会话就绪后再分叉");
          const cycle = this.lifecycle;
          const knownTarget = state.forkTargets?.[id];
          if (knownTarget) {
            this.update({ forkPending: id, menuSession: null });
            try {
              await this.attach(knownTarget);
              if (cycle !== this.lifecycle) return;
              const targets = { ...this.state.forkTargets };
              delete targets[id];
              this.update({ forkTargets: targets });
            } finally {
              if (cycle === this.lifecycle) this.update({ forkPending: null });
            }
            return;
          }
          const route = this.attaching;
          const operationId = crypto.randomUUID();
          this.update({ forkPending: id, menuSession: null });
          let allocated = false;
          let forkAttempted = false;
          const conversationId = source.hostFlavor
            ? crypto.randomUUID()
            : undefined;
          let target: NativeSession;
          try {
            if (conversationId) {
              const owner = state.authSession?.principal?.owner;
              if (!owner) throw Error(t("browserHost.authenticationRequired"));
              // Attach only the fresh destination route. The source presentation
              // and running Host remain authoritative until fork commits.
              await this.api.connectBrowserConversation(
                conversationId,
                owner,
                source.hostFlavor!,
              );
            }
            forkAttempted = true;
            target = await this.call<NativeSession>(
              "session.fork",
              {
                operation_id: operationId,
                expected_revision: source.revision,
                ...(conversationId ? { conversation_id: conversationId } : {}),
              },
              id,
            );
            allocated = true;
          } catch (error) {
            if (conversationId && !forkAttempted)
              await this.api.disconnectBrowserConversation(conversationId);
            // Once fork was sent, even a terminal failure can follow destination
            // allocation. Retain that exact Host until allocation is reconciled.
            // Unknown outcomes additionally block another fork allocation.
            if (
              cycle === this.lifecycle &&
              error instanceof CommandError &&
              error.outcomeUnknown
            ) {
              this.update({
                forkUnknown: { ...this.state.forkUnknown, [id]: operationId },
              });
              throw Error(
                "分叉结果未知。请刷新会话列表并选择已创建的分叉；不会自动重试。",
              );
            }
            throw error;
          } finally {
            if (!allocated && cycle === this.lifecycle)
              this.update({ forkPending: null });
          }
          if (cycle !== this.lifecycle) return;
          this.upsert(target);
          this.update({
            sessions: [...this.state.sessions],
            forkTargets: { ...this.state.forkTargets, [id]: target.id },
          });
          try {
            if (route !== this.attaching || this.state.sessionId !== id) return;
            // Allocation is complete. A failed attach can be retried from the new
            // list row; it must never cause a second fork allocation.
            await this.attach(target.id);
            if (cycle !== this.lifecycle) return;
            const targets = { ...this.state.forkTargets };
            delete targets[id];
            this.update({ forkTargets: targets });
          } finally {
            if (cycle === this.lifecycle) this.update({ forkPending: null });
          }
          return;
        }
        case "RevertTurn": {
          const id = state.sessionId;
          const messageId = String(value ?? "");
          const target = state.transcript.blocks.find(
            (block) =>
              block.messageId === messageId &&
              block.role === "user" && isDirectUserSource(block.payload.source) &&
              !block.temporary,
          );
          const checkpointId = (
            state.history as { checkpoint_id?: string } | null
          )?.checkpoint_id;
          if (
            !id ||
            !target ||
            !checkpointId ||
            !this.editableComposer() ||
            state.transcript.sessionStatus === "busy" ||
            state.transcript.inboxActive ||
            state.compactInflight ||
            state.isCreatingSession ||
            state.imageIntakePending ||
            state.historyMutationPending ||
            state.inboxPending ||
            state.retryPending
          )
            throw Error(t("conversation.undoUnavailable"));
          const cycle = this.lifecycle,
            route = this.composerRoute,
            epoch = this.draftEpoch;
          const draft = state.composer,
            images = state.composerImages;
          this.update({ historyMutationPending: true });
          try {
            const snapshot = await this.call<NativeSnapshot>(
              "history.travel",
              {
                direction: "undo",
                message_id: messageId,
                expected_checkpoint_id: checkpointId,
              },
              id,
            );
            if (
              cycle !== this.lifecycle ||
              route !== this.composerRoute ||
              id !== this.state.sessionId
            )
              return;
            const restoredCheckpoint = (
              snapshot.history as { checkpoint_id?: string } | null
            )?.checkpoint_id;
            const currentCheckpoint = (
              this.state.history as { checkpoint_id?: string } | null
            )?.checkpoint_id;
            if (
              currentCheckpoint !== checkpointId &&
              currentCheckpoint !== restoredCheckpoint
            )
              throw Error(t("conversation.undoUnavailable"));
            this.snapshot(snapshot);
            if (
              (this.state.history as { checkpoint_id?: string } | null)
                ?.checkpoint_id !== restoredCheckpoint
            )
              throw Error(t("conversation.undoUnavailable"));
            if (snapshot.restored_input?.message_id !== messageId)
              throw Error(t("conversation.undoRestoreMissing"));
            if (
              epoch !== this.draftEpoch ||
              this.state.imageIntakePending ||
              this.state.composer !== draft ||
              this.state.composerImages !== images
            ) {
              this.toast(t("conversation.undoDraftChanged"));
              return;
            }
            const parts = snapshot.restored_input.parts;
            const restored = await historicalImages(
              parts,
              id,
              messageId,
              this.api,
              this.state.capabilities?.limits ?? {},
              () =>
                cycle === this.lifecycle &&
                route === this.composerRoute &&
                id === this.state.sessionId &&
                epoch === this.draftEpoch &&
                this.state.composer === draft &&
                this.state.composerImages === images,
            );
            if (!restored) return;
            if (
              cycle !== this.lifecycle ||
              route !== this.composerRoute ||
              id !== this.state.sessionId ||
              epoch !== this.draftEpoch ||
              this.state.composer !== draft ||
              this.state.composerImages !== images
            ) {
              for (const image of restored)
                URL.revokeObjectURL(image.previewUrl);
              return;
            }
            this.clearComposer();
            this.update({
              composer: parts
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join("\n"),
              composerImages: restored,
            });
          } finally {
            if (
              cycle === this.lifecycle &&
              route === this.composerRoute &&
              id === this.state.sessionId
            )
              this.update({ historyMutationPending: false });
          }
          return;
        }
        case "RetryTurn": {
          const id = state.sessionId;
          const failedOperationId = String(value ?? "");
          if (
            !id ||
            !failedOperationId ||
            failedOperationId !== state.retryOperationId ||
            !this.editableComposer() ||
            !state.capabilities?.methods.includes("turn.retry") ||
            state.transcript.sessionStatus === "busy" ||
            state.isCreatingSession ||
            state.historyMutationPending ||
            state.inboxPending ||
            this.retryRequests.has(id)
          )
            throw Error(t("conversation.retryUnavailable"));
          const cycle = this.lifecycle,
            route = this.composerRoute;
          const operationId = crypto.randomUUID();
          this.retryRequests.set(id, {
            operationId,
            route,
            history: JSON.stringify(state.history),
          });
          this.update({ retryPending: true });
          try {
            const receipt = await this.call<NativeOperation>(
              "turn.retry",
              {
                operation_id: operationId,
                failed_operation_id: failedOperationId,
              },
              id,
            );
            if (cycle !== this.lifecycle) return;
            this.reconcileSubmission(receipt);
            if (route === this.composerRoute && id === this.state.sessionId)
              this.update({ retryOperationId: null });
          } catch (error) {
            if (cycle !== this.lifecycle) return;
            if (error instanceof CommandError && error.outcomeUnknown) {
              if (route === this.composerRoute && id === this.state.sessionId)
                this.toast(t("conversation.retryUnknown"), "error");
              try {
                const receipt = await this.call<NativeOperation>(
                  "turn.get",
                  { operation_id: operationId },
                  id,
                );
                if (cycle === this.lifecycle) this.reconcileSubmission(receipt);
              } catch {
                /* Observation failure never authorizes mutation replay. */
              }
              return;
            }
            this.retryRequests.delete(id);
            if (route === this.composerRoute && id === this.state.sessionId)
              this.update({ retryPending: false });
            throw error;
          }
          return;
        }
        case "HistoryUndo":
        case "HistoryRedo": {
          if (
            state.historyMutationPending ||
            state.inboxPending ||
            state.retryPending ||
            state.isCreatingSession ||
            state.historyAvailable?.[
              action.type === "HistoryRedo" ? "redo" : "undo"
            ] === false
          )
            throw Error(t("error.history.unavailable"));
          const id = state.sessionId,
            cycle = this.lifecycle,
            route = this.composerRoute;
          this.update({ historyMutationPending: true });
          try {
            const snapshot = await this.call<NativeSnapshot>("history.travel", {
              direction: action.type === "HistoryRedo" ? "redo" : "undo",
            });
            if (
              cycle === this.lifecycle &&
              route === this.composerRoute &&
              id === this.state.sessionId
            )
              this.snapshot(snapshot);
          } finally {
            if (
              cycle === this.lifecycle &&
              route === this.composerRoute &&
              id === this.state.sessionId
            )
              this.update({ historyMutationPending: false });
          }
          return;
        }
        case "Checkpoint":
          await this.call("checkpoint.create");
          return;
        case "ToggleTheme":
        case "SetTheme": {
          const theme =
            action.type === "ToggleTheme"
              ? state.resolvedTheme === "dark"
                ? "light"
                : "dark"
              : normalizeThemePreference(value);
          savePreference("theme", theme);
          this.applyTheme(theme);
          return;
        }
        case "ToggleRail":
          this.update({ railCollapsed: !state.railCollapsed });
          savePreference("railCollapsed", this.state.railCollapsed);
          return;
        case "FitPluginRail":
          if (
            !state.rightRailCollapsed &&
            !state.railCollapsed &&
            window.innerWidth >= 1000 &&
            window.innerWidth < 1200
          )
            this.update({ railCollapsed: true });
          return;
        case "ToggleRightRail": {
          const opening = state.rightRailCollapsed;
          this.update({
            rightRailCollapsed: !opening,
            ...(opening && window.innerWidth >= 1000 && window.innerWidth < 1200
              ? { railCollapsed: true }
              : {}),
          });
          savePreference("rightRailCollapsed", this.state.rightRailCollapsed);
          return;
        }
        case "SetRightOverlay":
          this.update({ rightOverlayOpen: Boolean(value) });
          return;
        case "SetRightRailWidth":
          this.update({ rightRailWidth: Number(value) });
          savePreference("rightRailWidth", value);
          return;
        case "SetConversationWidth":
          this.update({ conversationWidth: Number(value) });
          savePreference("conversationWidth", value);
          return;
        case "ShowToast":
          this.toast(action.text ?? value, action.kind);
          return;
        case "DismissToast":
          this.update({ toast: null });
          return;
        case "OpenCreateProjectDialog":
          this.update({
            popup: { type: "createProject" },
            showWorkspaceDropdown: false,
          });
          return;
        case "OpenRemoteConnectDialog":
          if (
            !this.state.projects.some(
              (p) => p.id === (action.projectId ?? value),
            )
          )
            return;
          this.update({
            popup: {
              type: "remoteConnect",
              projectId: action.projectId ?? value,
              error: action.error,
              endpoint: action.endpoint,
              transport: action.transport,
            },
            showWorkspaceDropdown: false,
          });
          return;
        case "SelectDraftWorkspace": {
          const flavor: ConversationHostFlavor =
            value?.kind === "browser_sandbox" ? "browser_sandbox" : "chat_only";
          // A mode choice always starts a new immutable conversation identity.
          const existing = !!this.state.sessionId;
          if (existing) this.newChat(false);
          const oldId = existing ? null : this.draftConversationId;
          const changed = this.draftFlavor() !== flavor;
          if (existing || changed || !oldId) {
            this.hostAttempt++;
            this.draftConversationId = crypto.randomUUID();
            this.browserPrepared = null;
            this.browserPreparation = null;
          }
          try {
            localStorage.setItem(
              "microcrab.host-project.v2:" +
                hostPreferenceScope(this.api.base, state.authSession),
              "",
            );
          } catch {
            // Workspace selection does not require persistent preferences.
          }
          try {
            localStorage.setItem(
              "microcrab.conversation-flavor.v1:" + this.hostScope(),
              flavor,
            );
          } catch {}
          this.draftConversationId ??= crypto.randomUUID();
          this.update({
            draftWorkspace: { kind: flavor },
            showWorkspaceDropdown: false,
          });
          const defaultsCycle = this.lifecycle;
          await this.refreshDraftDefaults();
          if (defaultsCycle !== this.lifecycle || this.draftFlavor() !== flavor)
            return;
          if (changed && oldId)
            await this.api.disconnectBrowserConversation(oldId);
          await this.connectBrowserConversation(this.draftConversationId, true);
          return;
        }
        case "OpenSettings":
          this.update({ popup: { type: "settings", tab: "backend" } });
          return;
        case "SetSettingsTab":
          this.update({ popup: { ...state.popup, tab: value } });
          return;
        case "OpenProjectSettings": {
          const projectId = String(value ?? action.projectId ?? "");
          const tab = action.tab ?? "host";
          this.update({
            popup: { type: "projectSettings", projectId, tab },
            menuProject: null,
          });
          return;
        }
        case "SetProjectSettingsTab":
          if (state.popup.type !== "projectSettings") return;
          this.update({ popup: { ...state.popup, tab: value } });
          return;
        case "SetLocale": {
          const locale = normalizeLocalePreference(value);
          savePreference("locale", locale);
          const resolvedLocale = syncLocaleFromPreference(locale);
          this.update({ locale, resolvedLocale });
          return;
        }
        case "OpenSearch":
          this.update({ popup: { type: "search", query: "" } });
          return;
        case "SetSearchQuery":
          this.update({ popup: { ...state.popup, query: value } });
          return;
        case "SelectSearchSession":
          this.update({ popup: { type: "none" } });
          return await this.attach(value);
        case "OpenModelSelect":
          this.update({ popup: { type: "modelSelect", query: "" } });
          return;
        case "SetModelSearchQuery":
          this.update({ popup: { ...state.popup, query: value } });
          return;
        case "ToggleWorkspaceDropdown":
          this.update({ showWorkspaceDropdown: !state.showWorkspaceDropdown });
          return;
        case "CloseDropdowns":
          this.update({
            showWorkspaceDropdown: false,
            showRunningToolsMenu: false,
            showSubagentsMenu: false,
          });
          return;
        case "CopyText":
          await navigator.clipboard.writeText(value);
          return;
        case "SelectPluginTab": {
          const plugin = this.plugins.registry
            ?.getSnapshot()
            .find(
              (entry) =>
                entry.manifest.id === value &&
                entry.manifest.targets.includes("session-tab"),
            );
          if (
            state.sessionId &&
            plugin &&
            !(
              state.popup.type === "subagentDetail" &&
              state.popup.parentId === state.sessionId
            ) &&
            this.plugins.registry?.isEnabled(value, state.sessionId)
          )
            this.update({
              viewMode: "chat",
              sessionPluginTab: { sessionId: state.sessionId, pluginId: value },
            });
          return;
        }
        case "SelectViewTab":
          if (value === "chat" || value === "trajectory")
            this.update({ viewMode: value, sessionPluginTab: null });
          return;
        case "ToggleRunningToolsMenu":
          this.update({ showRunningToolsMenu: !state.showRunningToolsMenu });
          return;
        case "ToggleSubagentsMenu":
          this.update({ showSubagentsMenu: !state.showSubagentsMenu });
          if (!state.showSubagentsMenu) void this.loadChildren();
          return;
        case "ToggleBlockFold": {
          const block = state.transcript.blocks.find((b) => b.id === value);
          if (block)
            block.fold = block.fold === "collapsed" ? "expanded" : "collapsed";
          break;
        }
        case "ToggleTurnFold":
        case "ToggleRoundFold": {
          const field =
            action.type === "ToggleTurnFold" ? "turnFolds" : "roundFolds";
          state.transcript[field][value] =
            state.transcript[field][value] === "collapsed"
              ? "expanded"
              : "collapsed";
          break;
        }
        case "SetRoundAccordion":
          state.transcript.roundAccordion[action.turnId] = value;
          break;
        default:
          // TODO(native-ui-actions): map remaining inherited actions to capability-owned APIs.
          throw new CommandError(
            "unsupported",
            t("error.unsupported", {
              name: action.type,
              todo: `native-ui-actions/${action.type}`,
            }),
          );
      }
      this.update({ transcript: { ...state.transcript } });
    } catch (error) {
      reportDiagnostic("store", action.type, error);
      if (
        [
          "ReplyPermissionProposal",
          "SettingsRequest",
          "LoadSessionPermissions",
          "SaveSessionPermissions",
        ].includes(action.type)
      )
        throw error;
      this.toast(error instanceof Error ? error.message : String(error));
      if (
        [
          "ConnectHost",
          "CreateConnectedProject",
          "ReadExecutionOutput",
          "ReadExecutionContent",
          "CancelExecution",
          "GetSessionSnapshot",
          "SetPermissions",
        ].includes(action.type)
      )
        throw error;
      return undefined;
    }
  }
}
