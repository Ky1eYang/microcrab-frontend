import {
  retainPermissionDecisions,
  validatePermissionDecision,
} from "../permission-decisions";
import { validateExecutionHistory } from "../execution-history";
import { reportDiagnostic, silenceDiagnostic } from "../diagnostics";
import { TransportDiagnosticStreak } from "../transport-diagnostics";
import { CommandError } from "../errors";
import { materialize } from "../increments";
import {
  decodeFrame,
  encodeCommand,
  MAX_FRAME_BYTES as MAX_FRAME,
} from "./codec";
import type {
  NativeEvent,
  NativeSnapshot,
  NativeSubscription,
  SessionEventFrame,
} from "../types";

const MAX_PENDING = 64;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
}

/** One socket for one Session selection. Opening subscribes; the first frame is
 * metadata followed by its bounded canonical page, and closing releases the subscription and every
 * executor lease this socket bound. A replacement selection uses a new
 * instance, so this socket stays open until the caller commits that
 * replacement. */
export class SessionSocket {
  private socket: WebSocket | null = null;
  private diagnostics = new TransportDiagnosticStreak("session_socket");
  private pending = new Map<string, Pending>();
  private subscription: NativeSubscription | null = null;
  private stopped = false;
  private ready = false;
  private manualRefresh: Promise<NativeSubscription> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private handlers: {
    event?: (event: NativeEvent) => void;
    /** The reopened socket's barrier. Its sequence is the barrier, not an event. */
    resubscribed?: (subscription: NativeSubscription) => void;
    authRequired?: () => void;
  } = {};

  constructor(
    private readonly urlFor: (path: string) => string,
    private readonly resumeQuery?: () => {
      display_watermark: number;
      history_lineage?: string;
    },
  ) {}

  private receivedBoundary() {
    // The advertised server high_water is availability, not client receipt.
    // Only the projector's validated scanned_through may skip replay records.
    return this.resumeQuery?.() ?? { display_watermark: 0 };
  }

  /** The Session this socket subscribed. Commands are valid only while it matches. */
  get sessionId(): string | null {
    return this.ready ? (this.subscription?.snapshot.session.id ?? null) : null;
  }

