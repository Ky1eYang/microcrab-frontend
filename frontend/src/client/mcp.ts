export interface McpServerConfig {
  /** Stable client-owned identity. Never send endpoint/auth to the model. */
  id: string;
  endpoint: string;
  authorization?: string;
}
export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface McpClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxPages?: number;
  maxTools?: number;
  protocolVersions?: readonly string[];
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface McpCallToolResult {
  content: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}
export type McpErrorCode =
  | "configuration"
  | "not_initialized"
  | "busy"
  | "closed"
  | "aborted"
  | "timeout"
  | "network"
  | "http"
  | "protocol"
  | "rpc"
  | "limit";
export class McpClientError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly outcomeUnknown = false,
    public readonly httpStatus?: number,
    public readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new McpClientError("protocol", message);
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new McpClientError("configuration", `Invalid MCP ${name}`);
  return value;
}
/** Full SHA-256 over framed identities; base64url keeps names at 47 ASCII chars. */
export async function mcpRegistrationName(
  serverId: string,
  toolName: string,
): Promise<string> {
  for (const text of [serverId, toolName]) {
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
        throw new McpClientError(
          "configuration",
          "MCP names must be valid Unicode",
        );
    }
  }
  if (!globalThis.crypto?.subtle)
    throw new McpClientError(
      "configuration",
      "MCP registration requires WebCrypto in a secure browser context",
    );
  const framed = new TextEncoder().encode(JSON.stringify([serverId, toolName]));
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", framed),
  );
  const encoded = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `mcp_${encoded}`;
}
export async function createMcpToolCatalog(
  client: McpHttpClient,
  tools: readonly McpTool[],
  /** Share this registry when assembling catalogs from multiple MCP servers. */
  registry: Map<string, string> = new Map(),
): Promise<{
  definitions: McpToolDefinition[];
  bindings: Map<string, string>;
}> {
  const bindings = new Map<string, string>();
  const definitions: McpToolDefinition[] = [];
  for (const tool of tools) {
    const name = await mcpRegistrationName(client.serverId, tool.name);
    const identity = JSON.stringify([client.serverId, tool.name]);
    if (bindings.has(name))
      fail("Duplicate or colliding MCP tool registration name");
    if (registry.has(name) && registry.get(name) !== identity)
      fail("MCP registration name collision; catalog admission rejected");
    registry.set(name, identity);
    bindings.set(name, tool.name);
    definitions.push({
      name,
      description: tool.description ?? "",
      parameters: structuredClone(tool.inputSchema),
    });
  }
  return { definitions, bindings };
}

