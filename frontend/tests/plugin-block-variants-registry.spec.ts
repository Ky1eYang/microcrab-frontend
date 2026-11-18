import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.route("**/block-variants-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Block variants</title>",
    }),
  );
  await page.goto("/block-variants-fixture");
  await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts",
      schemaPath = "/src/plugins/schema.ts";
    const { PluginRegistry } = await import(registryPath);
    const { result, validateBlockTextVariant } = await import(schemaPath);
    (window as any).variantFixture = () => {
      const registry: any = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId: "variant-regression",
      });
      const id = "variant.fixture";
      const events: any[] = [];
      const addPlugin = (pluginId = id) => {
        registry.plugins.set(pluginId, {
          manifest: {
            id: pluginId,
            name: pluginId,
            targets: ["block-slot", "sidebar"],
          },
          imports: ["microcrab:client-plugin/conversation@0.4.0"],
          status: "ready",
          priority: 0,
          enabledByDefault: true,
        });
        const instance: any = {
          generation: 1,
          vars: { count: 1 },
          trees: new Map(),
          surfaces: new Map(),
          controllers: new Map(),
          surfaceSequence: 0,
          queue: Promise.resolve(),
          queued: 0,
          eventTimes: [],
          renderTimes: [],
          worker: { terminate: () => events.push(["terminate", pluginId]) },
          network: {
            retireStale: () => {},
            close: () => events.push(["network-close", pluginId]),
          },
          resources: { close: () => {}, retireRequests: () => {} },
        };
        registry.live.set(pluginId, instance);
        return instance;
      };
      const instance = addPlugin();
      const source = (patch = {}) => ({
        block_id: "b",
        kind: "text",
        role: "assistant",
        text: "Original prose",
        source_digest: "a".repeat(64),
        history_revision: "revision-1",
        ...patch,
      });
      const variant = (patch = {}) => ({
        block_id: "b",
        variant_id: "translation",
        source_digest: "a".repeat(64),
        history_revision: "revision-1",
        label: "Translation",
        status: "completed",
        text: "Translated prose",
        default_display: "inline",
        ...patch,
      });
      const parse = (patch: any) =>
        result(JSON.stringify({ schema_version: 1, ...patch }));
      const apply = (patch: any, pluginId = id) =>
        registry.apply(pluginId, registry.live.get(pluginId), parse(patch));
      const rejects = (work: () => unknown) => {
        try {
          work();
          return false;
        } catch {
          return true;
        }
      };
      const mount = (pluginId = id) => {
        const descriptor = {
          surface_id: `variant:${pluginId}`,
          target: "block-slot",
          block_id: "b",
          slot_id: "translation",
        };
        registry.setSurfaceVisible(pluginId, descriptor, true);
        const live = registry.live.get(pluginId),
          controller = new AbortController();
        live.controllers.set(controller, descriptor.surface_id);
        live.trees.set(descriptor.surface_id, {
          mode: "native-json",
          content: "",
          tree: null,
        });
        return { descriptor, controller };
      };
      registry.rememberSettled(source());
      return {
        registry,
        id,
        instance,
        events,
        addPlugin,
        source,
        variant,
        parse,
        apply,
        rejects,
        mount,
        validateBlockTextVariant,
      };
    };
  });
}

test.beforeEach(async ({ page }) => setup(page));

test("schema enforces state-specific text, reason and error without accepting extra fields", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    const valid = [
      f.variant(),
      f.variant({ status: "pending", text: "" }),
      f.variant({ status: "cancelled", text: "" }),
      f.variant({ status: "skipped", text: "", reason: "same_language" }),
      f.variant({ status: "skipped", text: "", reason: "no_prose" }),
      f.variant({ status: "skipped", text: "", reason: "unchanged" }),
      f.variant({
        status: "error",
        text: "",
        error: "Provider rejected request",
      }),
    ];
    const invalid = [
      f.variant({ pluginId: "other" }),
      f.variant({ text: "" }),
      f.variant({ status: "pending" }),
      f.variant({ status: "skipped", text: "" }),
      f.variant({ reason: "unchanged" }),
      f.variant({ status: "error", text: "", error: "" }),
      f.variant({ error: "Unexpected" }),
      f.variant({ status: ["completed"] }),
      f.variant({ default_display: "replace" }),
      f.variant({ source_digest: "a".repeat(63) }),
      f.variant({ history_revision: "" }),
      f.variant({ retry_action: "" }),
      f.variant({ force_action: 1 }),
    ];
    return {
      valid: valid.map(
        (v: any) => !f.rejects(() => f.validateBlockTextVariant(v)),
      ),
      invalid: invalid.map((v: any) =>
        f.rejects(() => f.parse({ block_variants: [v] })),
      ),
    };
  });
  expect(actual.valid).toEqual(Array(7).fill(true));
  expect(actual.invalid).toEqual(Array(13).fill(true));
});

