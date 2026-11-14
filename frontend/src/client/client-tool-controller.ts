import { ApiClient } from "./api";
import type { PendingQuestion } from "./types";
import {
  parseQuestions,
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
  role: "executor" | "observer";
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
  private preparations = new Set<string>();
  private active = new Map<string, AbortController>();
  private generation = 0;
  private buffered: { kind: string; call: ClientInvocation }[] | null = null;
  constructor(
    private api: ApiClient,
    private changed: () => void,
    private report: (error: unknown) => void,
    private external?: (
      name: string,
      args: unknown,
      signal: AbortSignal,
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
    this.preparations.clear();
    this.buffered = null;
    this.changed();
  }
  async bind(sessionId: string, catalog: ClientCatalog) {
    const generation = ++this.generation;
    this.buffered = [];
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
    this.changed();
    for (const item of buffered) this.receive(item.kind, item.call);
    for (const call of binding.pending)
      if (
        call.tool === "ask_user_question" &&
        call.interaction &&
        binding.role === "executor"
      )
        void this.prepareQuestion(call).catch(this.report);
  }
  get questions(): PendingQuestion[] {
    return (this.binding?.pending ?? [])
      .filter((call) => call.tool === "ask_user_question" && unsettled(call))
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
            questions: parseQuestions(call.arguments),
            deadline: call.deadline_ms,
            blockingMode: call.blocking_mode ?? questionMode(call.arguments),
            paused: call.status === "paused",
            observer: this.binding?.role !== "executor",
            awaitingConfirmation: this.settling.has(call.invocation_id),
            disabled:
              this.binding?.role !== "executor" ||
              this.settling.has(call.invocation_id),
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
        "client_tool.paused",
        "client_tool.cancel_requested",
      ].includes(kind)
    )
      return;
    if (kind === "client_tool.cancel_requested") {
      // Request local cleanup; only the server's settled record confirms the outcome.
      this.active.get(call.invocation_id)?.abort();
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
    if (!unsettled(call)) this.active.get(call.invocation_id)?.abort();
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
    let result: unknown;
    try {
      if (call.tool === "ask_user_question") {
        parseQuestions(call.arguments);
        await this.prepareQuestion(call).catch(this.report);
        this.changed();
        return;
      }
      result =
        call.tool === "update_todo_list"
          ? { todos: parseTodos(call.arguments) }
          : await this.executeExternal(call);
    } catch (error) {
      await this.settle(
        call,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // Transport failure has unknown outcome: never convert it into another result submission.
    await this.settle(call, result);
  }
  private async prepareQuestion(call: ClientInvocation) {
    if (
      !call.interaction ||
      call.blocking_mode === "deferred" ||
      questionMode(call.arguments) === "deferred" ||
      call.prepared ||
      this.preparations.has(call.invocation_id)
    )
      return;
    const lease = this.binding?.lease_id;
    if (
      !lease ||
      this.binding?.role !== "executor" ||
      this.sessionId !== call.parent_session_id
    )
      return;
    this.preparations.add(call.invocation_id);
    const generation = this.generation;
    const timeout_result = recommendedQuestionResult(call.arguments);
    const prepared = await this.api.request<ClientInvocation>(
      "client_tools.prepare",
      {
        lease_id: lease,
        invocation_id: call.invocation_id,
        ...(timeout_result === undefined ? {} : { timeout_result }),
      },
      call.parent_session_id,
    );
    if (generation === this.generation && prepared?.invocation_id)
      this.receive(
        prepared.status === "paused"
          ? "client_tool.paused"
          : "client_tool.settled",
        prepared,
      );
  }
  private async executeExternal(call: ClientInvocation) {
    if (!this.external) throw Error(`Unknown client tool: ${call.tool}`);
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
      return await this.external(call.tool, call.arguments, controller.signal);
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
    );
  }
  private async settle(
    call: ClientInvocation,
    result?: unknown,
    error?: string,
  ) {
    const lease = this.binding?.lease_id;
    if (
      this.binding?.role !== "executor" ||
      !lease ||
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
        lease_id: lease,
        invocation_id: call.invocation_id,
        ...(error === undefined ? { result } : { error }),
      },
      call.parent_session_id,
    );
    if (generation === this.generation && settled?.invocation_id)
      this.receive("client_tool.settled", settled);
  }
}
