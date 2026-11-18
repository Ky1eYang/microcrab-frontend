import { expect, test, type Page } from "@playwright/test";

async function mount(
  page: Page,
  original: string,
  variant: string,
  options: { rich?: { streaming: boolean }; citation?: boolean } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/markdown-interleaved-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const module=await import('/src/features/markdown-interleaved.tsx');
const {Markdown}=await import('/src/features/views.tsx');
await import('/src/features/plugin-block-variants.css');
const {setActiveLocale}=await import('/src/i18n/index.ts'); setActiveLocale('en');
window.interleavedModule=module;
window.props=${JSON.stringify({ original, variant, label: "Variant label", ...options }).replace(/</g, "\\u003c")};
window.citationReads=[]; window.authorized=true;
if(window.props.citation)window.props.citation={owner:'owner',sessionId:'parent',childSessionId:'child',historyLineage:'history',messageId:'message',current:()=>window.authorized,read:async(request)=>{window.citationReads.push(request);return new Blob(['fixture'],{type:'text/plain'});}};
const root=ReactDOM.createRoot(document.getElementById('fixture'));
window.renderInterleaved=(patch={})=>{Object.assign(window.props,patch);root.render(React.createElement(module.InterleavedMarkdown,window.props));};
window.copyInterleaved=()=>module.interleavedMarkdownText(window.props.original,window.props.variant);
window.renderCopied=()=>root.render(React.createElement(Markdown,{text:window.copyInterleaved()}));
window.renderInterleaved();
</script></body></html>`,
    }),
  );
  await page.goto("/markdown-interleaved-fixture");
  await expect(page.locator(".markdown-interleaved")).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}

async function copied(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).copyInterleaved());
}

test("two paragraphs alternate in DOM and raw copy order, retaining whitespace", async ({
  page,
}) => {
  await mount(
    page,
    "  Original one\r\n\r\nOriginal two\r\n",
    "Variant one\n\nVariant two\n",
  );
  await expect(page.locator("[data-alignment]")).toHaveAttribute(
    "data-alignment",
    "blocks",
  );
  await expect(page.locator(".markdown-body p")).toHaveText([
    "Original one",
    "Variant one",
    "Original two",
    "Variant two",
  ]);
  expect(await copied(page)).toBe(
    "  Original one\r\n\r\n\n\n---\n\nVariant one\n\n\n\n---\n\nOriginal two\r\n\n\n---\n\nVariant two\n",
  );
});

test("GFM lists, blockquotes, tables and fenced code remain atomic with heading attributes", async ({
  page,
}) => {
  const source =
    "# Source {.kept #source-id}\n\n- Outer\n  - Nested\n\n  continuation\n\n> quote\n>\n> second\n\n| A | B |\n| - | - |\n| x | y |\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nInline ``a ` b`` tail";
  const variant = source
    .replace("Source", "Variant")
    .replace("#source-id", "#variant-id")
    .replace("Outer", "Translated");
  await mount(page, source, variant);
  await expect(page.locator("[data-alignment]")).toHaveAttribute(
    "data-alignment",
    "blocks",
  );
  await expect(page.locator("[data-interleaved=original]")).toHaveCount(6);
  await expect(page.locator("#source-id.kept")).toHaveText("Source");
  await expect(page.locator("[data-interleaved=original] ul ul")).toHaveCount(
    1,
  );
  await expect(
    page.locator("[data-interleaved=original] blockquote p"),
  ).toHaveText(["quote", "second"]);
  await expect(page.locator("table")).toHaveCount(2);
  await expect(page.locator("[data-interleaved=original] pre")).toContainText(
    "const x = 1;\n\nconst y = 2;",
  );
  const text = await copied(page);
  expect(text).toContain("```js\nconst x = 1;\n\nconst y = 2;\n```");
  expect(text).toContain("- Outer\n  - Nested\n\n  continuation");
  expect(text.indexOf("# Source")).toBeLessThan(text.indexOf("# Variant"));
  expect(text.indexOf("# Variant")).toBeLessThan(text.indexOf("- Outer"));
});

