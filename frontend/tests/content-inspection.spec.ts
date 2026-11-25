import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  presentContent,
  RICH_TEXT_LIMIT,
  SYNTAX_TOKEN_LIMIT,
} from "../src/features/content-inspection/format";
import { parseUnifiedDiff } from "../src/features/content-inspection/unified-diff";

async function secondary(viewer: Locator, key: string) {
  const action = viewer.getByTestId(`content-viewer-${key}`);
  if (!(await action.isVisible()))
    await viewer.getByTestId("content-viewer-more").click();
  return action;
}

// Mount the real Payload, viewer, editor and ContentDialog, not a copied toolbar.
// Parent runs these with the normal Vite/native browser gate; no extra server.
async function mount(
  page: Page,
  value: string,
  options: { editable?: boolean; dialog?: boolean; theme?: string } = {},
) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copied = text;
        },
      },
    });
  });
  const fixture = JSON.stringify({ value, ...options }).replace(
    /</g,
    "\\u003c",
  );
  await page.route("**/content-inspection-fixture", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html data-theme="${options.theme ?? "light"}"><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {Payload} = await import('/src/features/Payload.tsx');
const {ContentDialog} = await import('/src/features/ContentDialog.tsx');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('en');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
const fixture = ${fixture};
const root = ReactDOM.createRoot(document.getElementById('fixture'));
window.__calls = [];
window.__context = { witness: { generation: 1 }, hidden: ['full'] };
window.__props = { value: fixture.value, variant: 'inspector', documentId: 'first', editContext: window.__context };
if (fixture.editable) {
  window.__props.editValue = '{"visible":true,"hidden":900719925474099312345}';
  window.__props.onEdit = (text, context) => {
    window.__calls.push({text, context});
    return new Promise((resolve, reject) => { window.__resolve = resolve; window.__reject = reject; });
  };
}
window.__render = (props = {}) => {
  Object.assign(window.__props, props);
  const content = React.createElement(Payload, window.__props);
  root.render(fixture.dialog ? React.createElement(ContentDialog, {title:'Inspection', onClose:()=>root.render(null)}, content) : content);
};
window.__render();
</script></body></html>`,
    }),
  );
  await page.goto("/content-inspection-fixture");
  await expect(page.getByTestId("content-viewer")).toBeVisible();
}

async function copied(page: Page) {
  return page.evaluate(() => (window as any).__copied);
}
async function update(page: Page, value: string, documentId?: string) {
  await page.evaluate(
    ({ value, documentId }) =>
      (window as any).__render({
        value,
        ...(documentId ? { documentId } : {}),
      }),
    { value, documentId },
  );
}

const DIFF_SOURCE = [
  "diff --git a/中文.txt b/中文.txt",
  "index 1111111..2222222 100644",
  "--- a/中文.txt",
  "+++ b/中文.txt",
  "@@ -1,3 +1,4 @@ section",
  " context \t",
  "-old \t",
  "+new \t",
  "+<script>alert(1)</script>",
  " tail",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,2 @@",
  "+first",
  "+last",
  "\\ No newline at end of file",
  "",
].join("\r\n");

test("Unified diff preserves payload, ranges, CRLF and no-newline evidence across files", () => {
  const parsed = parseUnifiedDiff(DIFF_SOURCE, SYNTAX_TOKEN_LIMIT);
  expect(parsed.map((line) => line.text).join("")).toBe(DIFF_SOURCE);
  expect(parsed.filter((line) => line.role === "diff-add")).toHaveLength(4);
  expect(parsed.filter((line) => line.role === "diff-delete")).toHaveLength(1);
  expect(parsed.filter((line) => line.role === "diff-hunk")).toHaveLength(2);
  expect(presentContent(DIFF_SOURCE, "auto")).toEqual({
    text: DIFF_SOURCE,
    kind: "diff",
  });
  const headerLikePayload = "@@ -1 +1 @@\n--- literal\n+++ literal\n";
  expect(
    parseUnifiedDiff(headerLikePayload, SYNTAX_TOKEN_LIMIT).map(
      (line) => line.role,
    ),
  ).toEqual(["diff-hunk", "diff-delete", "diff-add"]);
  for (const source of [
    "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
    "@@ -1 +0,0 @@\n-deleted\n",
    "@@ -1 +1 @@\n \n",
    "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n",
  ])
    expect(presentContent(source, "diff")).toEqual({
      text: source,
      kind: "diff",
    });
});

test("invalid or excessive diff never changes source or silently invents valid structure", () => {
  for (const [source, reason] of [
    ["@@ -1,2 +1 @@\n-old\n+new\n", "Incomplete hunk"],
    ["@@ -1 +1 @@\n-old\n+new\n+extra\n", "Expected a file header"],
    ["@@ -1 +1 @@\nplain\n", "Expected hunk payload"],
    ["@@ -9007199254740992 +1 @@\n", "safe integer"],
    ["--- a/file\n", "Expected +++"],
    ["+++ b/file\n", "no preceding ---"],
    ["@@ malformed @@\n", "hunk header"],
    ["\\ No newline at end of file\n", "must follow"],
    ["diff --git a/a b/a\nGIT binary patch\n", "Binary patch bodies"],
  ]) {
    const view = presentContent(source, "diff");
    expect(view.kind).toBe("raw");
    expect(view.text).toBe(source);
    expect(view.error).toContain(reason);
    expect(presentContent(source, "auto").kind).toBe("raw");
    expect(presentContent(source, "raw")).toEqual({
      text: source,
      kind: "raw",
    });
  }
  const manyLines =
    `@@ -0,0 +1,${SYNTAX_TOKEN_LIMIT} @@\n` + "+x\n".repeat(SYNTAX_TOKEN_LIMIT);
  expect(presentContent(manyLines, "diff").error).toContain("syntax budget");
  const large = DIFF_SOURCE + "x".repeat(RICH_TEXT_LIMIT);
  expect(presentContent(large, "diff")).toEqual({
    text: large,
    kind: "raw",
    notice: "large",
  });
  expect(presentContent("+ ordinary text\n- another item", "auto").kind).toBe(
    "raw",
  );
});

for (const [width, theme] of [
  [1440, "dark"],
  [390, "light"],
] as const) {
  test(`Unified diff dropdown, syntax and copy retain original evidence at ${width}px ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, DIFF_SOURCE, { theme, dialog: true });
    const viewer = page.getByTestId("content-viewer");
    await expect(viewer).toHaveAttribute("data-format", "diff");
    await expect(
      viewer
        .getByRole("combobox")
        .getByRole("option", { name: "Unified diff" }),
    ).toHaveCount(1);
    await expect(viewer.locator(".syntax-diff-add")).toHaveCount(4);
    await expect(viewer.locator(".syntax-diff-delete")).toHaveCount(1);
    await expect(viewer.locator(".syntax-diff-hunk")).toHaveCount(2);
    expect(await viewer.locator("pre").textContent()).toBe(DIFF_SOURCE);
    expect(await viewer.locator("script").count()).toBe(0);
    await viewer.getByRole("combobox").selectOption("diff");
    await (await secondary(viewer, "copyOriginal")).click();
    expect(await copied(page)).toBe(DIFF_SOURCE);
    await (await secondary(viewer, "lineNumbers")).click();
    await (await secondary(viewer, "wrap")).click();
    await viewer.getByTestId("content-viewer-copyFormatted").click();
    expect(await copied(page)).toBe(DIFF_SOURCE);
    await viewer.getByRole("combobox").selectOption("raw");
    await expect(viewer.locator(".syntax-diff-add")).toHaveCount(0);
    expect(await viewer.locator("pre").textContent()).toBe(DIFF_SOURCE);
    await viewer.getByRole("combobox").selectOption("diff");
    await (await secondary(viewer, "wrap")).click();
    await page.screenshot({
      path: `test-results/visual/unified-diff-${width}-${theme}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await update(page, "@@ -1,2 +1 @@\n-old\n+new\n");
    await expect(viewer.getByRole("alert")).toContainText("Incomplete hunk");
  });
}

test("diff and patch Markdown fences and plugin declarations use the shared diff format", async ({
  page,
}) => {
  await mount(
    page,
    "```diff\n@@ -1 +1 @@\n-old\n+new\n```\n\n```patch\n@@ -1 +1 @@\n-before\n+after\n```",
  );
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByRole("combobox").selectOption("markdown");
  await expect(viewer.locator(".syntax-diff-add")).toHaveCount(2);
  await expect(viewer.locator(".syntax-diff-delete")).toHaveCount(2);
  const result = await page.evaluate(async () => {
    const schemaPath = "/src/plugins/schema.ts";
    const formatPath = "/src/features/content-inspection/format.ts";
    const schema = await import(schemaPath);
    const { CONTENT_FORMATS } = await import(formatPath);
    schema.validateTree({
      type: "payload",
      props: {
        value: "@@ -1 +1 @@\n-a\n+b\n",
        allowed_formats: [...CONTENT_FORMATS],
      },
    });
    let rejected = false;
    try {
      schema.validateTree({
        type: "payload",
        props: { allowed_formats: ["diff", "bogus"] },
      });
    } catch {
      rejected = true;
    }
    return rejected;
  });
  expect(result).toBe(true);
});

test("real viewer preserves original JSON bytes, duplicate keys and numeric lexemes", async ({
  page,
}) => {
  const source =
    ' \r\n{"x":900719925474099312345,"x":1e+309,"escaped":"\\u0061","unicode":"中文"}  \r\n';
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  await expect(viewer).toHaveAttribute("data-format", "json");
  const formatted = await viewer.locator("pre").textContent();
  expect(formatted).toContain('"x": 900719925474099312345');
  expect(formatted).toContain('"x": 1e+309');
  expect(formatted).toContain('"escaped": "\\u0061"');
  await (await secondary(viewer, "copyOriginal")).click();
  expect(await copied(page)).toBe(source);
  await (await secondary(viewer, "lineNumbers")).click();
  await (await secondary(viewer, "wrap")).click();
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  expect(await copied(page)).toBe(formatted);
  await viewer.getByRole("combobox").selectOption("raw");
  expect(await viewer.locator("pre").textContent()).toBe(source);
  await expect(viewer.getByTestId("content-viewer-edit")).toHaveCount(0);
});

test("forced JSON/XML failures retain raw input and actionable errors", async ({
  page,
}) => {
  const source = '{"incomplete": [1,}  \r\n';
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByRole("combobox").selectOption("json");
  await expect(viewer.getByRole("alert")).toContainText(
    "Expected a JSON value",
  );
  expect(await viewer.locator("pre").textContent()).toBe(source);
  await update(page, "<root><child></root>");
  await viewer.getByRole("combobox").selectOption("xml");
  await expect(viewer.getByRole("alert")).toContainText(
    "Mismatched XML closing tag",
  );
  expect(await viewer.locator("pre").textContent()).toBe(
    "<root><child></root>",
  );
  await update(
    page,
    '<!DOCTYPE x SYSTEM "https://example.invalid/secret"><x/>',
  );
  await expect(viewer.getByRole("alert")).toContainText(
    "DTD and entity declarations",
  );
});

test("mixed XML, CDATA and xml:space remain text with exact source spacing", async ({
  page,
}) => {
  const source =
    '<root xmlns:n="urn:demo"><p>Hello <n:b>world</n:b> !</p><![CDATA[a < b & raw]]><keep xml:space="preserve">  x\n y </keep><!-- note & raw --></root> \r\n';
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  await expect(viewer).toHaveAttribute("data-format", "xml");
  expect(await viewer.locator("pre").textContent()).toBe(source);
  await expect(viewer).toContainText("Source spacing is preserved");
  await expect(viewer.locator("n\\:b, root, keep")).toHaveCount(0);
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  expect(await copied(page)).toBe(source);
});

test("tool Markdown requires explicit selection and never creates images or scripts", async ({
  page,
}) => {
  const source =
    "# Tool heading\n\n![remote](https://example.invalid/tracker.png)\n\n<script>window.__executed=true</script>\n\n[unsafe](javascript:alert(1))";
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) requests.push(request.url());
  });
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  await expect(viewer.locator("h1")).toHaveCount(0);
  await viewer.getByRole("combobox").selectOption("markdown");
  await expect(
    viewer.getByRole("heading", { name: "Tool heading" }),
  ).toBeVisible();
  await expect(viewer.locator("img, script, iframe")).toHaveCount(0);
  await expect(viewer.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => (window as any).__executed)).toBeUndefined();
  await viewer.getByTestId("content-viewer-copyMarkdown").click();
  expect(await copied(page)).toBe(source);
});

test("save awaits callback, preserves failed draft and captures an independent full-source witness", async ({
  page,
}) => {
  await mount(page, '{"visible":true}', { editable: true, dialog: true });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-edit").click();
  const editor = viewer.getByTestId("content-viewer-editor");
  await expect(editor).toHaveText(
    '{"visible":true,"hidden":900719925474099312345}',
  );
  await editor.fill('{"changed":900719925474099312346}');
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  expect(await copied(page)).toBe('{"changed":900719925474099312346}');
  await (await secondary(viewer, "copyOriginal")).click();
  expect(await copied(page)).toBe(
    '{"visible":true,"hidden":900719925474099312345}',
  );
  await expect(await secondary(viewer, "lineNumbers")).toBeEnabled();
  await viewer.getByTestId("content-viewer-more").click();
  await page.evaluate(() => {
    (window as any).__context.witness.generation = 99;
  });
  await viewer.getByTestId("content-viewer-save").click();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(viewer.getByTestId("content-viewer-save")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() =>
    (window as any).__reject(new Error("Snapshot witness changed")),
  );
  await expect(viewer.getByRole("alert")).toContainText(
    "Snapshot witness changed",
  );
  await expect(editor).toHaveText('{"changed":900719925474099312346}');
  expect(await page.evaluate(() => (window as any).__calls)).toEqual([
    {
      text: '{"changed":900719925474099312346}',
      context: { witness: { generation: 1 }, hidden: ["full"] },
    },
  ]);
  await viewer.getByTestId("content-viewer-cancel").click();
  await expect(viewer.getByTestId("content-viewer-discard")).toBeVisible();
  await viewer.getByTestId("content-viewer-keepEditing").click();
  await expect(editor).toHaveText('{"changed":900719925474099312346}');
  await viewer.getByTestId("content-viewer-save").click();
  await page.evaluate(() => (window as any).__resolve());
  await expect(editor).toHaveCount(0);
});

test("dirty outer dismissal is guarded and read-only controls never invoke save", async ({
  page,
}) => {
  await mount(page, "read view", { editable: true, dialog: true });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByRole("combobox").selectOption("raw");
  await (await secondary(viewer, "wrap")).click();
  await viewer.getByTestId("content-viewer-edit").click();
  await viewer.getByTestId("content-viewer-editor").fill("dirty");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(viewer.getByTestId("content-viewer-discard")).toBeVisible();
  await viewer.getByTestId("content-viewer-discard").click();
  expect(await page.evaluate(() => (window as any).__calls.length)).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("pause freezes display and copy while identity change drops old presentation", async ({
  page,
}) => {
  await mount(page, "first\n  ");
  const viewer = page.getByTestId("content-viewer");
  await (await secondary(viewer, "pause")).click();
  await update(page, "second");
  expect(await viewer.locator("pre").textContent()).toBe("first\n  ");
  await (await secondary(viewer, "copyOriginal")).click();
  expect(await copied(page)).toBe("first\n  ");
  await expect(viewer).toContainText("New content available");
  await (await secondary(viewer, "resume")).click();
  expect(await viewer.locator("pre").textContent()).toBe("second");
  await (await secondary(viewer, "pause")).click();
  await update(page, '{"newOwner":true}', "second-document");
  await expect(viewer).toHaveAttribute("data-format", "json");
  await expect(viewer).toHaveAttribute("data-paused", "false");
  await expect(viewer).toContainText('"newOwner"');
});

test("native repeated Payload edit uses the exact root receipt path", async ({
  page,
}) => {
  await mount(page, "read only");
  await page.evaluate(async () => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const rendererPath = "/src/plugins/renderer.tsx";
    const schemaPath = "/src/plugins/schema.ts";
    const { default: React } = await import(reactPath);
    const { default: ReactDOM } = await import(domPath);
    const { PluginRenderer } = await import(rendererPath);
    const { validateTree } = await import(schemaPath);
    const element = document.createElement("div");
    element.dataset.testid = "repeat-root";
    document.body.append(element);
    const tree = {
      type: "repeat",
      props: { items: { $ref: "rows" }, as: "item" },
      children: [
        {
          type: "payload",
          props: {
            value: { $ref: "item.value" },
            edit_action: "save",
            edit_value: { $ref: "item.value" },
            edit_context: { $ref: "item.context" },
            edit_state: { $ref: "item.edit_state" },
          },
        },
      ],
    };
    validateTree(tree);
    ReactDOM.createRoot(element).render(
      React.createElement(PluginRenderer, {
        view: {
          pluginId: "repeat",
          target: "expanded-page",
          mode: "native-json",
          status: "ready",
          tree,
          vars: {
            rows: [
              {
                value: { value: 1 },
                context: { witness: "exact" },
                edit_state: { status: "idle" },
              },
            ],
          },
        },
        onAction: () => {},
        onVariable: () => {},
        onEditAction: async (
          action: string,
          text: string,
          context: unknown,
          statePath: string,
        ) => {
          (window as any).__repeatSaved = { action, text, context, statePath };
        },
      }),
    );
  });
  const surface = page.getByTestId("repeat-root");
  await expect(
    page
      .getByTestId("content-viewer")
      .first()
      .getByTestId("content-viewer-edit"),
  ).toHaveCount(0);
  await surface.getByTestId("content-viewer-edit").click();
  await surface.getByTestId("content-viewer-editor").fill('{"value":2}');
  await surface.getByTestId("content-viewer-save").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__repeatSaved))
    .toEqual({
      action: "save",
      text: '{"value":2}',
      context: { witness: "exact" },
      statePath: "rows.0.edit_state",
    });
});

test("declared formats constrain the toolbar inside a narrow desktop container", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, '{"value":1}', { editable: true });
  await page.evaluate(() => {
    document.getElementById("fixture")!.style.width = "280px";
    (window as any).__render({
      allowedFormats: ["json", "raw"],
      defaultFormat: "json",
    });
  });
  const viewer = page.getByTestId("content-viewer");
  const formats = viewer.getByRole("combobox", { name: "Display format" });
  await expect(formats).toHaveValue("json");
  await expect(formats.getByRole("option")).toHaveText(["JSON", "Raw"]);
  await expect(viewer.locator(".content-viewer-formats")).toHaveCount(0);
  await formats.selectOption("raw");
  await expect(formats).toHaveValue("raw");
  expect(await viewer.locator("pre").textContent()).toBe('{"value":1}');
  await formats.selectOption("json");
  await expect(viewer.locator(".content-viewer-kind")).toHaveCount(0);
  await expect(
    viewer.getByTestId("content-viewer-copyFormatted"),
  ).toBeVisible();
  await expect(viewer.getByTestId("content-viewer-edit")).toBeVisible();
  await expect(viewer.getByTestId("content-viewer-wrap")).not.toBeVisible();
  const toolbar = viewer.locator(".content-viewer-toolbar");
  expect(
    await toolbar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await viewer.getByTestId("content-viewer-more").click();
  const actions = viewer.getByRole("group", {
    name: "More actions",
    exact: true,
  });
  await expect(
    actions.getByRole("button", { name: "Copy original input" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = (await actions.boundingBox())!;
      const container = (await viewer.boundingBox())!;
      return (
        bounds.x >= container.x &&
        bounds.x + bounds.width <= container.x + container.width + 1
      );
    })
    .toBe(true);
  await page.keyboard.press("Escape");
  await viewer.getByTestId("content-viewer-edit").click();
  await expect(viewer.locator(".cm-gutters")).toBeVisible();
  await expect(viewer.locator(".content-viewer-edit-bar")).toContainText(
    "Editing",
  );
  await viewer.getByTestId("content-viewer-editor").fill('{"value":2}');
  await expect(viewer.locator(".content-viewer-edit-bar")).toContainText(
    "Unsaved changes",
  );
});

test("one format is a label and many formats retain the native choice", async ({
  page,
}) => {
  await mount(page, '{"value":1}');
  const viewer = page.getByTestId("content-viewer");
  await expect(
    viewer.getByRole("combobox", { name: "Display format" }),
  ).toBeVisible();
  await expect(viewer.locator(".content-viewer-kind")).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).__render({ allowedFormats: ["json"] }),
  );
  await expect(viewer.getByRole("combobox")).toHaveCount(0);
  await expect(viewer.locator(".content-viewer-format-label")).toHaveText(
    "JSON",
  );
  await expect(
    viewer.getByRole("button", { name: "JSON", exact: true }),
  ).toHaveCount(0);
});

test("More uses labelled native button rows and preserves keyboard and outside focus", async ({
  page,
}) => {
  await mount(page, '{"value":1}', { dialog: true });
  const viewer = page.getByTestId("content-viewer");
  const more = viewer.getByTestId("content-viewer-more");
  await expect(more).toHaveText("");
  await expect(more).toHaveAccessibleName("More actions");
  expect(
    await more.evaluate((element) => {
      const icon = element.firstElementChild;
      return (
        icon?.tagName.toLowerCase() === "svg" &&
        icon.querySelectorAll('circle[cx="12"]').length === 3 &&
        icon.nextElementSibling === null
      );
    }),
  ).toBe(true);
  await more.focus();
  await page.keyboard.press("Enter");
  const wrap = viewer.getByRole("button", { name: "Soft wrap", exact: true });
  await expect(wrap).toBeVisible();
  await expect(wrap).toHaveText("Soft wrap");
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(wrap.locator(".content-viewer-action-check")).toBeVisible();
  await wrap.hover();
  for (const key of ["wrap", "lineNumbers", "pause", "copyOriginal"]) {
    expect(
      await viewer
        .getByTestId(`content-viewer-${key}`)
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
  }
  await expect(viewer.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(wrap).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(viewer.getByTestId("content-viewer-lineNumbers")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(wrap).not.toBeVisible();
  await expect(more).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Space");
  await wrap.click();
  await expect(more).toBeFocused();
  await more.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(wrap.locator(".content-viewer-action-check")).not.toBeVisible();
  for (const key of ["lineNumbers", "pause", "copyOriginal"]) {
    const row = viewer.getByTestId(`content-viewer-${key}`);
    await expect(row.locator("svg")).toHaveCount(key === "lineNumbers" ? 2 : 1);
    await expect(row.locator("span")).not.toBeEmpty();
  }
  const copy = viewer.getByTestId("content-viewer-copyFormatted");
  await copy.click();
  await expect(wrap).not.toBeVisible();
  await expect(copy).toBeFocused();
});

for (const width of [390, 1440]) {
  test(`document toolbar scrolls out of the reading area at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(
      page,
      JSON.stringify(Array.from({ length: 100 }, (_, line) => ({ line }))),
      { dialog: true },
    );
    const viewer = page.getByTestId("content-viewer");
    const toolbar = viewer.locator(".content-viewer-toolbar");
    const before = await toolbar.boundingBox();
    expect(before).not.toBeNull();
    const scroll = await toolbar.evaluate((element) => {
      let owner = element.parentElement;
      while (
        owner &&
        !(
          owner.scrollHeight > owner.clientHeight &&
          /auto|scroll/.test(getComputedStyle(owner).overflowY)
        )
      )
        owner = owner.parentElement;
      if (!owner) throw new Error("Expected the dialog scroll owner");
      owner.scrollTop = 240;
      return {
        top: owner.getBoundingClientRect().top,
        scrollTop: owner.scrollTop,
      };
    });
    await expect
      .poll(async () => (await toolbar.boundingBox())!.y)
      .toBeLessThan(before!.y - 200);
    const after = (await toolbar.boundingBox())!;
    expect(scroll.scrollTop).toBe(240);
    expect(after.y + after.height).toBeLessThanOrEqual(scroll.top);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("async diagnostics cannot attach to a newer draft or rebase its captured context", async ({
  page,
}) => {
  await mount(page, '{"visible":true}', { editable: true });
  await page.evaluate(() => {
    (window as any).__validations = [];
    (window as any).__render({
      onValidateEdit: (text: string, context: unknown) =>
        new Promise((resolve) => {
          (window as any).__validations.push({ text, context, resolve });
        }),
    });
  });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-edit").click();
  const editor = viewer.getByTestId("content-viewer-editor");
  await expect
    .poll(() => page.evaluate(() => (window as any).__validations.length))
    .toBe(1);
  await editor.fill('{"visible":false}');
  await expect
    .poll(() => page.evaluate(() => (window as any).__validations.length))
    .toBe(2);
  await page.evaluate(() =>
    (window as any).__validations[0].resolve([
      { path: "/hidden", message: "STALE DIAGNOSTIC", severity: "error" },
    ]),
  );
  await expect(viewer).not.toContainText("STALE DIAGNOSTIC");
  await page.evaluate(() =>
    (window as any).__validations[1].resolve([
      {
        path: "/visible",
        message: "Current field is read-only",
        severity: "warning",
      },
    ]),
  );
  await expect(viewer.locator(".content-viewer-feedback")).toContainText(
    "/visible: Current field is read-only",
  );
  await expect(editor).toHaveText('{"visible":false}');
  await viewer.getByTestId("content-viewer-save").click();
  expect(await page.evaluate(() => (window as any).__calls[0])).toEqual({
    text: '{"visible":false}',
    context: { witness: { generation: 1 }, hidden: ["full"] },
  });
});

test("source edits support undo and retain syntax errors without formatting the draft", async ({
  page,
}) => {
  await mount(page, '{"visible":true}', { editable: true });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-edit").click();
  const editor = viewer.getByTestId("content-viewer-editor");
  await editor.fill('{"broken":}');
  await expect(
    viewer.locator(".cm-lintPoint-error, .cm-lintRange-error"),
  ).not.toHaveCount(0);
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  expect(await copied(page)).toBe('{"broken":}');
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toHaveText(
    '{"visible":true,"hidden":900719925474099312345}',
  );
});

test("outcome observation retains the failed draft and never replays a save", async ({
  page,
}) => {
  await mount(page, '{"visible":true}', { editable: true });
  await page.evaluate(() => {
    (window as any).__observations = 0;
    (window as any).__render({
      onObserve: async () => {
        (window as any).__observations++;
      },
    });
  });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-edit").click();
  const editor = viewer.getByTestId("content-viewer-editor");
  await editor.fill('{"visible":false}');
  await editor.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(viewer.getByTestId("content-viewer-discard")).toHaveCount(0);
  await viewer.getByTestId("content-viewer-save").click();
  await page.evaluate(() =>
    (window as any).__reject(
      new Error("Save outcome unknown; check the operation receipt"),
    ),
  );
  await expect(viewer.getByRole("alert")).toContainText("Save outcome unknown");
  await (await secondary(viewer, "reconcile")).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__observations))
    .toBe(1);
  await expect(editor).toHaveText('{"visible":false}');
  expect(await page.evaluate(() => (window as any).__calls.length)).toBe(1);
});

