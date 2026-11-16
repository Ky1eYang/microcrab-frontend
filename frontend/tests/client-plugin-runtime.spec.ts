import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test.setTimeout(90_000);
test.beforeEach(async ({ page }) => {
  await maintainedPluginBundle(page);
});

// These tests fetch the maintained, parent-built Rust Components. They never synthesize
// manifests or substitute a fake Worker. The content-hash index is the artifact authority.
test("real Component inspection rejects core bytes and an unsupported binary import version", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/component.ts";
    const { inspectComponent } = await import(path);
    const index = await (await fetch("/plugins/current.json")).json();
    const entry = index.plugins.find(
      (p: { id: string }) => p.id === "microcrab.state-viewer",
    );
    if (!entry)
      throw new Error(
        "parent must build/install the real State Viewer fixture",
      );
    const bytes = new Uint8Array(
      await (await fetch(`/plugins/${entry.file}`)).arrayBuffer(),
    );
    const inspected = await inspectComponent(bytes);
    const errors: string[] = [];
    try {
      await inspectComponent(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    } catch (e) {
      errors.push(String(e));
    }
    const needle = new TextEncoder().encode(
      "microcrab:client-plugin/session-state@0.4.0",
    );
    const changed = bytes.slice();
    let replaced = false;
    for (let i = 0; i <= changed.length - needle.length; i++) {
      if (needle.every((b, j) => changed[i + j] === b)) {
        changed[i + needle.length - 1] = 49;
        replaced = true;
      }
    }
    if (!replaced)
      throw new Error(
        "real State Viewer does not contain the canonical import",
      );
    try {
      await inspectComponent(changed);
    } catch (e) {
      errors.push(String(e));
    }
    return { imports: inspected.imports, errors };
  });
  expect(result.imports).toEqual([
    "microcrab:client-plugin/session-state@0.4.0",
    "microcrab:client-plugin/session-state-write@0.4.0",
    "microcrab:client-plugin/view-types@0.4.0",
  ]);
  expect(result.errors[0]).toContain("Component binary");
  expect(result.errors[1]).toContain("session-state@0.4.1");
});

test("real fixture caches structure, updates variables, preprocesses deterministically and retains failure", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `fixture-${crypto.randomUUID()}`,
    });
    try {
      await registry.initialize();
      await registry.setSession("fixture-session");
      const id = "microcrab.fixture";
      if (
        !registry
          .getSnapshot()
          .some((p: { manifest: { id: string } }) => p.manifest.id === id)
      )
        throw new Error("parent must build/install the real generic fixture");
      await registry.setEnabled(id, "fixture-session", true);
      const initial = await registry.render(id, "sidebar");
      const tree = initial.tree;
      const before = registry.getSnapshot();
      await registry.action(id, "increment");
      const incremented = registry.view(id, "sidebar");
      const sameTree = incremented.tree === tree;
      const snapshotChanged = before !== registry.getSnapshot();
      await registry.action(id, "prefix", { value: "fixture:" });
      await registry.action(id, "inject", { value: { original: 42 } });
      const transformed = await registry.beforeSubmit("original", {
        sessionId: "fixture-session",
      });
      const frozen =
        Object.isFrozen(transformed) &&
        Object.isFrozen(transformed.variables?.scoped_set?.[0]?.value);
      await registry.action(id, "reject", { value: true });
      let failure = "";
      try {
        await registry.beforeSubmit("retained draft");
      } catch (e) {
        failure = String(e);
      }
      return {
        sameTree,
        snapshotChanged,
        vars: incremented.vars,
        transformed,
        frozen,
        failure,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(result.sameTree).toBe(true);
  expect(result.snapshotChanged).toBe(true);
  expect(result.transformed.input).toBe("fixture:original");
  expect(result.transformed.variables?.scoped_set).toEqual([
    {
      name: "fixture_value",
      value: { original: 42 },
      visibility: "invisible",
      persistence: "ephemeral",
    },
  ]);
  expect(result.frozen).toBe(true);
  expect(result.failure).toContain("Fixture rejected input");
});

