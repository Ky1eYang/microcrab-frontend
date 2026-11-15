import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/chat-only-host-descriptor.json", import.meta.url),
    "utf8",
  ),
);

async function mount(page: Page) {
  await page.route("**/chat-only-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto("/chat-only-fixture");
}

test("Chat Only descriptor matches canonical Rust serialization bytes and stable instance identity", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(
    async ({ descriptor, canonical, digest }) => {
      const path = "/src/client/chat-only-host.ts";
      const { ChatOnlyHostRuntime } = await import(path);
      const host = new ChatOnlyHostRuntime(
        descriptor.host_id,
        descriptor.workspace_id,
      );
      const first = await host.descriptor();
      const second = await host.descriptor();
      const normalized = {
        ...first,
        bridge_instance_id: "",
        descriptor_digest: "",
      };
      return {
        canonical: JSON.stringify(normalized),
        digest: first.descriptor_digest,
        expected: { canonical, digest },
        stable: first.bridge_instance_id === second.bridge_instance_id,
        descriptor: {
          ...first,
          bridge_instance_id: descriptor.bridge_instance_id,
        },
      };
    },
    golden,
  );
  expect(result.canonical).toBe(golden.canonical);
  expect(result.digest).toBe(golden.digest);
  expect(result.descriptor).toEqual(golden.descriptor);
  expect(result.stable).toBe(true);
});

test("Chat Only answers recovery, request, status and heartbeat with exact protocol identities and fences retired leases", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const path = "/src/client/chat-only-host.ts";
    const { ChatOnlyHostRuntime } = await import(path);
    const host = new ChatOnlyHostRuntime("browser", "workspace");
    const scope = {
      scope_version: 3,
      scope_kind: "conversation",
      binding_id: "binding",
      backend_id: "backend",
      conversation_id: "conversation",
    };
    const frames: unknown[] = [];
    const send = async (frame: unknown) => {
      frames.push(frame);
    };
    const lease_generation = host.lease;
    await host.handle({ kind: "ping", lease_generation }, scope, send);
    await host.handle(
      {
        kind: "request",
        request_id: "ready",
        operation_id: "recovery-op",
        lease_generation,
        method: { method: "recovery" },
      },
      scope,
      send,
    );
    for (const method of [
      "read",
      "write",
      "shell_launch",
      "process_inventory",
      "stat",
      "settle_unknown",
    ]) {
      await host.handle(
        {
          kind: "request",
          request_id: "request-" + method,
          operation_id: "operation-" + method,
          lease_generation,
          method: { method },
        },
        scope,
        send,
      );
    }
    await host.handle(
      {
        kind: "status",
        request_id: "status",
        operation_id: "never-admitted",
        lease_generation,
      },
      scope,
      send,
    );
    await host.handle(
      { kind: "cancel", request_id: "request-read", lease_generation },
      scope,
      send,
    );
    let stale = false;
    try {
      await host.handle(
        { kind: "ping", lease_generation: "stale" },
        scope,
        send,
      );
    } catch {
      stale = true;
    }
    await host.handle({ kind: "detach", lease_generation }, scope, send);
    let closed = false;
    try {
      await host.handle({ kind: "ping", lease_generation }, scope, send);
    } catch {
      closed = true;
    }
    return { frames, lease_generation, stale, closed };
  });
  expect(result.frames[0]).toEqual({
    kind: "pong",
    lease_generation: result.lease_generation,
  });
  expect(result.frames[1]).toEqual({
    kind: "response",
    request_id: "ready",
    operation_id: "recovery-op",
    result: { Ok: [] },
  });
  for (const [index, method] of [
    "read",
    "write",
    "shell_launch",
    "process_inventory",
    "stat",
    "settle_unknown",
  ].entries()) {
    expect(result.frames[index + 2]).toMatchObject({
      kind: "response",
      request_id: "request-" + method,
      operation_id: "operation-" + method,
      result: { Err: { code: "unsupported" } },
    });
  }
  expect(result.frames.at(-1)).toEqual({
    kind: "receipt",
    request_id: "status",
    receipt: null,
  });
  expect(result.frames).toHaveLength(9);
  expect(result.stale && result.closed).toBe(true);
});