  /** Opens this socket and resolves with its first `subscribed` frame. A later
   * close of the same selection reconnects with the last watermark. */
  open(
    sessionId: string,
    query: { display_watermark: number; history_lineage?: string },
    handlers: {
      event: (event: NativeEvent) => void;
      resubscribed?: (subscription: NativeSubscription) => void;
      authRequired?: () => void;
    },
  ): Promise<NativeSubscription> {
    this.stopped = false;
    this.ready = false;
    this.handlers = handlers;
    clearTimeout(this.retry);
    this.retry = undefined;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    const url = new URL(
      this.urlFor(`api/v1/sessions/${encodeURIComponent(sessionId)}/ws`),
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("display_watermark", String(query.display_watermark));
    if (query.history_lineage)
      url.searchParams.set("history_lineage", query.history_lineage);
    return new Promise<NativeSubscription>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      let established = false;
      let diagnosticReported = false;
      let hasPage = false;
      let initial: NativeSubscription | null = null;
      let remaining = 0;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (!this.stopped && socket === this.socket && !diagnosticReported) {
          diagnosticReported = true;
          reportDiagnostic("session_socket", "subscribe", error);
        } else silenceDiagnostic(error);
        reject(error);
      };
      // The initial page is part of opening: a connected socket that never
      // supplies its declared events must not leave navigation pending forever.
      const opening = setTimeout(() => {
        fail(
          new CommandError("timed_out", "Session attachment timed out", true),
        );
        socket.close();
      }, 60000);
      socket.onmessage = ({ data }) => {
        if (socket !== this.socket) return;
        const decoded = decodeFrame(data);
        if (!decoded.ok) {
          diagnosticReported = true;
          reportDiagnostic("session_socket", "decode", {
            code: "invalid_result",
            message: "Invalid Session WebSocket frame",
            details: { close_code: decoded.closeCode, reason: decoded.reason },
          });
          socket.close(decoded.closeCode);
          return;
        }
        const frame = decoded.frame;
        if (!settled) {
          if (frame.type === "error") {
            if (frame.error?.code === "unauthenticated")
              this.handlers.authRequired?.();
            fail(
              new CommandError(
                frame.error?.code ?? "unavailable",
                frame.error?.message ?? "Session subscription refused",
              ),
            );
            socket.close();
            return;
          }
          if (initial) {
            if (
              !validEvent(frame) ||
              frame.session_id !== sessionId ||
              frame.subscription_id !== initial.subscription_id ||
              frame.generation !== initial.generation ||
              frame.sequence !== initial.sequence + 1 ||
              ![
                "blocks.page",
                "session.meta",
                "statistics.updated",
                "history.reset",
              ].includes(frame.event)
            ) {
              fail(
                new CommandError(
                  "invalid_result",
                  "Invalid initial Session event sequence",
                  true,
                ),
              );
              socket.close(4002);
              return;
            }
            const next = materialize(initial.snapshot, frame.event, frame.data);
            if (next.incomplete) {
              fail(
                new CommandError(
                  "invalid_result",
                  "Initial Session page omitted a block body",
                  true,
                ),
              );
              socket.close(4002);
              return;
            }
            hasPage ||= frame.event === "blocks.page";
            initial.snapshot = next.view;
            initial.sequence = frame.sequence;
            if (--remaining > 0) return;
            if (!hasPage) {
              fail(
                new CommandError(
                  "invalid_result",
                  "Initial Session events omitted the canonical page",
                  true,
                ),
              );
              socket.close(4002);
              return;
            }
            settled = true;
            established = true;
            this.ready = true;
            this.diagnostics.connected();
            clearTimeout(opening);
            this.subscription = initial;
            this.failures = 0;
            resolve(initial);
            return;
          }
          let subscription: NativeSubscription;
          try {
            subscription = subscriptionOf(frame, sessionId);
          } catch (error) {
            fail(error as Error);
            socket.close(4002);
            return;
          }
          initial = subscription;
          remaining = frame.initial_events;
          if (remaining > 0) return;
          settled = true;
          established = true;
          this.ready = true;
          this.diagnostics.connected();
          clearTimeout(opening);
          this.subscription = subscription;
          this.failures = 0;
          resolve(subscription);
          return;
        }
        if (frame.type === "result") this.settle(frame);
        else if (frame.type === "event" && validEvent(frame))
          this.handlers.event?.(frame);
        else socket.close(4002);
      };
      socket.onerror = () =>
        fail(
          new CommandError(
            "disconnected",
            "WebSocket unavailable; sign in again if your session expired",
            true,
          ),
        );
      socket.onclose = (event) => {
        clearTimeout(opening);
        const current = socket === this.socket;
        if (current) {
          if (!this.stopped && !diagnosticReported) {
            diagnosticReported = true;
            this.diagnostics.failure("close", {
              code: "disconnected",
              message: "Session WebSocket closed unexpectedly",
              details: {
                close_code: event.code,
                cause: event.reason,
                phase: established ? "established" : "opening",
                reason:
                  event.code === 1006
                    ? "abnormal_closure_no_close_frame"
                    : "close_frame",
                attempt: this.failures,
                buffered_bytes: socket.bufferedAmount,
              },
            });
          }
          this.socket = null;
          this.ready = false;
        }
        if (!established) {
          fail(new CommandError("disconnected", "Connection lost", true));
          return;
        }
        if (!current) return;
        this.rejectPending();
        if (!this.stopped && this.subscription)
          this.retry = setTimeout(
            () => this.reopen(sessionId),
            Math.min(1000 * 2 ** this.failures++, 10000),
          );
      };
    });
  }

  command<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    requestId: string,
    mutation = false,
  ): Promise<T> {
    // Admission and send must remain synchronous: selection replacement may
    // retire this socket immediately after issuing its exact lease unbind.
    try {
      return this.commandNative<T>(
        method,
        params,
        timeout,
        requestId,
        mutation,
      ).catch((error) => {
        reportDiagnostic("session_socket", method, error);
        throw error;
      });
    } catch (error) {
      reportDiagnostic("session_socket", method, error);
      return Promise.reject(error);
    }
  }

  private commandNative<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    requestId: string,
    mutation = false,
  ): Promise<T> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new CommandError(
          "disconnected",
          "Connection is not ready; reconnect before sending",
          true,
        ),
      );
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(
        new CommandError("limit_exceeded", "Too many pending commands", true),
      );
    const body = encodeCommand(method, params, requestId);
    if (
      new TextEncoder().encode(body).byteLength > MAX_FRAME ||
      socket.bufferedAmount > MAX_FRAME
    )
      return Promise.reject(
        new CommandError(
          "limit_exceeded",
          "Command exceeds the connection budget",
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new CommandError(
          "timed_out",
          mutation
            ? "Command outcome is unknown. Reconcile the receipt before trying again."
            : "Command timed out",
          true,
          mutation,
        );
        reportDiagnostic("session_socket", method, error);
        reject(error);
      }, timeout);
      const rejectReported = (error: Error) => {
        reportDiagnostic("session_socket", method, error);
        reject(error);
      };
      this.pending.set(requestId, {
        resolve,
        reject: rejectReported,
        timer,
        mutation,
      });
      try {
        socket.send(body);
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new CommandError(
            "disconnected",
            "Command outcome is unknown; reconcile the receipt",
            true,
            mutation,
          ),
        );
      }
    });
  }

  /** Closes this socket. The server releases its subscription and executor lease. */
  stop(reject = true) {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (reject) this.rejectPending();
  }

  /** Drops the live socket and opens a fresh subscription with the same
   * watermark. A gap or `resync_required` is the only caller: the barrier
   * view arrives through `resubscribed`, never as a synthetic event. */
  reconnect() {
    if (this.stopped || !this.subscription) return;
    this.ready = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const sessionId = this.subscription.snapshot.session.id;
    const socket = this.socket;
    this.socket = null;
    this.rejectPending();
    socket?.close();
    this.reopen(sessionId);
  }

  /** Explicit user refresh uses the same path and display watermark as gap
   * recovery. It awaits the new canonical page and pending questions; it never
   * borrows child authority or touches the global Host carrier. */
  refresh(): Promise<NativeSubscription> {
    if (this.manualRefresh) return this.manualRefresh;
    if (this.stopped || !this.subscription)
      return Promise.reject(
        new CommandError(
          "disconnected",
          "Session connection is not ready",
          true,
        ),
      );
    const previous = this.subscription;
    this.ready = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = null;
    this.rejectPending();
    socket?.close();
    const refresh = this.open(
      previous.snapshot.session.id,
      this.receivedBoundary(),
      this.handlers as { event: (event: NativeEvent) => void },
    )
      .then((subscription) => {
        this.handlers.resubscribed?.(subscription);
        return subscription;
      })
      .catch((error) => {
        if (!this.stopped)
          this.retry = setTimeout(
            () => this.reopen(previous.snapshot.session.id),
            1000,
          );
        throw error;
      })
      .finally(() => {
        if (this.manualRefresh === refresh) this.manualRefresh = null;
      });
    this.manualRefresh = refresh;
    return refresh;
  }

  private reopen(sessionId: string) {
    if (this.stopped) return;
    void this.open(
      sessionId,
      this.receivedBoundary(),
      this.handlers as { event: (event: NativeEvent) => void },
    )
      .then((subscription) => {
        // `open` already installed the barrier. Its sequence is not an event:
        // the next live frame is sequence + 1, so a synthetic snapshot would
        // collide with it and be dropped as a duplicate.
        this.handlers.resubscribed?.(subscription);
      })
      .catch(() => {
        if (this.stopped) return;
        this.retry = setTimeout(
          () => this.reopen(sessionId),
          Math.min(1000 * 2 ** this.failures++, 10000),
        );
      });
  }

  private settle(frame: Record<string, any>) {
    const pending = this.pending.get(frame.request_id);
    if (!pending) return;
    this.pending.delete(frame.request_id);
    clearTimeout(pending.timer);
    if (frame.ok === true) pending.resolve(frame.data);
    else {
      pending.reject(
        new CommandError(
          frame.error?.code ?? "invalid_result",
          frame.error?.message ?? "Command failed",
          frame.error?.retryable === true,
          frame.error?.code === "outcome_unknown",
          frame.error?.details,
        ),
      );
      if (frame.error?.code === "unauthenticated")
        this.handlers.authRequired?.();
    }
  }

  private rejectPending() {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      const error = new CommandError(
        "disconnected",
        "Connection lost",
        true,
        value.mutation,
      );
      if (this.stopped || !this.socket) silenceDiagnostic(error);
      value.reject(error);
    }
    this.pending.clear();
  }
}

