import { expect, test, type Page } from "@playwright/test";
import {
  buildStateTree,
  findStateNodes,
  stateReference,
} from "../src/features/state-viewer/inspection";
import { stateValuePreview } from "../src/features/state-viewer/value-preview";
import { parseStateInspection } from "../src/client/state-inspection";
import { decodeNativeStateInspection } from "../src/client/native-state-inspection";
import { selectedStateSource } from "../src/features/state-viewer/exact-source";
import { nativeBackend } from "./native-fixture";
import { stateInspection } from "./state-inspection-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("reference grammar matches Core syntax and byte/depth limits", () => {
  expect(stateReference("settings.search", "visible", ["/a~b", "0", ""])).toBe(
    "{{var:settings.search:/~1a~0b/0/}}",
  );
  expect(stateReference("SECRET-token", "secret")).toBe(
    "{{secret:SECRET-token}}",
  );
  for (const key of [
    "",
    " leading",
    "1key",
    "a\n",
    "nonascii值",
    "a".repeat(129),
  ])
    expect(stateReference(key, "secret")).toBeUndefined();
  for (const path of [
    ["bad}}suffix"],
    ["ends}"],
    ["é".repeat(256)],
    Array(33).fill("x"),
  ])
    expect(stateReference("ok", "visible", path)).toBeUndefined();
  expect(stateReference("ok", "visible", ["a".repeat(511)])).toBeDefined();
  expect(stateReference("ok", "secret", ["nested"])).toBeUndefined();
  expect(stateReference("ok", "invisible")).toBeUndefined();
  expect(stateReference("ok", "visible", ["a}", "b"])).toBe("{{var:ok:/a}/b}}");
});

test("tree never reads protected payloads and bounds depth and sibling expansion", () => {
  const source = stateInspection(
    { large: Array(5000).fill("safe ordinary string"), later: "small" },
    {
      token: { visibility: "secret" },
      "invalid key": { visibility: "secret" },
    },
  );
  Object.defineProperty(source.values, "token", {
    enumerable: true,
    get() {
      throw Error("protected payload was accessed");
    },
  });
  const tree = buildStateTree(source);
  const token = tree.roots.find(({ label }) => label === "token");
  expect(token?.preview).toBeUndefined();
  expect(token?.reference).toBe("{{secret:token}}");
  expect(
    tree.roots.find(({ label }) => label === "invalid key")?.reference,
  ).toBeUndefined();
  expect(tree.roots.find(({ label }) => label === "later")?.preview).toBe(
    '"small"',
  );
  expect(findStateNodes(tree.roots, "safe ordinary").size).toBeGreaterThan(1);
  expect(tree.nodes.size).toBe(1500);
  expect(tree.limited).toBe(true);
  const deep: Record<string, any> = {};
  let last = deep;
  for (let i = 0; i < 60; i++) last = last.nested = {};
  const nested = buildStateTree(stateInspection({ deep }));
  expect(nested.nodes.size).toBe(33);
  expect(nested.limited).toBe(true);
});

test("selected previews preserve JSON types, escapes, order, and safe projection", () => {
  const digest = "1234567890abcdef".repeat(4);
  const mixed = {
    second: { bytes: "ordinary", payload: '<img src="/must-not-load">' },
    first: [null, false, 0, "", [], {}, "a\nb\t\u0000\ud800\\😀"],
    [""]: "",
    ["long".repeat(100)]: "界".repeat(513),
  };
  const source = stateInspection(
    { agent_init: { component: digest }, mixed, empty: [], missing: null },
    { mixed: { visibility: "visible" }, secret: { visibility: "secret" } },
  );
  delete (source.values as Record<string, unknown>).missing;
  const { roots } = buildStateTree(source);
  const at = (key: string) => roots.find((node) => node.key === key)!;
  expect(stateValuePreview(at("mixed"))).toEqual({
    kind: "json",
    type: "object",
    text: JSON.stringify(mixed, null, 2),
  });
  expect(stateValuePreview(at("empty"))).toEqual({
    kind: "json",
    type: "array",
    text: "[]",
  });
  const values = at("mixed").children[1];
  expect(stateValuePreview(values).kind).toBe("json");
  expect(values.children.slice(0, 4).map(stateValuePreview)).toEqual(
    ["null", "false", "0", '\"\"'].map((text) => ({ kind: "scalar", text })),
  );
  expect(stateValuePreview(at("missing"))).toEqual({ kind: "none" });
  expect(stateValuePreview(at("secret"))).toEqual({ kind: "none" });
  expect(stateValuePreview(at("agent_init"))).toMatchObject({ kind: "json" });
  expect(stateValuePreview(at("agent_init"))).not.toHaveProperty(
    "text",
    expect.stringContaining(digest),
  );
  expect(at("agent_init").children[0].exact).toBe(digest);
});

