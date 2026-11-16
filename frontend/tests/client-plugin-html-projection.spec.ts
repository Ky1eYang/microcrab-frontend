import { expect, test } from "@playwright/test";

test("HTML projection bindings validate exact references and independent presentation bounds", async ({
  page,
}) => {
  await page.route("**/projection-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/projection-fixture");
  const actual = await page.evaluate(async () => {
    const schema = "/src/plugins/schema.ts";
    const { resolveViewState, renderOutput } = await import(schema);
    const vars = {
      state: { count: 3 },
      secret: "never-project",
      nullable: null,
    };
    const envelope = renderOutput({
      schemaVersion: 1,
      mode: "webview-html",
      content: JSON.stringify({
        html: "<p>static</p>",
        view_state: { $ref: "state" },
      }),
      rerender: false,
    });
    const failures = [];
    for (const value of [
      { $ref: "" },
      { $ref: "$" },
      { $ref: "$." },
      { $ref: "state..count" },
      { $ref: "constructor" },
      { $ref: "__proto__.state" },
      { $ref: "state.prototype" },
      { $ref: "x".repeat(513) },
      { $ref: 1 },
      { $ref: "missing" },
    ]) {
      try {
        resolveViewState(value, vars);
        failures.push("accepted");
      } catch (error) {
        failures.push(String(error));
      }
    }
    const quotas = [];
    for (const state of [
      "x".repeat(65537),
      Array.from({ length: 4097 }, () => null),
      Array.from({ length: 25 }).reduce((value) => [value], null),
    ]) {
      try {
        resolveViewState({ $ref: "state" }, { state });
        quotas.push("accepted");
      } catch (error) {
        quotas.push(String(error));
      }
    }
    return {
      bound: resolveViewState(envelope.view_output.viewState, vars),
      nullable: resolveViewState({ $ref: "nullable" }, vars),
      literal: resolveViewState({ $ref: "literal-data", other: true }, vars),
      nested: resolveViewState({ nested: { $ref: "state" } }, vars),
      failures,
      quotas,
    };
  });
  expect(actual.bound).toEqual({ count: 3 });
  expect(actual.nullable).toBeNull();
  expect(actual.literal).toEqual({ $ref: "literal-data", other: true });
  expect(actual.nested).toEqual({ nested: { $ref: "state" } });
  expect(actual.failures).toHaveLength(10);
  expect(
    actual.failures.every((error) => error.includes("HTML view-state binding")),
  ).toBe(true);
  expect(actual.quotas[0]).toContain("json-bytes");
  expect(actual.quotas[1]).toContain("json-nodes");
  expect(actual.quotas[2]).toContain("json-depth");
});
