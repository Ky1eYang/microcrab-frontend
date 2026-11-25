import { expect, test } from "@playwright/test";
import { referenceLabels } from "../src/features/referenceLabels";
import { toolReferenceProjection } from "../src/features/toolReferences";
import { stateReferenceProjection } from "../src/features/state-viewer/references";
import { hostGroups } from "../src/features/home/WorkspacePicker/projects";
import { messageBlocks } from "../src/client/native-message-blocks";
import { nativeBackend } from "./native-fixture";

const stem = "0123456789abcdef";
const a = stem + "12345678" + "a".repeat(40);
const b = stem + "12345678" + "b".repeat(40);
const c = stem + "c".repeat(48);

test("typed display collisions extend and never fall back to canonical bytes", () => {
  const values = [a, b, c, c];
  const labels = referenceLabels("digest", values);
  const reverse = referenceLabels("digest", [...values].reverse());
  expect(values.map(labels)).toEqual(values.map(reverse));
  expect(values.map(labels)).toEqual([
    `${stem}12345678…~1`,
    `${stem}12345678…~2`,
    `${stem}cccc…`,
    `${stem}cccc…`,
  ]);
  expect(referenceLabels("digest", [a])(a)).toBe(stem + "…");
  expect(referenceLabels("digest", [a + "\n"])(a + "\n")).toBe(a + "\n");
  expect(referenceLabels("session", [a.slice(0, 32)])(a.slice(0, 32))).toBe(
    stem + "…",
  );
  expect(labels(`fv_${stem}`)).toBe(`fv_${stem}`);
});

test("workspace collision labels use the digest, not the device namespace, and retain exact IDs", () => {
  const projects = [a, b, c].map((hash, i) => ({
    id: `p${i}`,
    name: `Project ${i}`,
    host_id: `device-${hash}`,
  }));
  const groups = hostGroups(projects, () => "ws://same.example/bridge");
  expect(groups.map((g) => g.id)).toEqual(projects.map((p) => p.host_id));
  expect(groups.map((g) => g.label)).toEqual([
    `same.example · device-${stem}12345678…~1`,
    `same.example · device-${stem}12345678…~2`,
    `same.example · device-${stem}cccc…`,
  ]);
});

test("projection preserves source, JSON lexemes and unclassified payloads", () => {
  const source = `{"version":"${a}","receipts":[{"outcome":{"version":"${b}"}}],"metadata":{"version":"${a}"},"body":"\\u0061","signed":"https://example.com/${a}","size":18446744073709551615}`;
  const result = toolReferenceProjection(source, "coding-file", "result")!;
  expect(result.display).toContain(`"version": "${stem}12345678…~1"`);
  expect(result.display).toContain(`"version": "${stem}12345678…~2"`);
  expect(result.display).toContain(`"version": "${a}"`);
  expect(result.display).toContain(`"body": "\\u0061"`);
  expect(result.display).toContain(`"size": 18446744073709551615`);
  expect(result.display).toContain(`"signed": "https://example.com/${a}"`);
  expect(toolReferenceProjection(source, undefined, "result")).toBeUndefined();
  expect(
    toolReferenceProjection(source, "plugin-artifact", "result"),
  ).toBeUndefined();
  expect(
    toolReferenceProjection(`Output: ${source}`, "coding-file", "result"),
  ).toBeUndefined();
  expect(
    toolReferenceProjection(
      { expected_version: `fv_${stem}` },
      "coding-file",
      "arguments",
    ),
  ).toBeUndefined();
  expect(
    toolReferenceProjection(
      { image_url: `file:${a}` },
      "view-image",
      "arguments",
    ),
  ).toMatchObject({ synthetic: true });
  expect(
    toolReferenceProjection(
      { image_url: `https://example.com/${a}` },
      "view-image",
      "arguments",
    ),
  ).toBeUndefined();
});

