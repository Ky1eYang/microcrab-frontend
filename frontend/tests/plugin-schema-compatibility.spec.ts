import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

// This test also proves that a short-looking artifact pattern alone grants nothing.
test("short artifact capability requires an exact known current or frozen schema", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const hubPath = "/src/plugins/tool-hub.ts";
    const compatibilityPath = "/src/plugins/tool-schema-compatibility.ts";
    const fixturePath = "/tests/plugin-short-schema-fixture.ts";
    const { PLUGIN_META_TOOL_DEFINITION } = await import(hubPath);
    const { supportsShortPluginArtifacts } = await import(compatibilityPath);
    const { previousShortArtifactSchema } = await import(fixturePath);
    const flat = structuredClone(PLUGIN_META_TOOL_DEFINITION.parameters);
    const previous = structuredClone(previousShortArtifactSchema);
    const legacy = structuredClone(previous);
    legacy.properties.artifact.pattern = "^[a-f0-9]{64}$";
    const unknowns = [
      null,
      {},
      { properties: { artifact: flat.properties.artifact } },
      { ...flat, required: ["action"] },
      { ...previous, additionalProperties: true },
      { ...previous, oneOf: [] },
      { ...flat, properties: { ...flat.properties, pin: { type: "string" } } },
    ];
    const before = JSON.stringify([flat, previous, legacy, unknowns]);
    const accepted = [flat, previous].map(supportsShortPluginArtifacts);
    const rejected = [legacy, ...unknowns].map(supportsShortPluginArtifacts);
    // Object key ordering is not a new schema version.
    const reordered = Object.fromEntries(Object.entries(previous).reverse());
    return {
      accepted,
      rejected,
      reordered: supportsShortPluginArtifacts(reordered),
      unchanged: JSON.stringify([flat, previous, legacy, unknowns]) === before,
    };
  });
  expect(actual.accepted).toEqual([true, true]);
  expect(actual.rejected.every((supported) => !supported)).toBe(true);
  expect(actual.reordered).toBe(true);
  expect(actual.unchanged).toBe(true);
});
