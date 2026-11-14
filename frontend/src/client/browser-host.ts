import { diagnosticMessage, reportDiagnostic } from "./diagnostics";
import { t } from "../i18n";
import type { ApiClient } from "./api";

/** Bounded transport only: opaque payloads retain their exact route envelope.
 * Control may pass bulk chunks; each bulk producer awaits FIFO admission. */
export class BrowserHostTransport {
  private control: Item[] = [];
  private data: Item[] = [];
  private bytes = 0;
  private pumping = false;
  constructor(private socket: () => WebSocket | null) {}
  send(frame: unknown): Promise<void> {
    const socket = this.socket();
    if (!socket || socket.readyState !== 1)
      return Promise.reject(Error("Browser Host route lost"));
    const text = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(text).byteLength;
    if (
      bytes > 135168 ||
      this.control.length + this.data.length >= 64 ||
      this.bytes + bytes > 4194304
    )
      return Promise.reject(
        Error("Browser Host transport queue limit reached"),
      );
    return new Promise((resolve, reject) => {
      // This transport hint changes only scheduling, never execution authority.
      const bulk =
        (frame as { frame?: { kind?: string } })?.frame?.kind ===
        "transfer_chunk";
      (bulk ? this.data : this.control).push({
        socket,
        text,
        bytes,
        resolve,
        reject,
        deadline: Date.now() + 30000,
      });
      this.bytes += bytes;
      void this.pump();
    });
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.control.length || this.data.length) {
        const item = this.control[0] ?? this.data[0];
        if (this.socket() !== item.socket || item.socket.readyState !== 1)
          throw Error("Browser Host route lost");
        if (Date.now() >= item.deadline)
          throw Error("Browser Host transport queue deadline exceeded");
        if (item.socket.bufferedAmount + item.bytes > 4194304) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        item.socket.send(item.text);
        (this.control.length ? this.control : this.data).shift();
        this.bytes -= item.bytes;
        item.resolve();
      }
    } catch (error) {
      if (this.socket()?.readyState === 1)
        reportDiagnostic("browser_host", "transport", error);
      for (const item of [...this.control.splice(0), ...this.data.splice(0)])
        item.reject(error);
      this.bytes = 0;
    } finally {
      this.pumping = false;
    }
  }
}
interface Item {
  socket: WebSocket;
  text: string;
  bytes: number;
  deadline: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function policyKey(base: string, owner: string) {
  return `microcrab.browser-host-network.v1:${JSON.stringify([base, owner])}`;
}
export function browserHostOrigins(
  base: string,
  owner: string,
): string[] | null {
  const saved = localStorage.getItem(policyKey(base, owner));
  if (saved === null) return null;
  const values: unknown = JSON.parse(saved);
  if (
    !Array.isArray(values) ||
    values.length > 32 ||
    values.some((value) => typeof value !== "string")
  )
    throw Error(t("browserHost.networkInvalid"));
  return values as string[];
}
export function resetBrowserHostOrigins(base: string, owner: string) {
  if (!owner) throw Error(t("browserHost.authenticationRequired"));
  localStorage.removeItem(policyKey(base, owner));
}
export function saveBrowserHostOrigins(
  base: string,
  owner: string,
  text: string,
) {
  if (!owner) throw Error(t("browserHost.authenticationRequired"));
  const origins = [...new Set(text.split(/\s+/).filter(Boolean))];
  if (origins.length > 32) throw Error(t("browserHost.networkInvalid"));
  for (const value of origins) {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.protocol !== "https:" ||
      url.origin === new URL(base).origin ||
      url.username ||
      url.password
    )
      throw Error(t("browserHost.networkInvalid"));
  }
  localStorage.setItem(policyKey(base, owner), JSON.stringify(origins));
}
interface ConversationScope {
  scope_version: 3;
  scope_kind: "conversation";
  binding_id: string;
  backend_id: string;
  conversation_id: string;
}
interface BrowserRuntime {
  lease: string;
  descriptor(): Promise<Record<string, unknown>>;
  handle(
    frame: unknown,
    scope: ConversationScope,
    send: (value: unknown) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}
interface BrowserConnection {
  host: BrowserRuntime;
  scope: ConversationScope;
  generation: string | null;
}
export class BrowserConversations {
  private hosts = new Map<string, BrowserConnection>();
  private connecting = new Map<
    string,
    ReturnType<BrowserConversations["open"]>
  >();
  private epoch = 0;
  constructor(
    private api: ApiClient,
    private send: (frame: unknown) => Promise<void>,
  ) {}
  async connect(conversationId: string, owner: string) {
    const current = this.hosts.get(conversationId);
    if (current?.generation) return current;
    const inFlight = this.connecting.get(conversationId);
    if (inFlight) return inFlight;
    const pending = this.open(conversationId, owner, this.epoch);
    this.connecting.set(conversationId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.connecting.get(conversationId) === pending)
        reportDiagnostic("browser_host", "connect", error);
      throw error;
    } finally {
      if (this.connecting.get(conversationId) === pending)
        this.connecting.delete(conversationId);
    }
  }
  private async open(conversationId: string, owner: string, epoch: number) {
    if (!owner) throw Error(t("browserHost.authenticationRequired"));
    const prefix = `microcrab.browser-host.v1:${JSON.stringify([this.api.base, owner])}`;
    let browserId: string, workspaceId: string;
    try {
      browserId =
        localStorage.getItem(prefix + ":browser") || crypto.randomUUID();
      localStorage.setItem(prefix + ":browser", browserId);
      workspaceId =
        localStorage.getItem(prefix + ":" + conversationId) ||
        crypto.randomUUID();
      localStorage.setItem(prefix + ":" + conversationId, workspaceId);
    } catch (error) {
      const failure = Error(
        `${t("browserHost.storageUnavailable")} ${diagnosticMessage(error)}`,
      );
      reportDiagnostic(
        "storage",
        "browserHostIdentity",
        failure,
        undefined,
        "warn",
      );
      throw failure;
    }
    const scope = await this.api.command<ConversationScope>(
      "conversation.binding",
      {
        conversation_id: conversationId,
        browser_id: browserId,
        workspace_id: workspaceId,
      },
    );
    if (
      scope.scope_version !== 3 ||
      scope.scope_kind !== "conversation" ||
      scope.conversation_id !== conversationId
    )
      throw Error(t("browserHost.bindingChanged"));
    const manifestUrl = new URL("/browser-host/current.json", this.api.base);
    const response = await fetch(manifestUrl, {
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) {
      const error = Error(
        `${t("browserHost.artifactsMissing")} (HTTP ${response.status})`,
      );
      reportDiagnostic("browser_host", "manifest", error, response.status);
      throw error;
    }
    const manifest = await response.json();
    if (
      manifest.schema !== 1 ||
      manifest.kind !== "browser-host" ||
      manifest.wasmsh_version !== "0.5.1" ||
      !/^[a-f0-9]{64}$/.test(manifest.hash) ||
      manifest.entry !== "supervisor.mjs" ||
      manifest.base_url !== `/browser-host/${manifest.hash}/`
    )
      throw Error(t("browserHost.artifactsMissing"));
    const entry = manifest.files?.find(
      (file: { path: string }) => file.path === manifest.entry,
    );
    if (!entry) throw Error(t("browserHost.artifactsMissing"));
    const entryUrl = new URL(
      manifest.entry,
      new URL(manifest.base_url, manifestUrl),
    );
    const source = await fetch(entryUrl, {
      credentials: "include",
      redirect: "error",
    });
    const bytes = await source.arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (!source.ok || hash !== entry.sha256 || bytes.byteLength !== entry.size)
      throw Error(t("browserHost.integrityFailed"));
    const runtime = await import(/* @vite-ignore */ entryUrl.href);
    let frameOwner: BrowserConnection | undefined;
    const host: BrowserRuntime = await runtime.BrowserHost.create({
      backend: this.api.base,
      owner,
      browserId,
      workspaceId,
      conversationId,
      manifestUrl: manifestUrl.href,
      allowedOrigins: browserHostOrigins(this.api.base, owner),
      onFrame: (frame: unknown) => {
        const owner = frameOwner;
        if (
          !owner ||
          epoch !== this.epoch ||
          this.hosts.get(conversationId) !== owner
        )
          return;
        void this.emit(conversationId, owner, frame).catch((error: unknown) => {
          if (this.hosts.get(conversationId) === owner) {
            reportDiagnostic("browser_host", "emit", error);
            void this.disconnect(conversationId, false);
          }
        });
      },
    });
    if (epoch !== this.epoch) {
      await host.close();
      throw Error(t("browserHost.bindingChanged"));
    }
    const connection = { host, scope, generation: null as string | null };
    frameOwner = connection;
    this.hosts.set(conversationId, connection);
    try {
      const descriptor = await host.descriptor();
      // Descriptor hashing and attachment cross lifecycle boundaries. Closing or
      // replacing this exact host revokes its authority even if a new socket is ready.
      if (epoch !== this.epoch || this.hosts.get(conversationId) !== connection)
        throw Error(t("browserHost.bindingChanged"));
      const attached = await this.api.command<{
        scope: ConversationScope;
        connection_generation: string;
        ready: boolean;
      }>("conversation.attach", {
        conversation_id: conversationId,
        descriptor,
        lease_generation: host.lease,
      });
      if (
        epoch !== this.epoch ||
        this.hosts.get(conversationId) !== connection ||
        !attached.ready ||
        attached.scope.binding_id !== scope.binding_id
      )
        throw Error(t("browserHost.bindingChanged"));
      connection.generation = attached.connection_generation;
      return connection;
    } catch (error) {
      if (this.hosts.get(conversationId) === connection)
        this.hosts.delete(conversationId);
      await host.close();
      throw error;
    }
  }
  private async emit(
    id: string,
    connection: BrowserConnection,
    frame: unknown,
    generation = connection.generation,
  ) {
    if (this.hosts.get(id) !== connection || !generation) return;
    await this.send({
      lane: "conversation_host",
      conversation_id: id,
      connection_generation: generation,
      frame,
    });
  }
  receive(value: {
    conversation_id: string;
    connection_generation: string;
    frame: unknown;
  }) {
    const connection = this.hosts.get(value.conversation_id);
    if (!connection) return;
    // The authenticated Server envelope owns routing. Preserve its exact token
    // on the reply instead of rebinding old work to a later generation.
    connection.generation = value.connection_generation;
    void connection.host
      .handle(value.frame, connection.scope, (frame) =>
        this.emit(
          value.conversation_id,
          connection,
          frame,
          value.connection_generation,
        ),
      )
      .catch((error: unknown) => {
        if (this.hosts.get(value.conversation_id) === connection) {
          reportDiagnostic("browser_host", "handle", error);
          void this.disconnect(value.conversation_id, false);
        }
      });
  }
  async disconnect(id: string, detach = true) {
    const connection = this.hosts.get(id);
    this.hosts.delete(id);
    if (!connection) return;
    if (detach)
      await this.api
        .command("conversation.detach", { conversation_id: id })
        .catch(() => {});
    await connection.host.close();
  }
  async close() {
    this.epoch++;
    this.connecting.clear();
    await Promise.all(
      [...this.hosts.keys()].map((id) => this.disconnect(id, false)),
    );
  }
}
