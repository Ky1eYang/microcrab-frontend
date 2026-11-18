import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("artifact reference bindings are immutable, isolated and atomically tombstone collisions", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/store.ts";
    const { PluginStore } = await import(path);
    const namespace = `artifact-references-${crypto.randomUUID()}`;
    const first = new PluginStore(namespace);
    const second = new PluginStore(namespace);
    const prefix = "0123456789abcdef";
    const a = prefix + "a".repeat(48);
    const b = prefix + "b".repeat(48);
    const failure = async (work: Promise<unknown>) => {
      try {
        await work;
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    };
    try {
      const initial = await first.registerArtifactReference("example.tools", a);
      const same = await second.registerArtifactReference("example.tools", a);
      const resolved = await second.resolveArtifactReference(
        "example.tools",
        prefix,
      );
      const registrations = await Promise.all([
        first.registerArtifactReference("racing.tools", a),
        second.registerArtifactReference("racing.tools", b),
      ]);
      const race = await failure(
        first.resolveArtifactReference("racing.tools", prefix),
      );
      const collision = await second.registerArtifactReference(
        "example.tools",
        b,
      );
      const cannotReassign = await first.registerArtifactReference(
        "example.tools",
        a,
      );
      await first.clearKV("example.tools");
      await first.remove("example.tools");
      const afterRemoval = await failure(
        second.resolveArtifactReference("example.tools", prefix),
      );
      const otherId = await first.registerArtifactReference("other.tools", a);
      const isolated = await first.resolveArtifactReference(
        "other.tools",
        prefix,
      );
      const missing = await failure(
        first.resolveArtifactReference("missing.tools", prefix),
      );
      first.close();
      const reloaded = new PluginStore(namespace);
      const afterReload = await failure(
        reloaded.resolveArtifactReference("example.tools", prefix),
      );
      const stillAmbiguous = await reloaded.registerArtifactReference(
        "example.tools",
        b,
      );
      reloaded.close();
      const otherOwner = new PluginStore(`${namespace}-other-owner`);
      const otherOwnerMissing = await failure(
        otherOwner.resolveArtifactReference("other.tools", prefix),
      );
      otherOwner.close();
      return {
        initial,
        same,
        resolved,
        registrations,
        race,
        collision,
        cannotReassign,
        afterRemoval,
        otherId,
        isolated,
        missing,
        afterReload,
        stillAmbiguous,
        otherOwnerMissing,
        a,
      };
    } finally {
      first.close();
      second.close();
    }
  });
  expect(actual.initial).toBe(true);
  expect(actual.same).toBe(true);
  expect(actual.resolved).toBe(actual.a);
  expect(actual.registrations.filter(Boolean)).toHaveLength(1);
  expect(actual.race).toContain("ambiguous");
  expect(actual.collision).toBe(false);
  expect(actual.cannotReassign).toBe(false);
  expect(actual.afterRemoval).toContain("ambiguous");
  expect(actual.afterReload).toContain("ambiguous");
  expect(actual.stillAmbiguous).toBe(false);
  expect(actual.otherId).toBe(true);
  expect(actual.isolated).toBe(actual.a);
  expect(actual.missing).toContain("unknown");
  expect(actual.otherOwnerMissing).toContain("unknown");
});