test("selected preview bounds depth, entries and escaped UTF-8; never fills in omitted tree children", () => {
  const deep = { a: { b: { c: { d: { e: "never reached" } } } } };
  const tree = buildStateTree(
    stateInspection({
      deep,
      eighty: Array(80).fill(0),
      eightyOne: Array(81).fill(0),
      largeKey: { ["\\\u0000😀".repeat(4000)]: "never reached" },
      largeValue: ["😀界\ud800\u0000".repeat(4000)],
      wide: Array(1600).fill(0),
      omittedByTree: [true],
    }),
  );
  const at = (key: string) =>
    stateValuePreview(tree.roots.find((node) => node.key === key)!);
  expect(at("eighty").kind).toBe("json");
  expect(at("eightyOne")).toEqual({
    kind: "excerpt",
    type: "array",
    text: `[${"\n  0,".repeat(79)}\n  0`,
  });
  expect(at("deep").kind).toBe("excerpt");
  for (const key of ["largeValue", "largeKey"]) {
    const preview = at(key);
    expect(preview.kind).toBe("excerpt");
    if (preview.kind !== "excerpt") throw Error("expected excerpt");
    const bytes = new TextEncoder().encode(preview.text).byteLength;
    expect(bytes).toBeGreaterThan(4090);
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(preview.text).not.toMatch(/[�…]|never reached/);
  }
  expect(tree.limited).toBe(true);
  expect(at("omittedByTree")).toEqual({
    kind: "excerpt",
    type: "array",
    text: "[",
  });
});

test("capacity uses validated framework values, independent of tree bounds, and never historical custom values", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [`f${i}`, i]),
  );
  const capacity = { buffers: { limit: 2, used: 3, remaining: 0 } };
  const source = stateInspection({ ...fields, execution_capacity: capacity });
  const tree = buildStateTree(source);
  expect(tree.limited).toBe(true);
  expect(tree.executionCapacity.buffers).toEqual(capacity.buffers);
  expect(tree.executionCapacity.pending).toBeUndefined();
  const custom = stateInspection(
    { execution_capacity: capacity },
    { execution_capacity: { visibility: "visible" } },
  );
  expect(buildStateTree(custom).executionCapacity.buffers).toBeUndefined();
});

test("witness and state inspection maps reject malformed revisions and prototype keys", () => {
  const source = stateInspection({ ordinary: true }, {}, "18446744073709551615");
  const tree = buildStateTree(source);
  expect(tree.roots.map(({ label }) => label)).toEqual(["ordinary"]);
  expect(parseStateInspection(source).ordinary).toEqual(source);
  for (const witness of [
    { ...source.witness, variables_revision: "not-a-uint" },
    { ...source.witness, variables_revision: "18446744073709551616" },
    { ...source.witness, runtime_instance_id: 123 },
  ]) {
    expect(() => buildStateTree({ ...source, witness })).toThrow(
      /^invalid_result$/,
    );
  }
});

