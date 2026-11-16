import { expect, test } from "@playwright/test";

test("HTML projection rejection cannot settle a correlated tool or commit its variables", async ({
  page,
}) => {
  await page.route("**/atomic-projection-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/atomic-projection-fixture");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    // Exercise the result-commit boundary directly: no fake Worker or network success
    // substitutes for a real guest. The invalid projection must precede every effect.
    const registry: any = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: "atomic-owner",
    });
    const instance = {
      generation: 1,
      vars: { state: { count: 1 } },
      trees: new Map([
        [
          "settings",
          {
            mode: "webview-html",
            content: "<p>Settings</p>",
            tree: null,
            viewState: { $ref: "state" },
          },
        ],
      ]),
    };
    registry.live.set("atomic", instance);
    const identity = { invocation_id: "atomic-tool" };
    const controller = new AbortController();
    const completions: unknown[] = [];
    registry.tools.set(identity.invocation_id, {
      pluginId: "atomic",
      instance,
      identity,
      context: registry.context(instance.generation),
      controller,
      resolve: (value: unknown) => completions.push(value),
      reject: (error: unknown) => completions.push(String(error)),
    });
    const completion = { identity, status: "completed", output: "accepted" };
    let rejection = "";
    try {
      registry.apply("atomic", instance, {
        schema_version: 1,
        tool_completion: completion,
        vars_patch: { state: "x".repeat(65537) },
      });
    } catch (error) {
      rejection = String(error);
    }
    const rejected = {
      rejection,
      completions: [...completions],
      aborted: controller.signal.aborted,
      retained: registry.tools.has(identity.invocation_id),
      vars: instance.vars,
    };
    if (registry.tools.has(identity.invocation_id))
      registry.apply("atomic", instance, {
        schema_version: 1,
        tool_completion: completion,
        vars_patch: { state: { count: 2 } },
      });
    const accepted = {
      completions: [...completions],
      aborted: controller.signal.aborted,
      retained: registry.tools.has(identity.invocation_id),
      vars: instance.vars,
    };
    registry.live.clear();
    registry.dispose();
    return { rejected, accepted };
  });
  expect(actual.rejected).toEqual({
    rejection: expect.stringContaining(
      "HTML view-state projection rejected: json-bytes",
    ),
    completions: [],
    aborted: false,
    retained: true,
    vars: { state: { count: 1 } },
  });
  expect(actual.accepted).toEqual({
    completions: ["accepted"],
    aborted: true,
    retained: false,
    vars: { state: { count: 2 } },
  });
});