test("artifact reference storage rejects corruption and exhaustion without evicting bindings", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/store.ts";
    const { PluginStore } = await import(path);
    const namespace = `artifact-reference-bounds-${crypto.randomUUID()}`;
    const store = new PluginStore(namespace);
    const artifact = "a".repeat(64),
      prefix = artifact.slice(0, 16);
    const failure = async (work: Promise<unknown>) => {
      try {
        await work;
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    };
    const save = async (value: unknown) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(
          `microcrab.client-plugins.v1:${namespace}`,
          1,
        );
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("settings", "readwrite");
          tx.objectStore("settings").put(value, "artifact-references.v1");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    try {
      await store.registerArtifactReference("existing.tools", artifact);
      const corruptions = [
        null,
        [],
        "broken",
        { bad: artifact },
        { [`existing.tools:${prefix}`]: "b".repeat(64) },
      ];
      const corrupted = [];
      for (const value of corruptions) {
        await save(value);
        corrupted.push(
          await failure(
            store.resolveArtifactReference("existing.tools", prefix),
          ),
        );
        corrupted.push(
          await failure(
            store.registerArtifactReference("existing.tools", artifact),
          ),
        );
      }
      const full = Object.fromEntries(
        Array.from({ length: 8192 }, (_, i) => [
          `capacity.${i}:${prefix}`,
          artifact,
        ]),
      );
      await save(full);
      const exhausted = await failure(
        store.registerArtifactReference("overflow.tools", artifact),
      );
      const retained = await store.resolveArtifactReference(
        "capacity.0",
        prefix,
      );
      const repeated = await store.registerArtifactReference(
        "capacity.0",
        artifact,
      );
      const collisionAtCapacity = await store.registerArtifactReference(
        "capacity.0",
        prefix + "b".repeat(48),
      );
      const tombstone = await failure(
        store.resolveArtifactReference("capacity.0", prefix),
      );
      const unavailable = new PluginStore(`${namespace}-unavailable`);
      unavailable.open = async () => {
        throw Error("IndexedDB unavailable for artifact references");
      };
      const storageFailure = await failure(
        unavailable.registerArtifactReference("example.tools", artifact),
      );
      return {
        corrupted,
        exhausted,
        retained,
        repeated,
        collisionAtCapacity,
        tombstone,
        storageFailure,
        artifact,
      };
    } finally {
      store.close();
    }
  });
  expect(actual.corrupted).toHaveLength(10);
  for (const error of actual.corrupted)
    expect(error).toContain("Invalid plugin artifact reference storage");
  expect(actual.exhausted).toContain("8192");
  expect(actual.retained).toBe(actual.artifact);
  expect(actual.repeated).toBe(true);
  expect(actual.collisionAtCapacity).toBe(false);
  expect(actual.tombstone).toContain("ambiguous");
  expect(actual.storageFailure).toContain("IndexedDB unavailable");
});