test("native wire capture rejects duplicate authority but never decodes unclassified or protected bodies", async () => {
  const signal = new AbortController().signal;
  const originalParse = JSON.parse;
  const wire = (
    values: string,
    metadata: string,
    descriptors = "{}",
    extra = "",
  ) =>
    `{"values":${values},"metadata":${metadata},"descriptors":${descriptors},"witness":{"runtime_instance_id":"runtime","variables_revision":"1"}${extra}}`;
  const source = wire(
    '{"secret": {"mustNotDecode":true},"unknown": ["mustNotDecode"],"ordinary":-0,"missingMeta":0}',
    '{"ordinary":{"visibility":"invisible"},"secret":{"visibility":"secret"},"missingMeta":null}',
    '{"missingMeta":{"kind":"framework"}}',
  );
  let decodedProtected = false;
  JSON.parse = (text, ...args) => {
    decodedProtected ||=
      typeof text === "string" && text.includes("mustNotDecode");
    return originalParse(text, ...args);
  };
  try {
    const result = await decodeNativeStateInspection(
      source,
      signal,
      () => true,
    );
    expect([...result.exactRoots]).toEqual([["ordinary", "-0"]]);
    expect(result.ordinary.values.secret).toBeUndefined();
    expect(result.ordinary.values.unknown).toBeUndefined();
    expect(result.ordinary.values.missingMeta).toBeUndefined();
    expect(decodedProtected).toBe(false);
  } finally {
    JSON.parse = originalParse;
  }
  for (const malformed of [
    wire("{}", "{}", "{}", ',"v\\u0061lues":{}'),
    wire('{"unsafe":0,"u\\u006esafe":1}', "{}"),
    wire("{}", '{"secret":{},"secret":{}}'),
    wire(
      '{"token":0}',
      '{"token":{"visibility":"secret","visibilit\\u0079":"visible"}}',
    ),
    wire('{"token":0}', "{}", '{"token":{"kind":"custom","kind":"framework"}}'),
    wire("{}", "{}").replace(
      '"variables_revision":"1"',
      '"variables_revision":"1","variables_revision":"2"',
    ),
    wire('{"unclassified":[00]}', "{}"),
  ]) {
    await expect(
      decodeNativeStateInspection(malformed, signal, () => true),
    ).rejects.toMatchObject({ code: "invalid_result" });
  }
  await expect(
    decodeNativeStateInspection(source, signal, () => false),
  ).rejects.toMatchObject({ name: "AbortError" });
  const pathSource = '{"dup":{"child":99},"dup":[{"a/b~":-0}],"other":false}';
  await expect(
    selectedStateSource(pathSource, ["dup", "0", "a/b~"], signal),
  ).resolves.toBe("-0");
  await expect(
    selectedStateSource(pathSource, ["dup", "child"], signal),
  ).resolves.toBeUndefined();
});

