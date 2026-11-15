import { expect, test, type Page } from "@playwright/test";
import {
  chartOption,
  closedFence,
  safeMath,
  safeMermaid,
  LIMITS,
} from "../src/features/visualizers/policy";

const spec = JSON.stringify({
  xAxis: { type: "category", data: ["A", "B"] },
  yAxis: { type: "value" },
  legend: { data: ["Count"] },
  dataZoom: [{ type: "inside" }],
  tooltip: { trigger: "axis" },
  series: [{ name: "Count", type: "bar", data: [2, 4] }],
});
const fence = (language: string, source: string) =>
  `\`\`\`${language}\n${source}\n\`\`\``;
async function mount(
  page: Page,
  text: string,
  rich: { streaming: boolean } | null = { streaming: false },
) {
  page.on("pageerror", (error) => console.error("Visual fixture page error:", error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as any).__copied = value;
        },
      },
    });
  });
  await page.route("**/rich-visual-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html data-theme="light"><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default: React}=await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {Markdown}=await import('/src/features/views.tsx');
const {setActiveLocale}=await import('/src/i18n/index.ts'); setActiveLocale('en');
await import('/src/styles/tokens.css'); await import('/src/styles/components.css');
const root=ReactDOM.createRoot(document.getElementById('root'));
window.__props=${JSON.stringify({ text, ...(rich ? { rich } : {}) }).replace(/</g, "\\u003c")};
window.__render=(props={})=>{Object.assign(window.__props,props);root.render(React.createElement(Markdown,window.__props));};window.__render();
</script></body></html>`,
    }),
  );
  await page.goto("/rich-visual-fixture");
  await expect(page.locator(".markdown-body")).toBeVisible();
}
async function update(page: Page, props: Record<string, unknown>) {
  await page.evaluate((props) => (window as any).__render(props), props);
}

test("data-only chart admission rejects executable/resource surfaces and bounded work", () => {
  expect(chartOption(spec)).not.toBeNull();
  for (const patch of [
    { graphic: { type: "image", style: { image: "https://evil.test/a" } } },
    { tooltip: { formatter: "<img src=x>" } },
    {
      series: [
        { type: "line", data: [1], symbol: "image://https://evil.test/x" },
      ],
    },
    { title: { text: "https://evil.test" } },
    { series: [{ type: "custom", data: [1] }] },
    { series: [{ type: "line", data: Array(LIMITS.points + 1).fill(0) }] },
    { constructor: {} },
    { xAxis: { data: [{}] } },
  ])
    expect(
      chartOption(JSON.stringify({ ...JSON.parse(spec), ...patch })),
    ).toBeNull();
  expect(chartOption("{")).toBeNull();
  expect(chartOption(" ".repeat(LIMITS.bytes + 1))).toBeNull();
  expect(
    chartOption('{"series":' + "[".repeat(20) + "0" + "]".repeat(20) + "}"),
  ).toBeNull();
  expect(safeMath("\\href{https://evil.test}{x}")).toBe(false);
});

test("Mermaid source admission locks configuration, directives, HTML and complexity", () => {
  expect(safeMermaid("flowchart TD\nA[Start] --> B[End]")).toBe(true);
  expect(safeMermaid("graph TD\nA --- B")).toBe(true);
  expect(
    safeMermaid("classDiagram\nclass Animal {\n+name\n}\nAnimal --> Food"),
  ).toBe(true);
  expect(safeMath("a".repeat(LIMITS.mathBytes + 1))).toBe(false);
  expect(safeMath("\\\\def\\\\x{\\\\x}\\\\x")).toBe(false);
  for (const source of [
    "%%{init: {'securityLevel':'loose'}}%%\ngraph TD\nA-->B",
    "---\nconfig: {}\n---\ngraph TD\nA-->B",
    'graph TD\nclick A "https://evil.test"',
    "graph TD\nA[<img src=x>]",
    "graph TD\n" + "A-->B\n".repeat(200),
  ])
    expect(safeMermaid(source)).toBe(false);
  expect(closedFence("```mermaid\nA-->B")).toBe(false);
  expect(closedFence("```mermaid\nA-->B\n```")).toBe(true);
  expect(closedFence("````mermaid\nA-->B\n```")).toBe(false);
  expect(closedFence("~~~chart\r\n{}\r\n~~~")).toBe(true);
});