function subscriptionOf(
  frame: Record<string, any>,
  sessionId: string,
): NativeSubscription {
  const reject = (reason: string): never => {
    throw new CommandError(
      "invalid_result",
      `Invalid Session subscription: ${reason}; retry loading the session`,
      true,
      false,
      { reason },
    );
  };
  const checks: [boolean, string][] = [
    [frame.type === "subscribed", "type: expected subscribed"],
    [frame.v === 1, "v: expected protocol version 1"],
    [
      typeof frame.subscription_id === "string" && !!frame.subscription_id,
      "subscription_id: expected nonempty string",
    ],
    [
      typeof frame.generation === "string" && !!frame.generation,
      "generation: expected nonempty string",
    ],
    [
      Number.isSafeInteger(frame.sequence) && frame.sequence >= 0,
      "sequence: expected nonnegative safe integer",
    ],
    [
      frame.session_id === sessionId,
      "session_id: expected selected Session identity",
    ],
    [
      Number.isSafeInteger(frame.initial_events) &&
        frame.initial_events >= 1 &&
        frame.initial_events <= 16,
      "initial_events: expected safe integer from 1 to 16",
    ],
    [
      frame.meta?.session?.id === sessionId,
      "meta.session.id: expected selected Session identity",
    ],
    [Array.isArray(frame.meta?.operations), "meta.operations: expected array"],
    [
      typeof frame.meta?.executions_omitted === "boolean",
      "meta.executions_omitted: expected boolean",
    ],
    [
      ["fresh", "reset"].includes(frame.resume?.mode),
      "resume.mode: expected fresh or reset",
    ],
  ];
  for (const [valid, reason] of checks) if (!valid) reject(reason);
  try {
    if (frame.pending?.permissions?.decisions !== undefined)
      retainPermissionDecisions(
        [],
        frame.pending.permissions.decisions,
        sessionId,
      );
  } catch (error) {
    reject(`pending.permissions.decisions: ${(error as Error).message}`);
  }
  try {
    if (!(
      frame.meta.executions === null && frame.meta.executions_omitted === true
    ))
      validateExecutionHistory(frame.meta.executions, sessionId);
  } catch (error) {
    reject(`meta.${(error as Error).message}`);
  }
  return {
    subscription_id: frame.subscription_id,
    generation: frame.generation,
    sequence: frame.sequence,
    snapshot: { ...frame.meta, messages: [] } as NativeSnapshot,
    pending: frame.pending,
    resume: frame.resume,
  };
}