test("clipboard rejection has one accessible prioritized error", async ({
  page,
}) => {
  await mount(page, '{"value":1}');
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  await expect(viewer.getByRole("alert")).toHaveCount(1);
  await expect(viewer.getByRole("alert")).toContainText("Copy failed");
});

test("large captured drafts retain full text in the reduced-impact editor", async ({
  page,
}) => {
  await mount(page, "view only", { editable: true });
  const full = "x".repeat(256 * 1024) + " END";
  await page.evaluate(
    (editValue) => (window as any).__render({ editValue }),
    full,
  );
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByTestId("content-viewer-edit").click();
  const editor = viewer.getByTestId("content-viewer-editor");
  await expect(editor).toHaveValue(full);
  await expect(viewer.getByTestId("content-source-editor")).toHaveCount(0);
  await viewer.getByTestId("content-viewer-copyFormatted").click();
  expect(await copied(page)).toBe(full);
  await viewer.getByTestId("content-viewer-save").click();
  expect(await page.evaluate(() => (window as any).__calls[0].text)).toBe(full);
});

for (const width of [390, 1440]) {
  test(`near 2 MiB keeps complete raw copy and bounded DOM at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const source = "x".repeat(2 * 1024 * 1024 - 8) + " \r\nEND";
    await mount(page, source, { theme: width === 390 ? "dark" : "light" });
    const viewer = page.getByTestId("content-viewer");
    await expect(viewer).toContainText("Large content");
    expect(await viewer.locator("pre").textContent()).toBe(source);
    expect(await viewer.locator("code span").count()).toBeLessThan(10);
    await (await secondary(viewer, "copyOriginal")).click();
    expect(await copied(page)).toBe(source);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("JSON tree preserves duplicate occurrences, paused exact source, clip boundaries, and copy failure", async ({ page }) => {
  const digest = "a".repeat(64);
  const fragment = '{ "wide":90071992547409930000, "wide":-0, "s":"line\\n<em>hello</em>" }';
  const source = ` {"obj":${fragment},"obj":1.30E-483,"version":"${digest}"} \n`;
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  const treeButton = viewer.getByRole("button", { name: "Tree", exact: true });
  const tree = viewer.getByTestId("object-inspector");
  await expect(tree).toHaveCount(0);
  await (await secondary(viewer, "pause")).click();
  await update(page, '{"version":"changed"}');
  await treeButton.click();
  await expect(tree.getByTestId("json-node")).toHaveCount(4);
  await expect(tree).not.toContainText("90071992547409930000");
  const collapsible = tree.getByRole("button", { name: "Expand obj", exact: true });
  const first = tree.getByRole("button", { name: "Copy exact value: obj", exact: true }).first();
  await expect(first).toHaveCSS("opacity", "0");
  await collapsible.hover();
  await expect(first).toHaveCSS("opacity", "1");
  await expect(tree.getByRole("button", { name: "Copy exact value: obj", exact: true }).last()).toHaveCSS("opacity", "0");
  await first.click();
  await expect.poll(() => copied(page)).toBe(fragment);
  await collapsible.focus();
  await page.keyboard.press("Enter");
  await expect(tree.getByTestId("json-node")).toHaveCount(7);
  await expect(tree.locator("em")).toHaveCount(0);
  const stringCopy = tree.getByRole("button", { name: "Copy exact value: s" });
  await stringCopy.focus();
  await expect(stringCopy).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect.poll(() => copied(page)).toBe("line\n<em>hello</em>");
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("rejected"); }; });
  await page.keyboard.press("Enter");
  await expect(viewer.getByText("Could not copy the exact value to the clipboard.")).toBeVisible();
  await update(page, '{"replacement":true}', "new-document");
  await expect(viewer.getByText("Could not copy the exact value to the clipboard.")).toHaveCount(0);
  await expect(tree).toHaveCount(0);
});

test("Text and Tree share a reading surface and expanded strings stay in the same row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const value = "first line\n" + "wrapped text ".repeat(24) + "end of value";
  await mount(page, JSON.stringify({ text: value }));
  const viewer = page.getByTestId("content-viewer");
  const surface = viewer.locator(".json-reading-surface");
  const pre = surface.locator("pre");
  await expect(pre).toBeVisible();
  const font = await pre.evaluate((el) => getComputedStyle(el).font);
  await viewer.getByRole("button", { name: "Tree", exact: true }).click();
  const expand = surface.getByRole("button", { name: "Expand text", exact: true });
  await expect(expand.locator("svg")).toHaveCSS("rotate", "none");
  await expect(surface).not.toContainText("end of value");
  await expand.focus();
  await page.keyboard.press("Enter");
  const collapse = surface.getByRole("button", { name: "Collapse text", exact: true });
  await expect(collapse).toBeFocused();
  await expect(collapse.locator("svg")).toHaveCSS("rotate", "90deg");
  const string = collapse.locator("..").locator(".json-string");
  expect(await string.textContent()).toBe(`"${value}"`);
  expect(await string.evaluate((el) => getComputedStyle(el).font)).toBe(font);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await collapse.press("Enter");
  await expect(surface).not.toContainText("end of value");
});

test("compact display does not become copy evidence and Raw-only never exposes Tree", async ({ page }) => {
  const digest = "a".repeat(64);
  await mount(page, `{"version":"${digest}"}`);
  await page.evaluate(async () => {
    const { toolReferenceProjection } = await import("/src/features/" + "toolReferences.ts");
    const value = (window as any).__props.value;
    (window as any).__render({projection: toolReferenceProjection(value, "coding-file", "result")});
  });
  const viewer = page.getByTestId("content-viewer");
  await viewer.getByRole("button", { name: "Tree", exact: true }).click();
  const tree = viewer.getByTestId("object-inspector");
  await expect(tree).not.toContainText(digest);
  await tree.getByRole("button", { name: "Copy exact value: version" }).click();
  await expect.poll(() => copied(page)).toBe(digest);
  await page.evaluate(() => (window as any).__render({allowedFormats: ["raw"]}));
  await expect(viewer.getByRole("button", { name: "Tree", exact: true })).toHaveCount(0);
});

test("near-response-limit document remains navigable with bounded rows, chunked strings and complete copy", async ({ page }) => {
  const source = '{"items":[' + '0,'.repeat(2500) + 'false],"long":"' + '😁'.repeat(975_000) + '"}';
  await mount(page, source);
  const viewer = page.getByTestId("content-viewer");
  const tree = viewer.getByTestId("object-inspector");
  await viewer.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(tree.getByTestId("json-node")).toHaveCount(3);
  await tree.getByRole("button", { name: "Expand items" }).click();
  await expect(tree.getByTestId("json-node")).toHaveCount(103);
  await tree.getByRole("button", { name: "Next range" }).click();
  await expect(tree.getByText("101–200 of 2501")).toBeVisible();
  await expect(tree.getByTestId("json-node")).toHaveCount(103);
  await tree.getByRole("button", { name: "Expand long" }).click();
  await expect(tree.getByRole("button", { name: "Next section" })).toBeVisible();
  expect((await tree.textContent())!.length).toBeLessThan(10000);
  await tree.getByRole("button", { name: "Copy exact value: long" }).click();
  expect(await page.evaluate(() => (window as any).__copied?.length)).toBe(1_950_000);
  await viewer.getByRole("button", { name: "Text", exact: true }).click();
  await expect(viewer.locator("pre")).toBeVisible();
});
