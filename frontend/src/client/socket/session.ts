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
const MAX_RECOVERY_ATTEMPTS = 6;
const MAX_RETRY_MS = 10_000;
const STABLE_CONNECTION_MS = 5_000;
let nextConnection = 0;

type CloseCause =
  | "stop"
  | "selection_replaced"
  | "resync"
  | "refresh"
  | "opening_timeout"
  | "subscription_refused"
  | "invalid_frame"
  | "connection_error";
export type SessionRecoveryStatus = "recovering" | "failed" | "forbidden";

interface Handlers {
  event: (event: NativeEvent) => void;
  resubscribed?: (subscription: NativeSubscription) => void;
  authRequired?: () => void;
  recovery?: (status: SessionRecoveryStatus | null) => void;
}

function recoveryDelay(attempt: number) {
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_MS);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

function mayRecover(error: unknown) {
  return (
    error instanceof CommandError &&
    ([
      "disconnected",
      "timed_out",
      "busy",
      "temporarily_unavailable",
      "unavailable",
    ].includes(error.code) ||
      (error.retryable &&
        ![
          "forbidden",
          "permission_denied",
          "unauthenticated",
          "not_found",
          "invalid_result",
        ].includes(error.code)))
  );
}

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
  private recovery: Promise<NativeSubscription> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private recoveryStatus: SessionRecoveryStatus | null = null;
  private stableSince = 0;
  private closeCurrent?: (cause: CloseCause, code?: number) => void;
  private handlers!: Handlers;

  constructor(
    private readonly urlFor: (path: string) => string,
    private readonly resumeQuery?: () => {
      display_watermark: number;
      history_lineage?: string;
    },
    private readonly appliedBoundary?: (
      subscription: NativeSubscription,
    ) => { applied: number; watermark: number } | undefined,
  ) {}

  get status() {
    return this.recoveryStatus;
  }

  private setRecovery(status: SessionRecoveryStatus | null) {
    if (this.recoveryStatus === status) return;
    this.recoveryStatus = status;
    this.handlers.recovery?.(status);
  }

  get selectedId() {
    return this.subscription?.snapshot.session.id ?? null;
  }

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
    handlers: Handlers,
  ): Promise<NativeSubscription> {
    if (this.socket || this.retry !== undefined || this.recovery)
      return Promise.reject(
        new CommandError("busy", "Session subscription already in progress"),
      );
    this.stopped = false;
    this.handlers = handlers;
    return this.start(sessionId, query);
  }

  private start(
    sessionId: string,
    query: ReturnType<SessionSocket["receivedBoundary"]>,
  ) {
    this.ready = false;
    return new Promise<NativeSubscription>((resolve, reject) => {
      const url = new URL(
        this.urlFor(`api/v1/sessions/${encodeURIComponent(sessionId)}/ws`),
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set(
        "display_watermark",
        String(query.display_watermark),
      );
      if (query.history_lineage)
        url.searchParams.set("history_lineage", query.history_lineage);
      const socket = new WebSocket(url);
      this.socket = socket;
      const connection = ++nextConnection;
      const attempt = this.attempts;
      let phase: "opening" | "open" | "initial_page" | "subscribed" = "opening";
      let closeCause: CloseCause | undefined;
      let failure: CommandError | undefined;
      let settled = false;
      let hasPage = false;
      let initial: NativeSubscription | null = null;
      let receivedSequence: number | undefined;
      let closedAt: { applied?: number; watermark: number } | undefined;
      let remaining = 0;
      const cursor = () =>
        (phase === "subscribed" && initial
          ? this.appliedBoundary?.(initial)
          : undefined) ?? {
          applied: undefined,
          watermark: query.display_watermark,
        };
      const close = (cause: CloseCause, code?: number) => {
        if (closeCause) return;
        closeCause = cause;
        closedAt = cursor();
        this.ready = false;
        // A timed-out open cannot later become a valid attachment, even if
        // its transport takes longer to emit the close event.
        clearTimeout(opening);
        socket.close(code);
      };
      this.closeCurrent = close;
      // The initial page is part of opening, not merely the HTTP upgrade.
      const opening = setTimeout(() => {
        failure = new CommandError(
          "timed_out",
          "Session attachment timed out",
          true,
        );
        close("opening_timeout");
      }, 60_000);
      socket.onopen = () => {
        if (!closeCause) phase = "open";
      };
      socket.onmessage = ({ data }) => {
        if (socket !== this.socket || closeCause) return;
        const decoded = decodeFrame(data);
        if (!decoded.ok) {
          failure = new CommandError(
            "invalid_result",
            "Invalid Session WebSocket frame",
            false,
            false,
            {
              reason: decoded.reason,
            },
          );
          close("invalid_frame", decoded.closeCode);
          return;
        }
        const frame = decoded.frame;
        if (!settled) {
          if (frame.type === "error") {
            failure = new CommandError(
              frame.error?.code ?? "unavailable",
              frame.error?.message ?? "Session subscription refused",
              frame.error?.retryable === true,
            );
            close("subscription_refused");
            if (failure.code === "unauthenticated")
              this.handlers.authRequired?.();
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
              failure = new CommandError(
                "invalid_result",
                "Invalid initial Session event sequence",
              );
              close("invalid_frame", 4002);
              return;
            }
            receivedSequence = frame.sequence;
            const next = materialize(initial.snapshot, frame.event, frame.data);
            if (next.incomplete) {
              failure = new CommandError(
                "invalid_result",
                "Initial Session page omitted a block body",
              );
              close("invalid_frame", 4002);
              return;
            }
            hasPage ||= frame.event === "blocks.page";
            initial.snapshot = next.view;
            initial.sequence = frame.sequence;
            if (--remaining > 0) return;
            if (!hasPage) {
              failure = new CommandError(
                "invalid_result",
                "Initial Session events omitted the canonical page",
              );
              close("invalid_frame", 4002);
              return;
            }
            settled = true;
            phase = "subscribed";
            this.ready = true;
            this.stableSince = performance.now();
            this.diagnostics.connected();
            clearTimeout(opening);
            this.subscription = initial;
            resolve(initial);
            return;
          }
          try {
            initial = subscriptionOf(frame, sessionId);
          } catch (error) {
            failure = error as CommandError;
            close("invalid_frame", 4002);
            return;
          }
          phase = "initial_page";
          receivedSequence = initial.sequence;
          remaining = frame.initial_events;
          return;
        }
        if (frame.type === "result") this.settle(frame);
        else if (frame.type === "event" && validEvent(frame)) {
          if (
            frame.session_id === sessionId &&
            frame.subscription_id === initial?.subscription_id &&
            frame.generation === initial.generation
          )
            receivedSequence = Math.max(receivedSequence ?? 0, frame.sequence);
          this.handlers.event(frame);
        } else close("invalid_frame", 4002);
      };
      socket.onerror = () => {
        // Browsers expose no underlying network error here. Keep the close
        // code as separate evidence; do not guess the peer's initiator.
        if (!settled && !closeCause) {
          failure = new CommandError(
            "disconnected",
            "Session WebSocket unavailable",
            true,
          );
          close("connection_error");
        }
      };
      socket.onclose = ({ code }) => {
        clearTimeout(opening);
        const current = socket === this.socket;
        const at = closedAt ?? cursor();
        const intentional =
          closeCause === "stop" ||
          closeCause === "selection_replaced" ||
          closeCause === "resync" ||
          closeCause === "refresh";
        const error =
          failure ??
          new CommandError("disconnected", "Session connection lost", true);
        const evidence = {
          code: closeCause === "invalid_frame" ? "invalid_result" : error.code,
          message: intentional
            ? "Session WebSocket closed by browser request"
            : "Session WebSocket closed",
          details: {
            ...error.details,
            connection,
            close_code: code,
            phase,
            cause: closeCause ?? "no_local_close_request",
            reason:
              code === 1006 ? "abnormal_closure_no_close_frame" : "close_event",
            attempt,
            buffered_bytes: socket.bufferedAmount,
            received_sequence: receivedSequence,
            applied_sequence: at.applied,
            display_watermark: at.watermark,
          },
        };
        if (intentional)
          reportDiagnostic(
            "session_socket",
            "close",
            evidence,
            undefined,
            "info",
          );
        else this.diagnostics.failure("close", evidence);
        if (current) {
          this.socket = null;
          this.closeCurrent = undefined;
          this.ready = false;
        }
        if (!settled) {
          if (intentional || attempt > 0) silenceDiagnostic(error);
          reject(error);
        }
        if (!current) return;
        this.rejectPending();
        if (
          settled &&
          performance.now() - this.stableSince >= STABLE_CONNECTION_MS
        )
          this.attempts = 0;
        if (this.continueAfterClose) this.continueAfterClose(!this.stopped);
        else if (!this.stopped && settled) this.scheduleRecovery();
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
          "Not sent: the selected Session connection is not ready",
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
  stop(cause: "stop" | "selection_replaced" = "stop") {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.closeCurrent?.(cause);
    this.rejectPending();
  }

  /** Coalesce resync signals and always wait for the old socket to close. */
  reconnect() {
    if (this.stopped || !this.subscription || !this.ready) return;
    this.beginReplacement("resync");
  }

  /** Explicit refresh joins the in-flight observer or consumes the one retry
   * timer. It never submits any pending command again. */
  refresh(): Promise<NativeSubscription> {
    if (this.recovery) return this.recovery;
    if (this.stopped || !this.subscription)
      return Promise.reject(
        new CommandError(
          "disconnected",
          "Session connection is not ready",
          true,
        ),
      );
    if (this.afterClose) return this.afterClose;
    if (this.ready) {
      this.attempts = 0;
      this.beginReplacement("refresh");
      // The old connection must actually close before opening its replacement.
      return this.afterClose!;
    }
    if (this.socket) {
      // A network close may already be in flight before its event is delivered.
      this.ready = false;
      return this.waitForClose();
    }
    if (this.retry === undefined) this.attempts = 0;
    clearTimeout(this.retry);
    this.retry = undefined;
    return this.reopen();
  }

  private afterClose?: Promise<NativeSubscription>;
  private continueAfterClose?: (resume: boolean) => void;

  private waitForClose() {
    const next = new Promise<NativeSubscription>((resolve, reject) => {
      this.continueAfterClose = (resume) => {
        this.continueAfterClose = undefined;
        this.afterClose = undefined;
        if (resume) this.reopen().then(resolve, reject);
        else
          reject(
            new CommandError(
              "disconnected",
              "Session selection was closed",
              true,
            ),
          );
      };
    });
    this.afterClose = next;
    // A resync may not have a manual caller waiting for its first attempt.
    void next.catch(() => {});
    return next;
  }

  private beginReplacement(cause: "resync" | "refresh") {
    if (cause === "refresh") this.waitForClose();
    this.closeCurrent?.(cause);
    this.rejectPending();
    this.setRecovery("recovering");
  }

  private scheduleRecovery() {
    if (
      this.stopped ||
      this.retry !== undefined ||
      this.attempts >= MAX_RECOVERY_ATTEMPTS
    ) {
      if (!this.stopped && this.attempts >= MAX_RECOVERY_ATTEMPTS)
        this.setRecovery("failed");
      return;
    }
    this.setRecovery("recovering");
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        void this.reopen().catch(() => {});
      },
      recoveryDelay(this.attempts + 1),
    );
  }

  private reopen(): Promise<NativeSubscription> {
    if (this.recovery) return this.recovery;
    const sessionId = this.selectedId;
    if (this.stopped || !sessionId)
      return Promise.reject(
        new CommandError("disconnected", "Session selection was closed", true),
      );
    this.attempts++;
    this.setRecovery("recovering");
    const opening = this.start(sessionId, this.receivedBoundary()).then(
      (subscription) => {
        if (this.stopped || !this.ready || this.subscription !== subscription)
          throw new CommandError(
            "disconnected",
            "Session selection was closed",
            true,
          );
        // The barrier sequence is not a synthetic event. Adopt it before the
        // next live frame; buffered old bytes cannot advance this watermark.
        this.handlers.resubscribed?.(subscription);
        this.setRecovery(null);
        return subscription;
      },
    );
    const attempt = opening.finally(() => {
      if (this.recovery === attempt) this.recovery = null;
    });
    this.recovery = attempt;
    void attempt.catch((error) => {
      if (this.stopped) return;
      if (mayRecover(error)) this.scheduleRecovery();
      else
        this.setRecovery(
          error instanceof CommandError &&
            ["forbidden", "permission_denied"].includes(error.code)
            ? "forbidden"
            : "failed",
        );
    });
    return attempt;
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
        value.mutation
          ? "Connection lost after sending; the command outcome is unknown"
          : "Connection lost",
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
  "client_tools.lease_changed": true,
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