test("schema measures UTF-8 byte boundaries and bounds unique upsert/removal batches", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    const checks = [
      !f.rejects(() =>
        f.parse({ block_variants: [f.variant({ text: "é".repeat(16384) })] }),
      ),
      f.rejects(() =>
        f.parse({ block_variants: [f.variant({ text: "é".repeat(16385) })] }),
      ),
      !f.rejects(() =>
        f.parse({ block_variants: [f.variant({ label: "é".repeat(128) })] }),
      ),
      f.rejects(() =>
        f.parse({ block_variants: [f.variant({ label: "é".repeat(129) })] }),
      ),
      f.rejects(() =>
        f.parse({
          block_variants: [f.variant({ history_revision: "中".repeat(342) })],
        }),
      ),
      f.rejects(() =>
        f.parse({
          block_variants: [
            f.variant({ status: "error", text: "", error: "é".repeat(2049) }),
          ],
        }),
      ),
      f.rejects(() => f.parse({ block_variants: [f.variant(), f.variant()] })),
      !f.rejects(() =>
        f.parse({
          block_variants: Array.from({ length: 128 }, (_, i) =>
            f.variant({ variant_id: String(i) }),
          ),
        }),
      ),
      f.rejects(() =>
        f.parse({
          block_variants: Array.from({ length: 129 }, (_, i) =>
            f.variant({ variant_id: String(i) }),
          ),
        }),
      ),
      f.rejects(() =>
        f.parse({
          remove_block_variants: [
            { block_id: "b", variant_id: "translation", pluginId: "other" },
          ],
        }),
      ),
      f.rejects(() =>
        f.parse({
          remove_block_variants: [
            { block_id: "b", variant_id: "translation" },
            { block_id: "b", variant_id: "translation" },
          ],
        }),
      ),
      f.rejects(() =>
        f.parse({
          remove_block_variants: Array.from({ length: 129 }, (_, i) => ({
            block_id: "b",
            variant_id: String(i),
          })),
        }),
      ),
    ];
    return checks;
  });
  expect(actual).toEqual(Array(12).fill(true));
});

test("admission requires exact digest/history and untruncated settled assistant text", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    const mismatches = [
      { source_digest: "b".repeat(64) },
      { history_revision: "revision-2" },
      { block_id: "unknown" },
    ];
    const rejected = mismatches.map((patch) =>
      f.rejects(() => f.apply({ block_variants: [f.variant(patch)] })),
    );
    for (const patch of [
      { role: "user" },
      { kind: "reasoning" },
      { text_truncated: true },
      { text: "" },
    ]) {
      f.registry.rememberSettled(f.source(patch));
      rejected.push(
        f.rejects(() => f.apply({ block_variants: [f.variant()] })),
      );
    }
    f.registry.rememberSettled(f.source());
    f.apply({ block_variants: [f.variant()] });
    const matching = f.registry.getBlockVariants("b", "Original prose").length;
    const mismatched = f.registry.getBlockVariants("b", "Changed prose").length;
    f.registry.plugins.get(f.id).status = "faulted";
    const faulted = f.registry.getBlockVariants("b").length;
    f.registry.plugins.get(f.id).status = "ready";
    f.registry.plugins.get(f.id).enabledByDefault = false;
    return {
      rejected,
      matching,
      mismatched,
      faulted,
      disabled: f.registry.getBlockVariants("b").length,
    };
  });
  expect(actual).toEqual({
    rejected: Array(7).fill(true),
    matching: 1,
    mismatched: 0,
    faulted: 0,
    disabled: 0,
  });
});