test("real worker receives canonical artifact identities while short discovery fences replacements and collisions", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(registryPath);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: crypto.randomUUID(),
    });
    const id = "microcrab.mcp-bridge",
      session = "artifact-reference-worker";
    const captured: {
      request: Record<string, unknown>;
      identity: Record<string, unknown>;
    }[] = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
      if (message.type === "call" && message.method === "startTool") {
        captured.push({
          request: JSON.parse(message.args[0]),
          identity: JSON.parse(message.args[1]).tool_invocation,
        });
      }
      return originalPostMessage.call(this, message, ...(rest as [any]));
    };
    const run = (artifact: string) =>
      registry.executeTool(
        Object.freeze({ plugin: id, artifact, action: "list" }),
        {
          invocation_id: crypto.randomUUID(),
          session_id: session,
          parent_session_id: session,
          call_id: crypto.randomUUID(),
          catalog_digest: "artifact-reference-catalog",
          epoch: 1,
          turn_id: 1,
          round_id: 1,
          deadline_ms: 0,
        },
        new AbortController().signal,
      );
    const failure = async (work: Promise<unknown>) => {
      try {
        await work;
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    };
    try {
      await registry.initialize();
      await registry.setSession(session);
      await registry.setEnabled(id, session, true);
      const before = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id);
      if (!before?.artifact)
        throw Error(
          "Build/install the maintained MCP component before this suite",
        );
      const advertised = registry
        .toolInventory()
        .find((p: any) => p.id === id).artifact;
      const unknownReference =
        (advertised[0] === "0" ? "1" : "0") + advertised.slice(1);
      const unknown = await failure(run(unknownReference));
      const inventoryAfterUnknown = registry.toolInventory();
      await run(advertised);
      await run(before.artifact);
      await registry.restart(id);
      await run(advertised);
      const shortBefore = captured.slice();
      const name = new TextEncoder().encode(
        "microcrab-artifact-reference-test",
      );
      const bytes = new Uint8Array(before.bytes.length + name.length + 3);
      bytes.set(before.bytes);
      bytes.set([0, name.length + 1, name.length], before.bytes.length);
      bytes.set(name, before.bytes.length + 3);
      await registry.importPlugin(bytes, { replace: true, expectedId: id });
      const after = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id);
      const oldShort = await failure(run(advertised));
      const oldFull = await failure(run(before.artifact));
      const newShort = registry
        .toolInventory()
        .find((p: any) => p.id === id).artifact;
      await run(newShort);
      const store = registry.store;
      const resolveReference = store.resolveArtifactReference.bind(store);
      let release!: (artifact: string) => void;
      store.resolveArtifactReference = () =>
        new Promise<string>((resolve) => {
          release = resolve;
        });
      const pending = failure(run(newShort));
      await registry.restart(id);
      release(after.artifact);
      const changedWhileReading = await pending;
      store.resolveArtifactReference = resolveReference;
      const beforeCollisionCount = captured.length;
      // Fabricated SHA identities exercise a collision without brute-forcing WASM.
      const last = after.artifact.endsWith("0") ? "1" : "0";
      await store.registerArtifactReference(
        id,
        after.artifact.slice(0, -1) + last,
      );
      const crossTabCollision = await failure(run(newShort));
      const afterCollisionCount = captured.length;
      await registry.restart(id);
      const inventoryAfterCollision = registry.toolInventory();
      const collisionDiagnostic = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id).error;
      const statusAfterCollision = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id).status;
      await run(after.artifact);
      const fullAfterCollision = captured.at(-1);
      const beforeStorageFailureCount = captured.length;
      store.resolveArtifactReference = async () => {
        throw Error("Artifact reference storage unavailable");
      };
      const storageFailure = await failure(run(newShort));
      const afterStorageFailureCount = captured.length;
      store.resolveArtifactReference = resolveReference;
      return {
        before: before.artifact,
        after: after.artifact,
        advertised,
        unknown,
        inventoryAfterUnknown,
        newShort,
        shortBefore,
        oldShort,
        oldFull,
        changedWhileReading,
        crossTabCollision,
        beforeCollisionCount,
        afterCollisionCount,
        inventoryAfterCollision,
        collisionDiagnostic,
        statusAfterCollision,
        fullAfterCollision,
        storageFailure,
        beforeStorageFailureCount,
        afterStorageFailureCount,
      };
    } finally {
      Worker.prototype.postMessage = originalPostMessage;
      registry.dispose();
    }
  });
  expect(actual.advertised).toBe(actual.before.slice(0, 16));
  expect(actual.unknown).toContain("unknown");
  expect(actual.inventoryAfterUnknown).toContainEqual(
    expect.objectContaining({
      id: "microcrab.mcp-bridge",
      artifact: actual.advertised,
    }),
  );
  expect(actual.newShort).toBe(actual.after.slice(0, 16));
  expect(actual.before).not.toBe(actual.after);
  expect(actual.shortBefore).toHaveLength(3);
  for (const call of actual.shortBefore) {
    expect(call.request.artifact).toBe(actual.before);
    expect(call.identity.artifact).toBe(actual.before);
  }
  expect(actual.oldShort).toContain("artifact is unavailable or changed");
  expect(actual.oldFull).toContain("artifact is unavailable or changed");
  expect(actual.changedWhileReading).toContain(
    "artifact is unavailable or changed",
  );
  expect(actual.crossTabCollision).toContain("ambiguous");
  expect(actual.afterCollisionCount).toBe(actual.beforeCollisionCount);
  expect(
    actual.inventoryAfterCollision.some(
      (p: any) => p.id === "microcrab.mcp-bridge",
    ),
  ).toBe(false);
  expect(actual.collisionDiagnostic).toContain("ambiguous");
  expect(actual.statusAfterCollision).toBe("ready");
  expect(actual.fullAfterCollision?.request.artifact).toBe(actual.after);
  expect(actual.fullAfterCollision?.identity.artifact).toBe(actual.after);
  expect(actual.storageFailure).toContain("storage unavailable");
  expect(actual.afterStorageFailureCount).toBe(
    actual.beforeStorageFailureCount,
  );
});