/** Browser-only Streamable HTTP. No retries, background GET stream, or effect replay. */
export class McpHttpClient {
  readonly serverId: string;
  private readonly endpoint: string;
  private readonly authorization?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly responseLimit: number;
  private readonly requestLimit: number;
  private readonly maxPages: number;
  private readonly maxTools: number;
  private readonly versions: readonly string[];
  private session?: string;
  private version?: string;
  private ready = false;
  private initializing = false;
  private closed = false;
  private sequence = 0;
  private active = new Set<AbortController>();

  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw new McpClientError(
        "configuration",
        "MCP endpoint must be an absolute HTTP(S) URL",
      );
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      !config.id ||
      config.id.length > 256
    )
      throw new McpClientError(
        "configuration",
        "Invalid MCP endpoint or server identity",
      );
    if (
      config.authorization !== undefined &&
      (!config.authorization || /[\r\n]/.test(config.authorization))
    )
      throw new McpClientError(
        "configuration",
        "Invalid MCP authorization header",
      );
    this.serverId = config.id;
    this.endpoint = endpoint.href;
    this.authorization = config.authorization;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = positive(options.timeoutMs ?? 30_000, "deadline");
    this.responseLimit = positive(
      options.maxResponseBytes ?? 2 * 1024 * 1024,
      "response limit",
    );
    this.requestLimit = positive(
      options.maxRequestBytes ?? 1024 * 1024,
      "request limit",
    );
    this.maxPages = positive(options.maxPages ?? 100, "page limit");
    this.maxTools = positive(options.maxTools ?? 1000, "tool limit");
    this.versions = [...(options.protocolVersions ?? VERSIONS)];
    if (
      !this.versions.length ||
      this.versions.some((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v))
    )
      throw new McpClientError(
        "configuration",
        "Invalid MCP protocol versions",
      );
  }
  get protocolVersion(): string | undefined {
    return this.version;
  }
  get sessionId(): string | undefined {
    return this.session;
  }

  async initialize(options: McpRequestOptions = {}): Promise<void> {
    if (this.ready) return;
    if (this.initializing)
      throw new McpClientError(
        "busy",
        "MCP initialization is already in progress",
      );
    this.initializing = true;
    try {
      await this.operation(options, async (signal) => {
        const result = await this.rpc(
          "initialize",
          {
            protocolVersion: this.versions[0],
            capabilities: {},
            clientInfo: { name: "microcrab-browser", version: "0.1.10" },
          },
          signal,
        );
        if (
          !record(result) ||
          typeof result.protocolVersion !== "string" ||
          !this.versions.includes(result.protocolVersion) ||
          !record(result.capabilities) ||
          !record(result.serverInfo)
        )
          fail(
            "MCP server returned an unsupported or invalid initialization result",
          );
        this.version = result.protocolVersion;
        await this.notify("notifications/initialized", undefined, signal);
        if (signal.aborted)
          throw new McpClientError("aborted", "MCP initialization cancelled");
        this.ready = true;
      });
    } catch (error) {
      this.session = undefined;
      this.version = undefined;
      this.ready = false;
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpTool[]> {
    this.requireReady();
    return this.operation(options, async (signal) => {
      const tools: McpTool[] = [],
        cursors = new Set<string>(),
        names = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < this.maxPages; page++) {
        const result = await this.rpc(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        );
        if (!record(result) || !Array.isArray(result.tools))
          fail("Invalid MCP tools/list result");
        for (const raw of result.tools) {
          if (
            !record(raw) ||
            typeof raw.name !== "string" ||
            !raw.name ||
            !record(raw.inputSchema) ||
            raw.inputSchema.type !== "object" ||
            (raw.description !== undefined &&
              typeof raw.description !== "string")
          )
            fail("Invalid MCP tool definition");
          if (names.has(raw.name))
            fail("Duplicate MCP tool name across catalog pages");
          if (tools.length >= this.maxTools)
            throw new McpClientError(
              "limit",
              "MCP tool catalog exceeded the tool limit",
            );
          names.add(raw.name);
          tools.push({
            name: raw.name,
            ...(typeof raw.description === "string"
              ? { description: raw.description }
              : {}),
            inputSchema: raw.inputSchema,
          });
        }
        if (result.nextCursor === undefined) return tools;
        if (
          typeof result.nextCursor !== "string" ||
          !result.nextCursor ||
          cursors.has(result.nextCursor)
        )
          fail("Invalid or repeated MCP pagination cursor");
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      throw new McpClientError(
        "limit",
        "MCP tool catalog exceeded the page limit",
      );
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpCallToolResult> {
    this.requireReady();
    if (!name || !record(args))
      throw new McpClientError(
        "configuration",
        "MCP tool name and object arguments are required",
      );
    return this.operation(
      options,
      async (signal) => {
        const result = await this.rpc(
          "tools/call",
          { name, arguments: args },
          signal,
        );
        if (
          !record(result) ||
          !Array.isArray(result.content) ||
          result.content.some(
            (item) => !record(item) || typeof item.type !== "string",
          ) ||
          (result.isError !== undefined &&
            typeof result.isError !== "boolean") ||
          (result.structuredContent !== undefined &&
            !record(result.structuredContent))
        )
          throw new McpClientError(
            "protocol",
            "Invalid MCP tools/call result; the tool may already have executed",
            true,
          );
        return result as McpCallToolResult;
      },
      true,
    );
  }

  /** Local shutdown aborts all work; reopening requires a new explicit client. */
  close(): void {
    this.closed = true;
    this.ready = false;
    for (const controller of this.active) controller.abort();
  }
  private requireReady(): void {
    if (this.closed) throw new McpClientError("closed", "MCP client is closed");
    if (!this.ready)
      throw new McpClientError(
        "not_initialized",
        "Initialize the MCP client explicitly before using tools",
      );
  }
  private async operation<T>(
    options: McpRequestOptions,
    run: (signal: AbortSignal) => Promise<T>,
    effect = false,
  ): Promise<T> {
    if (this.closed) throw new McpClientError("closed", "MCP client is closed");
    if (options.signal?.aborted)
      throw new McpClientError(
        "aborted",
        "MCP request was cancelled before dispatch",
      );
    const timeout = positive(options.timeoutMs ?? this.timeoutMs, "deadline");
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new McpClientError(
            timedOut ? "timeout" : "aborted",
            timedOut
              ? "MCP request deadline exceeded"
              : "MCP request cancelled",
            effect,
          ),
        );
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([run(controller.signal), cancelled]);
    } catch (error) {
      if (error instanceof McpClientError) {
        if (
          effect &&
          !["configuration", "limit", "rpc"].includes(error.code) &&
          !error.outcomeUnknown
        )
          throw new McpClientError(
            error.code,
            error.message,
            true,
            error.httpStatus,
            error.rpcCode,
          );
        throw error;
      }
      throw new McpClientError(
        "network",
        "MCP transport failed; check connectivity, CORS, and server availability",
        effect,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      this.active.delete(controller);
    }
  }
  private headers(): Headers {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    });
    if (this.authorization) headers.set("Authorization", this.authorization);
    if (this.session) headers.set("Mcp-Session-Id", this.session);
    if (this.version) headers.set("MCP-Protocol-Version", this.version);
    return headers;
  }
  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new McpClientError(
        "configuration",
        "MCP request is not JSON serializable",
      );
    }
    if (new TextEncoder().encode(text).length > this.requestLimit)
      throw new McpClientError("limit", "MCP request exceeded the byte limit");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: text,
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new McpClientError("aborted", "MCP request cancelled", true);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) {
        this.ready = false;
        this.session = undefined;
        this.version = undefined;
      }
      throw new McpClientError(
        "http",
        `MCP HTTP request failed (${response.status})`,
        false,
        response.status,
      );
    }
    const session = response.headers.get("Mcp-Session-Id");
    if (session !== null) {
      if (
        !/^[\x21-\x7e]+$/.test(session) ||
        session.length > 4096 ||
        (this.session !== undefined && session !== this.session)
      ) {
        void response.body?.cancel().catch(() => {});
        fail("MCP server returned an invalid or changed session ID");
      }
      this.session = session;
    }
    return response;
  }
  private async notify(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.post(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      signal,
    );
    void response.body?.cancel().catch(() => {});
    if (response.status !== 202 && response.status !== 204)
      fail("MCP notification was not acknowledged");
  }
  private async rpc(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = ++this.sequence;
    try {
      const response = await this.post(
        { jsonrpc: "2.0", id, method, params },
        signal,
      );
      return await this.readResponse(response, id, signal);
    } catch (error) {
      // Best effort cancellation is bounded and never retries the original request.
      if (signal.aborted && method !== "initialize" && !this.closed) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1000);
        void this.notify(
          "notifications/cancelled",
          { requestId: id, reason: "Client cancelled request" },
          controller.signal,
        )
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      }
      throw error;
    }
  }
  private async readResponse(
    response: Response,
    id: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const type = response.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (type !== "application/json" && type !== "text/event-stream") {
      void response.body?.cancel().catch(() => {});
      fail("MCP response must be application/json or text/event-stream");
    }
    const length = response.headers.get("Content-Length");
    if (length !== null && Number(length) > this.responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new McpClientError(
        "limit",
        "MCP response exceeded the byte limit",
        true,
      );
    }
    if (!response.body) fail("MCP response body is missing");
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    let total = 0,
      buffer = "",
      data: string[] = [];
    const decode = (text: string): { matched: boolean; result?: unknown } => {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return fail("Invalid JSON in MCP response");
      }
      if (!record(message) || message.jsonrpc !== "2.0")
        fail("Invalid MCP JSON-RPC envelope");
      if (typeof message.method === "string") {
        if (message.id !== undefined)
          fail("MCP server requests are unsupported by this client");
        return { matched: false };
      }
      if (message.id !== id) fail("MCP response ID does not match the request");
      if ("result" in message === "error" in message)
        fail("Invalid MCP JSON-RPC result/error");
      if ("error" in message) {
        if (
          !record(message.error) ||
          typeof message.error.code !== "number" ||
          typeof message.error.message !== "string"
        )
          fail("Invalid MCP JSON-RPC error");
        // Do not forward arbitrary upstream error text/data that can contain credentials.
        throw new McpClientError(
          "rpc",
          `MCP server returned JSON-RPC error ${message.error.code}`,
          false,
          undefined,
          message.error.code,
        );
      }
      return { matched: true, result: message.result };
    };
    const event = () => {
      if (!data.length) return { matched: false };
      const text = data.join("\n");
      data = [];
      return decode(text);
    };
    try {
      while (true) {
        if (signal.aborted)
          throw new McpClientError("aborted", "MCP response cancelled", true);
        const { done, value } = await reader.read();
        if (value) {
          total += value.byteLength;
          if (total > this.responseLimit)
            throw new McpClientError(
              "limit",
              "MCP response exceeded the byte limit",
              true,
            );
        }
        try {
          buffer += decoder.decode(value, { stream: !done });
        } catch {
          fail("MCP response is not valid UTF-8");
        }
        if (type === "text/event-stream") {
          while (true) {
            const match = /[\r\n]/.exec(buffer);
            if (!match) break;
            const index = match.index;
            if (!done && buffer[index] === "\r" && index === buffer.length - 1)
              break;
            const line = buffer.slice(0, index);
            buffer = buffer.slice(
              index +
                (buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1),
            );
            if (!line) {
              const parsed = event();
              if (parsed.matched) return parsed.result;
            } else if (line === "data" || line.startsWith("data:"))
              data.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
          }
        }
        if (done) {
          if (type === "application/json") {
            const parsed = decode(buffer);
            if (parsed.matched) return parsed.result;
          }
          fail("MCP stream ended before a matching JSON-RPC response");
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
