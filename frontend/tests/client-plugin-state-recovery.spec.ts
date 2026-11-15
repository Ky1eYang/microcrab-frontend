import { createHash } from "node:crypto";
import { stateInspection } from "./state-inspection-fixture";
import { expect, test, type Page, type Route } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test.setTimeout(90_000);

const deadlineError = "plugin host effect exceeded 10000ms deadline";

async function viewerOnlyBundle(page: Page) {
  const response = await page.request.get("/plugins/current.json");
  expect(response.ok(), "Build/install the real Viewer before this suite").toBe(
    true,
  );
  const index = await response.json();
  const viewer = index.plugins.find(
    (plugin: { id: string }) => plugin.id === "microcrab.state-viewer",
  );
  expect(viewer, "The bundled index must contain the real Viewer").toBeTruthy();
  // These fixtures count exact Viewer init/effect receipts. Other bundled
  // plugins own independent workers and must not enter those observations.
  // Keep the real Viewer descriptor and immutable bytes unchanged.
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({ json: { ...index, plugins: [viewer] } }),
  );
}

async function captureApplication(page: Page) {
  await viewerOnlyBundle(page);
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as RecoveryStore } from '/src/state/store.ts';
const recoveryStart = RecoveryStore.prototype.start;
RecoveryStore.prototype.start = function () { window.stateRecoveryStore = this; return recoveryStart.call(this); };
window.stateRecoveryCompletions = [];
const recoveryPost = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (data, ...rest) {
  if (data.method === 'onPhase' && data.args[0] === 'event-result')
    window.stateRecoveryCompletions.push(JSON.parse(data.args[1]));
  return recoveryPost.call(this, data, ...rest);
};
${await response.text()}`,
    });
  });
}

async function currentView(page: Page) {
  return page.evaluate(() =>
    (window as any).stateRecoveryStore.plugins.registry.view(
      "microcrab.state-viewer",
      "expanded-page",
    ),
  );
}

const metadata = {
  framework: { visibility: "visible", persistence: "persisted" },
};

test("real Viewer reports the host deadline, stops loading and recovers only on manual refresh", async ({
  page,
}) => {
  await nativeBackend(page);
  await captureApplication(page);
  await page.clock.install();
  const held: Route[] = [];
  let valuesReads = 0;
  let metadataReads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    metadataReads++;
    if (++valuesReads === 1) {
      held.push(route);
      return;
    }
    return route.fulfill({
      json: stateInspection({ framework: "fresh-after-deadline" }, metadata),
    });
  });
  await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
  const viewer = page.getByTestId("expanded-plugin-page");
  await expect.poll(() => held.length).toBe(1);
  await expect
    .poll(async () => (await currentView(page)).vars.loading)
    .toBe(true);
  // Advance only after genuine Worker imports reached the atomic inspection route. Worker
  // startup and its independent clock must not consume an artificial deadline.
  await page.clock.fastForward(10_001);
  await expect(viewer.getByText(deadlineError, { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await currentView(page)).vars.loading)
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).stateRecoveryCompletions.length),
    )
    .toBe(1);
  const failures = await page.evaluate(
    () => (window as any).stateRecoveryCompletions,
  );
  expect(
    failures.every(
      (completion: any) => !completion.ok && completion.error === deadlineError,
    ),
  ).toBe(true);
  expect(
    new Set(failures.map((completion: any) => completion.request_id)).size,
  ).toBe(1);
  const refresh = viewer.getByRole("button", { name: "刷新", exact: true });
  await expect(refresh).toBeEnabled();
  await viewer.getByRole("searchbox").fill("framework");
  // fill() settles the DOM event, not the genuine asynchronous Worker action.
  // Its derived control certifies that reply before advancing only host time.
  await expect(
    viewer.getByRole("button", { name: "清除搜索", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(10_001);
  expect([valuesReads, metadataReads]).toEqual([1, 1]);
  await refresh.click();
  await expect(
    viewer.getByText("fresh-after-deadline", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(async () => (await currentView(page)).vars.loading)
    .toBe(false);
  expect([valuesReads, metadataReads]).toEqual([2, 2]);
  // The actual bridge HTTP promises may outlive the runtime abort. Their late
  // results must not overwrite the successful manual refresh or clear its state.
  for (const route of held)
    await route.fulfill({
      json: stateInspection({ framework: "obsolete-deadline-value" }, metadata),
    });
  await page.evaluate(async () => {
    await (window as any).stateRecoveryStore.plugins.registry.action(
      "microcrab.state-viewer",
      "search",
      { value: "" },
      { surface_id: "default:expanded-page", target: "expanded-page" },
    );
  });
  await expect(
    viewer.getByText("obsolete-deadline-value", { exact: false }),
  ).toHaveCount(0);
  await expect(
    viewer.getByText("fresh-after-deadline", { exact: false }),
  ).toBeVisible();
});

test("actual Session history.reset cancels stalled Viewer reads and recovers in the same Session", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await captureApplication(page);
  const held: Route[] = [];
  let valuesReads = 0;
  let metadataReads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    metadataReads++;
    if (++valuesReads === 1) {
      held.push(route);
      return;
    }
    return route.fulfill({
      json: stateInspection({ framework: "current-history-value" }, metadata),
    });
  });
  await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
  await expect.poll(() => held.length).toBe(1);
  await expect
    .poll(async () => (await currentView(page)).vars.loading)
    .toBe(true);
  backend.event("history.reset", {
    lineage: "same-session-replacement",
    epoch: 2,
    reason: "rewritten",
  });
  const viewer = page.getByTestId("expanded-plugin-page");
  await expect(
    viewer.getByText("current-history-value", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(async () => (await currentView(page)).vars.loading)
    .toBe(false);
  expect([valuesReads, metadataReads]).toEqual([2, 2]);
  for (const route of held)
    await route.fulfill({
      json: stateInspection({ framework: "obsolete-history-value" }, metadata),
    });
  await page.evaluate(async () => {
    await (window as any).stateRecoveryStore.plugins.registry.action(
      "microcrab.state-viewer",
      "search",
      { value: "" },
      { surface_id: "default:expanded-page", target: "expanded-page" },
    );
  });
  await expect(
    viewer.getByText("obsolete-history-value", { exact: false }),
  ).toHaveCount(0);
  await expect(
    viewer.getByText("current-history-value", { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/session\/s1\/plugins\/microcrab.state-viewer$/);
});

test("history replacement during a genuine init reply retries within the same Worker", async ({
  page,
}) => {
  await nativeBackend(page);
  await viewerOnlyBundle(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    let captured!: () => void;
    const capture = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let held: { worker: Worker; data: unknown } | undefined;
    let initCalls = 0;
    let targetWorker: Worker | undefined;
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `init-history-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        const post = worker.postMessage.bind(worker);
        let firstInit: number | undefined;
        worker.postMessage = (data: any) => {
          if (
            data.method === "init" &&
            data.context.session_id === "init-history-session"
          ) {
            initCalls++;
            targetWorker = worker;
            if (initCalls === 1) firstInit = data.callId;
          }
          post(data);
        };
        worker.addEventListener("message", (event) => {
          if (event.data.type === "result" && event.data.callId === firstInit) {
            firstInit = undefined;
            event.stopImmediatePropagation();
            held = { worker, data: event.data };
            captured();
          }
        });
        return worker;
      },
      effectHandler: async () => ({
        values: { framework: "initialized-current-history" },
        metadata: {},
        descriptors: {
          framework: {
            kind: "framework",
            editable: false,
            owner_editable: false,
            deletable: false,
          },
        },
        witness: {
          runtime_instance_id: "init-history-runtime",
          variables_revision: "1",
        },
      }),
    });
    try {
      await registry.initialize();
      const starting = registry.setSession("init-history-session");
      await capture;
      registry.observe("history-reset", {});
      held!.worker.dispatchEvent(
        new MessageEvent("message", { data: held!.data }),
      );
      await starting;
      await registry.render("microcrab.state-viewer", "sidebar");
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      const view = registry.view("microcrab.state-viewer", "sidebar");
      return {
        initCalls,
        sameWorker: targetWorker === held!.worker,
        status: view.status,
        loading: view.vars.loading,
        values: view.vars.values,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(result).toEqual({
    initCalls: 2,
    sameWorker: true,
    status: "ready",
    loading: false,
    values: { framework: "initialized-current-history" },
  });
});

