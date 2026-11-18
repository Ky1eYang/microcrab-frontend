import { CommandError, type ApiClient } from "../client/api";
import type {
  AppState,
  NativeEvent,
  RoundLimitRequest,
  RoundLimitRequests,
} from "../client/types";
import { t } from "../i18n";

/** Round questions have their own lifecycle; permission grants never answer them. */
export class RoundLimitController {
  private parent: string | null = null;
  private requests = new Map<string, RoundLimitRequest>();
  private settled = new Set<string>();
  private submitting = new Set<string>();
  private generation = 0;
  private eventVersion = 0;
  private sync = 0;
  constructor(
    private api: ApiClient,
    private state: () => AppState,
    private publish: (patch: Partial<AppState>) => void,
    private lease: () => string | null,
    /** Re-attach the session; the attachment carries the current pending set. */
    private reconcile: () => Promise<void> = async () => {},
    private canInteract: () => boolean = () => !!this.lease(),
  ) {}
  private rememberSettled(id: string) {
    this.settled.add(id);
    while (this.settled.size > 256)
      this.settled.delete(this.settled.values().next().value!);
  }
  project() {
    const state = this.state();
    const executor = state.connection === "ws" && this.canInteract();
    this.publish({
      roundLimitRequests: [...this.requests.values()]
        .filter(
          (request) =>
            request.parent_session_id === state.sessionId &&
            !this.settled.has(request.request_id),
        )
        .map((request) => ({
          ...request,
          observer: !executor,
          submitting: this.submitting.has(request.request_id),
          disabled: !executor || this.submitting.has(request.request_id),
        })),
    });
  }
  reset(parent: string | null = null) {
    this.parent = parent;
    this.generation++;
    this.sync++;
    this.requests.clear();
    this.settled.clear();
    this.submitting.clear();
    this.project();
  }
  /** Install the pending set delivered by a session attachment. */
  refresh(snapshot?: RoundLimitRequests | null) {
    const state = this.state(),
      parent = state.sessionId;
    if (!parent || snapshot === undefined) return;
    if (snapshot === null) {
      this.requests.clear();
      this.project();
      return;
    }
    if (this.parent !== parent) this.reset(parent);
    if (state.connection !== "ws" || snapshot.parent_session_id !== parent)
      return;
    this.sync++;
    this.requests.clear();
    for (const request of snapshot.requests ?? [])
      if (
        request.parent_session_id === parent &&
        !this.settled.has(request.request_id)
      )
        this.requests.set(request.request_id, request);
    this.project();
  }
  receive(event: NativeEvent) {
    if (event.event === "round_limit.requested") {
      const request = event.data.request;
      if (
        request?.parent_session_id !== this.state().sessionId ||
        this.settled.has(request.request_id)
      )
        return;
      this.eventVersion++;
      this.requests.set(request.request_id, request);
      this.project();
    } else if (event.event === "round_limit.settled") {
      const result = event.data;
      if (
        result.parent_session_id &&
        result.parent_session_id !== this.state().sessionId
      )
        return;
      this.eventVersion++;
      this.rememberSettled(result.request_id);
      this.requests.delete(result.request_id);
      this.submitting.delete(result.request_id);
      this.project();
    }
  }
  async reply(requestId: string, decision: string) {
    const state = this.state(),
      parent = state.sessionId,
      lease = this.lease();
    if (
      !["continue", "stop"].includes(decision) ||
      !parent ||
      !this.requests.has(requestId) ||
      this.settled.has(requestId)
    )
      throw Error(t("roundLimit.stale"));
    if (this.submitting.has(requestId)) return;
    if (state.connection !== "ws" || !this.canInteract())
      throw Error(t("roundLimit.observer"));
    const generation = this.generation;
    this.submitting.add(requestId);
    this.project();
    let unknown = false;
    try {
      const result = await this.api.request<{
        request_id: string;
        decision: string;
      }>(
        "round_limit.reply",
        { request_id: requestId, ...(lease ? { lease_id: lease } : {}), decision },
        parent,
      );
      if (result.request_id !== requestId || !["continue", "stop"].includes(result.decision))
        throw new CommandError(
          "invalid_result",
          t("roundLimit.stale"),
          false,
          true,
        );
      if (generation !== this.generation || this.state().sessionId !== parent)
        return;
      this.rememberSettled(requestId);
      this.requests.delete(requestId);
    } catch (error) {
      unknown = error instanceof CommandError && error.outcomeUnknown;
      if (unknown) {
        const receipt = await this.api.request<{ request_id: string; decision: string }>(
          "client_tools.decision", { kind: "round_limit", request_id: requestId }, parent).catch(() => null);
        if (generation === this.generation && this.state().sessionId === parent &&
            receipt?.request_id === requestId && ["continue", "stop"].includes(receipt.decision)) {
          unknown = false;
          this.rememberSettled(requestId);
          this.requests.delete(requestId);
          return;
        }
      }
      if (generation !== this.generation || this.state().sessionId !== parent)
        return;
      await this.reconcile().catch(() => {});
      throw error;
    } finally {
      if (generation === this.generation) {
        if (!unknown) this.submitting.delete(requestId);
        this.project();
      }
    }
  }
}