test("reference definitions resolve in every fragment and occur only once per source in copy", async ({
  page,
}) => {
  const original =
    'First [one][ref].\n\n- Nested [two][ref]\n\nLast [three][ref].\n\n[ref]: https://example.com/source "Title"\n';
  const variant = original
    .replaceAll("[ref]", "[translated]")
    .replace("/source", "/variant");
  await mount(page, original, variant);
  await expect(page.locator("[data-alignment]")).toHaveAttribute(
    "data-alignment",
    "blocks",
  );
  await expect(
    page.locator(
      '[data-interleaved=original] a[href="https://example.com/source"]',
    ),
  ).toHaveCount(3);
  await expect(
    page.locator(
      '[data-interleaved=variant] a[href="https://example.com/variant"]',
    ),
  ).toHaveCount(3);
  const text = await copied(page);
  expect(text.split("[interleaved-original-0]:").length - 1).toBe(1);
  expect(text.split("[interleaved-variant-0]:").length - 1).toBe(1);
  expect(text).toContain(
    '[interleaved-original-0]: https://example.com/source "Title"\n',
  );
});

for (const [name, original, variant] of [
  ["split paragraphs", "One\n\nTwo", "Merged one and two"],
  ["merge paragraphs", "Merged source", "One\n\nTwo"],
  ["different types", "# Heading\n\nBody", "Paragraph\n\nBody"],
  ["empty variant", "Original", ""],
  ["empty original", "", "Variant"],
  [
    "footnotes",
    "One[^a]\n\nTwo[^a]\n\n[^a]: note",
    "First[^b]\n\nSecond[^b]\n\n[^b]: translated",
  ],
  [
    "nested definitions",
    "> [ref]: https://example.com\n\n[Link][ref]",
    "> [ref]: https://example.org\n\n[Link][ref]",
  ],
  [
    "semantic HTML",
    "<details><summary>Title</summary>\n\nBody\n\n</details>",
    "<details><summary>Variant</summary>\n\nBody\n\n</details>",
  ],
] as const) {
  test(`${name} conservatively groups complete raw documents`, async ({
    page,
  }) => {
    await mount(page, original, variant);
    await expect(page.locator("[data-alignment]")).toHaveAttribute(
      "data-alignment",
      "grouped",
    );
    await expect(page.locator("[data-interleaved=original]")).toHaveCount(1);
    await expect(page.locator("[data-interleaved=variant]")).toHaveCount(1);
    if (name === "nested definitions") {
      const text = await copied(page);
      expect(text).toContain("> [interleaved-original-0]: https://example.com");
      expect(text).toContain("> [interleaved-variant-0]: https://example.org");
    } else if (name === "footnotes") {
      expect(await copied(page)).toBe(
        `${original.replaceAll("[^a]", "[^interleaved-original-footnote-0]")}\n\n---\n\n${variant.replaceAll("[^b]", "[^interleaved-variant-footnote-0]")}`,
      );
    } else expect(await copied(page)).toBe(`${original}\n\n---\n\n${variant}`);
  });
}

test("footnote document fallback retains distinct global anchors and backlinks", async ({
  page,
}) => {
  await mount(
    page,
    "One[^a]\n\nTwo[^a]\n\n[^a]: source note",
    "First[^a]\n\nSecond[^a]\n\n[^a]: variant note",
  );
  await expect(
    page.locator("[data-interleaved=original] [data-footnote-ref]"),
  ).toHaveCount(2);
  await expect(
    page.locator("[data-interleaved=original] [data-footnote-backref]"),
  ).toHaveCount(2);
  await expect(
    page.locator("[data-interleaved=variant] .footnotes"),
  ).toContainText("variant note");
  expect(
    await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
      return {
        unique: ids.length === new Set(ids).size,
        localDescriptions: [
          ...document.querySelectorAll<HTMLElement>("[data-footnote-ref]"),
        ].every((anchor) => {
          const labels =
            anchor.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
          return (
            labels.length > 0 &&
            labels.every(
              (id) =>
                document.getElementById(id)?.closest("[data-interleaved]") ===
                anchor.closest("[data-interleaved]"),
            )
          );
        }),
        localTargets: [
          ...document.querySelectorAll<HTMLAnchorElement>(
            "[data-footnote-ref], [data-footnote-backref]",
          ),
        ].every(
          (anchor) =>
            document
              .getElementById(decodeURIComponent(anchor.hash.slice(1)))
              ?.closest("[data-interleaved]") ===
            anchor.closest("[data-interleaved]"),
        ),
      };
    }),
  ).toEqual({ unique: true, localDescriptions: true, localTargets: true });
});

