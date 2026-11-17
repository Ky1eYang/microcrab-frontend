import { expect, test } from "@playwright/test";
import {
  SUMMARY_ARGUMENTS_MAX_LINES,
  looksLikeBlob,
  permissionSummary,
  readSummaryAnnotation,
  toolInputSchema,
} from "../src/features/permission-summary";

// Pure tool-generic summary: no branch may depend on the tool name.
test("schema annotation selects the primary argument and its kind", () => {
  const schema = {
    type: "object",
    "x-microcrab-summary": { arg: "path", kind: "path" },
    properties: { content: { type: "string" }, path: { type: "string" } },
  };
  expect(
    permissionSummary({ content: "short text", path: "/tmp/a b.txt" }, schema),
  ).toEqual({
    kind: "path",
    text: "/tmp/a b.txt",
    arg: "path",
    source: "annotation",
    truncated: false,
  });
});

test("property-level annotation defaults arg to the property name", () => {
  const schema = {
    properties: {
      note: { type: "string" },
      cmd: { type: "string", "x-microcrab-summary": { kind: "command" } },
    },
  };
  expect(readSummaryAnnotation(schema)).toEqual({
    arg: "cmd",
    kind: "command",
  });
  expect(permissionSummary({ note: "n", cmd: "ls -la" }, schema)).toMatchObject(
    {
      kind: "command",
      text: "ls -la",
      source: "annotation",
    },
  );
  expect(
    readSummaryAnnotation({
      properties: { url: { "x-microcrab-summary": true } },
    }),
  ).toEqual({ arg: "url", kind: "text" });
  // Unknown kinds degrade to text instead of failing.
  expect(
    readSummaryAnnotation({
      "x-microcrab-summary": { arg: "a", kind: "rocket" },
    }),
  ).toEqual({ arg: "a", kind: "text" });
});

test("without annotation the first short single-line string field is used", () => {
  const summary = permissionSummary({
    blob: "A".repeat(80),
    data: "data:image/png;base64,iVBORw0KGgo=",
    multi: "line one\nline two",
    long: "x ".repeat(150),
    count: 3,
    command: "echo permission",
  });
  expect(summary).toEqual({
    kind: "text",
    text: "echo permission",
    arg: "command",
    source: "field",
    truncated: false,
  });
  // The same arguments under any tool name give the same result.
  expect(permissionSummary({ command: "echo permission" }, undefined)).toEqual(
    permissionSummary({ command: "echo permission" }, null),
  );
});

test("annotation pointing at a missing or non-string field falls back", () => {
  const schema = { "x-microcrab-summary": { arg: "command", kind: "command" } };
  expect(permissionSummary({ path: "a.txt" }, schema)).toMatchObject({
    source: "field",
    text: "a.txt",
  });
  expect(permissionSummary({ command: ["ls", "-la"] }, schema)).toMatchObject({
    source: "arguments",
    kind: "arguments",
  });
});

test("without a usable field the full arguments are shown, clamped", () => {
  const args = {
    steps: Array.from({ length: 30 }, (_, i) => ({ op: "move", index: i })),
  };
  const summary = permissionSummary(args)!;
  expect(summary.source).toBe("arguments");
  expect(summary.truncated).toBe(true);
  expect(summary.text.endsWith("…")).toBe(true);
  expect(summary.text.split("\n").length).toBeLessThanOrEqual(
    SUMMARY_ARGUMENTS_MAX_LINES,
  );
  const huge = permissionSummary({ items: ["y".repeat(5000)] })!;
  expect(huge.text.length).toBeLessThanOrEqual(2049);
});

test("edge arguments never throw", () => {
  expect(permissionSummary(undefined)).toBeNull();
  expect(permissionSummary(null)).toBeNull();
  expect(permissionSummary({})).toBeNull();
  expect(permissionSummary([])).toBeNull();
  expect(permissionSummary("rm -rf build")).toMatchObject({
    source: "arguments",
    text: "rm -rf build",
  });
  expect(permissionSummary([1, 2])).toMatchObject({ source: "arguments" });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => permissionSummary(cyclic)).not.toThrow();
  expect(permissionSummary(42)).toMatchObject({ text: "42" });
});

test("blob detection and catalog schema lookup", () => {
  expect(
    looksLikeBlob("SGVsbG8gV29ybGQhSGVsbG8gV29ybGQhSGVsbG8gV29ybGQh"),
  ).toBe(true);
  expect(looksLikeBlob("src/features/views.tsx")).toBe(false);
  const schema = { type: "object" };
  expect(
    toolInputSchema([{ name: "a", parameters: schema }, { name: "b" }], "a"),
  ).toBe(schema);
  expect(toolInputSchema([{ name: "a", input_schema: schema }], "a")).toBe(
    schema,
  );
  expect(toolInputSchema(undefined, "a")).toBeUndefined();
});