test("Chat Only binds explicit flavor before attach without browser execution assets, Worker or WASM", async ({
  page,
}) => {
  await mount(page);
  const executionAssets: string[] = [];
  page.on("request", (request) => {
    if (/browser-host|\.wasm(?:\?|$)|supervisor\.mjs/.test(request.url()))
      executionAssets.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(path);
    const calls: { method: string; params: any }[] = [];
    let workers = 0,
      wasm = 0;
    const originalWorker = window.Worker,
      originalCompile = WebAssembly.compile;
    window.Worker = class {
      constructor() {
        workers++;
        throw Error("Unexpected Worker");
      }
    } as any;
    WebAssembly.compile = async () => {
      wasm++;
      throw Error("Unexpected WASM");
    };
    const scope = {
      scope_version: 3,
      scope_kind: "conversation",
      binding_id: "binding",
      backend_id: "backend",
      conversation_id: "conversation",
    };
    const api: any = {
      base: location.origin + "/",
      async command(method: string, params: any) {
        calls.push({ method, params });
        if (method === "conversation.binding")
          return { ...scope, host_flavor: params.host_flavor };
        if (method === "conversation.attach")
          return {
            scope,
            host_flavor: "chat_only",
            ready: true,
            connection_generation: "generation",
          };
        throw Error(method);
      },
    };
    const routed: unknown[] = [];
    const conversations = new BrowserConversations(api, async (frame) => {
      routed.push(frame);
    });
    try {
      const connection = await conversations.connect(
        "conversation",
        "owner",
        "chat_only",
      );
      const reused = await conversations.connect(
        "conversation",
        "owner",
        "chat_only",
      );
      let immutable = false;
      try {
        await conversations.connect("conversation", "owner", "browser_sandbox");
      } catch {
        immutable = true;
      }
      let ownerFenced = false;
      try {
        await conversations.connect("conversation", "different-owner", "chat_only");
      } catch { ownerFenced = true; }
      if (!ownerFenced) throw Error("Cached Host crossed authenticated owner");
      // Real route receive uses the exact authenticated generation for replies.
      conversations.receive({
        conversation_id: "conversation",
        connection_generation: "observed-generation",
        frame: { kind: "ping", lease_generation: connection.host.lease },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const descriptor = await connection.host.descriptor();
      await conversations.close();
      return {
        calls,
        workers,
        wasm,
        immutable,
        reused: connection === reused,
        routed,
        descriptor,
      };
    } finally {
      window.Worker = originalWorker;
      WebAssembly.compile = originalCompile;
    }
  });
  expect(
    executionAssets.filter(
      (url) => !url.endsWith("/src/client/browser-host.ts"),
    ),
  ).toEqual([]);
  expect(result.workers + result.wasm).toBe(0);
  expect(result.calls.map((call) => call.method)).toEqual([
    "conversation.binding",
    "conversation.attach",
  ]);
  expect(result.calls[0].params.host_flavor).toBe("chat_only");
  expect(result.calls[1].params.host_flavor).toBe("chat_only");
  expect(result.descriptor.tool_capabilities).toEqual([]);
  expect(result.descriptor.supported_primitives).toEqual([]);
  expect((result.descriptor.info as any).capabilities).toEqual([]);
  expect(result.immutable && result.reused).toBe(true);
  expect(result.routed).toEqual([
    {
      lane: "conversation_host",
      conversation_id: "conversation",
      connection_generation: "observed-generation",
      frame: {
        kind: "pong",
        lease_generation: (result.routed[0] as any).frame.lease_generation,
      },
    },
  ]);
});

test("binding flavor conflict rejects before loading any execution asset or attaching", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(path);
    const calls: string[] = [];
    const api: any = {
      base: location.origin + "/",
      async command(method: string) {
        calls.push(method);
        return {
          scope_version: 3,
          scope_kind: "conversation",
          conversation_id: "legacy",
          host_flavor: "browser_sandbox",
        };
      },
    };
    const conversations = new BrowserConversations(api, async () => {});
    let rejected = false;
    try {
      await conversations.connect("legacy", "owner", "chat_only");
    } catch {
      rejected = true;
    }
    return { calls, rejected };
  });
  expect(result).toEqual({ calls: ["conversation.binding"], rejected: true });
});

test("projectless delegated and one-shot projections never acquire implicit browser authority", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const projectorPath = "/src/client/projector.ts",
      readinessPath = "/src/state/host-readiness.ts",
      modelPath = "/src/state/model.ts";
    const { sessionView } = await import(projectorPath);
    const { hostReadiness } = await import(readinessPath);
    const { initialState } = await import(modelPath);
    return ["delegated", "one_shot"].map((kind) => {
      const session = sessionView({
        id: kind,
        project_id: null,
        kind,
        status: "idle",
        model: "model",
      } as any);
      const state = {
        ...initialState(),
        sessionId: kind,
        sessions: [session],
        hostConnection: {
          conversationId: kind,
          hostFlavor: "browser_sandbox",
          state: "ready",
          connected: true,
          catalogReady: true,
        },
      };
      return {
        flavor: session.hostFlavor ?? null,
        matched: hostReadiness(state).matched,
      };
    });
  });
  expect(result).toEqual([
    { flavor: null, matched: false },
    { flavor: null, matched: false },
  ]);
});