test("invalid sibling commits no variant, variables, mount retirement, effects or tool completion", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    f.apply({ block_variants: [f.variant()] });
    const { descriptor, controller } = f.mount();
    const completions: unknown[] = [],
      effects: unknown[] = [],
      toolController = new AbortController();
    const identity = { invocation_id: "variant-atomic-tool" };
    f.registry.tools.set(identity.invocation_id, {
      pluginId: f.id,
      instance: f.instance,
      identity,
      context: f.registry.context(1),
      controller: toolController,
      resolve: (v: unknown) => completions.push(v),
      reject: (e: unknown) => completions.push(String(e)),
    });
    f.registry.effect = async (...args: unknown[]) => {
      effects.push(args);
    };
    const rejected = f.rejects(() =>
      f.apply({
        remove_block_variants: [{ block_id: "b", variant_id: "translation" }],
        block_variants: [f.variant({ block_id: "unsettled" })],
        vars_patch: { count: 2 },
        effects: [{ kind: "block-slots", payload: { slots: [] } }],
        tool_completion: { identity, status: "completed", output: "committed" },
      }),
    );
    const afterReject = {
      rejected,
      count: f.instance.vars.count,
      variants: f.registry.getBlockVariants("b").length,
      mounted: f.instance.surfaces.has(descriptor.surface_id),
      aborted: controller.signal.aborted,
      completions: [...completions],
      effects: effects.length,
      toolRetained: f.registry.tools.has(identity.invocation_id),
      toolAborted: toolController.signal.aborted,
    };
    f.apply({
      vars_patch: { count: 2 },
      tool_completion: { identity, status: "completed", output: "committed" },
    });
    return {
      afterReject,
      accepted: {
        count: f.instance.vars.count,
        completions,
        toolRetained: f.registry.tools.has(identity.invocation_id),
        toolAborted: toolController.signal.aborted,
      },
    };
  });
  expect(actual.afterReject).toEqual({
    rejected: true,
    count: 1,
    variants: 1,
    mounted: true,
    aborted: false,
    completions: [],
    effects: 0,
    toolRetained: true,
    toolAborted: false,
  });
  expect(actual.accepted).toEqual({
    count: 2,
    completions: ["committed"],
    toolRetained: false,
    toolAborted: true,
  });
});

test("removal is owned, known and conflict-free and retires only the exact variant mount", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    f.apply({ block_variants: [f.variant()] });
    const own = f.mount();
    f.addPlugin("other.fixture");
    f.apply({ block_variants: [f.variant()] }, "other.fixture");
    const other = f.mount("other.fixture");
    const removal = { block_id: "b", variant_id: "translation" };
    const conflict = f.rejects(() =>
      f.apply({
        remove_block_variants: [removal],
        block_variants: [f.variant()],
      }),
    );
    const unknown = f.rejects(() =>
      f.apply({
        remove_block_variants: [{ ...removal, variant_id: "missing" }],
      }),
    );
    const before = f.registry.getBlockVariants("b").length;
    f.apply({ remove_block_variants: [removal] });
    const twice = f.rejects(() =>
      f.apply({ remove_block_variants: [removal] }),
    );
    return {
      conflict,
      unknown,
      before,
      twice,
      owners: f.registry.getBlockVariants("b").map((v: any) => v.pluginId),
      ownAborted: own.controller.signal.aborted,
      otherAborted: other.controller.signal.aborted,
      ownMount: f.instance.surfaces.has(own.descriptor.surface_id),
      otherMount: f.registry.live
        .get("other.fixture")
        .surfaces.has(other.descriptor.surface_id),
    };
  });
  expect(actual).toEqual({
    conflict: true,
    unknown: true,
    before: 2,
    twice: true,
    owners: ["other.fixture"],
    ownAborted: true,
    otherAborted: false,
    ownMount: false,
    otherMount: true,
  });
});

test("source replacement preserves identical settlement but retires stale translations and their work", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    f.apply({ block_variants: [f.variant()] });
    const mounted = f.mount();
    f.registry.rememberSettled(f.source());
    const identical = {
      variants: f.registry.getBlockVariants("b").length,
      aborted: mounted.controller.signal.aborted,
    };
    f.registry.rememberSettled(
      f.source({
        text: "New source",
        source_digest: "b".repeat(64),
        history_revision: "revision-2",
      }),
    );
    return {
      identical,
      variants: f.registry.getBlockVariants("b").length,
      aborted: mounted.controller.signal.aborted,
      mounted: f.instance.surfaces.has(mounted.descriptor.surface_id),
      tree: f.instance.trees.has(mounted.descriptor.surface_id),
      lateRejected: f.rejects(() => f.apply({ block_variants: [f.variant()] })),
    };
  });
  expect(actual).toEqual({
    identical: { variants: 1, aborted: false },
    variants: 0,
    aborted: true,
    mounted: false,
    tree: false,
    lateRejected: true,
  });
});