test("node budget bounds fragment rendering without losing source content", async ({
  page,
}) => {
  const original = Array.from({ length: 300 }, (_, i) => `Original ${i}`).join(
    "\n\n",
  );
  const variant = original.replaceAll("Original", "Variant");
  await mount(page, original, variant);
  await expect(page.locator("[data-alignment]")).toHaveAttribute(
    "data-alignment",
    "grouped",
  );
  await expect(page.locator("[data-interleaved=original] p")).toHaveCount(300);
  expect(await copied(page)).toBe(`${original}\n\n---\n\n${variant}`);
});

test("comparison without citation authority never loads original or variant images", async ({
  page,
}) => {
  const images: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("comparison-image")) images.push(request.url());
  });
  await mount(
    page,
    "![Original image](https://example.com/comparison-image-original.png)",
    "![Variant image](https://example.com/comparison-image-variant.png)",
  );
  await expect(page.locator(".markdown-interleaved img")).toHaveCount(0);
  await expect(page.locator("[data-interleaved=original]")).toContainText(
    "Original image",
  );
  await expect(page.locator("[data-interleaved=variant]")).toContainText(
    "Variant image",
  );
  expect(images).toEqual([]);
});

test("raw HTML stays inert and variants never receive images or rich engine authority", async ({
  page,
}) => {
  const original =
    'Source `literal`\n\n```svg\n<svg width="20" height="20"><rect width="20" height="20"/></svg>\n```';
  const variant =
    '![remote](https://example.com/should-not-load.png)\n\n<script>window.injected=true</script>\n\n<a href="javascript:alert(1)">unsafe</a>\n\n```svg\n<svg><rect/></svg>\n```';
  const images: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("should-not-load")) images.push(request.url());
  });
  await mount(page, original, variant, { rich: { streaming: false } });
  await expect(
    page.locator("[data-interleaved=original] [data-testid=svg-preview]"),
  ).toHaveCount(1);
  await expect(
    page.locator(
      "[data-interleaved=variant] img, [data-interleaved=variant] script, [data-interleaved=variant] [data-testid=svg-preview]",
    ),
  ).toHaveCount(0);
  await expect(page.locator("[data-interleaved=variant]")).toContainText(
    "remote",
  );
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  expect(images).toEqual([]);
});

test("rich math is retained only for the source and parent citation authority stays exact", async ({
  page,
}) => {
  const text = "Formula $x^2$ and [local](docs/file.txt).\n\nSecond $y^2$.";
  await mount(page, text, text, { rich: { streaming: false }, citation: true });
  await expect(page.locator("[data-alignment]")).toHaveAttribute(
    "data-alignment",
    "blocks",
  );
  await expect(page.locator("[data-interleaved=original] .katex")).toHaveCount(
    2,
  );
  await expect(
    page.locator(
      "[data-interleaved=variant] .katex, [data-interleaved=variant] [data-testid=file-citation]",
    ),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-interleaved=original] [data-testid=file-citation]"),
  ).toHaveCount(1);
  await page.getByTestId("file-citation").click();
  expect(await page.evaluate(() => (window as any).citationReads)).toEqual([
    {
      sessionId: "parent",
      childSessionId: "child",
      messageId: "message",
      historyLineage: "history",
      href: "docs/file.txt",
    },
  ]);
  await page.evaluate(() => {
    (window as any).authorized = false;
  });
  await page.getByTestId("file-citation").click();
  expect(await page.evaluate(() => (window as any).citationReads.length)).toBe(
    1,
  );
  await page.evaluate(() =>
    (window as any).renderInterleaved({ rich: { streaming: true } }),
  );
  await expect(page.locator(".katex")).toHaveCount(0);
});