test("real Viewer retains a near-two-MiB invisible value through WASM completion and local reveal", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const original = "x".repeat(2 * 1024 * 1024 - 1024);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `large-values-${crypto.randomUUID()}`,
      effectHandler: async (effect: { kind: string }) => {
        if (effect.kind !== "state-inspection")
          throw new Error(`unexpected effect ${effect.kind}`);
        return {
          values: { large_value: original },
          metadata: {
            large_value: {
              visibility: "invisible",
              persistence: "ephemeral",
              owner: "client",
              editors: ["client"],
            },
          },
          descriptors: {
            large_value: {
              kind: "custom",
              editable: true,
              owner_editable: true,
              deletable: true,
            },
          },
          witness: {
            runtime_instance_id: "large-values",
            variables_revision: "0",
          },
        };
      },
    });
    try {
      await registry.initialize();
      await registry.setSession("large-values-session");
      await registry.render("microcrab.state-viewer", "sidebar");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("large real State value did not settle"));
        }, 10000);
        const inspect = () => {
          const view = registry.view("microcrab.state-viewer", "sidebar");
          if (view.status === "faulted") {
            clearTimeout(timer);
            unsubscribe();
            reject(new Error(view.error));
          } else if (view.vars.values?.large_value === original) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = registry.subscribe(inspect);
        inspect();
      });
      const before = registry.view("microcrab.state-viewer", "sidebar");
      await registry.action("microcrab.state-viewer", "toggle-invisible");
      const after = registry.view("microcrab.state-viewer", "sidebar");
      return {
        originalLength: before.vars.values.large_value.length,
        hidden: !Object.hasOwn(before.vars.display_values, "large_value"),
        originalUnchanged: after.vars.values.large_value === original,
        revealedUnchanged: after.vars.display_values.large_value === original,
        sameTree: before.tree === after.tree,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual).toEqual({
    originalLength: 2 * 1024 * 1024 - 1024,
    hidden: true,
    originalUnchanged: true,
    revealedUnchanged: true,
    sameTree: true,
  });
});