test("settled source eviction retires variants, mounts and in-flight surface work", async ({
  page,
}) => {
  const actual = await page.evaluate(() => {
    const f = (window as any).variantFixture();
    f.apply({ block_variants: [f.variant()] });
    const mounted = f.mount();
    for (let i = 0; i < 512; i++)
      f.registry.rememberSettled(f.source({ block_id: `next-${i}` }));
    return {
      source: f.registry.settled.has("b"),
      variants: f.registry.getBlockVariants("b").length,
      retainedVariants: f.registry.variants.size,
      mounted: f.instance.surfaces.has(mounted.descriptor.surface_id),
      tree: f.instance.trees.has(mounted.descriptor.surface_id),
      aborted: mounted.controller.signal.aborted,
    };
  });
  expect(actual).toEqual({
    source: false,
    variants: 0,
    retainedVariants: 0,
    mounted: false,
    tree: false,
    aborted: true,
  });
});

for (const lifecycle of [
  "disable",
  "fault",
  "reset",
  "history-reset",
] as const) {
  test(`${lifecycle} removes certified variants and cancels mounted work`, async ({
    page,
  }) => {
    const actual = await page.evaluate(async (lifecycle) => {
      const f = (window as any).variantFixture();
      f.apply({ block_variants: [f.variant()] });
      const mounted = f.mount();
      // Avoid persistent state and actual worker startup; exercise production cleanup.
      f.registry.store.savePreferences = async () => {};
      f.registry.store.clearKV = async () => {};
      f.registry.start = async () => {};
      if (lifecycle === "disable") {
        f.registry.sessionId = "session";
        await f.registry.setEnabled(f.id, "session", false);
      } else if (lifecycle === "fault")
        f.registry.fault(f.id, new Error("Provider fault"));
      else if (lifecycle === "reset") await f.registry.reset(f.id);
      else {
        // Suppress guest event dispatch; the lifecycle transition itself stays real.
        f.registry.snapshot = [];
        f.registry.publish = () => {};
        f.registry.observe("history-reset", {});
      }
      return {
        variants: f.registry.getBlockVariants("b").length,
        retainedVariants: f.registry.variants.size,
        aborted: mounted.controller.signal.aborted,
        live: f.registry.live.has(f.id),
        status: f.registry.plugins.get(f.id).status,
      };
    }, lifecycle);
    expect(actual.variants).toBe(0);
    expect(actual.retainedVariants).toBe(0);
    expect(actual.aborted).toBe(true);
    expect(actual.live).toBe(lifecycle === "history-reset");
    expect(actual.status).toBe(
      lifecycle === "fault"
        ? "faulted"
        : lifecycle === "history-reset"
          ? "ready"
          : "disabled",
    );
  });
}

test("variant actions require the exact mounted descriptor and reject queued retirement", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const f = (window as any).variantFixture();
    f.apply({ block_variants: [f.variant()] });
    const { descriptor } = f.mount();
    const calls: any[] = [];
    f.registry.send = async (
      _worker: unknown,
      _generation: number,
      request: any,
    ) => {
      calls.push(request);
      return { type: "result", result: { schema_version: 1 } };
    };
    await f.registry.action(f.id, "block.force", { block_id: "b" }, descriptor);
    let forgedRejected = false;
    try {
      await f.registry.action(
        f.id,
        "block.force",
        { block_id: "other" },
        { ...descriptor, block_id: "other" },
      );
    } catch {
      forgedRejected = true;
    }
    let forgedSlotRejected = false;
    try {
      await f.registry.action(
        f.id,
        "block.force",
        { block_id: "b" },
        { ...descriptor, slot_id: "other" },
      );
    } catch {
      forgedSlotRejected = true;
    }
    const contexts = calls.map((c) => ({
      block: c.context.surface.block_id,
      action: c.args[0],
      userAction: c.context.user_action,
    }));
    let release!: () => void;
    f.instance.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = f.registry
      .action(f.id, "block.force", { block_id: "b" }, descriptor)
      .then(
        () => false,
        () => true,
      );
    f.apply({
      remove_block_variants: [{ block_id: "b", variant_id: "translation" }],
    });
    release();
    const retiredRejected = await queued;
    let remountRejected = false;
    try {
      f.registry.setSurfaceVisible(f.id, descriptor, true);
    } catch {
      remountRejected = true;
    }
    return {
      contexts,
      forgedRejected,
      forgedSlotRejected,
      retiredRejected,
      remountRejected,
      calls: calls.length,
    };
  });
  expect(actual).toEqual({
    contexts: [{ block: "b", action: "block.force", userAction: true }],
    forgedRejected: true,
    forgedSlotRejected: true,
    retiredRejected: true,
    remountRejected: true,
    calls: 1,
  });
});