async function mount(
  page: Page,
  inject = false,
  methods = ["state.inspection"],
) {
  await page.route("**/native-state-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { AppStore } = await import('/src/state/store.ts');
      const { AppProvider, useAppStore } = await import('/src/state/index.ts');
      const { NativeStateViewer } = await import('/src/features/state-viewer/NativeStateViewer.tsx');
      await import('/src/styles/tokens.css'); await import('/src/styles/components.css'); await import('/src/styles/chrome.css');
      window.pendingState = []; window.copiedState = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => window.copiedState.push(text) } });
      const readInspection = ${inject ? `(id, signal) => new Promise((resolve) => window.pendingState.push({ id, signal, resolve }))` : "undefined"};
      AppStore.prototype.start = function () {
        window.stateStore = this;
        this.update({ page: 'conversation', viewMode: 'state', sessionId: 's1', composer: 'Keep this draft', resolvedLocale: 'en',
          authSession: { authenticated: true, principal: { owner: 'owner', expires_at: 9999999999999 } },
          capabilities: { methods: ${JSON.stringify(methods)}, limits: {} },
           transcript: { ...this.state.transcript, historyView: { lineage: 'first', epoch: 0 } } });
      };
      function Fixture() {
        useAppStore();
        const [target, setTarget] = React.useState({ sessionId: 's1', active: true });
        window.setStateTarget = setTarget;
        return React.createElement(NativeStateViewer, { ...target, readInspection });
      }
      ReactDOM.createRoot(document.querySelector('#fixture')).render(React.createElement(AppProvider, null, React.createElement(Fixture)));
    </script>`,
    }),
  );
  await page.goto("/native-state-fixture");
}

test("native State copies exact HTTP spans outside its display budget and fences stale clipboard work", async ({
  page,
}) => {
  const requests: string[] = [];
  const sparseTail = `{"wide":90071992547409931234567, "wide":-0, "scientific":1.234567890123456789e+91,"escaped":"a\\nb\\u2665"}`;
  const ordinary = `[${"0,".repeat(1600)}${sparseTail}]`;
  const wire =
    `{"values":{"bytes":${ordinary},"secret":"\\u0066alse","token":{"BODY_MARKER":true},"unknown":{"UNCLASSIFIED_MARKER":true},"empty":"","zero":-0,"nil":null,"flag":false},` +
    `"metadata":{"bytes":{"visibility":"visible"},"secret":{"visibility":"invisible"},"token":{"visibility":"secret"},"empty":{"visibility":"visible"},"zero":{"visibility":"visible"},"nil":{"visibility":"visible"},"flag":{"visibility":"visible"}},` +
    `"descriptors":{},"witness":{"runtime_instance_id":"1a348fbe-3f8f-47e8-b4fc-561531759c42","variables_revision":"9"}}`;
  await page.route("**/api/v1/**", (route) => {
    requests.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    return route.fulfill({ contentType: "application/json", body: wire });
  });
  await mount(page);
  const panel = page.getByRole("region", { name: "Session State" });
  const preview = panel.getByRole("region", { name: "Value preview" });
  const exact = preview.getByTestId("json-copy-root");
  const written = () => page.evaluate(() => (window as any).copiedState);
  await panel.getByRole("button", { name: "bytes Array", exact: true }).click();
  await expect(preview).toContainText("Preview truncated");
  await expect(preview).not.toContainText("90071992547409931234567");
  await preview.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(preview.getByTestId("object-inspector")).toBeVisible();
  await expect(preview).not.toContainText("90071992547409931234567");
  await exact.click();
  await expect.poll(written).toEqual([ordinary]);
  for (const [label, value] of [
    ["secret String", "false"],
    ["empty String", ""],
    ["zero Number", "-0"],
    ["nil Null", "null"],
    ["flag Boolean", "false"],
  ]) {
    await panel.getByRole("button", { name: label, exact: true }).click();
    await exact.click();
    await expect.poll(async () => (await written()).at(-1)).toBe(value);
  }
  for (const label of ["token Secret", "unknown"]) {
    await panel.getByRole("button", { name: label, exact: true }).click();
    await expect(preview).toHaveCount(0);
  }
  await expect(panel).not.toContainText(/BODY_MARKER|UNCLASSIFIED_MARKER/);
  const search = panel.getByRole("searchbox");
  await search.fill("MARKER");
  await expect(panel).toContainText("No matching State fields.");
  await search.clear();

  await panel
    .getByRole("button", { name: "secret String", exact: true })
    .click();
  // A click schedules async evidence resolution. Revoke authority in the same
  // browser task, before the clone reaches the clipboard or publishes feedback.
  await exact.evaluate((button: HTMLElement) => {
    const store = (window as any).stateStore;
    button.click();
    store.update({ capabilities: { methods: [], limits: {} } });
  });
  await expect(preview).toHaveCount(0);
  expect(await written()).toEqual([
    ordinary,
    "false",
    "",
    "-0",
    "null",
    "false",
  ]);
  expect(requests).toEqual(["GET /api/v1/sessions/s1/state/inspection"]);
});

test("native panel inspects a hierarchy and copies references, never protected payloads or draft text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    requests.push(route.request().method());
    return route.fulfill({
      json: stateInspection(
        {
          profile: { "a/b~": ["a searchable city"] },
          hidden: "owner-only",
          token: { SYNTHETIC_RAW_PRIVATE_KEY: "SYNTHETIC_RAW_PRIVATE_VALUE" },
          framework: 1,
        },
        {
          profile: { visibility: "visible", persistence: "persisted" },
          hidden: { visibility: "invisible", persistence: "persisted" },
          token: { visibility: "secret", persistence: "ephemeral" },
          "invalid secret key": { visibility: "secret" },
        },
        "99",
      ),
    });
  });
  await mount(page);
  const panel = page.getByRole("region", { name: "Session State" });
  const search = panel.getByRole("searchbox");
  const copy = panel.getByRole("button", { name: "Copy reference" });
  await panel.getByRole("button", { name: "Expand: profile" }).click();
  await expect(panel.getByRole("button", { name: "a/b~ Array" })).toBeVisible();
  await search.fill("a searchable city");
  await panel.getByRole("button", { name: "0 String" }).click();
  await expect(panel).toContainText("a searchable city");
  await expect(panel.getByText("Custom", { exact: true })).toBeVisible();
  await expect(panel.getByText("99", { exact: true })).toBeVisible();
  await copy.click();
  await expect(panel.getByRole("status")).toHaveText("Reference copied.");
  await search.fill("SYNTHETIC_RAW_PRIVATE");
  await expect(panel).toContainText("No matching State fields.");
  await search.fill("");
  await panel
    .getByRole("button", { name: "token Secret", exact: true })
    .click();
  await expect(panel).toContainText("Secret values cannot be read.");
  expect(
    await panel.evaluate((node) =>
      node.textContent?.includes("SYNTHETIC_RAW_PRIVATE"),
    ),
  ).toBe(false);
  await copy.click();
  for (const name of [
    "hidden String",
    "framework Number",
    "invalid secret key Secret",
  ]) {
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(copy).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).copiedState)).toEqual([
    "{{var:profile:/a~1b~0/0}}",
    "{{secret:token}}",
  ]);
  expect(
    await page.evaluate(
      () => (window as any).stateStore.getSnapshot().composer,
    ),
  ).toBe("Keep this draft");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(requests).toEqual(["GET"]);
});

test("only the selected container renders a preview, with narrow zoomed reflow and no media requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const requests: string[] = [];
  await page.route(/\/api\/v1\/|must-not-load/, (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: stateInspection({
        document: {
          nested: { bytes: '<img src="/must-not-load">' },
          empty: [],
        },
        agent_init: { component: "1234567890abcdef".repeat(4) },
        large: ["界".repeat(4000), ...Array(1600).fill(0)],
      }),
    });
  });
  await mount(page);
  const panel = page.getByRole("region", { name: "Session State" });
  const preview = panel.getByRole("region", { name: "Value preview" });
  const pre = preview.locator("pre");
  await expect(pre).toHaveCount(0);
  const documentRow = panel.getByRole("button", { name: "document Object" });
  await documentRow.focus();
  await page.keyboard.press("Enter");
  await expect(documentRow).toBeFocused();
  await expect(pre).toContainText('"bytes": "<img');
  await expect(panel.locator("img")).toHaveCount(0);
  await panel.getByRole("button", { name: "Expand: document" }).click();
  await panel.getByRole("button", { name: "empty Array" }).click();
  await expect(pre).toHaveText("[]");
  await panel.getByRole("button", { name: "nested Object" }).click();
  await expect(pre).toContainText('"bytes": "<img');
  await expect(preview.getByText("Object", { exact: true })).toBeVisible();

  const digest = "1234567890abcdef".repeat(4);
  await panel.getByRole("button", { name: "agent_init Object" }).click();
  await expect(pre).toContainText(digest.slice(0, 16));
  await expect(pre).not.toContainText(digest);
  const exact = panel.getByRole("button", {
    name: /Show exact evidence|显示精确证据/,
  });
  await expect(exact).toHaveCount(0);
  await panel.getByRole("button", { name: "Expand: agent_init" }).click();
  await panel.getByRole("button", { name: "component String" }).click();
  await expect(pre).not.toContainText(digest);
  await exact.click();
  await expect(pre).toHaveText(`"${digest}"`);

  const originalPreviewFontSize = await pre.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize),
  );
  await page.addStyleTag({
    content:
      "html { font-size: 200%; } .native-state-viewer { font-size: calc(var(--fs-sm) * 2); }",
  });
  await panel.getByRole("button", { name: "large Array" }).click();
  await expect(pre).toHaveCSS("font-size", `${originalPreviewFontSize * 2}px`);
  await expect(preview).toContainText(
    "Preview truncated — expand the tree to inspect individual values.",
  );
  await expect(panel.getByRole("status")).toHaveText(
    "Only a bounded part of the State tree is shown.",
  );
  await expect(pre).not.toContainText("Preview truncated");
  await expect(pre).not.toHaveAttribute("tabindex");
  expect(
    await pre.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as any).stateStore.update({ resolvedLocale: "zh-CN" }),
  );
  await expect(page.getByRole("region", { name: "值预览" })).toContainText(
    "预览已截断 — 展开状态树可查看各个值。",
  );
  expect(requests).toEqual(["/api/v1/sessions/s1/state/inspection"]);
});

test("reference items expose explicit Markdown ref and placeholder copy without rendering external URLs", async ({
  page,
}) => {
  const refId = "ref_0123456789abcdef";
  const response = {
    values: {
      references: [
        {
          id: refId,
          title: "Diagram",
          source_kind: "upload",
          media_type: "image/png",
          byte_length: 33,
          revision: "1_abcd",
          read_only: false,
        },
      ],
    },
    metadata: {},
    descriptors: {
      references: { kind: "reference", editable: false, deletable: false },
    },
    witness: {
      runtime_instance_id: "1a348fbe-3f8f-47e8-b4fc-561531759c42",
      variables_revision: "2",
    },
  };
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: response }));
  await mount(page);
  const panel = page.getByRole("region", { name: "Session State" });
  await panel.getByRole("button", { name: /^references/ }).click();
  await panel.getByRole("button", { name: "Expand: references" }).click();
  await panel.getByRole("button", { name: /^0 / }).click();
  await panel.getByRole("button", { name: "Copy Markdown ref link" }).click();
  expect(await page.evaluate(() => (window as any).copiedState)).toEqual([
    `![${refId}](ref:${refId})`,
  ]);
  await panel
    .getByRole("button", { name: "Copy {{ref:...}} placeholder" })
    .click();
  expect(await page.evaluate(() => (window as any).copiedState)).toEqual([
    `![${refId}](ref:${refId})`,
    `{{ref:base64:${refId}}}`,
  ]);
});

test("plugin State inspection and its publication remain JSON-only", async ({
  page,
}) => {
  await mount(page, true);
  await expect
    .poll(() => page.evaluate(() => (window as any).pendingState?.length))
    .toBe(1);
  const source = stateInspection(
    { ordinary: true },
    {},
    "18446744073709551615",
  );
  const projected = await page.evaluate(async (inspection) => {
    // @ts-expect-error Browser source import is resolved by the existing test server.
    const { ClientPlugins } = await import("/src/state/client-plugins.ts");
    const reads: unknown[] = [];
    let wire: unknown = inspection;
    const bridge: any = new ClientPlugins(
      () => ({ request: async () => wire }),
      (value: unknown) => reads.push(value),
    );
    bridge.session = "s1";
    const effect = {
      kind: "state-inspection",
      payload: {},
      sessionId: "s1",
      context: { session_id: "s1" },
      signal: new AbortController().signal,
    };
    const result = await bridge.effect(effect, 0);
    wire = {
      ...inspection,
      values: { private_image: "SYNTHETIC_BYTE_PAYLOAD" },
      witness: { ...inspection.witness, variables_revision: "not-a-uint" },
    };
    let error: string | undefined;
    try {
      await bridge.effect(effect, 0);
    } catch (cause) {
      error = (cause as Error).message;
    }
    return { result, reads, error };
  }, source);
  expect(projected).toEqual({
    result: stateInspection(
      { ordinary: true },
      {},
      source.witness.variables_revision,
    ),
    reads: [{ ordinary: true }],
    error: "invalid_result",
  });
});

test("long native inspectors scroll within the conversation at mobile and desktop widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  const backend = await nativeBackend(page, {
    extraMethods: ["state.inspection"],
  });
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
    route.fulfill({
      json: stateInspection(
        Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`field-${i}`, i]),
        ),
      ),
    }),
  );
  await page.route("**/api/v1/sessions/s1/history/prompt?*", (route) =>
    route.fulfill({
      json: {
        session_id: "s1",
        history_lineage: "viewer-layout",
        epoch: 0,
        status: "available",
        system: "One long source line\n".repeat(60),
        tools: Array.from({ length: 21 }, (_, i) => ({
          name: `tool-${i}`,
          description: "",
          parameters: {},
        })),
      },
    }),
  );
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  backend.publish({
    ...backend.snapshot(),
    history_view: {
      lineage: "viewer-layout",
      epoch: 0,
      start_cursor: 0,
      end_cursor: 2,
      message_count: 2,
      turns: [],
    },
  });
  await page.locator("#view-tab-prompt").click();
  const prompt = page.getByRole("region", { name: "Frozen Prompt" });
  const source = prompt.getByLabel("SYSTEM source");
  await expect(source).toBeVisible();
  await expect(source).toHaveCSS("overflow-y", "auto");
  const assertScrollport = async (panel: typeof prompt) => {
    await expect(panel).toHaveCSS("overflow-y", "auto");
    expect(
      await panel.evaluate(
        (node) =>
          node.scrollHeight > node.clientHeight &&
          node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
  };
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 640 });
    const next = prompt.getByRole("button", { name: "Next declarations" });
    await expect(next).toBeEnabled();
    await assertScrollport(prompt);
    await next.scrollIntoViewIfNeeded();
    expect(await prompt.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await next.click();
    await expect(prompt.getByRole("button", { name: "tool-20" })).toBeVisible();

    await page.locator("#view-tab-state").click();
    const state = page.getByRole("region", { name: "Session State" });
    const last = state.getByRole("button", { name: "field-49 Number" });
    await expect(last).toBeVisible();
    const fields = state.getByRole("navigation", { name: "Session State" });
    const details = state.locator(".native-state-detail");
    const owner = width === 390 ? state : fields;
    await assertScrollport(owner);
    await expect(details).toHaveCSS(
      "overflow-y",
      width === 390 ? "visible" : "auto",
    );
    await last.click();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => owner.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    if (width !== 390)
      expect(await state.evaluate((node) => node.scrollTop)).toBe(0);
    await page.locator("#view-tab-prompt").click();
  }
});

test("history, owner, child and inactive views revoke stale reads and visible results", async ({
  page,
}) => {
  await mount(page, true);
  const pending = () =>
    page.evaluate(() =>
      ((window as any).pendingState ?? []).map(({ id, signal }: any) => [
        id,
        signal.aborted,
      ]),
    );
  const panel = page.getByRole("region", { name: "Session State" });
  await expect.poll(pending).toEqual([["s1", false]]);
  await page.evaluate(() => {
    const store = (window as any).stateStore;
    const { transcript } = store.getSnapshot();
    store.update({ transcript: { ...transcript, historyResetRevision: 1 } });
  });
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", false],
  ]);
  await page.evaluate(
    ([stale, current]) => {
      (window as any).pendingState[0].resolve(stale);
      (window as any).pendingState[1].resolve(current);
    },
    [
      stateInspection({ stale: true }),
      stateInspection({ fresh: { scoped: "owner value" } }),
    ],
  );
  await panel.getByRole("button", { name: "fresh Object" }).click();
  const preview = panel.getByRole("region", { name: "Value preview" });
  await expect(preview).toContainText("owner value");
  await expect(
    panel.getByRole("button", { name: "stale Boolean" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const store = (window as any).stateStore;
    const { authSession } = store.getSnapshot();
    store.update({
      authSession: {
        ...authSession,
        principal: { ...authSession.principal, owner: "replacement" },
      },
    });
  });
  await expect(panel.getByRole("button", { name: "fresh Object" })).toHaveCount(
    0,
  );
  await expect(preview).toHaveCount(0);
  await expect(panel).not.toContainText("owner value");
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", true],
    ["s1", false],
  ]);
  await page.evaluate(() =>
    (window as any).stateStore.update({
      popup: { type: "subagentDetail", childId: "child" },
    }),
  );
  await expect(panel).toContainText("State inspection is unavailable");
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", true],
    ["s1", true],
  ]);
  await page.evaluate(() => {
    (window as any).setStateTarget({ sessionId: "child", active: true });
    (window as any).stateStore.update({ popup: { type: "none" } });
  });
  await expect(panel).toContainText("State inspection is unavailable");
  await page.evaluate(() =>
    (window as any).setStateTarget({ sessionId: "s1", active: false }),
  );
  await expect(panel).toHaveCount(0);
  expect(await pending()).toHaveLength(3);
});

test("servers without State inspection show unreported capacity without an Execution History section", async ({
  page,
}) => {
  await mount(page, false, []);
  const panel = page.getByRole("region", { name: "Session State" });
  await expect(panel.getByRole("status")).toHaveText(
    "State inspection is unavailable in this view.",
  );
  await expect(
    panel.getByRole("heading", { name: "Runtime execution capacity" }),
  ).toBeVisible();
  await expect(panel.getByText("Not reported", { exact: true })).toHaveCount(2);
  await expect(
    panel.getByRole("heading", { name: "Execution history" }),
  ).toHaveCount(0);
});

test("the actual State tab keeps capacity and mounted Chat without listing executions", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await nativeBackend(page, {
    extraMethods: ["state.inspection", "executions.list"],
  });
  const stateReads: string[] = [];
  const executionReads: string[] = [];
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    stateReads.push(route.request().method());
    return route.fulfill({
      json: stateInspection({
        stable: true,
        execution_capacity: {
          buffers: { limit: 8, used: 7, remaining: 1 },
          pending: { limit: 16, used: "1", remaining: 15 },
        },
      }),
    });
  });
  await page.route(
    /\/api\/v1\/sessions\/[^/]+\/executions(?:\?|$)/,
    (route) => {
      executionReads.push(route.request().url());
      return route.fulfill({ json: { items: [], next_cursor: null } });
    },
  );
  await page.goto("/#/session/s1");
  const transcript = page.locator("#conversation-transcript");
  await expect(transcript.getByText("历史提问", { exact: true })).toBeVisible();
  await transcript.evaluate((node) =>
    node.setAttribute("data-state-regression", "retained"),
  );
  expect(stateReads).toEqual([]);
  const stateTab = page.locator("#view-tab-state");
  await stateTab.focus();
  await page.keyboard.press("Enter");
  await expect(stateTab).toBeFocused();
  const panel = page.getByRole("region", { name: "Session State" });
  const field = panel.getByRole("button", { name: "stable Boolean" });
  await expect(field).toBeVisible();
  await expect(panel.getByText("7 of 8 used · 1 remaining")).toBeVisible();
  await expect(panel.getByText("Not reported", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Execution history" }),
  ).toHaveCount(0);
  await expect(transcript).toBeHidden();
  await expect(transcript).toHaveAttribute("data-state-regression", "retained");

  await panel.getByRole("button", { name: "Refresh State" }).click();
  await expect(field).toBeVisible();
  await page.locator("#view-tab-chat").click();
  await expect(panel).toHaveCount(0);
  await expect(transcript).toBeVisible();
  await expect(transcript).toHaveAttribute("data-state-regression", "retained");
  expect(stateReads).toEqual(["GET", "GET"]);

  await stateTab.click();
  await expect(field).toBeVisible();
  expect(stateReads).toEqual(["GET", "GET", "GET"]);
  expect(executionReads).toEqual([]);
});


test("State distinguishes attach and recovery without reading outside the current scope", async ({ page }) => {
  await mount(page, true);
  const region = page.getByRole("region", { name: "Session State" });
  const reads = () => page.evaluate(() =>
    ((window as any).pendingState ?? []).map(({ signal }: { signal: AbortSignal }) => signal.aborted),
  );
  const update = (patch: Record<string, unknown>) => page.evaluate((value) =>
    (window as any).stateStore.update(value), patch,
  );
  await expect.poll(reads).toEqual([false]);
  await update({ sessionAttachingId: "s2" });
  await expect(region.getByRole("status")).toHaveText("Opening session…");
  await expect.poll(reads).toEqual([true]);
  await update({ sessionAttachingId: null, sessionTransportRecovery: "recovering" });
  await expect(region.getByRole("status")).toContainText("Restoring the Session connection");
  expect(await reads()).toEqual([true]);
  await update({ sessionTransportRecovery: "forbidden" });
  await expect(region.getByRole("status")).toHaveText("The server refused access to this Session connection.");
  await update({ authRequired: true });
  await expect(region.getByRole("status")).toHaveText("State inspection is unavailable in this view.");
  expect(await reads()).toEqual([true]);
  await update({ authRequired: false, sessionTransportRecovery: null });
  await expect.poll(reads).toEqual([true, false]);
});
