import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test("server-owned Chat Only allocates no runtime, attach or detach route", async ({
  page,
}) => {
  await page.route("**/server-host-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  let assets = 0;
  await page.route("**/browser-host/**", (route) => {
    assets++;
    return route.abort();
  });
  await page.goto("/server-host-fixture");
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(path);
    const commands: string[] = [];
    const scope = {
      scope_version: 3,
      scope_kind: "conversation",
      binding_id: "b",
      backend_id: "server",
      conversation_id: "new-draft",
    };
    const client = new BrowserConversations(
      {
        base: location.origin + "/",
        command: async (method: string) => {
          commands.push(method);
          if (method !== "conversation.binding")
            throw Error("No route allocation allowed");
          return { ...scope, host_flavor: "chat_only", server_owned: true };
        },
      } as any,
      async () => {
        throw Error("No frame allowed");
      },
    );
    const first = await client.connect("new-draft", "owner", "chat_only");
    const second = await client.connect("new-draft", "owner", "chat_only");
    await client.disconnect("new-draft");
    return {
      commands,
      reused: first === second,
      host: first.host,
      serverOwned: first.serverOwned,
    };
  });
  expect(result).toEqual({
    commands: ["conversation.binding"],
    reused: true,
    host: null,
    serverOwned: true,
  });
  expect(assets).toBe(0);
});

test("secondary Sandbox attachment has no route and explicit takeover preserves workspace identity", async ({
  page,
}) => {
  const source = `export const BrowserHost={async create(options){const f=window.__hostParticipant;const host={lease:'local-lease',async descriptor(){return {host_id:'same-workspace'}},async close(){f.closes++},async handle(){f.handles++}};f.identities.push([options.browserId,options.workspaceId]);return host}};`;
  const hash = "b".repeat(64);
  await page.route("**/browser-host/current.json", (route) =>
    route.fulfill({
      json: {
        schema: 1,
        kind: "browser-host",
        wasmsh_version: "0.5.1",
        hash,
        entry: "supervisor.mjs",
        base_url: `/browser-host/${hash}/`,
        files: [
          {
            path: "supervisor.mjs",
            size: Buffer.byteLength(source),
            sha256: createHash("sha256").update(source).digest("hex"),
          },
        ],
      },
    }),
  );
  await page.route(`**/browser-host/${hash}/supervisor.mjs`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.route("**/participant-host-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto("/participant-host-fixture");
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(path);
    const f = {
      identities: [] as string[][],
      closes: 0,
      handles: 0,
      commands: [] as any[],
    };
    (window as any).__hostParticipant = f;
    const scope = {
      scope_version: 3,
      scope_kind: "conversation",
      binding_id: "b",
      backend_id: "backend",
      conversation_id: "sandbox",
    };
    const client = new BrowserConversations(
      {
        base: location.origin + "/",
        command: async (method: string, params: any) => {
          f.commands.push({ method, params });
          if (method === "conversation.binding")
            return { ...scope, host_flavor: "browser_sandbox" };
          if (method === "conversation.attach")
            return {
              scope,
              host_flavor: "browser_sandbox",
              ready: true,
              attached: params.force_takeover === true,
              connection_generation: params.force_takeover
                ? "fresh-generation"
                : null,
            };
          return {};
        },
      } as any,
      async () => {
        throw Error("unexpected frame");
      },
    );
    const participant = await client.connect(
      "sandbox",
      "owner",
      "browser_sandbox",
    );
    client.receive({
      conversation_id: "sandbox",
      connection_generation: "other-owner-generation",
      frame: {},
    });
    const reused = await client.connect("sandbox", "owner", "browser_sandbox");
    const afterSecondary = {
      closes: f.closes,
      host: participant.host,
      participant: participant.participant,
      same: participant === reused,
    };
    const executor = await client.connect(
      "sandbox",
      "owner",
      "browser_sandbox",
      true,
    );
    await client.disconnect("sandbox");
    return {
      afterSecondary,
      identities: f.identities,
      handles: f.handles,
      attaches: f.commands
        .filter((item) => item.method === "conversation.attach")
        .map((item) => item.params.force_takeover),
      detaches: f.commands.filter(
        (item) => item.method === "conversation.detach",
      ).length,
      generation: executor.generation,
    };
  });
  expect(result.afterSecondary).toEqual({
    closes: 1,
    host: null,
    participant: true,
    same: true,
  });
  expect(result.identities[0]).toEqual(result.identities[1]);
  expect(result.handles).toBe(0);
  expect(result.attaches).toEqual([false, true]);
  expect(result.detaches).toBe(1);
  expect(result.generation).toBe("fresh-generation");
});

test("retired participant cleanup cannot overwrite a replacement Sandbox route", async ({
  page,
}) => {
  const source = `export const BrowserHost={async create(){const f=window.__hostRace;const first=++f.created===1;return {lease:'lease',async descriptor(){return {host_id:'workspace'}},async close(){if(first){f.closing();await f.gate}},async handle(){}}}};`;
  const hash = "c".repeat(64);
  await page.route("**/browser-host/current.json", (route) =>
    route.fulfill({
      json: {
        schema: 1,
        kind: "browser-host",
        wasmsh_version: "0.5.1",
        hash,
        entry: "supervisor.mjs",
        base_url: `/browser-host/${hash}/`,
        files: [
          {
            path: "supervisor.mjs",
            size: Buffer.byteLength(source),
            sha256: createHash("sha256").update(source).digest("hex"),
          },
        ],
      },
    }),
  );
  await page.route(`**/browser-host/${hash}/supervisor.mjs`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.route("**/participant-race-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto("/participant-race-fixture");
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(path);
    let release!: () => void, closing!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      closing = resolve;
    });
    (window as any).__hostRace = { created: 0, gate, closing };
    const scope = {
      scope_version: 3,
      scope_kind: "conversation",
      binding_id: "b",
      conversation_id: "sandbox",
    };
    const client = new BrowserConversations(
      {
        base: location.origin + "/",
        command: async (method: string, params: any) => {
          if (method === "conversation.binding")
            return { ...scope, host_flavor: "browser_sandbox" };
          if (method === "conversation.attach")
            return {
              scope,
              host_flavor: "browser_sandbox",
              ready: true,
              attached: params.force_takeover,
              connection_generation: params.force_takeover
                ? "replacement"
                : null,
            };
          return {};
        },
      } as any,
      async () => {},
    );
    const stale = client.connect("sandbox", "owner", "browser_sandbox").then(
      () => false,
      () => true,
    );
    await closed;
    const disconnected = client.disconnect("sandbox", false);
    const replacement = await client.connect(
      "sandbox",
      "owner",
      "browser_sandbox",
      true,
    );
    release();
    await disconnected;
    const rejected = await stale;
    const current = await client.connect("sandbox", "owner", "browser_sandbox");
    await client.close();
    return {
      rejected,
      retained: current === replacement,
      generation: current.generation,
    };
  });
  expect(result).toEqual({
    rejected: true,
    retained: true,
    generation: "replacement",
  });
});