test("old host completions queued behind a real Worker call cannot enter replacement history", async ({
  page,
}) => {
  await nativeBackend(page);
  await viewerOnlyBundle(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    let holding = false;
    let captured!: () => void;
    const capture = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let held: { worker: Worker; data: unknown } | undefined;
    const pending: ((value: any) => void)[] = [];
    const completions: any[] = [];
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `queued-history-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (data: any) => {
          if (data.method === "onPhase" && data.args[0] === "event-result")
            completions.push(JSON.parse(data.args[1]));
          post(data);
        };
        worker.addEventListener("message", (event) => {
          if (holding && event.data.type === "result") {
            holding = false;
            event.stopImmediatePropagation();
            held = { worker, data: event.data };
            captured();
          }
        });
        return worker;
      },
      effectHandler: () => {
        if (pending.length < 1)
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        return Promise.resolve({
          values: { framework: "queued-current-history" },
          metadata: {},
          descriptors: {
            framework: {
              kind: "framework",
              editable: false,
              owner_editable: false,
              deletable: false,
            },
          },
          witness: {
            runtime_instance_id: "queued-current-runtime",
            variables_revision: "1",
          },
        });
      },
    });
    try {
      await registry.initialize();
      await registry.setSession("queued-history-session");
      await registry.render("microcrab.state-viewer", "sidebar");
      if (pending.length !== 1)
        throw new Error(
          "real Viewer did not issue one atomic State inspection",
        );
      holding = true;
      const blocked = registry
        .action("microcrab.state-viewer", "search", { value: "" })
        .catch(String);
      await capture;
      pending[0]({
        values: { framework: "queued-obsolete-history" },
        metadata: {},
        descriptors: {},
        witness: {
          runtime_instance_id: "queued-obsolete-runtime",
          variables_revision: "0",
        },
      });
      // Drain the actual host promise continuations while the genuine action
      // result is held. The old completions are now queued, not executed.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      registry.observe("history-reset", {});
      held!.worker.dispatchEvent(
        new MessageEvent("message", { data: held!.data }),
      );
      const staleAction = await blocked;
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      const view = registry.view("microcrab.state-viewer", "sidebar");
      return {
        staleAction,
        completions,
        status: view.status,
        loading: view.vars.loading,
        values: view.vars.values,
      };
    } finally {
      holding = false;
      registry.dispose();
    }
  });
  expect(result.staleAction).toContain("stale plugin call result discarded");
  expect(result.completions).toHaveLength(1);
  expect(result.completions.every((completion) => completion.ok)).toBe(true);
  expect(
    result.completions.some(
      (completion) =>
        completion.value?.values?.framework === "queued-obsolete-history",
    ),
  ).toBe(false);
  expect(result.status).toBe("ready");
  expect(result.loading).toBe(false);
  expect(result.values).toEqual({ framework: "queued-current-history" });
});

test("retired namespace imports are rejected without rewriting their supplied bytes", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/component.ts";
    const { binaryImports } = await import(path);
    // Deliberately frozen old vocabulary tests the framing rejection only.
    // This is not an archived Component or a substitute for genuine guest tests.
    const name = new TextEncoder().encode(
      "micro-crab:client-plugin/session-state@0.2.0",
    );
    const payload = [1, 0, name.length, ...name, 5, 0];
    const bytes = Uint8Array.from([
      0,
      97,
      115,
      109,
      13,
      0,
      1,
      0,
      10,
      payload.length,
      ...payload,
    ]);
    const before = Array.from(bytes);
    let error = "";
    try {
      binaryImports(bytes);
    } catch (cause) {
      error = String(cause);
    }
    return { error, before, after: Array.from(bytes) };
  });
  expect(actual.error).toContain(
    "unsupported Component import: micro-crab:client-plugin/session-state@0.2.0",
  );
  expect(actual.after).toEqual(actual.before);
});

async function bundledViewerIndexes(page: Page) {
  const response = await page.request.get("/plugins/current.json");
  expect(
    response.ok(),
    "Build/install the current real Viewer before this suite",
  ).toBe(true);
  const index = await response.json();
  const current = index.plugins.find(
    (entry: { id: string }) => entry.id === "microcrab.state-viewer",
  );
  expect(
    current,
    "The bundled index must contain the real Viewer",
  ).toBeTruthy();
  expect(
    current.supersedes ?? [],
    "Only the exact built microcrab Viewers are bundled predecessors",
  ).toEqual([
    "781d4bd5abf1708a22936060fbe4df063590e86cd50eac9f02056a7e27fa33e5",
    "2986d8730a92e2a6a48b13fa89ec56138ca5eff4a822e23ddc18505bbd9bc73f",
  ]);
  const artifact = await page.request.get(`/plugins/${current.file}`);
  expect(artifact.ok(), "The real current Viewer must be installed").toBe(true);
  const currentBytes = await artifact.body();
  expect(createHash("sha256").update(currentBytes).digest("hex")).toBe(
    current.sha256,
  );
  // A valid inert Component custom section gives the real current guest a
  // distinct test-only byte identity without changing its manifest or ABI.
  // This exercises exact-hash repair within the new namespace; it is neither
  // an archived release nor a migration of retired private component bytes.
  const name = Buffer.from("microcrab-test-predecessor");
  const payload = Buffer.concat([Buffer.from([name.length]), name]);
  const bytes = Buffer.concat([
    currentBytes,
    Buffer.from([0, payload.length]),
    payload,
  ]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const previous = {
    id: current.id,
    file: `${current.id}/${hash}/plugin.wasm`,
    sha256: hash,
    default_enabled: true,
  };
  await page.route(`**/plugins/${previous.file}`, (route) =>
    route.fulfill({ body: bytes, contentType: "application/wasm" }),
  );
  return { previous, current };
}

test("a known bundled predecessor upgrades the real Viewer while preserving preferences and KV", async ({
  page,
}) => {
  await nativeBackend(page);
  const { previous, current } = await bundledViewerIndexes(page);
  let activeIndex = { version: 1, plugins: [previous] };
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({ json: activeIndex }),
  );
  await page.goto("/");
  const owner = await page.evaluate(async (previous) => {
    const storePath = "/src/plugins/store.ts";
    const { PluginStore } = await import(storePath);
    const owner = `bundle-upgrade-${crypto.randomUUID()}`;
    const store = new PluginStore(JSON.stringify([location.origin, owner]));
    try {
      const bytes = new Uint8Array(
        await (await fetch(`/plugins/${previous.file}`)).arrayBuffer(),
      );
      await store.put({
        manifest: {
          schema_version: 1,
          id: previous.id,
          name: "State Viewer",
          version: "0.1.16",
          targets: ["sidebar", "page"],
        },
        imports: [
          "microcrab:client-plugin/session-state@0.2.0",
          "microcrab:client-plugin/session-state-write@0.2.0",
          "microcrab:client-plugin/view-types@0.2.0",
        ],
        bytes,
        enabledByDefault: false,
        priority: 7,
        status: "disabled",
      });
      await store.savePreferences({
        sessions: {
          "preserved-enabled-session": { [previous.id]: true },
          "preserved-disabled-session": { [previous.id]: false },
        },
        tombstones: [],
      });
      await store.writeKV(previous.id, "upgrade-check", "retained-owner-value");
      return owner;
    } finally {
      store.close();
    }
  }, previous);
  activeIndex = {
    version: 1,
    plugins: [{ ...current, supersedes: [previous.sha256] }],
  };
  await page.reload();
  const upgraded = await page.evaluate(async (owner) => {
    const registryPath = "/src/plugins/registry.ts";
    const storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginStore } = await import(storePath);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
      effectHandler: async () => ({
        values: { framework: "upgraded-real-viewer" },
        metadata: {},
        descriptors: {},
        witness: {
          runtime_instance_id: "upgraded-runtime",
          variables_revision: "1",
        },
      }),
    });
    const store = new PluginStore(JSON.stringify([location.origin, owner]));
    try {
      await registry.initialize();
      const plugin = registry
        .getSnapshot()
        .find((entry: any) => entry.manifest.id === "microcrab.state-viewer");
      if (!plugin) throw new Error("upgraded Viewer was not retained");
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", plugin.bytes)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const preferences = {
        enabled: registry.isEnabled(
          "microcrab.state-viewer",
          "preserved-enabled-session",
        ),
        disabled: registry.isEnabled(
          "microcrab.state-viewer",
          "preserved-disabled-session",
        ),
        defaultEnabled: plugin.enabledByDefault,
        priority: plugin.priority,
        kv: await store.kv("microcrab.state-viewer"),
      };
      await registry.setSession("preserved-enabled-session");
      await registry.render("microcrab.state-viewer", "sidebar");
      await registry.action("microcrab.state-viewer", "search", { value: "" });
      const view = registry.view("microcrab.state-viewer", "sidebar");
      return {
        hash,
        preferences,
        status: view.status,
        values: view.vars.values,
        loading: view.vars.loading,
      };
    } finally {
      registry.dispose();
      store.close();
    }
  }, owner);
  expect(upgraded.hash).toBe(current.sha256);
  expect(upgraded.preferences).toEqual({
    enabled: true,
    disabled: false,
    defaultEnabled: false,
    priority: 7,
    kv: { "upgrade-check": "retained-owner-value" },
  });
  expect(upgraded.status).toBe("ready");
  expect(upgraded.loading).toBe(false);
  expect(upgraded.values).toEqual({ framework: "upgraded-real-viewer" });
});

test("bundled repairs preserve an unlisted installed hash and never reinstall a tombstone", async ({
  page,
}) => {
  await nativeBackend(page);
  const { previous, current } = await bundledViewerIndexes(page);
  let activeIndex = { version: 1, plugins: [previous] };
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({ json: activeIndex }),
  );
  await page.goto("/");
  const owners = await page.evaluate(async (previous) => {
    const path = "/src/plugins/store.ts";
    const { PluginStore } = await import(path);
    const unknown = `unlisted-bundle-${crypto.randomUUID()}`;
    const removed = `removed-bundle-${crypto.randomUUID()}`;
    const bytes = new Uint8Array(
      await (await fetch(`/plugins/${previous.file}`)).arrayBuffer(),
    );
    for (const owner of [unknown, removed]) {
      const store = new PluginStore(JSON.stringify([location.origin, owner]));
      try {
        if (owner === unknown) {
          await store.put({
            manifest: {
              schema_version: 1,
              id: previous.id,
              name: "State Viewer",
              version: "0.1.16",
              targets: ["sidebar", "page"],
            },
            imports: [
              "microcrab:client-plugin/session-state@0.2.0",
              "microcrab:client-plugin/session-state-write@0.2.0",
              "microcrab:client-plugin/view-types@0.2.0",
            ],
            bytes,
            enabledByDefault: false,
            priority: 0,
            status: "disabled",
          });
        }
        await store.savePreferences({
          sessions: {},
          tombstones: owner === removed ? [previous.id] : [],
        });
      } finally {
        store.close();
      }
    }
    return { unknown, removed };
  }, previous);
  activeIndex = {
    version: 1,
    plugins: [{ ...current, supersedes: ["0".repeat(64)] }],
  };
  await page.reload();
  const unlistedHash = await page.evaluate(async (owner) => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    try {
      await registry.initialize();
      const plugin = registry
        .getSnapshot()
        .find((entry: any) => entry.manifest.id === "microcrab.state-viewer");
      if (!plugin) throw new Error("unlisted user component was removed");
      return [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", plugin.bytes)),
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } finally {
      registry.dispose();
    }
  }, owners.unknown);
  expect(unlistedHash).toBe(previous.sha256);
  activeIndex = {
    version: 1,
    plugins: [{ ...current, supersedes: [previous.sha256] }],
  };
  const reinstalled = await page.evaluate(async (owner) => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    try {
      await registry.initialize();
      return registry
        .getSnapshot()
        .some((entry: any) => entry.manifest.id === "microcrab.state-viewer");
    } finally {
      registry.dispose();
    }
  }, owners.removed);
  expect(reinstalled).toBe(false);
});

test("bundled supersedes lists reject malformed or excessive predecessor hashes", async ({
  page,
}) => {
  await nativeBackend(page);
  const { current } = await bundledViewerIndexes(page);
  let supersedes: unknown;
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: { version: 1, plugins: [{ ...current, supersedes }] },
    }),
  );
  await page.goto("/");
  for (const invalid of [
    "not-an-array",
    ["INVALID"],
    [7],
    Array(17).fill("a".repeat(64)),
  ]) {
    supersedes = invalid;
    const installed = await page.evaluate(async () => {
      const path = "/src/plugins/registry.ts";
      const { PluginRegistry } = await import(path);
      const registry = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId: `invalid-upgrade-${crypto.randomUUID()}`,
      });
      try {
        await registry.initialize();
        return registry.getSnapshot().length;
      } finally {
        registry.dispose();
      }
    });
    expect(installed).toBe(0);
  }
});
