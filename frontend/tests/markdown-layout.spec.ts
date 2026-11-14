import { expect, test, type Page } from "@playwright/test";

// Mount production components and styles in their actual conversation wrappers.
// The fixture has no backend dependency and works with any Vite baseURL.
async function mount(page: Page, text: string, mixed = false) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/markdown-layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { createElement: h } = React;
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
const { createRoot } = ReactDOM;
const { Markdown, Think, ToolAccordionGroup, CompactionSummaryCard, ActionBar } = await import('/src/features/views.tsx');
const { AppProvider, AppStore } = await import('/src/state/index.ts');
// This is a render-only component fixture, not an unauthenticated app entry.
AppStore.prototype.start = function() {};
await import('/src/styles/tokens.css');
await import('/src/styles/chrome.css');
await import('/src/styles/components.css');
const text = ${JSON.stringify(text).replace(/</g, "\\u003c")};
const body = (value, user = false) => h('article', {className:'block', 'data-role':user ? 'user' : 'assistant'},
  h('div', {className:'block-body' + (user ? ' user-bubble' : '')}, h(Markdown, {text:value})));
const turn = (user, children) => h('div', {className:'message-turn-container ' + (user ? 'user-turn' : 'assistant-turn')},
  ...children, h(ActionBar, {text, user}));
createRoot(document.getElementById('fixture')).render(h(AppProvider, null,
  h('div', {className:'transcript-inner', style:{width:'100%', maxWidth:'760px'}},
    turn(true, [body(text, true)]),
    turn(false, ${mixed} ? [
      body('First paragraph\\n\\nSecond paragraph'),
      h(Think, {text:'Thought one\\n\\nThought two', streaming:false}),
      h(ToolAccordionGroup, {tools:[{id:'tool-1', payload:{text:''}, tool:{name:'read', status:'completed', input:{path:'README.md'}, output:'ok'}}]}),
      h(CompactionSummaryCard, {summary:'Summary one\\n\\nSummary two', shadowedCount:8}),
      body('Final paragraph')
    ] : [body(text)])
  )));
</script></body></html>`,
    }),
  );
  await page.goto("/markdown-layout");
  await expect
    .poll(async () => {
      if (errors.length) throw new Error(errors.join("\n"));
      return page.locator(".markdown-body").count();
    })
    .toBeGreaterThan(0);
  await page.evaluate(() => document.fonts.ready);
}

test("paragraph geometry is 8px in user and assistant wrappers", async ({
  page,
}) => {
  await mount(page, "First paragraph\n\nSecond paragraph");
  for (const markdown of await page.locator(".markdown-body").all()) {
    const geometry = await markdown.evaluate((root) => {
      const [first, second] = [...root.querySelectorAll("p")].map((p) =>
        p.getBoundingClientRect(),
      );
      return {
        gap: second.top - first.bottom,
        height: root.getBoundingClientRect().height,
      };
    });
    expect(geometry.gap).toBeCloseTo(8, 2);
    // Preserve the user's 22px body line-height, with no newline text-node rows.
    expect(geometry.height).toBeCloseTo(52, 2);
  }
});

test("all heading levels meet lists and code cards at 4px", async ({
  page,
}) => {
  const text = Array.from({ length: 6 }, (_, i) => {
    const heading = "#".repeat(i + 1);
    return `${heading} List\n\n- item\n\n${heading} Ordered\n\n1. item\n\n${heading} Code\n\n\`\`\`text\nline\n\`\`\``;
  }).join("\n\n");
  await mount(page, text);
  const gaps = await page
    .locator(".markdown-body")
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(
          (heading) =>
            heading.nextElementSibling!.getBoundingClientRect().top -
            heading.getBoundingClientRect().bottom,
        ),
      ),
    );
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) expect(gap).toBeCloseTo(4, 2);
});

test("code uses real 19px line boxes, full language labels and local scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(
    page,
    "```c++\na\nb\nc\n```\n\n```c#\n" +
      "long ".repeat(100) +
      "\n```\n\n```\nplain\n```",
  );
  await expect(page.locator(".user-turn .code-block-lang")).toHaveText([
    "c++",
    "c#",
    "text",
  ]);
  const geometry = await page
    .locator(".assistant-turn pre")
    .first()
    .evaluate((pre) => {
      const text = pre.querySelector("code")!.firstChild!;
      const ys = [0, 2, 4].map((offset) => {
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        return range.getBoundingClientRect().top;
      });
      return {
        steps: [ys[1] - ys[0], ys[2] - ys[1]],
        height: pre.getBoundingClientRect().height,
      };
    });
  for (const step of geometry.steps) expect(step).toBeCloseTo(19, 2);
  expect(geometry.height).toBeCloseTo(77, 2);
  const scroll = await page
    .locator(".assistant-turn pre")
    .nth(1)
    .evaluate((pre) => {
      pre.scrollLeft = 100;
      return {
        left: pre.scrollLeft,
        overflow: pre.scrollWidth > pre.clientWidth,
      };
    });
  expect(scroll.overflow).toBe(true);
  expect(scroll.left).toBe(100);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("mixed Think Tool Compact blocks and actions keep stable flow", async ({
  page,
}) => {
  await mount(page, "Question", true);
  const turn = page.locator(".assistant-turn");
  const bounds = () =>
    turn.evaluate((root) => {
      const children = [...root.children].filter(
        (child) => !child.classList.contains("message-action-bar"),
      );
      const rects = children.map((child) => child.getBoundingClientRect());
      return {
        height: root.getBoundingClientRect().height,
        gaps: rects.slice(1).map((rect, i) => rect.top - rects[i].bottom),
        trailing: root.getBoundingClientRect().bottom - rects.at(-1)!.bottom,
      };
    });
  const collapsed = await bounds();
  expect(collapsed.trailing).toBeGreaterThanOrEqual(0);
  for (const gap of collapsed.gaps) {
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(12);
  }
  await turn.hover();
  await expect(turn.locator(".message-action-bar")).toHaveCSS("opacity", "1");
  expect((await bounds()).height).toBe(collapsed.height);
  await page.locator(".think-toggle-btn").click();
  await page.locator(".tool-accordion-group-header").click();
  await page.locator(".compaction-header-btn").click();
  await expect(page.locator(".think-content")).toBeVisible();
  await expect(page.locator(".tool-accordion-items")).toBeVisible();
  await expect(page.locator(".compaction-row .markdown-body")).toBeVisible();
  const expanded = await bounds();
  expect(expanded.height).toBeGreaterThan(collapsed.height);
  for (const gap of expanded.gaps) {
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(12);
  }
  await page.screenshot({
    path: test.info().outputPath("mixed-expanded.png"),
    fullPage: true,
  });
  await page.locator(".think-toggle-btn").click();
  await page.locator(".tool-accordion-group-header").click();
  await page.locator(".compaction-header-btn").click();
  expect((await bounds()).height).toBe(collapsed.height);
});
