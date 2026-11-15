import type { BrowserRuntime, ConversationScope } from "./browser-host";

/** An inert protocol peer: client tools keep their independent authorization. */
export class ChatOnlyHostRuntime implements BrowserRuntime {
  readonly lease = crypto.randomUUID();
  private readonly instance = crypto.randomUUID();
  private closed = false;
  constructor(
    private browserId: string,
    private workspaceId: string,
  ) {}

  async descriptor(): Promise<Record<string, unknown>> {
    // Field order is microcrab_host_protocol::HostDescriptor / HostInfo's serde
    // order. Optional None fields are omitted, not serialized as null.
    const descriptor = {
      protocol_version: 2,
      host_id: this.browserId,
      workspace_id: this.workspaceId,
      bridge_instance_id: "",
      workspace_root: "/chat",
      platform: "browser",
      info: {
        os_family: "other",
        os: "browser",
        arch: "wasm32",
        shell: "none",
        path_separator: "/",
        newline: "\n",
        capabilities: [],
        description:
          "Chat Only has no filesystem, shell, process or Host network execution. Authorized client tools and plugins remain available.",
      },
      tool_capabilities: [],
      supported_primitives: [],
      descriptor_digest: "",
    };
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(descriptor)),
    );
    descriptor.descriptor_digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    descriptor.bridge_instance_id = this.instance;
    return descriptor;
  }

  async handle(
    value: unknown,
    _scope: ConversationScope,
    send: (value: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.closed) throw Error("Chat Only Host is closed");
    const frame = value as {
      kind: string;
      lease_generation: string;
      request_id: string;
      operation_id: string;
      method?: { method: string };
    };
    if (frame.lease_generation !== this.lease)
      throw Error("Chat Only Host lease changed");
    switch (frame.kind) {
      case "ping":
        await send({ kind: "pong", lease_generation: this.lease });
        return;
      case "cancel":
        // No effects or pending observations survive synchronous dispatch.
        return;
      case "detach":
        await this.close();
        return;
      case "status":
        await send({
          kind: "receipt",
          request_id: frame.request_id,
          receipt: null,
        });
        return;
      case "request":
        await send({
          kind: "response",
          request_id: frame.request_id,
          operation_id: frame.operation_id,
          // Recovery is protocol readiness, not an executable primitive. This
          // Host never admits effects and therefore has no durable receipts.
          result:
            frame.method?.method === "recovery"
              ? { Ok: [] }
              : {
                  Err: {
                    code: "unsupported",
                    message:
                      "Chat Only does not support Host execution operations.",
                  },
                },
        });
        return;
      default:
        throw Error("Unsupported Chat Only Host control frame");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
