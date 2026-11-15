import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const runtimeSource = `export const BrowserHost = {
  async create(options) {
    const fixture = window.hostRace;
    const index = fixture.hosts.length;
    const host = {
      lease: 'lease-' + index, closes: 0,
      async descriptor() {
        if (index === 0) {
          fixture.descriptorEntered.resolve();
          await fixture.descriptorGate.promise;
        }
        return { host_id: 'host-' + index };
      },
      onFrame: options.onFrame,
      async close() { this.closes++; },
      async handle(...args) { if (fixture.handle) await fixture.handle(...args); },
    };
    fixture.hosts.push(host);
    return host;
  }
};`;

async function mount(page: Page, pause: "descriptor" | "attach") {
  const hash = "a".repeat(64);
  await page.route("**/browser-host/current.json", (route) =>
    route.fulfill({ json: {
      schema: 1, kind: "browser-host", wasmsh_version: "0.5.1", hash,
      entry: "supervisor.mjs", base_url: `/browser-host/${hash}/`,
      files: [{ path: "supervisor.mjs", size: Buffer.byteLength(runtimeSource),
        sha256: createHash("sha256").update(runtimeSource).digest("hex") }],
    } }),
  );
  await page.route(`**/browser-host/${hash}/supervisor.mjs`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: runtimeSource }),
  );
  await page.route("**/browser-host-race-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<html><body></body></html>' }),
  );
  await page.goto("/browser-host-race-fixture");
  await page.evaluate(async (pause) => {
    const modulePath = "/src/client/browser-host.ts";
    const { BrowserConversations } = await import(modulePath);
    function gate() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }
    const scope = { scope_version: 3, scope_kind: "conversation", binding_id: "binding",
      backend_id: "backend", conversation_id: "conversation", host_flavor: "browser_sandbox" };
    const fixture: any = {
      hosts: [], attaches: [], descriptorEntered: gate(), descriptorGate: gate(),
      attachEntered: gate(), attachGate: gate(),
    };
    (window as any).hostRace = fixture;
    const api: any = { base: location.origin + "/", async command(method: string, params: any) {
      if (method === "conversation.binding") return scope;
      if (method !== "conversation.attach") throw Error(method);
      fixture.attaches.push(params.descriptor.host_id);
      if (params.descriptor.host_id === "host-0" && pause === "attach") {
        fixture.attachEntered.resolve();
        await fixture.attachGate.promise;
      }
      return { ready: true, scope, host_flavor: "browser_sandbox", connection_generation: params.descriptor.host_id };
    } };
    fixture.frames = [];
    fixture.conversations = new BrowserConversations(api, async (frame: unknown) => {
      fixture.frames.push(frame);
      if (fixture.send) await fixture.send();
    });
    // Handle rejection immediately so the intentional stale open never becomes
    // an unhandled browser rejection while its replacement is being prepared.
    fixture.old = fixture.conversations.connect("conversation", "owner", "browser_sandbox").then(
      () => "ready", () => "stale",
    );
    await fixture.descriptorEntered.promise;
    if (pause === "attach") {
      fixture.descriptorGate.resolve();
      await fixture.attachEntered.promise;
    }
  }, pause);
}

for (const pause of ["descriptor", "attach"] as const) {
  test(`closed browser Host cannot resume after ${pause} await or close its replacement`, async ({ page }) => {
    await mount(page, pause);
    const result = await page.evaluate(async () => {
      const fixture = (window as any).hostRace;
      await fixture.conversations.close();
      const replacement = await fixture.conversations.connect("conversation", "owner", "browser_sandbox");
      fixture.descriptorGate.resolve();
      fixture.attachGate.resolve();
      const old = await fixture.old;
      const current = await fixture.conversations.connect("conversation", "owner", "browser_sandbox");
      return { old, attaches: fixture.attaches, replacementRetained: current === replacement,
        replacementGeneration: current.generation, closes: fixture.hosts.map((host: any) => host.closes) };
    });
    expect(result.old).toBe("stale");
    expect(result.attaches).toEqual(pause === "descriptor" ? ["host-1"] : ["host-0", "host-1"]);
    expect(result.replacementRetained).toBe(true);
    expect(result.replacementGeneration).toBe("host-1");
    expect(result.closes[0]).toBeGreaterThanOrEqual(1);
    expect(result.closes[1]).toBe(0);
  });
}

for (const boundary of ["spontaneous", "send-failure", "handle-failure", "handle-reply"] as const) {
  test(`retired Host ${boundary} callback cannot borrow or close its replacement`, async ({ page }) => {
    await mount(page, "descriptor");
    const result = await page.evaluate(async (boundary) => {
      const fixture = (window as any).hostRace;
      fixture.descriptorGate.resolve();
      await fixture.old;
      const oldHost = fixture.hosts[0];
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      if (boundary === "send-failure") {
        fixture.send = async () => { entered(); await gate; throw Error("old send failed"); };
        oldHost.onFrame({ old: true });
        await started;
      } else if (boundary.startsWith("handle-")) {
        fixture.handle = async (_frame: unknown, _scope: unknown, send: (value: unknown) => Promise<void>) => {
          entered();
          await gate;
          if (boundary === "handle-failure") throw Error("old handler failed");
          await send({ oldReply: true });
        };
        fixture.conversations.receive({ conversation_id: "conversation", connection_generation: "host-0", frame: {} });
        await started;
      }
      await fixture.conversations.close();
      const replacement = await fixture.conversations.connect("conversation", "owner", "browser_sandbox");
      if (boundary === "spontaneous") oldHost.onFrame({ late: true });
      release();
      // Finish the actual async reply/rejection handlers before observing the
      // replacement, using an event-loop checkpoint instead of a race delay.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const current = await fixture.conversations.connect("conversation", "owner", "browser_sandbox");
      return { retained: current === replacement, frames: fixture.frames,
        replacementCloses: fixture.hosts[1].closes, generation: current.generation };
    }, boundary);
    expect(result.retained).toBe(true);
    expect(result.replacementCloses).toBe(0);
    expect(result.generation).toBe("host-1");
    expect(result.frames).toEqual(boundary === "send-failure" ? [{
      lane: "conversation_host", conversation_id: "conversation", connection_generation: "host-0", frame: { old: true },
    }] : []);
  });
}