test("generic and streaming Markdown do not request visual engines/fonts; incomplete fence stays raw", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const text = fence("mermaid", "flowchart TD\nA-->B") + "\n\n$E=mc^2$";
  await mount(page, text, null);
  await expect(page.getByTestId("code-block")).toBeVisible();
  expect(
    requests.filter((url) =>
      /MermaidBlock|EChartsBlock|math-engine|katex|mermaid\/|\.woff/.test(url),
    ),
  ).toEqual([]);
  await update(page, { rich: { streaming: true } });
  await expect(page.getByTestId("mermaid-preview")).toHaveCount(0);
  expect(
    requests.filter((url) => /MermaidBlock|math-engine|\.woff/.test(url)),
  ).toEqual([]);
  await update(page, {
    text: "```mermaid\nflowchart TD\nA-->B",
    rich: { streaming: false },
  });
  await expect(page.getByTestId("mermaid-preview")).toHaveCount(0);
  expect(requests.filter((url) => /MermaidBlock/.test(url))).toEqual([]);
  await update(page, { text });
  await expect(page.getByTestId("mermaid-preview")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("math-preview")).toBeVisible();
  expect(requests.some((url) => /math-engine/.test(url))).toBe(true);
});

test("Mermaid modal IDs are unique, theme reacts, raw copy preserves CRLF and invalid stays quiet", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const source = "flowchart TD\r\nA[Start] --> B[End]\r\n";
  await mount(page, "```mermaid\r\n" + source + "```");
  await expect(page.getByTestId("mermaid-preview")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByTestId("code-block")
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(source);
  await page
    .getByRole("button", { name: "Expand content", exact: true })
    .click();
  await expect(page.getByTestId("mermaid-preview")).toHaveCount(2);
  const ids = await page
    .locator('[data-testid="mermaid-preview"] svg')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(2);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect(page.getByTestId("mermaid-preview")).toBeVisible();
  await update(page, { text: fence("mermaid", "flowchart TD\nA[broken") });
  await expect(page.getByTestId("mermaid-preview")).toHaveCount(0);
  await expect(page.locator(".code-block-pre")).toContainText("A[broken");
  expect(await page.locator(".visual-mermaid-temporary").count()).toBe(0);
  expect(errors).toEqual([]);
});

test("ECharts retains container and interactions through updates and invalid recovery; resizes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page, fence("echarts", spec));
  await expect(page.getByTestId("echarts-preview")).toHaveAttribute(
    "data-valid",
    "true",
    { timeout: 30000 },
  );
  await page.evaluate(async () => {
    const engine = await import(
      /* @vite-ignore */ "/node_modules/.vite/deps/echarts_core.js"
    );
    const element = document.querySelector('[data-testid="echarts-preview"]')!;
    (window as any).__chartElement = element;
    const chart = engine.getInstanceByDom(element);
    chart.dispatchAction({ type: "legendUnSelect", name: "Count" });
    chart.dispatchAction({ type: "dataZoom", start: 20, end: 80 });
    (window as any).__chart = chart;
  });
  await update(page, {
    text: fence("echarts", spec.replace("[2,4]", "[5,7]")),
  });
  await expect(page.getByTestId("echarts-preview")).toHaveAttribute(
    "data-valid",
    "true",
  );
  expect(
    await page.evaluate(
      () => (window as any).__chart.getOption().legend[0].selected.Count,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => (window as any).__chart.getOption().dataZoom[0].start,
    ),
  ).toBe(20);
  await update(page, { text: fence("echarts", "{invalid") });
  await expect(page.getByTestId("echarts-preview")).toHaveAttribute(
    "data-valid",
    "false",
  );
  await update(page, { text: fence("echarts", spec) });
  await expect(page.getByTestId("echarts-preview")).toHaveAttribute(
    "data-valid",
    "true",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__chartElement ===
        document.querySelector('[data-testid="echarts-preview"]'),
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect
    .poll(() => page.evaluate(() => (window as any).__chart.getWidth()))
    .toBeLessThan(400);
  expect(errors).toEqual([]);
});

