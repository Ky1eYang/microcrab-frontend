import { childTurnPath, validateChildOperationId, validateChildTurnOperation, type ChildTurnScope, type ChildTurnRequest, type ChildTurnOperation } from "./child-turns";
import { speakerPath, validateSpeakerSnapshot, validateSpeakerOperation, validateSpeakerUpdate, validateSpeakerKey, validSpeakerIdentity, type SpeakerScope, type SpeakerSnapshot, type SpeakerUpdate, type SpeakerKey, type SpeakerOperationResponse } from "./external-speakers";
import { questionImagePath, type QuestionImageRequest } from "./question-images";
import { boundedCitationBlob, citationPath, CITATION_TIMEOUT_MS, type CitationRequest } from "./citations";
import { validateExecutionHistory } from "./execution-history";
import {
  normalizeSettingsSnapshot,
  validateReferences,
  validatePublicProvider,
} from "./settings";
import {
  diagnosticMessage,
  reportDiagnostic,
  silenceDiagnostic,
} from "./diagnostics";
import { BrowserConversations, BrowserHostTransport } from "./browser-host";
import {
  decodeFrame,
  encodeCommand,
  MAX_FRAME_BYTES as MAX_FRAME,
} from "./socket/codec";
import type { HostDescriptor, HostConnectionState } from "./host";
import type { BrowserAuthSession } from "./auth";
import {
  isUnavailableSessionChange,
  validateSessionList,
} from "./session-availability";
import { validatePolicySnapshot } from "./permissions";
import type { NativeHostStateDetails } from "./types";
import { traceEvent } from "./trace";
export { CommandError } from "./errors";
import { CommandError } from "./errors";
import { TransportDiagnosticStreak } from "./transport-diagnostics";
import { hostCarrier } from "./host-locators";
import {
  outboundSignalUrl,
  signalOutbound,
  type OutboundOffer,
} from "./host-outbound";
import { t } from "../i18n";
import type { NativeOwnerEvent } from "./types";
export function normalizeBaseUrl(raw: string) {
  const url = new URL(
    raw.includes("://") ? raw.trim() : `http://${raw.trim()}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "Use an HTTP(S) server origin without credentials or query parameters",
    );
  return `${url.origin}/`;
}
export function resolveApiBase() {
  return typeof location === "undefined"
    ? "http://127.0.0.1:4096/"
    : normalizeBaseUrl(location.origin);
}
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  mutation: boolean;
}
interface Handlers {
  open?: () => void;
  close?: () => void;
  error?: (error: Error) => void;
  authRequired?: () => void;
  event?: (event: NativeOwnerEvent) => void;
}
const MAX_PENDING = 64;
/** Methods owned by the selected Session's socket. The path is their session
 * authority, so no command carries a session id. */
const SESSION_METHODS = new Set([
  "display.subscribe",
  "session.blocks",
  "session.interrupt",
  "turn.submit",
  "turn.queue",
  "turn.steer",
  "turn.retry",
  "inbox.update",
  "inbox.remove",
  "inbox.resume",
  "permission.reply",
  "permission.proposal.reply",
  "round_limit.reply",
  "client_tools.bind",
  "client_tools.result",
  "client_tools.unbind",
  "client_tools.prepare",
  "client_tools.output",
  "client_tools.arguments",
  "client_tools.secret",
  "client_tools.secret_operation",
  "client_tools.decision",
  "client_tools.takeover",
  "executions.read",
  "executions.cancel",
]);
export interface SessionTransport {
  readonly sessionId: string | null;
  command<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    requestId: string,
    mutation: boolean,
  ): Promise<T>;
}
const HTTP_QUERIES: Record<string, string> = {
  "server.capabilities": "capabilities",
  "identity.current": "identity",
  "project.list": "projects",
  "model.list": "models",
  "settings.get": "settings",
  "provider.list": "providers",
  "model.metadata": "models/metadata",
  "session.list": "sessions",
};
// Session reads that the WebSocket attachment does not deliver. Snapshot,
// history pages and pending requests are Session-socket-only (open /
// session.blocks); settings and lifecycle mutations stay on HTTP.
const SESSION_QUERIES: Record<string, string> = {
  "session.children": "/children",
  "permission.get": "/permission",
  "workspace.files": "/workspace/files",
  "state.get": "/state",
  "state.metadata": "/state/metadata",
  "state.inspection": "/state/inspection",
  "session.settings.get": "/settings",
  "executions.list": "/executions",
  "client_tools.calls": "/client-tools/calls",
};
const SESSION_MUTATIONS: Record<string, [string, string]> = {
  "session.variables.patch": ["PATCH", "/variables"],
  "session.fork": ["POST", "/fork"],
  "session.open": ["PUT", "/runtime"],
  "session.close": ["DELETE", "/runtime"],
  "session.rename": ["PATCH", ""],
  "session.archive": ["POST", "/archive"],
  "session.delete": ["DELETE", ""],
  "session.set_mode": ["PUT", "/mode"],
  "session.set_model": ["PUT", "/model"],
  "permission.set": ["PUT", "/permission"],
  "session.settings.set": ["PUT", "/settings"],
  "session.references.refresh": ["POST", "/references/refresh"],
  "session.compact": ["POST", "/compact"],
  "session.retry_agent_init": ["POST", "/agent-init/retry"],
  "session.retry_auto_compaction": ["POST", "/auto-compaction/retry"],
  "history.travel": ["POST", "/history/travel"],
  "checkpoint.create": ["POST", "/checkpoints"],
  "audit.requests": ["POST", "/audit/requests"],
  "display.observations": ["POST", "/display/observations/query"],
};
const MUTATIONS = new Set([
  "session.variables.patch",
  "model.metadata.refresh",
  "permission.reply",
  "permission.proposal.reply",
  "round_limit.reply",
  "session.create",
  "session.fork",
  "session.rename",
  "session.archive",
  "session.delete",
  "session.close",
  "session.open",
  "turn.submit",
  "turn.retry",
  "turn.queue",
  "turn.steer",
  "session.interrupt",
  "session.compact",
  "session.retry_agent_init",
  "session.retry_auto_compaction",
  "history.travel",
  "inbox.update",
  "inbox.remove",
  "inbox.resume",
  "checkpoint.create",
  "permission.set",
  "session.set_mode",
  "session.set_model",
  "executions.cancel",
  "client_tools.result",
  "client_tools.prepare",
  "client_tools.secret",
  "client_tools.takeover",
  "host.relay_attach",
]);
function commandTimeout(method: string): number {
  if (method === "session.open" || method === "session.retry_agent_init")
    // Must exceed server PermissionAsk ASK_TIMEOUT (120s) plus review latency so
    // an explicit pre-open permission prompt does not abort the client HTTP call.
    return 150000;
  return [
    "model.metadata.refresh",
    "session.create",
    "session.fork",
    "agent.catalog",
    "host.relay_attach",
  ].includes(method)
    ? 60000
    : 15000;
}
export type HostLifecycleTrigger =
  | "resume_project:bootstrap"
  | "resume_project:attach"
  | "resume_project:select_project"
  | "resume_project:create_session"
  | "action:connect_host"
  | "action:disconnect_host"
  | "action:logout"
  | "action:refresh_host"
  | "relay_lost"
  | "connect_error_cleanup";

interface HostRelayRelease {
  relay_id: string;
  relay_generation: string;
}
function relayReleaseWitness(value: unknown): HostRelayRelease | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as HostRelayRelease;
  if (
    typeof candidate.relay_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate.relay_id,
    ) ||
    typeof candidate.relay_generation !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(candidate.relay_generation) ||
    BigInt(candidate.relay_generation) > 18446744073709551615n
  )
    return null;
  return {
    relay_id: candidate.relay_id,
    relay_generation: candidate.relay_generation,
  };
}

/** Command retry is owned by the caller. Socket reconnect only restores observation. */
export class ApiClient {
  readonly base: string;
  private socket: WebSocket | null = null;
  private socketDiagnostics = new TransportDiagnosticStreak("global_socket");
  private hostProject: string | null = null;
  private outboundSupported = false;
  private hostTransport: "grpc" | "relay" | "outbound" | null = null;
  private hostDescriptor: HostDescriptor | null = null;
  private hostRelayRelease: HostRelayRelease | null = null;
  readonly tabId = crypto.randomUUID();
  currentHostProject() {
    return this.hostProject;
  }
  currentHostTransport() {
    return this.hostTransport;
  }
  hasOpenRelayFor(projectId: string) {
    return (
      this.hostProject === projectId &&
      this.hostTransport === "relay" &&
      this.relaySocket?.readyState === WebSocket.OPEN
    );
  }
  /** Releasing browser observation must never revoke a server-owned gRPC route. */
  async releaseHostObservation(trigger: HostLifecycleTrigger) {
    if (this.hostTransport === "relay") {
      await this.disconnectHost(false, { trigger, relayOnly: true });
      return;
    }
    ++this.hostEpoch;
    this.closeRelay();
    this.hostProject = null;
    this.hostTransport = null;
    this.hostDescriptor = null;
  }
  private browserEgress = new BrowserHostTransport(() => this.socket);
  private browserHosts = new BrowserConversations(this, (frame) =>
    this.browserEgress.send(frame),
  );
  async disconnectBrowserConversation(conversationId: string) {
    return this.browserHosts.disconnect(conversationId);
  }
  async connectBrowserConversation(
    conversationId: string,
    owner: string,
    flavor: import("./types").ConversationHostFlavor,
    forceTakeover = false,
  ) {
    return this.browserHosts.connect(conversationId, owner, flavor, forceTakeover);
  }
  private hostEpoch = 0;
  private relayRelease: Promise<unknown> = Promise.resolve();
  private relaySocket: WebSocket | null = null;
  private relayForward: ((bytes: ArrayBuffer) => void) | null = null;
  private closeRelay() {
    const bridge = this.relaySocket;
    this.relaySocket = null;
    this.relayForward = null;
    this.hostRelayRelease = null;
    if (bridge && bridge.readyState < WebSocket.CLOSING) bridge.close();
  }
  /** Implicit browser cleanup has authority over only its authenticated relay.
   * Missing witnesses never fall back to a project-wide disconnect. */
  private releaseOwnedRelay(
    project: string,
    relay: HostRelayRelease | null,
    trigger: HostLifecycleTrigger,
  ) {
    if (!relay) return Promise.resolve();
    const release = this.http(
      this.url(
        `api/v1/projects/${encodeURIComponent(project)}/host/disconnect`,
      ),
      "POST",
      JSON.stringify({ revoke: false, relay_release: relay }),
      60000,
      "application/json",
      undefined,
      trigger,
    );
    this.relayRelease = release.catch(() => {});
    return release;
  }
  /** The selected Session's socket, installed by the store after each commit.
   * Session methods go there and nowhere else; the global socket carries
   * owner-list notifications, conversation attachment and Host forwarding. */
  private sessionTransport: (() => SessionTransport | null) | null = null;
  setSessionTransport(provider: () => SessionTransport | null) {
    this.sessionTransport = provider;
  }
  async connectHost(
    projectId: string,
    bridgeUrl: string,
    pairingToken: string | undefined,
    onState: (
      state: HostConnectionState,
      reason?: string,
      details?: NativeHostStateDetails,
    ) => void,
    options: {
      directory?: string;
      expectedHostId?: string;
      expectedWorkspaceId?: string;
      allowLegacyBinding?: boolean;
      trigger?: HostLifecycleTrigger;
    } = {},
  ): Promise<HostDescriptor> {
    if (
      this.hasOpenRelayFor(projectId) &&
      !pairingToken &&
      this.hostDescriptor
    ) {
      onState("ready");
      return this.hostDescriptor;
    }
    const epoch = ++this.hostEpoch;
    const previousRelayProject =
      this.hostTransport === "relay" ? this.hostProject : null;
    const previousRelayRelease = this.hostRelayRelease;
    this.closeRelay();
    // gRPC stays server-dialed. WebSocket is a byte relay on this page's sockets.
    onState("connecting");
    let acquiredRelay: HostRelayRelease | null = null;
    try {
      const carrier = hostCarrier(bridgeUrl);
      if (!carrier)
        throw new CommandError("invalid_request", t("hostDlg.badAddress"));
      await this.relayRelease;
      if (epoch !== this.hostEpoch)
        throw new CommandError(
          "disconnected",
          "Host connection observation was replaced",
        );
      if (carrier === "grpc" && previousRelayProject) {
        // Closing the bridge socket does not close the server global-socket relay.
        // New observations wait for this exact old route release before attaching.
        this.hostProject = null;
        this.hostTransport = null;
        this.hostDescriptor = null;
        await this.releaseOwnedRelay(
          previousRelayProject,
          previousRelayRelease,
          options.trigger ?? "action:connect_host",
        );
        if (epoch !== this.hostEpoch)
          throw new CommandError(
            "disconnected",
            "Host connection observation was replaced",
          );
      }
      let effectiveCarrier: "grpc" | "relay" | "outbound" = carrier;
      let result: Awaited<ReturnType<ApiClient["attachGrpc"]>>;
      if (carrier === "grpc") {
        result = await this.attachGrpc(
          projectId,
          bridgeUrl,
          pairingToken,
          options,
        );
        effectiveCarrier =
          result.transport === "outbound_wss" ? "outbound" : "grpc";
      } else if (this.outboundSupported && outboundSignalUrl(bridgeUrl)) {
        try {
          result = await this.attachOutbound(
            epoch,
            projectId,
            bridgeUrl,
            pairingToken,
            options,
          );
          effectiveCarrier = result.transport === "grpc" ? "grpc" : "outbound";
        } catch (error) {
          // Only the Server's pre-auth result authorizes fallback. A local signal
          // failure or lost HTTP response cannot prove that Pair was unconsumed.
          if (
            !(error instanceof CommandError) ||
            error.code !== "host_outbound_unavailable"
          )
            throw error;
          if (epoch !== this.hostEpoch) throw error;
          reportDiagnostic(
            "host_transport",
            "outbound_fallback",
            {
              code: "host_outbound_unavailable",
              message:
                "Direct Host connection unavailable; using browser relay",
            },
            undefined,
            "warn",
          );
          result = await this.attachRelay(
            epoch,
            projectId,
            bridgeUrl,
            pairingToken,
            onState,
            options,
          );
        }
      } else {
        result = await this.attachRelay(
          epoch,
          projectId,
          bridgeUrl,
          pairingToken,
          onState,
          options,
        );
      }
      if (epoch !== this.hostEpoch)
        throw new CommandError(
          "disconnected",
          "Host connection observation was replaced",
        );
      if (result.status === "existing_project")
        throw new CommandError(
          "existing_project",
          "This Host workspace already belongs to an existing Project",
          false,
          false,
          {
            existing_project_id: result.existing_project_id,
            descriptor: result.descriptor,
            pairing_token_consumed: result.pairing_token_consumed !== false,
          },
        );
      acquiredRelay =
        effectiveCarrier === "relay"
          ? relayReleaseWitness(result.relay_release)
          : null;
      if (!result.descriptor?.host_id || !result.descriptor?.workspace_id)
        throw new CommandError(
          "invalid_result",
          "Server returned no authenticated Host identity",
        );
      if (result.ready !== true && result.connected !== true)
        throw new CommandError(
          result.reconciliation_error?.code ?? "host_disconnected",
          result.reconciliation_error?.message ??
            "Host route is unavailable after attachment",
          false,
          false,
          {
            readiness: result.readiness,
            reconciliation_error: result.reconciliation_error,
          },
        );
      this.hostProject = projectId;
      this.hostTransport = effectiveCarrier;
      this.hostDescriptor = result.descriptor;
      this.hostRelayRelease = acquiredRelay;
      onState(
        result.ready ? "ready" : "reconciling",
        result.reconciliation_error?.code,
        {
          readiness: result.readiness,
          reconciliation_error: result.reconciliation_error,
        },
      );
      return result.descriptor;
    } catch (error) {
      if (epoch === this.hostEpoch) {
        this.closeRelay();
        if (acquiredRelay) {
          await this.releaseOwnedRelay(
            projectId,
            acquiredRelay,
            "connect_error_cleanup",
          ).catch(() => {});
        }
        if (epoch !== this.hostEpoch) throw error;
        onState(
          "suspended",
          error instanceof CommandError ? error.code : "disconnected",
          { message: error instanceof Error ? error.message : String(error) },
        );
      }
      throw error;
    }
  }
  private async attachOutbound(
    epoch: number,
    projectId: string,
    bridgeUrl: string,
    pairingToken: string | undefined,
    options: {
      directory?: string;
      allowLegacyBinding?: boolean;
      trigger?: HostLifecycleTrigger;
    },
  ): Promise<Awaited<ReturnType<ApiClient["attachGrpc"]>>> {
    const root = `api/v1/projects/${encodeURIComponent(projectId)}/host/outbound`;
    let offer: OutboundOffer;
    try {
      const started = await this.http<
        OutboundOffer | Awaited<ReturnType<ApiClient["attachGrpc"]>>
      >(
        this.url(`${root}/start`),
        "POST",
        JSON.stringify({
          url: bridgeUrl,
          token: pairingToken?.trim() || undefined,
          directory: options.directory,
          allow_legacy_binding: options.allowLegacyBinding,
        }),
        15000,
        "application/json",
        undefined,
        options.trigger ?? "action:connect_host",
      );
      if ("descriptor" in started) return started;
      offer = started;
    } catch (error) {
      // No offer has reached Bridge, so no Pair can have been dispatched.
      if (
        error instanceof CommandError &&
        ["not_found", "unsupported", "host_outbound_unavailable"].includes(
          error.code,
        )
      ) {
        throw new CommandError(
          "host_outbound_unavailable",
          "Server outbound Host carrier is unavailable",
          true,
        );
      }
      throw error;
    }
    const cancel = () =>
      this.http(
        this.url(`${root}/cancel`),
        "POST",
        JSON.stringify({ attempt_id: offer.attempt_id }),
        10000,
        "application/json",
      );
    if (epoch !== this.hostEpoch) {
      await cancel().catch(() => {});
      throw new CommandError(
        "disconnected",
        "Host connection observation was replaced",
      );
    }
    try {
      // A lost signal acknowledgement is ambiguous: finish owns the authoritative
      // phase, and is always consulted before deciding whether fallback is safe.
      await signalOutbound(
        outboundSignalUrl(bridgeUrl)!,
        offer,
        () => epoch === this.hostEpoch,
      ).catch(() => {});
      if (epoch !== this.hostEpoch) {
        await cancel().catch(() => {});
        throw new CommandError(
          "disconnected",
          "Host connection observation was replaced",
        );
      }
      return await this.http<Awaited<ReturnType<ApiClient["attachGrpc"]>>>(
        this.url(`${root}/finish`),
        "POST",
        JSON.stringify({ attempt_id: offer.attempt_id }),
        40000,
        "application/json",
        undefined,
        options.trigger ?? "action:connect_host",
      );
    } catch (error) {
      await cancel().catch(() => {});
      throw error;
    }
  }
  private async attachGrpc(
    projectId: string,
    bridgeUrl: string,
    pairingToken: string | undefined,
    options: {
      directory?: string;
      allowLegacyBinding?: boolean;
      trigger?: HostLifecycleTrigger;
    },
  ) {
    return this.http<{
      descriptor: HostDescriptor;
      transport?: "grpc" | "outbound_wss";
      relay_release?: HostRelayRelease;
      status?: string;
      existing_project_id?: string;
      pairing_token_consumed?: boolean;
      ready?: boolean;
      connected?: boolean;
      readiness?: NativeHostStateDetails["readiness"];
      reconciliation_error?: NativeHostStateDetails["reconciliation_error"];
    }>(
      this.url(`api/v1/projects/${encodeURIComponent(projectId)}/host/connect`),
      "POST",
      JSON.stringify({
        url: bridgeUrl,
        token: pairingToken?.trim() || undefined,
        directory: options.directory,
        allow_legacy_binding: options.allowLegacyBinding,
      }),
      60000,
      "application/json",
      undefined,
      options.trigger ?? "action:connect_host",
    );
  }
  private async attachRelay(
    epoch: number,
    projectId: string,
    bridgeUrl: string,
    pairingToken: string | undefined,
    onState: (
      state: HostConnectionState,
      reason?: string,
      details?: NativeHostStateDetails,
    ) => void,
    options: { directory?: string; allowLegacyBinding?: boolean },
  ) {
    const bridge = new WebSocket(bridgeUrl);
    bridge.binaryType = "arraybuffer";
    let established = false;
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new CommandError(
            "connection_timeout",
            t("hostDlg.bridgeTimeout"),
            true,
          ),
        );
        bridge.close();
      }, 10000);
      bridge.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      bridge.onerror = () => {
        /* The close event reports the failure. */
      };
    });
    const closed = new Promise<never>((_, reject) => {
      bridge.addEventListener("close", () => {
        if (!established)
          reject(new CommandError("disconnected", t("hostDlg.bridgeClosed")));
      });
    });
    try {
      await Promise.race([opened, closed]);
    } catch (error) {
      if (bridge.readyState < WebSocket.CLOSING) bridge.close();
      throw error;
    }
    if (epoch !== this.hostEpoch) {
      if (bridge.readyState < WebSocket.CLOSING) bridge.close();
      throw new CommandError(
        "disconnected",
        "Host connection observation was replaced",
      );
    }
    this.relaySocket = bridge;
    bridge.onmessage = (event) => {
      if (this.relaySocket !== bridge) return;
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength > 131072) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
    };
    this.relayForward = (bytes) => {
      if (this.relaySocket === bridge && bridge.readyState === WebSocket.OPEN)
        bridge.send(bytes);
    };
    bridge.addEventListener("close", () => {
      if (this.relaySocket !== bridge || !established) return;
      this.relaySocket = null;
      this.relayForward = null;
      if (epoch !== this.hostEpoch) return;
      onState("suspended", "disconnected", {
        message: t("hostDlg.relayLost"),
      });
      void this.disconnectHost(false, {
        trigger: "relay_lost",
        relayOnly: true,
      });
    });
    const result = await Promise.race([
      this.command<{
        descriptor: HostDescriptor;
        relay_release?: HostRelayRelease;
        status?: string;
        existing_project_id?: string;
        pairing_token_consumed?: boolean;
        ready?: boolean;
        connected?: boolean;
        readiness?: NativeHostStateDetails["readiness"];
        reconciliation_error?: NativeHostStateDetails["reconciliation_error"];
      }>("host.relay_attach", {
        project_id: projectId,
        url: bridgeUrl,
        token: pairingToken?.trim() || undefined,
        directory: options.directory,
        allow_legacy_binding: options.allowLegacyBinding,
      }),
      closed,
    ]);
    if (epoch !== this.hostEpoch) {
      if (this.relaySocket === bridge) this.closeRelay();
      else if (bridge.readyState < WebSocket.CLOSING) bridge.close();
      throw new CommandError(
        "disconnected",
        "Host connection observation was replaced",
      );
    }
    established = true;
    return result;
  }
  async disconnectHost(
    revoke = false,
    options: {
      backendDetached?: boolean;
      trigger?: HostLifecycleTrigger;
      relayOnly?: boolean;
    } = {},
  ) {
    ++this.hostEpoch;
    const project = this.hostProject;
    const relay = this.hostRelayRelease;
    this.hostProject = null;
    this.hostTransport = null;
    this.hostDescriptor = null;
    this.closeRelay();
    if (project && !options.backendDetached) {
      if (options.relayOnly) {
        await this.releaseOwnedRelay(
          project,
          relay,
          options.trigger ?? "relay_lost",
        );
        return;
      }
      const release = this.http(
        this.url(
          `api/v1/projects/${encodeURIComponent(project)}/host/disconnect`,
        ),
        "POST",
        JSON.stringify({ revoke }),
        60000,
        "application/json",
        undefined,
        options.trigger ?? "action:disconnect_host",
      );
      this.relayRelease = release.catch(() => {});
      await release;
    }
  }
  private pending = new Map<string, Pending>();
  private httpPending = new Set<AbortController>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  // Default matches the announced server bound (one WebSocket frame); the server
  // announcement replaces it once capabilities arrive.
  private commandBytes = 1024 * 1024;
  configureLimits(limits: Record<string, number>) {
    if (Number.isSafeInteger(limits.command_bytes) && limits.command_bytes > 0)
      this.commandBytes = Math.min(MAX_FRAME, limits.command_bytes);
  }
  private stopped = true;
  private handlers: Handlers = {};
  constructor(base = resolveApiBase()) {
    this.base = normalizeBaseUrl(base);
  }
  url(path: string) {
    return new URL(path.replace(/^\//, ""), this.base).toString();
  }
  async browserSession(): Promise<BrowserAuthSession> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "TimeoutError")),
      8000,
    );
    let status: number | undefined;
    try {
      const response = await fetch(this.url("api/auth/session"), {
        credentials: "include",
        headers: { "x-client-tab-id": this.tabId },
        signal: controller.signal,
      });
      status = response.status;
      if (response.status === 401) return { authenticated: false };
      if (!response.ok)
        throw Error(`Authentication unavailable (${response.status})`);
      return await response.json();
    } catch (error) {
      reportDiagnostic("auth", "session", error, status);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  clearHostCredentials() {
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("microcrab.host-relay.v2:")) {
          try {
            // The scoped prefix is a JSON tuple followed by the underlying relay key.
            const end = key.indexOf("]:microcrab.host-relay.");
            const scope = JSON.parse(
              key.slice("microcrab.host-relay.v2:".length, end + 1),
            );
            if (scope[0] === this.base) sessionStorage.removeItem(key);
          } catch {
            /* Invalid foreign storage never authorizes a credential. */
          }
        }
      }
      const prefix = "microcrab.host-relay.v2:";
      for (const key of Object.keys(sessionStorage).filter((key) =>
        key.startsWith(prefix),
      )) {
        try {
          const endpoints = JSON.parse(key.slice(prefix.length));
          if (
            new URL(endpoints[0]).origin ===
            new URL(this.base).origin.replace(/^http/, "ws")
          )
            sessionStorage.removeItem(key);
        } catch {}
      }
    } catch {}
  }
  /** Returns the IdP end-session URL to visit, when the server provides one. */
  async logout(): Promise<string | undefined> {
    this.clearHostCredentials();
    let status: number | undefined;
    try {
      const response = await fetch(this.url("api/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers: {
          "x-client-tab-id": this.tabId,
          "x-client-trigger": "action:logout",
        },
        signal: AbortSignal.timeout(8000),
      });
      status = response.status;
      if (!response.ok) throw Error(`Sign out failed (${response.status})`);
      // 204: local-only logout. 200 + {redirect}: RP-Initiated Logout at the IdP.
      if (response.status !== 200) return undefined;
      const body = (await response.json().catch(() => null)) as {
        redirect?: unknown;
      } | null;
      return logoutRedirect(body?.redirect);
    } catch (error) {
      reportDiagnostic("auth", "logout", error, status);
      throw error;
    }
  }
  async health() {
    return this.http(this.url("api/v1/health"), "GET", undefined, 5000);
  }
  connect(handlers: Handlers) {
    this.stop();
    this.stopped = false;
    this.handlers = handlers;
    this.open();
  }
  private open() {
    if (this.stopped) return;
    const url = new URL(this.url("api/v1/ws"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let diagnosticReported = false;
    let established = false;
    const opening = setTimeout(() => socket.close(), 10000);
    socket.onopen = () => {
      established = true;
      this.socketDiagnostics.connected();
      clearTimeout(opening);
      this.failures = 0;
      this.handlers.open?.();
    };
    socket.onmessage = ({ data }) => {
      if (socket !== this.socket) return;
      if (data instanceof ArrayBuffer) {
        if (data.byteLength <= 131072) this.relayForward?.(data);
        return;
      }
      const decoded = decodeFrame(data);
      if (!decoded.ok) {
        diagnosticReported = true;
        reportDiagnostic("global_socket", "decode", {
          code: "invalid_result",
          message: "Invalid global WebSocket frame",
          details: { close_code: decoded.closeCode, reason: decoded.reason },
        });
        socket.close(decoded.closeCode);
        return;
      }
      const frame = decoded.frame;
      if (frame.lane === "conversation_host") {
        if (
          typeof frame.conversation_id !== "string" ||
          typeof frame.connection_generation !== "string" ||
          !Object.hasOwn(frame, "frame")
        ) {
          socket.close(4002);
          return;
        }
        this.browserHosts.receive({
          conversation_id: frame.conversation_id,
          connection_generation: frame.connection_generation,
          frame: frame.frame,
        });
        return;
      }
      if (
        frame.v === 1 &&
        frame.type === "event" &&
        typeof frame.subscription_id === "string" &&
        typeof frame.generation === "string" &&
        Number.isSafeInteger(frame.sequence) &&
        typeof frame.session_id === "string" &&
        [
          "sessions.changed",
          "session.cleanup_failed",
          "resync_required",
        ].includes(frame.event)
      ) {
        if (
          frame.event === "sessions.changed" &&
          frame.data?.op === "unavailable" &&
          !isUnavailableSessionChange(frame.data)
        ) {
          this.handlers.error?.(
            Error(
              "sessions.changed.unavailable: expected session_id and a concrete configuration error",
            ),
          );
          socket.close(4002);
          return;
        }
        this.handlers.event?.(frame as NativeOwnerEvent);
        return;
      }
      if (frame.v !== 1 || frame.type !== "result") {
        socket.close(4002);
        return;
      }
      const pending = this.pending.get(frame.request_id);
      if (!pending) return;
      this.pending.delete(frame.request_id);
      clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.data);
      else
        pending.reject(
          new CommandError(
            frame.error?.code ?? "invalid_result",
            frame.error?.message ?? "Command failed",
            frame.error?.retryable === true,
            frame.error?.code === "outcome_unknown",
            frame.error?.details,
          ),
        );
      if (frame.ok !== true && frame.error?.code === "unauthenticated")
        this.handlers.authRequired?.();
    };
    socket.onerror = () => {
      if (socket !== this.socket || this.stopped) return;
      this.handlers.error?.(
        Error("WebSocket unavailable; sign in again if your session expired"),
      );
    };
    socket.onclose = (event) => {
      clearTimeout(opening);
      if (socket !== this.socket) return;
      if (!this.stopped && !diagnosticReported)
        this.socketDiagnostics.failure("close", {
          code: "disconnected",
          message: "Global WebSocket closed unexpectedly",
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
      this.socket = null;
      this.closeRelay();
      void this.browserHosts.close();
      this.rejectPending();
      this.handlers.close?.();
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.open(),
          Math.min(1000 * 2 ** this.failures++, 10000),
        );
    };
  }
  /** Only this allowlist moves to HTTP. Host route commands always use command(). */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout = commandTimeout(method),
    interactionId?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return this.observe(
      method,
      sessionId,
      requestId,
      () =>
        this.requestNative<T>(
          method,
          params,
          sessionId,
          timeout,
          requestId,
          signal,
        ),
      interactionId,
    );
  }
  private requestNative<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeout: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let verb = "GET";
    let path: string | undefined;
    let query = params;
    if (Object.hasOwn(HTTP_QUERIES, method)) path = HTTP_QUERIES[method];
    else if (method === "settings.set") {
      path = "settings";
      verb = "PUT";
    } else if (
      [
        "project.settings.get",
        "project.settings.set",
        "project.references.get",
        "project.references.set",
      ].includes(method)
    ) {
      if (typeof params.project_id !== "string" || !params.project_id)
        return Promise.reject(
          new CommandError("invalid_request", "Project is required"),
        );
      path = `projects/${encodeURIComponent(params.project_id)}/${method.includes("references") ? "references" : "settings"}`;
      verb = method.endsWith(".set") ? "PUT" : "GET";
      params = Object.fromEntries(
        Object.entries(params).filter(([key]) => key !== "project_id"),
      );
      query = {};
    } else if (
      [
        "provider.get",
        "provider.set",
        "provider.delete",
        "provider.discover",
      ].includes(method)
    ) {
      if (typeof params.provider_id !== "string" || !params.provider_id)
        return Promise.reject(
          new CommandError("invalid_request", "Provider is required"),
        );
      path = `providers/${encodeURIComponent(params.provider_id)}${method === "provider.discover" ? "/discover" : ""}`;
      verb =
        method === "provider.set"
          ? "PUT"
          : method === "provider.delete"
            ? "DELETE"
            : method === "provider.discover"
              ? "POST"
              : "GET";
      params = Object.fromEntries(
        Object.entries(params).filter(([key]) => key !== "provider_id"),
      );
      query = {};
    } else if (method === "model.metadata.refresh") {
      path = "models/metadata/refresh";
      verb = "POST";
    } else if (
      [
        "project.host_state",
        "project.operations",
        "project.host_reconcile",
      ].includes(method)
    ) {
      if (typeof params.project_id !== "string" || !params.project_id)
        return Promise.reject(
          new CommandError("invalid_request", "Project is required"),
        );
      const suffix =
        method === "project.host_state"
          ? "host-state"
          : method === "project.operations"
            ? "operations"
            : "host-reconcile";
      path = `projects/${encodeURIComponent(params.project_id)}/${suffix}`;
      query = method === "project.operations" ? { limit: 100 } : {};
      if (method === "project.host_reconcile") {
        verb = "POST";
        params = {};
      }
    } else if (method === "agent.catalog") {
      if (
        typeof params.conversation_id === "string" &&
        params.conversation_id
      ) {
        path = `conversations/${encodeURIComponent(params.conversation_id)}/agents`;
      } else if (typeof params.project_id === "string" && params.project_id) {
        path = `projects/${encodeURIComponent(params.project_id)}/agents`;
      } else
        return Promise.reject(
          new CommandError("invalid_request", "Host scope is required"),
        );
      query = {};
    } else if (method === "project.create") {
      path = "projects";
      verb = "POST";
    } else if (method === "project.delete_provisional") {
      path = `projects/${encodeURIComponent(String(params.project_id))}/provisional`;
      verb = "DELETE";
      params = {};
    } else if (method === "project.delete" || method === "project.rename") {
      if (typeof params.project_id !== "string" || !params.project_id)
        return Promise.reject(
          new CommandError("invalid_request", "Project is required"),
        );
      path = `projects/${encodeURIComponent(params.project_id)}`;
      verb = method === "project.delete" ? "DELETE" : "PATCH";
    } else if (method === "session.create") {
      path = "sessions";
      verb = "POST";
    } else if (method === "session.child") {
      if (!sessionId || typeof params.child_id !== "string" || !params.child_id)
        return Promise.reject(
          new CommandError(
            "invalid_request",
            "Parent and child identities are required",
          ),
        );
      path = `sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(params.child_id)}`;
      query = Object.fromEntries(
        Object.entries(params).filter(([name]) => name !== "child_id"),
      );
    } else if (method === "executions.content") {
      if (
        !sessionId ||
        !Number.isSafeInteger(params.execution_id) ||
        Number(params.execution_id) < 1 ||
        (params.field !== "arguments" && params.field !== "result")
      )
        return Promise.reject(
          new CommandError(
            "invalid_request",
            "Session, execution and content field are required",
          ),
        );
      path = `sessions/${encodeURIComponent(sessionId)}/executions/${params.execution_id}/content`;
      query = {
        field: params.field,
        cursor: params.cursor ?? 0,
        max_bytes: params.max_bytes ?? 16384,
      };
    } else if (SESSION_METHODS.has(method)) {
      return this.sessionCommand<T>(
        method,
        params,
        sessionId,
        timeout,
        requestId,
      );
    } else if (
      Object.hasOwn(SESSION_QUERIES, method) ||
      Object.hasOwn(SESSION_MUTATIONS, method) ||
      method === "turn.get" ||
      method === "session.variables.operation"
    ) {
      if (!sessionId)
        return Promise.reject(
          new CommandError("invalid_request", "Session is required"),
        );
      path = `sessions/${encodeURIComponent(sessionId)}`;
      if (Object.hasOwn(SESSION_MUTATIONS, method)) {
        const [mutationVerb, suffix] = SESSION_MUTATIONS[method];
        verb = mutationVerb;
        path += suffix;
      } else if (
        method === "turn.get" ||
        method === "session.variables.operation"
      ) {
        if (typeof params.operation_id !== "string" || !params.operation_id)
          return Promise.reject(
            new CommandError("invalid_request", "Resource ID is required"),
          );
        path += `${method === "session.variables.operation" ? "/variables" : ""}/operations/${encodeURIComponent(params.operation_id)}`;
        query = Object.fromEntries(
          Object.entries(params).filter(([name]) => name !== "operation_id"),
        );
      } else path += SESSION_QUERIES[method];
    }
    if (path === undefined)
      return this.command<T>(method, params, sessionId, timeout, requestId);
    const url = new URL(this.url(`api/v1/${path}`));
    if (verb === "GET") {
      for (const [key, value] of Object.entries(query))
        if (value !== undefined && value !== null)
          url.searchParams.set(key, String(value));
    }
    const body = verb === "GET" ? undefined : JSON.stringify(params);
    if (body && new TextEncoder().encode(body).byteLength > this.commandBytes)
      return Promise.reject(
        new CommandError(
          "limit_exceeded",
          "Request exceeds the connection budget",
        ),
      );
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      return Promise.reject(
        new CommandError("limit_exceeded", "Too many pending requests", true),
      );
    return this.http<T>(
      url.href,
      verb,
      body,
      timeout,
      "application/json",
      requestId,
      [
        "project.host_state",
        "project.host_reconcile",
        "project.operations",
      ].includes(method)
        ? "action:refresh_host"
        : undefined,
      signal,
    ).then((data) => {
      const value = data as any;
      let valid = true;
      if (
        [
          "session.create",
          "session.fork",
          "session.rename",
          "session.archive",
        ].includes(method)
      )
        valid = typeof value.id === "string" && value.id.length > 0;
      else if (["session.set_mode", "session.set_model"].includes(method))
        // Configuration acknowledgement has no canonical-window authority.
        // A committed metadata receipt is sufficient even without messages.
        valid =
          value.session?.id === sessionId &&
          Number.isSafeInteger(value.session.revision) &&
          value.session.revision >= 0 &&
          typeof value.session.model === "string" &&
          (value.session.mode === null ||
            typeof value.session.mode === "string");
      else if (
        ["session.open", "session.compact", "history.travel"].includes(method)
      )
        valid =
          typeof value.session?.id === "string" &&
          Array.isArray(value.messages);
      else if (method === "session.list") {
        try {
          validateSessionList(value);
        } catch (failure) {
          throw new CommandError(
            "invalid_result",
            failure instanceof Error ? failure.message : String(failure),
            true,
            false,
          );
        }
      } else if (
        [
          "project.list",
          "model.list",
          "agent.catalog",
          "workspace.files",
        ].includes(method)
      )
        valid = Array.isArray(value.items);
      else if (method === "project.create" || method === "project.rename")
        valid = typeof value.id === "string" && typeof value.name === "string";
      else if (method === "project.delete") valid = value.deleted === true;
      else if (["permission.get", "permission.set"].includes(method)) {
        try {
          validatePolicySnapshot(value);
        } catch (failure) {
          throw new CommandError(
            "invalid_result",
            failure instanceof Error ? failure.message : String(failure),
            true,
            verb !== "GET",
          );
        }
      } else if (method === "state.inspection") {
        const object = (entry: unknown) =>
          !!entry && typeof entry === "object" && !Array.isArray(entry);
        valid =
          object(value.values) &&
          object(value.metadata) &&
          object(value.descriptors) &&
          typeof value.witness?.runtime_instance_id === "string" &&
          !!value.witness.runtime_instance_id &&
          typeof value.witness?.variables_revision === "string" &&
          /^(0|[1-9][0-9]*)$/.test(value.witness.variables_revision);
      } else if (
        (method === "session.variables.patch" &&
          Object.hasOwn(params, "expected")) ||
        method === "session.variables.operation"
      ) {
        valid =
          value.operation_id === params.operation_id &&
          (method === "session.variables.patch"
            ? value.status === "applied" &&
              value.boundary === "next_state_patch" &&
              typeof value.commit?.changed === "boolean" &&
              typeof value.commit?.before?.runtime_instance_id === "string" &&
              typeof value.commit?.before?.variables_revision === "string" &&
              typeof value.commit?.after?.runtime_instance_id === "string" &&
              typeof value.commit?.after?.variables_revision === "string"
            : ["queued", "applied", "rejected", "unknown"].includes(
                value.status,
              ));
      } else if (method === "server.capabilities")
        valid =
          Array.isArray(value.methods) &&
          value.limits !== null &&
          typeof value.limits === "object";
      if (!valid)
        throw new CommandError(
          "invalid_result",
          "Server returned an invalid result; reconcile the receipt",
          true,
          verb !== "GET",
        );
      if (
        [
          "settings.get",
          "settings.set",
          "project.settings.get",
          "project.settings.set",
          "session.settings.get",
          "session.settings.set",
        ].includes(method)
      )
        return normalizeSettingsSnapshot(value) as T;
      if (["project.references.get", "project.references.set"].includes(method))
        validateReferences(value);
      if (
        ["provider.get", "provider.set", "provider.discover"].includes(method)
      )
        validatePublicProvider(value);
      if (method === "executions.list") {
        validateExecutionHistory(value.items, sessionId ?? "");
        if (
          value.next_cursor !== null &&
          (!Number.isSafeInteger(value.next_cursor) || value.next_cursor < 0)
        )
          throw Error("executions.next_cursor: expected cursor or null");
      }
      if (method === "provider.list") {
        if (!Array.isArray(value.items))
          throw Error("providers.items: expected array");
        value.items.forEach(validatePublicProvider);
      }
      if (method === "server.capabilities")
        this.outboundSupported = value.methods.includes(
          "project.host_outbound_start",
        );
      return data;
    });
  }
  private authReceipts = new Set<Promise<void>>();
  /** Suspension is immediate; document navigation waits for bounded received bodies. */
  async finishAuthReceipts(): Promise<void> {
    while (this.authReceipts.size) await Promise.all([...this.authReceipts]);
    // Allow request/store rejection handlers to record exact operation outcomes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  private async http<T>(
    url: string,
    method: string,
    body: string | File | undefined,
    timeout: number,
    contentType = "application/json",
    requestId?: string,
    trigger?: HostLifecycleTrigger,
    signal?: AbortSignal,
    binary = false,
    executorLease?: string,
    sensitive = false,
    readOnlyRequest = false,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const mutation = method !== "GET" && !readOnlyRequest;
    let status: number | undefined;
    let finishAuthReceipt: (() => void) | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeout);
    this.httpPending.add(controller);
    try {
      const response = await fetch(url, {
        method,
        credentials: "include",
        cache: "no-store",
        headers: {
          Accept: binary ? "application/octet-stream, image/png, image/jpeg, image/gif, image/webp" : "application/json",
          "x-client-tab-id": this.tabId,
          ...(trigger ? { "x-client-trigger": trigger } : {}),
          ...(body === undefined ? {} : { "Content-Type": contentType }),
          ...(requestId ? { "X-Request-ID": requestId } : {}),
          ...(executorLease ? { "X-Microcrab-Executor-Lease": executorLease } : {}),
        },
        body,
        signal: controller.signal,
      });
      status = response.status;
      if (response.status === 401) {
        // Auth suspension stops other traffic immediately. This already-received
        // response must finish its bounded read: it may report an admitted
        // mutation whose outcome remains unknown. Its own timeout still applies.
        this.httpPending.delete(controller);
        // Owner revocation disposes plugin effects and aborts their caller
        // signals. A received receipt belongs to this bounded read now, not
        // that effect's lifetime; retain only our own timeout/byte limits.
        signal?.removeEventListener("abort", abort);
        const receipt = new Promise<void>((resolve) => {
          finishAuthReceipt = resolve;
        });
        this.authReceipts.add(receipt);
        void receipt.then(() => this.authReceipts.delete(receipt));
        this.handlers.authRequired?.();
      }
      if (binary && response.ok)
        return await boundedCitationBlob(response, controller.signal) as T;
      // Bound reads while streaming; an unreadable success can hide an admitted mutation.
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = "",
        bytes = 0;
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_FRAME) {
              await reader.cancel();
              throw new CommandError(
                "invalid_result",
                "Response exceeds the connection budget",
                true,
                mutation,
              );
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (cause) {
        if (response.status === 401)
          throw new CommandError(
            "unauthenticated",
            "Authentication required",
            false,
            mutation,
          );
        throw new CommandError(
          "invalid_result",
          "Server returned an unreadable response; reconcile the receipt",
          true,
          mutation,
          { category: "syntax", reason: diagnosticMessage(cause) },
        );
      }
      if (!response.ok) {
        if (
          typeof data?.error?.code === "string" &&
          typeof data.error.message === "string"
        )
          throw new CommandError(
            data.error.code,
            data.error.message,
            data.error.retryable === true,
            data.error.code === "outcome_unknown",
            data.error.details,
          );
        if (response.status === 401)
          throw new CommandError(
            "unauthenticated",
            "Authentication required",
            false,
            mutation,
          );
        throw new CommandError(
          "invalid_result",
          `Server request failed (${response.status}); reconcile the receipt`,
          true,
          mutation,
        );
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new CommandError(
          "invalid_result",
          "Server returned an invalid result; reconcile the receipt",
          true,
          mutation,
        );
      return data as T;
    } catch (error) {
      const failure =
        error instanceof CommandError
          ? error
          : new CommandError(
              timedOut ? "timed_out" : "disconnected",
              `${mutation ? "Operation outcome is unknown. Reconcile the receipt before trying again." : timedOut ? "Request timed out" : "Request connection lost"} ${diagnosticMessage(error)}`,
              true,
              mutation,
            );
      if (controller.signal.aborted && !timedOut) silenceDiagnostic(failure);
      else if (!sensitive) reportDiagnostic("http", method, failure, status);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.httpPending.delete(controller);
      finishAuthReceipt?.();
    }
  }
  async enterChild(scope: ChildTurnScope, signal: AbortSignal): Promise<import("./types").NativeChildDetail> {
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    const path = childTurnPath(scope).replace(/\/turns$/, "/enter");
    const value = await this.http<import("./types").NativeChildDetail>(this.url(path), "POST", "{}", 15000,
      "application/json", crypto.randomUUID(), undefined, signal);
    if (value.parent_session_id !== scope.parentId || value.id !== scope.childId || !Array.isArray(value.messages) || !["persisted", "pending", "unavailable"].includes(value.availability))
      throw new CommandError("invalid_result", "child.enter: detail identity or shape mismatch", false, true);
    return value;
  }
  async submitChildTurn(scope: ChildTurnScope, request: ChildTurnRequest, owner: string, signal: AbortSignal): Promise<ChildTurnOperation> {
    validateChildOperationId(request.operation_id);
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    const value = await this.http<unknown>(this.url(childTurnPath(scope)), "POST", JSON.stringify(request), 15000,
      "application/json", request.operation_id, undefined, signal);
    try { validateChildTurnOperation(value, scope, request.operation_id, owner); }
    catch (error) { if (error instanceof CommandError) error.outcomeUnknown = true; throw error; }
    return value;
  }
  async getChildTurnOperation(scope: ChildTurnScope, operationId: string, owner: string, signal: AbortSignal): Promise<ChildTurnOperation> {
    validateChildOperationId(operationId);
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    const value = await this.http<unknown>(this.url(childTurnPath(scope) + `/${operationId}`), "GET", undefined, 15000,
      "application/json", crypto.randomUUID(), undefined, signal);
    validateChildTurnOperation(value, scope, operationId, owner);
    return value;
  }
  /** Owner settings only: never pass credentials through command observation or AppState. */
  private async speakerRequest<T>(scope: SpeakerScope, verb: "GET" | "PUT" | "POST", body: unknown, signal: AbortSignal, key = false): Promise<T> {
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    return this.http<T>(this.url(speakerPath(scope) + (key ? "/key" : "")), verb,
      body === undefined ? undefined : JSON.stringify(body), 15000,
      "application/json", crypto.randomUUID(), undefined, signal, false, undefined, true, key);
  }
  async getExternalSpeakers(scope: SpeakerScope, signal: AbortSignal): Promise<SpeakerSnapshot> {
    const value = await this.speakerRequest<unknown>(scope, "GET", undefined, signal);
    validateSpeakerSnapshot(value);
    return value;
  }
  async putExternalSpeakers(scope: SpeakerScope, update: SpeakerUpdate, signal: AbortSignal): Promise<SpeakerOperationResponse> {
    validateSpeakerUpdate(scope, update);
    try {
      const value = await this.speakerRequest<unknown>(scope, "PUT", update, signal);
      try {
        validateSpeakerOperation(value, update.operation_id);
      } catch (error) {
        if (error instanceof CommandError) error.outcomeUnknown = true;
        throw error;
      }
      return value;
    } catch (error) {
      // Even a misbehaving endpoint must not echo an authored secret into UI or diagnostics.
      if (error instanceof CommandError) {
        let message = error.message;
        for (const binding of Object.values(update.speakers))
          if (binding.action === "set" && binding.key.kind === "custom")
            message = message.replaceAll(binding.key.value, "[redacted]");
        throw new CommandError(error.code, message, error.retryable, error.outcomeUnknown);
      }
      throw error;
    }
  }
  async getExternalSpeakerOperation(scope: SpeakerScope, operationId: string, signal: AbortSignal): Promise<SpeakerOperationResponse> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId))
      throw new CommandError("invalid_request", "external-speakers.operation_id: expected canonical UUID");
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    const value = await this.http<unknown>(this.url(speakerPath(scope) + `/operations/${operationId}`), "GET", undefined,
      15000, "application/json", crypto.randomUUID(), undefined, signal, false, undefined, true);
    validateSpeakerOperation(value, operationId);
    return value;
  }
  async revealExternalSpeakerKey(scope: SpeakerScope, identity: string, signal: AbortSignal): Promise<SpeakerKey> {
    if (!validSpeakerIdentity(identity)) throw new CommandError("invalid_request", "external-speakers.identity: invalid identity");
    const value = await this.speakerRequest<unknown>(scope, "POST", { identity }, signal, true);
    validateSpeakerKey(value);
    if (value.identity !== identity) throw new CommandError("invalid_result", "external-speakers.key: identity mismatch");
    return value;
  }
  async readCitation(request: CitationRequest, signal: AbortSignal): Promise<Blob> {
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    return this.http<Blob>(this.url(citationPath(request)), "GET", undefined,
      CITATION_TIMEOUT_MS, "application/json", undefined, undefined, signal, true);
  }
  async readQuestionImage(
    request: QuestionImageRequest,
    leaseId: string | undefined,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    const blob = await this.http<Blob>(this.url(questionImagePath(request)), "GET", undefined,
      CITATION_TIMEOUT_MS, "application/json", undefined, undefined, signal, true, leaseId);
    if (!blob.type.startsWith("image/"))
      throw new CommandError("unsupported_image", "Question reference is not a supported raster image");
    return blob;
  }
  async uploadImage(sessionId: string, file: File) {
    if (this.httpPending.size + this.pending.size >= MAX_PENDING)
      throw new CommandError("overloaded", "Too many pending requests");
    return this.http<{
      attachment_id: string;
      media_type: string;
      bytes: number;
      width: number;
      height: number;
    }>(
      this.url(`api/v1/sessions/${encodeURIComponent(sessionId)}/attachments`),
      "POST",
      file,
      120000,
      file.type,
    );
  }
  private async observe<T>(
    method: string,
    sessionId: string | undefined,
    requestId: string,
    run: () => Promise<T>,
    interactionId?: string,
    transport?: "ws",
  ): Promise<T> {
    const started = performance.now();
    const fields = { method, sessionId, requestId, interactionId, transport };
    traceEvent("api.request", { ...fields, outcome: "started" });
    try {
      const result = await run();
      traceEvent("api.request", {
        ...fields,
        outcome: "succeeded",
        elapsedMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      reportDiagnostic("api", method, error);
      traceEvent("api.request", {
        ...fields,
        outcome: "failed",
        elapsedMs: performance.now() - started,
        code: error instanceof CommandError ? error.code : "client_error",
      });
      throw error;
    }
  }
  command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout = commandTimeout(method),
    requestId?: string,
  ): Promise<T> {
    const id = requestId ?? crypto.randomUUID();
    const run = () => {
      try {
        return this.commandNative<T>(method, params, timeout, id).catch(
          (error) => {
            reportDiagnostic("global_socket", method, error);
            throw error;
          },
        );
      } catch (error) {
        reportDiagnostic("global_socket", method, error);
        return Promise.reject(error);
      }
    };
    return requestId
      ? run()
      : this.observe(method, sessionId, id, run, undefined, "ws");
  }
  private sessionCommand<T>(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    timeout: number,
    requestId: string,
  ): Promise<T> {
    const socket = this.sessionTransport?.() ?? null;
    if (!socket || !sessionId || socket.sessionId !== sessionId)
      return Promise.reject(
        new CommandError(
          "disconnected",
          "The session connection is not ready; reload the session before sending",
          true,
        ),
      );
    return socket.command<T>(
      method,
      params,
      timeout,
      requestId,
      MUTATIONS.has(method),
    );
  }
  private commandNative<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    request_id: string,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
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
    const body = encodeCommand(method, params, request_id);
    if (
      new TextEncoder().encode(body).byteLength > this.commandBytes ||
      socket.bufferedAmount > MAX_FRAME
    )
      return Promise.reject(
        new CommandError(
          "limit_exceeded",
          "Command exceeds the connection budget",
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const mutation = MUTATIONS.has(method);
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(
          new CommandError(
            "timed_out",
            mutation
              ? "Command outcome is unknown. Reconcile the receipt before trying again."
              : "Command timed out",
            true,
            mutation,
          ),
        );
      }, timeout);
      this.pending.set(request_id, {
        resolve,
        reject,
        timer,
        mutation,
      });
      try {
        socket.send(body);
      } catch {
        this.pending.delete(request_id);
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
  private rejectPending() {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      const error = new CommandError(
        "disconnected",
        value.mutation
          ? "Connection lost. Operation outcome is unknown; reconnect to reconcile."
          : "Connection lost",
        true,
        value.mutation,
      );
      if (this.stopped) silenceDiagnostic(error);
      value.reject(error);
    }
    this.pending.clear();
  }
  stop() {
    ++this.hostEpoch;
    this.closeRelay();
    void this.browserHosts.close();
    this.stopped = true;
    for (const controller of this.httpPending) controller.abort();
    clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectPending();
  }
}

/** Only absolute http(s) end-session URLs are followed. */
export function logoutRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
