import { ApiClient } from "./api";
import type { PendingQuestion } from "./types";
import {
  parseQuestions,
  parseSecretRequest,
  parseTodos,
  questionResult,
  questionMode,
  recommendedQuestionResult,
  type ClientToolDefinition,
} from "./client-tools";
export interface ClientInvocation {
  invocation_id: string;
  parent_session_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  arguments: unknown;
  epoch: number;
  turn_id: number | null;
  round_id: number | null;
  history_anchor?: string | null;
  catalog_digest: string;
  status:
    | "pending"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled"
    | "deadline"
    | "paused";
  interaction?: boolean;
  blocking_mode?: "blocking" | "deferred" | null;
  prepared?: boolean;
  timeout_result?: unknown;
  timeout_applied?: boolean;
  created_at_ms: number;
  deadline_ms: number;
  result?: unknown;
  error?: string;
}
export interface ClientCatalog {
  catalog_digest: string;
  definitions: ClientToolDefinition[];
  calls: ClientInvocation[];
  selected_invocation_ids?: string[];
}
export interface ClientBinding extends ClientCatalog {
  role: "executor" | "participant" | "observer";
  can_interact?: boolean;
  participation_id?: string;
  lease_id?: string;
  pending: ClientInvocation[];
  calls_truncated?: boolean;
  pending_truncated?: boolean;
  next_cursor?: number | null;
  total_calls?: number;
}
function unsettled(call: ClientInvocation) {
  return call.status === "pending" || call.status === "paused";
}
/** A socket lease is the sole execution authority; durable results are never replayed. */
export class ClientToolController {
  readonly clientId = crypto.randomUUID();
  binding: ClientBinding | null = null;
  sessionId: string | null = null;
  private seen = new Set<string>();
  private settling = new Set<string>();
  private imageRevoked = new Set<string>();
  private preparations = new Set<string>();
  private secretOperations = new Map<string, string>();
  private rebinding: Promise<void> | null = null;
  private leaseRefreshRequested = false;
  private bindingEpoch = 0;
  private revokeBinding() {
    if (this.binding) {
      const {
        lease_id: _lease,
        participation_id: _participation,
        ...binding
      } = this.binding;
      this.binding = { ...binding, role: "observer", can_interact: false };
    }
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.changed();
  }
  private releaseBuffer(buffered: { kind: string; call: ClientInvocation }[]) {
    if (this.buffered !== buffered) return;
    this.buffered = null;
    this.bufferSession = null;
    for (const item of buffered) this.receive(item.kind, item.call);
  }
  get canInteract() {
    return (
      !!this.binding &&
      (this.binding.can_interact === true ||
        (this.binding.can_interact === undefined &&
          this.binding.role === "executor" &&
          !!this.binding.lease_id))
    );
  }
  private canAnswer(call: ClientInvocation) {
    return (
      this.canInteract &&
      (call.interaction === true || this.binding?.role === "executor")
    );
  }
  private active = new Map<string, AbortController>();
  private generation = 0;
  private buffered: { kind: string; call: ClientInvocation }[] | null = null;
  private bufferSession: string | null = null;
  constructor(
    private api: ApiClient,
    private changed: () => void,
    private report: (error: unknown) => void,
    private external?: (
      name: string,
      args: unknown,
      signal: AbortSignal,
      invocation: Readonly<ClientInvocation>,
    ) => Promise<unknown>,
  ) {}
  reset() {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    if (this.binding?.lease_id && this.sessionId)
      void this.api
        .request(
          "client_tools.unbind",
          { lease_id: this.binding.lease_id },
          this.sessionId,
        )
        .catch(() => {});
    this.generation++;
    this.binding = null;
    this.sessionId = null;
    this.seen.clear();
    this.settling.clear();
    this.imageRevoked.clear();
    this.preparations.clear();
    this.secretOperations.clear();
    this.bindingEpoch++;
    this.rebinding = null;
    this.leaseRefreshRequested = false;
    this.buffered = null;
    this.bufferSession = null;
    this.changed();
  }
  async bind(sessionId: string, catalog: ClientCatalog) {
    const generation = ++this.generation;
    const buffer =
      this.bufferSession === sessionId ? (this.buffered ?? []) : [];
    this.buffered = buffer;
    this.bufferSession = sessionId;
    this.revokeBinding();
    try {
      const binding = await this.api.request<ClientBinding>(
        "client_tools.bind",
        { client_id: this.clientId, catalog_digest: catalog.catalog_digest },
        sessionId,
      );
      if (generation !== this.generation) return;
      if (binding.calls_truncated || binding.pending_truncated) {
        const calls: ClientInvocation[] = [];
        let cursor: number | null = 0;
        let bytes = 0;
        const cursors = new Set<number>();
        while (cursor !== null) {
          if (cursors.has(cursor) || cursors.size >= 128)
            throw Error("Invalid client invocation pagination");
          cursors.add(cursor);
          const page: {
            calls: ClientInvocation[];
            next_cursor: number | null;
            total_calls: number;
          } = await this.api.request<{
            calls: ClientInvocation[];
            next_cursor: number | null;
            total_calls: number;
          }>("client_tools.calls", { cursor, limit: 64 }, sessionId);
          if (generation !== this.generation) return;
          bytes += new TextEncoder().encode(
            JSON.stringify(page.calls),
          ).byteLength;
          if (
            !Array.isArray(page.calls) ||
            page.calls.length > 64 ||
            page.total_calls > 8192 ||
            bytes > 32 * 1024 * 1024
          )
            throw Error("Client invocation recovery exceeds browser budget");
          calls.push(...page.calls);
          cursor = page.next_cursor;
          if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0))
            throw Error("Invalid client invocation cursor");
        }
        binding.calls = calls;
        binding.pending = calls.filter(unsettled);
        binding.calls_truncated = false;
        binding.pending_truncated = false;
      }
      this.sessionId = sessionId;
      this.binding = binding;
      // Only questions are recoverable. Reconnection never executes mutations again.
      const buffered = this.buffered ?? [];
      const live = new Set(
        buffered
          .filter((item) => item.kind === "client_tool.requested")
          .map((item) => item.call.invocation_id),
      );
      for (const call of binding.pending)
        if (!live.has(call.invocation_id)) this.seen.add(call.invocation_id);
      this.buffered = null;
      this.bufferSession = null;
      this.changed();
      for (const item of buffered) this.receive(item.kind, item.call);
      for (const call of binding.pending)
        if (
          ["ask_user_question", "request_secret"].includes(call.tool) &&
          call.interaction &&
          this.canInteract
        )
          void this.prepareQuestion(call).catch(this.report);
    } catch (error) {
      if (generation !== this.generation) return;
      // Keep receipts and pending interactions observable after a failed refresh,
      // but never keep the previous executor lease or replay producer requests.
      this.revokeBinding();
      this.releaseBuffer(buffer);
      throw error;
    }
  }
  get questions(): PendingQuestion[] {
    return (this.binding?.pending ?? [])
      .filter(
        (call) =>
          ["ask_user_question", "request_secret"].includes(call.tool) &&
          unsettled(call),
      )
      .map((call): PendingQuestion | null => {
        try {
          return {
            id: call.invocation_id,
            sessionId: call.session_id,
            parentSessionId: call.parent_session_id,
            callId: call.call_id,
            epoch: call.epoch,
            turnId: call.turn_id,
            roundId: call.round_id,
            createdAt: call.created_at_ms,
            questions:
              call.tool === "request_secret"
                ? []
                : parseQuestions(call.arguments),
            ...(call.tool === "request_secret"
              ? { secret: parseSecretRequest(call.arguments) }
              : {}),
            deadline: call.deadline_ms,
            blockingMode:
              call.blocking_mode ??
              (call.tool === "request_secret"
                ? "blocking"
                : questionMode(call.arguments)),
            paused: call.status === "paused",
            observer: !this.canAnswer(call),
            awaitingConfirmation: this.settling.has(call.invocation_id),
            imageRevoked: this.imageRevoked.has(call.invocation_id),
            disabled:
              !this.canAnswer(call) || this.settling.has(call.invocation_id),
          };
        } catch {
          return null;
        }
      })
      .filter((question): question is PendingQuestion => question !== null);
  }
  receive(kind: string, call: ClientInvocation) {
    if (this.buffered) {
      if (this.buffered.length >= 8192)
        throw Error("Client tool event buffer exceeded");
      this.buffered.push({ kind, call });
      return;
    }
    if (
      !this.binding ||
      !call ||
      ![
        "client_tool.requested",
        "client_tool.settled",
        "client_tool.prepared",
        "client_tool.paused",
        "client_tool.cancel_requested",
      ].includes(kind)
    )
      return;
    if (kind === "client_tool.cancel_requested") {
      // Request local cleanup; only the server's settled record confirms the outcome.
      this.active.get(call.invocation_id)?.abort();
      this.imageRevoked.add(call.invocation_id);
      this.changed();
      return;
    }
    const prior = this.binding.calls.find(
      (item) => item.invocation_id === call.invocation_id,
    );
    if (
      prior &&
      ((!unsettled(prior) && unsettled(call)) ||
        (prior.status === "paused" && call.status === "pending"))
    )
      return;
    if (!unsettled(call)) {
      this.active.get(call.invocation_id)?.abort();
      this.settling.delete(call.invocation_id);
      this.secretOperations.delete(call.invocation_id);
      this.preparations.delete(call.invocation_id);
    }
    this.binding.calls = [
      ...this.binding.calls.filter(
        (item) => item.invocation_id !== call.invocation_id,
      ),
      call,
    ];
    this.binding.pending = [
      ...this.binding.pending.filter(
        (item) => item.invocation_id !== call.invocation_id,
      ),
      ...(unsettled(call) ? [call] : []),
    ];
    this.changed();
    if (
      kind === "client_tool.requested" &&
      ["ask_user_question", "request_secret"].includes(call.tool) &&
      this.canInteract
    )
      void this.prepareQuestion(call).catch(this.report);
    if (
      kind !== "client_tool.requested" ||
      this.binding.role !== "executor" ||
      this.seen.has(call.invocation_id)
    )
      return;
    this.seen.add(call.invocation_id);
    void this.execute(call).catch(this.report);
  }
  private async execute(call: ClientInvocation) {
    if (!unsettled(call)) return;
    const generation = this.generation;
    let result: unknown;
    try {
      if (call.tool === "request_secret") {
        parseSecretRequest(call.arguments);
        await this.prepareQuestion(call).catch(this.report);
        this.changed();
        return;
      }
      if (call.tool === "ask_user_question") {
        parseQuestions(call.arguments);
        await this.prepareQuestion(call).catch(this.report);
        this.changed();
        return;
      }
      result = await this.executeExternal(call);
    } catch (error) {
      if (generation !== this.generation) return;
      await this.settle(
        call,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // Transport failure has unknown outcome: never convert it into another result submission.
    if (generation !== this.generation) return;
    await this.settle(call, result);
  }
  private async prepareQuestion(call: ClientInvocation) {
    if (
      !call.interaction ||
      call.blocking_mode === "deferred" ||
      (call.tool === "ask_user_question" &&
        questionMode(call.arguments) === "deferred") ||
      call.prepared ||
      this.preparations.has(call.invocation_id)
    )
      return;
    const lease = this.binding?.lease_id;
    if (!this.canInteract || this.sessionId !== call.parent_session_id) return;
    this.preparations.add(call.invocation_id);
    const generation = this.generation;
    const timeout_result =
      call.tool === "ask_user_question"
        ? recommendedQuestionResult(call.arguments)
        : undefined;
    const prepared = await this.api.request<ClientInvocation>(
      "client_tools.prepare",
      {
        ...(lease ? { lease_id: lease } : {}),
        invocation_id: call.invocation_id,
        ...(timeout_result === undefined ? {} : { timeout_result }),
      },
      call.parent_session_id,
    );
    if (generation === this.generation && prepared?.invocation_id)
      this.receive(
        prepared.status === "paused"
          ? "client_tool.paused"
          : "client_tool.prepared",
        prepared,
      );
  }
  private async executeExternal(call: ClientInvocation) {
    const controller = new AbortController();
    this.active.set(call.invocation_id, controller);
    const timer =
      call.deadline_ms > 0
        ? setTimeout(
            () => controller.abort(),
            Math.max(0, Math.min(2147483647, call.deadline_ms - Date.now())),
          )
        : undefined;
    try {
      const lease = this.binding?.lease_id;
      if (this.binding?.role !== "executor" || !lease)
        throw Error("Client execution lease expired");
      const privateCall = await this.api.request<{
        invocation_id: string;
        arguments: unknown;
      }>(
        "client_tools.arguments",
        { invocation_id: call.invocation_id, lease_id: lease },
        call.parent_session_id,
      );
      if (
        controller.signal.aborted ||
        this.binding?.lease_id !== lease ||
        this.binding?.role !== "executor" ||
        privateCall.invocation_id !== call.invocation_id
      )
        throw Error("Client execution lease or invocation expired");
      if (call.tool === "update_todo_list")
        return { todos: parseTodos(privateCall.arguments) };
      if (!this.external) throw Error(`Unknown client tool: ${call.tool}`);
      return await this.external(
        call.tool,
        privateCall.arguments,
        controller.signal,
        Object.freeze(structuredClone(call)),
      );
    } finally {
      clearTimeout(timer);
      this.active.delete(call.invocation_id);
    }
  }
  async answer(id: string, answers: unknown, dismissed: boolean) {
    const call = this.binding?.pending.find(
      (item) => item.invocation_id === id,
    );
    if (!call || call.tool !== "ask_user_question")
      throw Error("Question is no longer pending");
    return this.settle(
      call,
      questionResult(parseQuestions(call.arguments), answers, dismissed),
      undefined,
      true,
    );
  }
  async declineSecret(id: string) {
    const call = this.binding?.pending.find(
      (item) => item.invocation_id === id,
    );
    if (!call || call.tool !== "request_secret")
      throw Error("Secret request is no longer pending");
    return this.settle(call, { status: "declined" }, undefined, true);
  }
  async submitSecret(id: string, values: Record<string, string>) {
    const call = this.binding?.pending.find(
      (item) => item.invocation_id === id,
    );
    if (
      !call ||
      !this.canAnswer(call) ||
      call.tool !== "request_secret" ||
      this.sessionId !== call.parent_session_id
    )
      throw Error("Secret request is no longer pending");
    const request = parseSecretRequest(call.arguments);
    if (
      Object.keys(values).length !== request.secrets.length ||
      request.secrets.some(
        ({ key }) =>
          typeof values[key] !== "string" ||
          new TextEncoder().encode(values[key]).byteLength < 1 ||
          new TextEncoder().encode(values[key]).byteLength > 8192,
      )
    )
      throw Error("Invalid secret values");
    if (this.secretOperations.has(id)) return this.observeSecret(id);
    const operation = crypto.randomUUID();
    const generation = this.generation;
    this.secretOperations.set(id, operation);
    this.settling.add(id);
    this.changed();
    try {
      const settled = await this.api.request<ClientInvocation>(
        "client_tools.secret",
        {
          invocation_id: id,
          operation_id: operation,
          values,
        },
        call.parent_session_id,
      );
      if (generation === this.generation && settled.invocation_id === id)
        this.receive("client_tool.settled", settled);
    } catch {
      // Never echo a failure body or replay a payload that may have committed.
      if (generation === this.generation) await this.observeSecret(id);
      throw Error("Secret reply requires receipt reconciliation");
    } finally {
      for (const key of Object.keys(values)) delete values[key];
    }
  }
  async observeSecret(id: string) {
    const operation = this.secretOperations.get(id);
    const parent = this.sessionId;
    if (!operation || !parent) return;
    const generation = this.generation;
    const receipt = await this.api.request<{
      operation_id: string;
      invocation_id: string;
      status: "committing" | "completed" | "failed";
      call?: ClientInvocation;
    }>("client_tools.secret_operation", { operation_id: operation }, parent);
    if (
      generation !== this.generation ||
      receipt.operation_id !== operation ||
      receipt.invocation_id !== id
    )
      return;
    if (receipt.call) this.receive("client_tool.settled", receipt.call);
    if (receipt.status !== "committing") {
      this.secretOperations.delete(id);
      this.settling.delete(id);
      this.changed();
    }
  }
  /** Lease events restore observation; only the Server may elect a new executor. */
  leaseChanged(executorConnected: boolean) {
    if (!this.binding || !this.sessionId) return;
    void executorConnected;
    this.leaseRefreshRequested = true;
    if (this.rebinding) {
      // A newer election invalidates the in-flight bind's captured snapshot.
      this.generation++;
      this.revokeBinding();
      return;
    }
    const parent = this.sessionId;
    const epoch = this.bindingEpoch;
    const refresh = (async () => {
      // One current refresh plus one coalesced trailing refresh. Repeated churn
      // leaves a safe observer instead of creating an unbounded bind loop.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (
          epoch !== this.bindingEpoch ||
          this.sessionId !== parent ||
          !this.binding ||
          !this.leaseRefreshRequested
        )
          return;
        this.leaseRefreshRequested = false;
        await this.bind(parent, this.binding);
      }
      if (
        epoch === this.bindingEpoch &&
        this.sessionId === parent &&
        this.leaseRefreshRequested
      ) {
        this.leaseRefreshRequested = false;
        this.revokeBinding();
        if (this.buffered) this.releaseBuffer(this.buffered);
        throw Error(
          "Client execution lease kept changing; reconnect to refresh the binding",
        );
      }
    })().finally(() => {
      if (this.rebinding === refresh) this.rebinding = null;
    });
    this.rebinding = refresh;
    void refresh.catch(this.report);
  }
  async takeover() {
    if (!this.sessionId || !this.binding || !this.canInteract)
      throw Error("Interaction binding expired");
    const generation = this.generation;
    const binding = await this.api.request<ClientBinding>(
      "client_tools.takeover",
      {
        client_id: this.clientId,
        catalog_digest: this.binding.catalog_digest,
      },
      this.sessionId,
    );
    if (generation !== this.generation) return;
    this.generation++;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.binding = binding;
    this.changed();
  }
  private async settle(
    call: ClientInvocation,
    result?: unknown,
    error?: string,
    human = false,
  ) {
    const lease = this.binding?.lease_id;
    if (
      !this.binding ||
      (human
        ? !this.canAnswer(call)
        : this.binding.role !== "executor" || !lease) ||
      this.sessionId !== call.parent_session_id ||
      !this.binding.pending.some(
        (item) => item.invocation_id === call.invocation_id,
      )
    )
      throw Error("Client execution lease or invocation expired");
    if (error === undefined) {
      const encoded = JSON.stringify(result);
      if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > 64 * 1024
      ) {
        error =
          "Client tool result is missing or exceeds the durable bridge budget";
        result = undefined;
      }
    }
    if (error !== undefined) error = error.slice(0, 4000);
    if (this.settling.has(call.invocation_id))
      throw Error("Response is awaiting durable reconciliation");
    this.settling.add(call.invocation_id);
    this.changed();
    const generation = this.generation;
    const settled = await this.api.request<ClientInvocation>(
      "client_tools.result",
      {
        ...(lease ? { lease_id: lease } : {}),
        invocation_id: call.invocation_id,
        ...(error === undefined ? { result } : { error }),
      },
      call.parent_session_id,
    );
    if (generation === this.generation && settled?.invocation_id)
      this.receive("client_tool.settled", settled);
  }
}