test("State projection uses descriptors and known paths, not custom field names", () => {
  const references = [
    { content_digest: a, metadata: { content_digest: b } },
    { content_digest: b },
  ];
  expect(stateReferenceProjection("references", "custom", references)).toBe(
    references,
  );
  expect(
    stateReferenceProjection("references", "reference", references),
  ).toEqual([
    { content_digest: `${stem}12345678…~1`, metadata: { content_digest: b } },
    { content_digest: `${stem}12345678…~2` },
  ]);
  expect(references[0].content_digest).toBe(a);
  const ordinary = {
    call_id: `agent-init:1:2:${a}`,
    subject: { kind: "tool", component: a },
    result: { version: b },
  };
  const lifecycle = {
    ...ordinary,
    subject: { kind: "agent_init", component: a },
  };
  expect(
    stateReferenceProjection("executions", "framework", [ordinary, lifecycle]),
  ).toEqual([
    ordinary,
    {
      ...lifecycle,
      call_id: `agent-init:1:2:${stem}…`,
      subject: { kind: "agent_init", component: `${stem}…` },
    },
  ]);
});

test("native transcript carries provenance from the DTO, not the tool's name", () => {
  const call = { id: "call", name: "read", arguments: { expected_version: a } };
  const [unknown, known] = messageBlocks(
    "session",
    {
      role: "assistant",
      id: "row",
      text: null,
      parts: [],
      tool_calls: [call, { ...call, presentation: "coding-file" }],
    },
    "/api",
  );
  expect(unknown.tool.presentation).toBeUndefined();
  expect(known.tool.presentation).toBe("coding-file");
  expect(known.tool.input).toEqual(call.arguments);
});

test("ordinary copy is compact; exact evidence mode copies retained source bytes", async ({
  page,
  context,
}) => {
  page.on("pageerror", (error) => console.error(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const raw = ` { "version": "${a}", "n": 18446744073709551615 }\n`;
  await page.route("**/reference-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      const {default: React} = await import('/node_modules/.vite/deps/react.js');
      const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const {Payload} = await import('/src/features/Payload.tsx');
      const {toolReferenceProjection} = await import('/src/features/toolReferences.ts');
      const value = ${JSON.stringify(raw)};
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Payload, {testid:'reference-payload', variant:'trajectory', value, projection:toolReferenceProjection(value, 'coding-file', 'result')}));
    </script></body></html>`,
    }),
  );
  await page.goto("/reference-fixture");
  const payload = page.getByTestId("reference-payload");
  await expect(payload.locator("pre")).toContainText(`${stem}…`);
  await expect(payload.locator("pre")).not.toContainText(a);
  await payload.locator(".payload-copy").click();
  const read = () => page.evaluate(() => navigator.clipboard.readText());
  expect(await read()).toContain(`${stem}…`);
  expect(await read()).not.toContain(a);
  await payload
    .getByRole("button", { name: /Show exact evidence|显示精确证据/ })
    .click();
  await expect(payload.locator("pre")).toContainText(a);
  await payload
    .getByRole("button", { name: /Copy exact evidence|复制精确证据/ })
    .click();
  expect(await read()).toBe(raw);
});

test("chat and trajectory report shorten certified slots without rewriting user text", async ({
  page,
  context,
}) => {
  const backend = await nativeBackend(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const position = { epoch: 0, turn: 1, round: 1 };
  const callId = "file-call-fixture";
  backend.snapshot().messages = [
    {
      id: "typed-user",
      role: "user",
      text: `Retain prose: ${b}`,
      parts: [],
      tool_calls: [],
      position: { ...position, round: 0 },
    },
    {
      id: "typed-assistant",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        {
          id: callId,
          name: "edit",
          presentation: "coding-file",
          arguments: { expected_version: a, path: "sample.md" },
        },
      ],
      position,
    },
    {
      id: "typed-tool",
      role: "tool",
      text: JSON.stringify({ version: a }),
      parts: [],
      tool_calls: [],
      call_id: callId,
      tool_name: "edit",
      presentation: "coding-file",
      position,
    },
  ];
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "工具调用 1 次" }).click();
  const tool = page.getByTestId("tool-row").filter({ hasText: "edit" });
  await expect(tool).toHaveAttribute("aria-label", new RegExp(stem + "…"));
  await expect(tool).not.toHaveAttribute("aria-label", new RegExp(a));
  await tool.click();
  await expect(page.getByTestId("tool-payload-output")).toContainText(
    stem + "…",
  );
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page.getByRole("button", { name: "复制轨迹报告" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toContain(`${stem}…`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(b);
  expect(copied).not.toContain(a);
});
