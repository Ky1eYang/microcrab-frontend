import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.route("**/slot-lifecycle-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Slot lifecycle</title>",
    }),
  );
  await page.goto("/slot-lifecycle-fixture");
}

test("slot parser accepts exact deferred metadata and retained native slots, rejects mixed partials and bounded removal abuse", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/schema.ts";
    const { result } = await import(path);
    const valid = [
      { slot_id: "translation", block_id: "b", placement: "after" },
      {
        slot_id: "native",
        block_id: "b",
        tree: { type: "text", props: { text: "native" } },
      },
      {
        slot_id: "html",
        block_id: "b",
        mode: "webview-html",
        content: "<b>html</b>",
      },
    ];
    const accepted = valid.map(
      (slot) =>
        result(JSON.stringify({ schema_version: 1, block_slots: [slot] }))
          .block_slots![0],
    );
    const invalid = [
      { slot_id: "x", block_id: "b" },
      { slot_id: "x", block_id: "b", placement: "after", target: "block-slot" },
      { slot_id: "x", block_id: "b", placement: "after", content: "partial" },
      { slot_id: "x", block_id: "b", placement: "after", view_state: {} },
      {
        slot_id: "x",
        block_id: "b",
        mode: "webview-html",
        content: "<b>x</b>",
        tree: { type: "text" },
      },
      { slot_id: "", block_id: "b", placement: "after" },
    ];
    const rejected = invalid.map((slot) => {
      try {
        result(JSON.stringify({ schema_version: 1, block_slots: [slot] }));
        return false;
      } catch {
        return true;
      }
    });
    const removalInvalid = [
      null,
      {},
      [{ block_id: "b", slot_id: "s", plugin_id: "other" }],
      [{ block_id: "", slot_id: "s" }],
      [
        { block_id: "b", slot_id: "s" },
        { block_id: "b", slot_id: "s" },
      ],
      Array.from({ length: 129 }, (_, i) => ({
        block_id: String(i),
        slot_id: "s",
      })),
    ];
    const removalsRejected = removalInvalid.map((remove_block_slots) => {
      try {
        result(JSON.stringify({ schema_version: 1, remove_block_slots }));
        return false;
      } catch {
        return true;
      }
    });
    return { accepted, rejected, removalsRejected };
  });
  expect(result.accepted).toHaveLength(3);
  expect(result.rejected).toEqual(Array(6).fill(true));
  expect(result.removalsRejected).toEqual(Array(6).fill(true));
});

test("own-slot removal validates siblings atomically, retires exact mounts before index reuse and never deletes another plugin slot", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts",
      schemaPath = "/src/plugins/schema.ts";
    const { PluginRegistry } = await import(registryPath),
      { result } = await import(schemaPath);
    const registry: any = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: "slots-owner",
    });
    const id = "slot.fixture",
      other = "other.fixture",
      key = (plugin: string, block: string, slot: string) =>
        JSON.stringify([plugin, block, slot]);
    registry.plugins.set(id, {
      manifest: { id, targets: ["block-slot"] },
      imports: ["microcrab:client-plugin/conversation@0.4.0"],
      status: "ready",
      priority: 0,
    });
    const controller = new AbortController(),
      unrelated = new AbortController();
    const instance = {
      vars: { blocks: [{ text: "old" }] },
      trees: new Map([
        [
          "old-mount",
          {
            mode: "webview-html",
            content: "old",
            viewState: { $ref: "blocks.0" },
          },
        ],
      ]),
      surfaces: new Map([
        [
          "old-mount",
          {
            descriptor: {
              surface_id: "old-mount",
              target: "block-slot",
              block_id: "old",
              slot_id: "translation",
            },
            visible: true,
            revision: 1,
          },
        ],
      ]),
      controllers: new Map([
        [controller, "old-mount"],
        [unrelated, "other-mount"],
      ]),
      network: { retireStale: () => {} },
    };
    registry.live.set(id, instance);
    registry.slots.set(key(id, "old", "translation"), {
      pluginId: id,
      block_id: "old",
      slot_id: "translation",
      placement: "after",
    });
    registry.slots.set(key(other, "old", "translation"), {
      pluginId: other,
      block_id: "old",
      slot_id: "translation",
      placement: "after",
    });
    registry.settled.set("new", { payload: {}, bytes: 0 });
    const removal = [{ block_id: "old", slot_id: "translation" }];
    let siblingRejected = false;
    try {
      registry.apply(
        id,
        instance,
        result(
          JSON.stringify({
            schema_version: 1,
            remove_block_slots: removal,
            vars_patch: { blocks: [] },
            block_slots: [
              {
                block_id: "unsettled",
                slot_id: "translation",
                placement: "after",
              },
            ],
          }),
        ),
      );
    } catch {
      siblingRejected = true;
    }
    const unchanged =
      instance.vars.blocks.length === 1 &&
      instance.surfaces.has("old-mount") &&
      !controller.signal.aborted &&
      registry.getBlockSlots("old").length === 2;
    registry.apply(
      id,
      instance,
      result(
        JSON.stringify({
          schema_version: 1,
          remove_block_slots: removal,
          vars_patch: { blocks: [] },
          block_slots: [
            { block_id: "new", slot_id: "translation", placement: "after" },
          ],
        }),
      ),
    );
    const retired =
      !instance.surfaces.has("old-mount") &&
      !instance.trees.has("old-mount") &&
      controller.signal.aborted &&
      !unrelated.signal.aborted;
    const ownGone = registry
      .getBlockSlots("old")
      .every((slot: any) => slot.pluginId === other);
    registry.settled.set("old", { payload: {}, bytes: 0 });
    let recreateRejected = false;
    try {
      registry.setSurfaceVisible(
        id,
        {
          surface_id: "old-mount",
          target: "block-slot",
          block_id: "old",
          slot_id: "translation",
        },
        true,
      );
    } catch {
      recreateRejected = true;
    }
    let crossRejected = false;
    try {
      registry.apply(
        id,
        instance,
        result(
          JSON.stringify({ schema_version: 1, remove_block_slots: removal }),
        ),
      );
    } catch {
      crossRejected = true;
    }
    const missingCapability: any = {
      ...instance,
      vars: {},
      surfaces: new Map(),
      trees: new Map(),
    };
    registry.live.set(id, missingCapability);
    registry.plugins.get(id).imports = [];
    let capabilityRejected = false;
    try {
      registry.apply(
        id,
        missingCapability,
        result(
          JSON.stringify({
            schema_version: 1,
            remove_block_slots: [{ block_id: "new", slot_id: "translation" }],
          }),
        ),
      );
    } catch {
      capabilityRejected = true;
    }
    return {
      siblingRejected,
      unchanged,
      retired,
      ownGone,
      crossRejected,
      recreateRejected,
      capabilityRejected,
      newSlots: registry.getBlockSlots("new").length,
    };
  });
  expect(result).toEqual({
    siblingRejected: true,
    unchanged: true,
    retired: true,
    ownGone: true,
    crossRejected: true,
    recreateRejected: true,
    capabilityRejected: true,
    newSlots: 1,
  });
});