test("ECharts shares bounded legend and zoom choices across theme, modal and Raw without crossing identities", async ({
  page,
}) => {
  await mount(page, fence("echarts", spec));
  await expect(page.getByTestId("echarts-preview")).toHaveAttribute(
    "data-valid",
    "true",
    { timeout: 30000 },
  );
  await page.evaluate(async () => {
    (window as any).__chartEngine = await import(
      /* @vite-ignore */ "/node_modules/.vite/deps/echarts_core.js"
    );
    const chart = (window as any).__chartEngine.getInstanceByDom(
      document.querySelector('[data-testid="echarts-preview"]'),
    );
    (window as any).__beforeTheme = chart;
    chart.dispatchAction({ type: "legendUnSelect", name: "Count" });
    chart.dispatchAction({ type: "dataZoom", start: 20, end: 80 });
  });
  const states = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="echarts-preview"]')].map(
        (element) => {
          const chart = (window as any).__chartEngine.getInstanceByDom(element);
          const option = chart?.getOption();
          return option?.legend && option?.dataZoom
            ? {
                selected: option.legend[0].selected.Count !== false,
                start: option.dataZoom[0].start,
                end: option.dataZoom[0].end,
              }
            : null;
        },
      ),
    );
  const selected = (value: boolean, start: number, end: number) => ({
    selected: value,
    start,
    end,
  });
  await expect.poll(states).toEqual([selected(false, 20, 80)]);
  await update(page, {
    text: fence("echarts", spec.replace("[2,4]", "[7,9]")),
  });
  await expect.poll(states).toEqual([selected(false, 20, 80)]);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect
    .poll(() => page.evaluate(() => (window as any).__beforeTheme.isDisposed()))
    .toBe(true);
  await expect.poll(states).toEqual([selected(false, 20, 80)]);
  await page
    .getByRole("button", { name: "Expand content", exact: true })
    .click();
  await expect
    .poll(states)
    .toEqual([selected(false, 20, 80), selected(false, 20, 80)]);
  await page.evaluate(() => {
    const chart = (window as any).__chartEngine.getInstanceByDom(
      document.querySelector('dialog [data-testid="echarts-preview"]'),
    );
    chart.dispatchAction({ type: "legendSelect", name: "Count" });
    chart.dispatchAction({ type: "dataZoom", start: 35, end: 70 });
  });
  await expect
    .poll(states)
    .toEqual([selected(true, 35, 70), selected(true, 35, 70)]);
  await page.keyboard.press("Escape");
  await expect.poll(states).toEqual([selected(true, 35, 70)]);
  await page
    .getByRole("combobox", { name: "Display format" })
    .selectOption("raw");
  await expect(page.getByTestId("echarts-preview")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Display format" })
    .selectOption("preview");
  await expect.poll(states).toEqual([selected(true, 35, 70)]);
  await update(page, {
    text: fence("echarts", spec.replaceAll("Count", "Other")),
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const chart = (window as any).__chartEngine.getInstanceByDom(
          document.querySelector('[data-testid="echarts-preview"]'),
        );
        const option = chart?.getOption();
        return option?.legend && option?.dataZoom
          ? {
              selected: option.legend[0].selected.Other !== false,
              start: option.dataZoom[0].start,
              end: option.dataZoom[0].end,
            }
          : null;
      }),
    )
    .toEqual(selected(true, 0, 100));
});

test("currency, ambiguous dollars, malformed math and untrusted math fall back quietly", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await mount(page, "Costs $5 and $10. Also $word$ and $ x $.");
  await expect(page.getByTestId("math-preview")).toHaveCount(0);
  expect(requests.filter((url) => /math-engine|\.woff/.test(url))).toEqual([]);
  await update(page, { text: "$\\href{https://evil.test}{x}$" });
  await expect(page.getByTestId("math-preview")).toHaveCount(0);
  await update(page, { text: "$$\n\\frac{a}{b} = c\n$$" });
  await expect(page.getByTestId("math-preview")).toBeVisible();
  await update(page, { text: "$$\n\\frac{a}{b}" });
  await expect(page.getByTestId("math-preview")).toHaveCount(0);
  await update(page, { text: "$$\\rule{999em}{999em}$$" });
  await expect(page.getByTestId("math-preview")).toBeVisible();
  expect(await page.getByTestId("math-preview").innerHTML()).not.toContain(
    "width:999em",
  );
  await update(page, { text: "$\\frac{$" });
  await expect(page.getByTestId("math-preview")).toHaveCount(0);
});