test("inventory preserves old short and legacy frozen schemas while new catalogs use short references", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const pluginsPath = "/src/state/client-plugins.ts";
    const modelPath = "/src/state/model.ts";
    const hubPath = "/src/plugins/tool-hub.ts";
    const { ClientPlugins } = await import(pluginsPath);
    const { initialState } = await import(modelPath);
    const { PLUGIN_META_TOOL_DEFINITION } = await import(hubPath);
    const fixturePath = "/tests/plugin-short-schema-fixture.ts";
    const { previousShortArtifactSchema } = await import(fixturePath);
    const plugins = new ClientPlugins(() => {
      throw Error("No API calls expected");
    });
    const state = initialState();
    const owner = crypto.randomUUID(),
      id = "example.tools",
      full = "a".repeat(64);
    state.sessionId = "frozen-artifact-catalog";
    state.authRequired = false;
    state.authSession = { authenticated: true, principal: { owner } };
    // Supply only registry observations; real sync chooses representation from the
    // selected Session's actual binding definitions, never a test capability flag.
    plugins.scope = JSON.stringify([state.apiBase, owner]);
    plugins.registry = {
      toolInventory: () => [
        {
          id,
          artifact: full.slice(0, 16),
          name: "Example",
          version: "1",
          description: "Tools",
        },
      ],
      getSnapshot: () => [{ manifest: { id }, artifact: full }],
      setEnvironment() {},
      observe() {},
      setSession: async () => {},
      beforeSubmit: async (input: string) => ({ input }),
      dispose() {},
    };
    const legacy = structuredClone(PLUGIN_META_TOOL_DEFINITION);
    legacy.parameters = structuredClone(previousShortArtifactSchema);
    legacy.parameters.properties.artifact.pattern = "^[a-f0-9]{64}$";
    state.clientTools = {
      definitions: [legacy],
      catalog_digest: "frozen-legacy",
      calls: [],
      pending: [],
      role: "executor",
    };
    const originalCatalog = structuredClone(state.clientTools);
    const input = { parts: [{ type: "text", text: "original" }] };
    try {
      plugins.sync(state);
      const old = await plugins.preprocess(
        input,
        "old-operation",
        state.sessionId,
        () => true,
      );
      const unchangedCatalog =
        JSON.stringify(state.clientTools) === JSON.stringify(originalCatalog);
      state.clientTools = {
        ...state.clientTools,
        catalog_digest: "frozen-prior-short",
        definitions: [
          {
            ...PLUGIN_META_TOOL_DEFINITION,
            parameters: structuredClone(previousShortArtifactSchema),
          },
        ],
      };
      const priorCatalog = JSON.stringify(state.clientTools);
      plugins.sync(state);
      const priorShort = await plugins.preprocess(
        input,
        "prior-short-operation",
        state.sessionId,
        () => true,
      );
      const unchangedPriorCatalog =
        JSON.stringify(state.clientTools) === priorCatalog;
      const unknownSchema = structuredClone(previousShortArtifactSchema);
      unknownSchema.additionalProperties = true;
      state.clientTools = {
        ...state.clientTools,
        catalog_digest: "unknown-modified-short",
        definitions: [
          { ...PLUGIN_META_TOOL_DEFINITION, parameters: unknownSchema },
        ],
      };
      plugins.sync(state);
      const modifiedUnknown = await plugins.preprocess(
        input,
        "modified-unknown-operation",
        state.sessionId,
        () => true,
      );
      const preparedPriorShort = await plugins.preprocess(
        input,
        "prior-short-operation",
        state.sessionId,
        () => true,
      );
      state.clientTools = {
        ...state.clientTools,
        catalog_digest: "explicit-new-catalog",
        definitions: [PLUGIN_META_TOOL_DEFINITION],
      };
      plugins.sync(state);
      const frozenOld = await plugins.preprocess(
        input,
        "old-operation",
        state.sessionId,
        () => true,
      );
      const current = await plugins.preprocess(
        input,
        "new-operation",
        state.sessionId,
        () => true,
      );
      state.clientTools = null;
      plugins.sync(state);
      const unknown = await plugins.preprocess(
        input,
        "unknown-catalog",
        state.sessionId,
        () => true,
      );
      state.sessionId = null;
      plugins.sync(state);
      const draft = await plugins.preprocess(
        input,
        "draft-operation",
        "draft",
        () => true,
      );
      return {
        old,
        priorShort,
        preparedPriorShort,
        modifiedUnknown,
        unchangedPriorCatalog,
        frozenOld,
        current,
        unknown,
        draft,
        unchangedCatalog,
        full,
      };
    } finally {
      plugins.dispose();
    }
  });
  const artifact = (input: any) =>
    input.variables.scoped_set.find((entry: any) => entry.name === "plugins")
      .value[0].artifact;
  expect(artifact(actual.old)).toBe(actual.full);
  expect(actual.frozenOld).toEqual(actual.old);
  expect(artifact(actual.priorShort)).toBe(actual.full.slice(0, 16));
  expect(actual.preparedPriorShort).toEqual(actual.priorShort);
  expect(artifact(actual.modifiedUnknown)).toBe(actual.full);
  expect(actual.unchangedPriorCatalog).toBe(true);
  expect(artifact(actual.current)).toBe(actual.full.slice(0, 16));
  expect(artifact(actual.unknown)).toBe(actual.full);
  expect(artifact(actual.draft)).toBe(actual.full.slice(0, 16));
  expect(actual.unchangedCatalog).toBe(true);
});