test("history reset drops delayed genuine Worker effects while fresh Viewer requests still run", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    let holding = false;
    const held: { worker: Worker; data: unknown }[] = [];
    let capturedResult: (() => void) | undefined;
    const calls: string[] = [];
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `history-effect-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        // Delay this exact guest's real transport frames. Other default plugins
        // can complete startup concurrently without satisfying this capture.
        let pluginId = "";
        worker.addEventListener("message", (event) => {
          if (event.data.type === "loaded") pluginId = event.data.manifest.id;
          if (
            pluginId !== "microcrab.state-viewer" ||
            !holding ||
            !["effect", "result"].includes(event.data.type)
          )
            return;
          event.stopImmediatePropagation();
          held.push({ worker, data: event.data });
          if (event.data.type === "result") capturedResult?.();
        });
        return worker;
      },
      effectHandler: async (effect: { kind: string }) => {
        calls.push(effect.kind);
        if (effect.kind !== "state-inspection")
          throw new Error(`unexpected effect ${effect.kind}`);
        return {
          values: { key: "current history" },
          metadata: {
            key: {
              visibility: "visible",
              persistence: "persisted",
              owner: "client",
              editors: ["client"],
            },
          },
          descriptors: {
            key: {
              kind: "custom",
              editable: true,
              owner_editable: true,
              deletable: true,
            },
          },
          witness: {
            runtime_instance_id: "history-effect",
            variables_revision: "0",
          },
        };
      },
    });
    try {
      await registry.initialize();
      await registry.setSession("history-effect-session");
      await registry.setEnabled(
        "microcrab.state-viewer",
        "history-effect-session",
        true,
      );
      const baseline = calls.length;
      holding = true;
      const captured = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("real Viewer render frames were not captured")),
          1500,
        );
        capturedResult = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      const staleRender = registry
        .render("microcrab.state-viewer", "sidebar")
        .then(
          () => "unexpectedly accepted old render",
          (error: unknown) => String(error),
        );
      await captured;
      const heldEffects = held.filter(
        (frame) => (frame.data as { type: string }).type === "effect",
      ).length;
      registry.observe("history-reset", {});
      holding = false;
      for (const frame of held)
        frame.worker.dispatchEvent(
          new MessageEvent("message", { data: frame.data }),
        );
      const staleFailure = await staleRender;
      const staleCalls = calls.length - baseline;
      const statusAfterStale = registry.view(
        "microcrab.state-viewer",
        "sidebar",
      ).status;
      await registry.render("microcrab.state-viewer", "sidebar");
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      return {
        heldEffects,
        staleFailure,
        staleCalls,
        statusAfterStale,
        freshCalls: calls.slice(baseline),
      };
    } finally {
      holding = false;
      registry.dispose();
    }
  });
  expect(result.heldEffects).toBe(1);
  expect(result.staleFailure).toContain("stale plugin call result discarded");
  expect(result.staleCalls).toBe(0);
  expect(result.statusAfterStale).toBe("ready");
  expect(result.freshCalls).toEqual(["state-inspection"]);
});

test("real Viewer requests atomic values metadata descriptors and witness with frozen Session scope", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const calls: {
      kind: string;
      session: string | null;
      frozen: boolean;
      generation: number;
      request: number;
    }[] = [];
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `viewer-${crypto.randomUUID()}`,
      effectHandler: async (e: {
        kind: string;
        sessionId: string | null;
        context: object;
        instanceGeneration: number;
        requestId: number;
      }) => {
        calls.push({
          kind: e.kind,
          session: e.sessionId,
          frozen: Object.isFrozen(e.context),
          generation: e.instanceGeneration,
          request: e.requestId,
        });
        if (e.kind === "state-inspection")
          return {
            values: {
              public: "visible value",
              private: "original secret",
              transient: { nested: true },
            },
            metadata: {
              public: {
                visibility: "visible",
                persistence: "persisted",
                owner: "client",
                editors: ["client"],
              },
              private: {
                visibility: "invisible",
                persistence: "persisted",
                owner: "client",
                editors: ["client"],
              },
              transient: {
                visibility: "invisible",
                persistence: "ephemeral",
                owner: "client",
                editors: ["client"],
              },
            },
            descriptors: Object.fromEntries(
              ["public", "private", "transient"].map((key) => [
                key,
                {
                  kind: "custom",
                  editable: true,
                  owner_editable: true,
                  deletable: true,
                },
              ]),
            ),
            witness: {
              runtime_instance_id: "owner-session",
              variables_revision: "0",
            },
          };
        throw new Error(`unexpected State Viewer capability: ${e.kind}`);
      },
    });
    try {
      await registry.initialize();
      await registry.setSession("owner-session");
      await registry.setEnabled(
        "microcrab.state-viewer",
        "owner-session",
        true,
      );
      await registry.render("microcrab.state-viewer", "sidebar");
      // Drain genuine queued event-result deliveries without guessing a timer delay.
      await registry.action("microcrab.state-viewer", "refresh");
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      return {
        calls,
        imports: registry
          .getSnapshot()
          .find(
            (p: { manifest: { id: string } }) =>
              p.manifest.id === "microcrab.state-viewer",
          )?.imports,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(
    result.calls.some(
      (e) => e.kind === "state-inspection" && e.session === "owner-session",
    ),
  ).toBe(true);
  expect(
    result.calls.some(
      (e) => e.kind === "state-inspection" && e.session === "owner-session",
    ),
  ).toBe(true);
  expect(
    result.calls.every(
      (e) => e.frozen && Number.isSafeInteger(e.request) && e.generation > 0,
    ),
  ).toBe(true);
  expect(result.imports).toEqual([
    "microcrab:client-plugin/session-state@0.4.0",
    "microcrab:client-plugin/session-state-write@0.4.0",
    "microcrab:client-plugin/view-types@0.4.0",
  ]);
});

test("enablement choices are local to owner and Session and removal survives default seeding", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const owner = `choices-${crypto.randomUUID()}`;
    const a = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    const b = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `${owner}-other`,
    });
    await a.initialize();
    await b.initialize();
    const id = "microcrab.fixture";
    await a.setSession("A");
    await a.setEnabled(id, "A", true);
    await a.setSession("B");
    const sessionB = a.isEnabled(id);
    await a.setDefaultEnabled(id, true);
    const existingSessionAfterDefault = a.isEnabled(id);
    await a.setSession("C");
    const newSessionAfterDefault = a.isEnabled(id);
    await a.setSession("A");
    const sessionA = a.isEnabled(id);
    const foreignOwner = b.isEnabled(id, "A");
    await a.remove(id);
    a.dispose();
    b.dispose();
    const restored = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    try {
      await restored.initialize();
      return {
        sessionA,
        sessionB,
        existingSessionAfterDefault,
        newSessionAfterDefault,
        foreignOwner,
        reinstalled: restored
          .getSnapshot()
          .some((p: { manifest: { id: string } }) => p.manifest.id === id),
      };
    } finally {
      restored.dispose();
    }
  });
  expect(result).toEqual({
    sessionA: true,
    sessionB: false,
    existingSessionAfterDefault: false,
    newSessionAfterDefault: true,
    foreignOwner: false,
    reinstalled: false,
  });
});

test("opaque Session IDs use own preference keys and cannot enable another owner or mutate prototypes", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const storePath = "/src/plugins/store.ts";
    const { normalizePreferences, ownRecordValue } = await import(storePath);
    const owner = `own-keys-${crypto.randomUUID()}`,
      id = "microcrab.fixture";
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    const foreign = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `${owner}-foreign`,
    });
    const sessions = ["constructor", "__proto__", "toString"];
    const foreignChoices: boolean[] = [];
    try {
      await registry.initialize();
      await foreign.initialize();
      for (const session of sessions) {
        await registry.setSession(session);
        await registry.setEnabled(id, session, true);
        foreignChoices.push(foreign.isEnabled(id, session));
      }
    } finally {
      registry.dispose();
      foreign.dispose();
    }
    const restored = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    try {
      await restored.initialize();
      const remembered = sessions.map((session) =>
        restored.isEnabled(id, session),
      );
      const normalized = normalizePreferences(
        JSON.parse(
          '{"sessions":{"constructor":{"constructor":true,"__proto__":false},"__proto__":{"constructor":false}},"tombstones":[]}',
        ),
      );
      return {
        remembered,
        foreignChoices,
        prototypeClean:
          !Object.hasOwn(Object.prototype, id) && !Object.hasOwn(Object, id),
        constructorChoice: ownRecordValue(
          ownRecordValue(normalized.sessions, "constructor"),
          "constructor",
        ),
        protoChoice: ownRecordValue(
          ownRecordValue(normalized.sessions, "__proto__"),
          "constructor",
        ),
        missingOwn:
          ownRecordValue(normalized.sessions, "toString") === undefined,
      };
    } finally {
      restored.dispose();
    }
  });
  expect(result).toEqual({
    remembered: [true, true, true],
    foreignChoices: [false, false, false],
    prototypeClean: true,
    constructorChoice: true,
    protoChoice: false,
    missingOwn: true,
  });
});

test("network adapter permits declared same-origin HTTP and bounds real WebSocket messages", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/plugin-network-proof", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "real browser fetch",
    }),
  );
  const closes: number[] = [];
  await page.routeWebSocket("wss://plugin-network.example/socket", (socket) => {
    socket.onMessage((message) => socket.send(message));
    socket.onClose((code) => {
      closes.push(code);
    });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/network.ts";
    const { PluginNetwork } = await import(path);
    let resolveMessage: (value: unknown) => void = () => {};
    const message = new Promise((resolve) => {
      resolveMessage = resolve;
    });
    const network = new PluginNetwork(
      {
        schema_version: 1,
        id: "test.network",
        name: "Network",
        version: "1",
        targets: [],
        network_origins: [location.origin, "wss://plugin-network.example"],
      },
      (_requestId: number, value: { type?: string }) => {
        if (value.type === "ws-message") resolveMessage(value);
      },
    );
    const signal = new AbortController().signal;
    try {
      const http = await network.execute(
        "http",
        { url: `${location.origin}/plugin-network-proof` },
        signal,
        1,
      );
      let denied = "";
      try {
        await network.execute(
          "http",
          { url: "https://undeclared.example/" },
          signal,
          2,
        );
      } catch (e) {
        denied = String(e);
      }
      const opened = await network.execute(
        "ws-open",
        { url: "wss://plugin-network.example/socket" },
        signal,
        3,
      );
      await network.execute(
        "ws-send",
        { handle: opened.handle, data: "echo" },
        signal,
        4,
      );
      const echo = await message;
      let quota = "";
      try {
        await network.execute(
          "ws-send",
          { handle: opened.handle, data: "x".repeat(2 * 1024 * 1024 + 1) },
          signal,
          5,
        );
      } catch (e) {
        quota = String(e);
      }
      await network.execute("ws-close", { handle: opened.handle }, signal, 6);
      return { http, denied, echo, quota };
    } finally {
      network.close();
    }
  });
  expect(result.http).toMatchObject({
    status: 200,
    body: "real browser fetch",
  });
  expect(result.denied).toContain("not declared");
  expect(result.echo).toMatchObject({ type: "ws-message", data: "echo" });
  expect(result.quota).toContain("quota");
  await expect.poll(() => closes).toContain(1000);
});

test("main-thread deadline terminates a spinning real guest while UI timers remain responsive", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `spin-${crypto.randomUUID()}`,
    });
    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats++;
    }, 25);
    try {
      await registry.initialize();
      await registry.setSession("spin-session");
      await registry.setEnabled("microcrab.fixture", "spin-session", true);
      const started = performance.now();
      let failure = "";
      try {
        await registry.action("microcrab.fixture", "spin");
      } catch (e) {
        failure = String(e);
      }
      const elapsed = performance.now() - started,
        fault = registry
          .getSnapshot()
          .find(
            (p: { manifest: { id: string } }) =>
              p.manifest.id === "microcrab.fixture",
          )?.status;
      await registry.reset("microcrab.fixture");
      await registry.action("microcrab.fixture", "increment");
      return {
        heartbeats,
        elapsed,
        failure,
        fault,
        recovered: registry.view("microcrab.fixture", "sidebar").vars.count,
      };
    } finally {
      clearInterval(timer);
      registry.dispose();
    }
  });
  expect(result.failure).toContain("deadline");
  expect(result.fault).toBe("faulted");
  expect(result.elapsed).toBeLessThan(10_000);
  expect(result.heartbeats).toBeGreaterThan(10);
  expect(result.recovered).toBe(1);
});

test("ordered logical writes overlay across plugins but ambiguous single results fail concretely", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/schema.ts";
    const { overlayVariables, variables, validateProjection, writePath } =
      await import(path);
    let change = overlayVariables(
      { remove: ["key"], set: { other: 1 } },
      {
        scoped_set: [
          {
            name: "key",
            value: "original",
            visibility: "invisible",
            persistence: "ephemeral",
          },
        ],
      },
    );
    const scoped = change;
    change = overlayVariables(change, {
      set: { key: "last" },
      remove: ["other"],
    });
    let duplicate = "";
    try {
      variables({ set: { key: 1 }, remove: ["key"] });
    } catch (e) {
      duplicate = String(e);
    }
    let invalidScope = "";
    try {
      variables({
        scoped_set: [
          {
            name: "key",
            value: 1,
            visibility: "visible",
            persistence: "ephemeral",
          },
        ],
      });
    } catch (e) {
      invalidScope = String(e);
    }
    let expanded = "";
    try {
      validateProjection(
        {
          type: "repeat",
          props: { items: { $ref: "rows" } },
          children: [{ type: "text", props: { text: { $ref: "item" } } }],
        },
        { rows: Array(2001).fill("value") },
      );
    } catch (e) {
      expanded = String(e);
    }
    let text = "";
    try {
      validateProjection(
        { type: "text", props: { text: { $ref: "value" } } },
        { value: "x".repeat(256 * 1024 + 1) },
      );
    } catch (e) {
      text = String(e);
    }
    validateProjection(
      { type: "payload", props: { value: { $ref: "value" } } },
      { value: "original".repeat(256 * 1024) },
    );
    const written = writePath(
      { rows: [{ value: "before" }] },
      "rows.0.value",
      "after",
    );
    return {
      scoped,
      final: change,
      duplicate,
      invalidScope,
      expanded,
      text,
      written,
    };
  });
  expect(result.scoped).toEqual({
    set: { other: 1 },
    scoped_set: [
      {
        name: "key",
        value: "original",
        visibility: "invisible",
        persistence: "ephemeral",
      },
    ],
  });
  expect(result.final).toEqual({ set: { key: "last" }, remove: ["other"] });
  expect(result.duplicate).toContain(
    "turn_variables.remove[0]: duplicate logical variable key",
  );
  expect(result.invalidScope).toContain("visible ephemeral");
  expect(result.expanded).toContain("2000 nodes");
  expect(result.text).toContain("256 KiB");
  expect(result.written).toEqual({ rows: [{ value: "after" }] });
});

test("IndexedDB namespaces, durable ACKs, reset and cancellation preserve quota errors", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/store.ts";
    const { PluginStore } = await import(path);
    const namespace = `storage-proof-${crypto.randomUUID()}`;
    const store = new PluginStore(namespace),
      foreign = new PluginStore(`${namespace}-other`);
    try {
      await store.writeKV("plugin-a", "key", "durable");
      const own = await store.kv("plugin-a"),
        otherPlugin = await store.kv("plugin-b"),
        otherOwner = await foreign.kv("plugin-a");
      let quota = "";
      try {
        await store.writeKV("plugin-a", "large", "x".repeat(4 * 1024 * 1024));
      } catch (e) {
        quota = String(e);
      }
      const retained = await store.kv("plugin-a");
      const controller = new AbortController();
      controller.abort();
      let cancelled = "";
      try {
        await store.writeKV(
          "plugin-a",
          "cancelled",
          "never committed",
          controller.signal,
        );
      } catch (e) {
        cancelled = String(e);
      }
      await store.clearKV("plugin-a");
      return {
        own,
        otherPlugin,
        otherOwner,
        quota,
        retained,
        cancelled,
        reset: await store.kv("plugin-a"),
      };
    } finally {
      store.close();
      foreign.close();
    }
  });
  expect(result.own).toEqual({ key: "durable" });
  expect(result.otherPlugin).toEqual({});
  expect(result.otherOwner).toEqual({});
  expect(result.quota).toContain("4 MiB");
  expect(result.retained).toEqual({ key: "durable" });
  expect(result.cancelled).toContain("cancelled");
  expect(result.reset).toEqual({});
});