test("copy namespaces full, collapsed, shortcut and image references without changing captions, code or URLs", async ({
  page,
}) => {
  const original =
    '[same][ref] [ref][] [ref] ![picture][ref]\n\n`[ref]`\n\n```text\n[ref]: code untouched\n```\n\n[ref]: https://example.com/original "Original title"';
  const variant =
    '[译][ref] [ref][] [ref] ![图片][ref]\n\n`[ref]`\n\n```text\n[ref]: code untouched\n```\n\n[ref]: https://example.com/variant "Variant title"';
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await mount(page, original, variant);
  const text = await copied(page);
  expect(text).toContain(
    "[same][interleaved-original-0] [ref][interleaved-original-0] [ref][interleaved-original-0] ![picture][interleaved-original-0]",
  );
  expect(text).toContain(
    "[译][interleaved-variant-0] [ref][interleaved-variant-0] [ref][interleaved-variant-0] ![图片][interleaved-variant-0]",
  );
  expect(text.split("[ref]: code untouched").length - 1).toBe(2);
  expect(text.split("`[ref]`").length - 1).toBe(2);
  await page.evaluate(() => (window as any).renderCopied());
  await expect(
    page.locator('a[href="https://example.com/original"]'),
  ).toHaveCount(3);
  await expect(
    page.locator('a[href="https://example.com/variant"]'),
  ).toHaveCount(3);
  await expect(page.locator('img[alt="picture"]')).toHaveAttribute(
    "src",
    "https://example.com/original",
  );
  await expect(page.locator('img[alt="图片"]')).toHaveAttribute(
    "src",
    "https://example.com/variant",
  );
});

test("copy isolates identical footnote labels and retains each note body and code", async ({
  page,
}) => {
  const original =
    "Original[^n]. Again[^n].\n\n[^n]: source note\n\n    `[^n]`\n\n    ```text\n    [^n]: source code\n    ```";
  const variant =
    "译文[^n]. Again[^n].\n\n[^n]: variant note\n\n    `[^n]`\n\n    ```text\n    [^n]: variant code\n    ```";
  await mount(page, original, variant);
  const text = await copied(page);
  expect(text).toContain("Original[^interleaved-original-footnote-0]");
  expect(text).toContain("译文[^interleaved-variant-footnote-0]");
  expect(text).toContain("[^interleaved-original-footnote-0]: source note");
  expect(text).toContain("[^interleaved-variant-footnote-0]: variant note");
  expect(text.split("`[^n]`").length - 1).toBe(2);
  expect(text).toContain("[^n]: source code");
  expect(text).toContain("[^n]: variant code");
  await page.evaluate(() => (window as any).renderCopied());
  await expect(page.locator("[data-footnote-ref]")).toHaveCount(4);
  await expect(page.locator(".footnotes > ol > li")).toHaveCount(2);
  await expect(page.locator(".footnotes > ol > li").nth(0)).toContainText(
    "source note",
  );
  await expect(page.locator(".footnotes > ol > li").nth(1)).toContainText(
    "variant note",
  );
  expect(
    await page
      .locator("[data-footnote-ref]")
      .evaluateAll((anchors) =>
        anchors.map(
          (anchor) =>
            document.getElementById(
              decodeURIComponent((anchor as HTMLAnchorElement).hash.slice(1)),
            )?.textContent,
        ),
      ),
  ).toEqual([
    expect.stringContaining("source note"),
    expect.stringContaining("source note"),
    expect.stringContaining("variant note"),
    expect.stringContaining("variant note"),
  ]);
});

test("comparison omits plugin labels and separates each structural block with a divider", async ({
  page,
}) => {
  await mount(page, "Original paragraph", "Variant paragraph");
  await page.evaluate(() =>
    (window as any).renderInterleaved({ label: "``` <custom> &amp;\r\nLabel" }),
  );
  await expect(page.locator(".markdown-interleaved")).not.toContainText(
    "Label",
  );
  await expect(page.locator(".markdown-interleaved > hr")).toHaveCount(1);
  await page.evaluate(() => (window as any).renderCopied());
  await expect(page.locator(".markdown-body p")).toHaveText([
    "Original paragraph",
    "Variant paragraph",
  ]);
  await expect(page.locator(".markdown-body hr")).toHaveCount(1);
  await expect(page.locator("pre, custom")).toHaveCount(0);
});