// Record completeness keeps runtime validation aligned with the typed vocabulary.
const EVENT_NAMES = {
  "session.meta": true,
  "blocks.page": true,
  "blocks.upsert": true,
  "history.reset": true,
  session: true,
  turn: true,
  tool: true,
  model_observation: true,
  "display.batch": true,
  "display.settled": true,
  "display.fragment": true,
  "display.unavailable": true,
  "executions.updated": true,
  "statistics.updated": true,
  compaction: true,
  "permission.requested": true,
  "permission.updated": true,
  "permission.proposal.requested": true,
  "permission.proposal.settled": true,
  "permission.settled": true,
  "round_limit.requested": true,
  "round_limit.settled": true,
  "client_tool.requested": true,
  "client_tool.prepared": true,
  "client_tool.paused": true,
  "client_tool.settled": true,
  "client_tool.cancel_requested": true,
  "audit.available": true,
  "child.display.available": true,
  "child.display.unavailable": true,
  host_detached: true,
  host_connection: true,
  resync_required: true,
} satisfies Record<SessionEventFrame["event"], true>;

function validEvent(frame: Record<string, any>): frame is NativeEvent {
  if (frame.event === "permission.settled") {
    try {
      validatePermissionDecision(frame.data, frame.session_id);
    } catch {
      return false;
    }
  }
  if (frame.event === "executions.updated") {
    try {
      validateExecutionHistory(frame.data?.items, frame.session_id);
    } catch {
      return false;
    }
  }
  if (
    frame.event === "session.meta" &&
    Object.hasOwn(frame.data ?? {}, "executions")
  ) {
    try {
      if (!(
        frame.data.executions === null && frame.data.executions_omitted === true
      ))
        validateExecutionHistory(frame.data.executions, frame.session_id);
    } catch {
      return false;
    }
  }
  return (
    frame.type === "event" &&
    frame.v === 1 &&
    typeof frame.subscription_id === "string" &&
    typeof frame.generation === "string" &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence >= 0 &&
    typeof frame.session_id === "string" &&
    typeof frame.event === "string" &&
    Object.prototype.hasOwnProperty.call(EVENT_NAMES, frame.event)
  );
}
