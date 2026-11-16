import { expect, test, type Page } from "@playwright/test";

const cat = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><defs><linearGradient id="paint"><stop offset="0" stop-color="#f7f4ee"/><stop offset="1" stop-color="burlywood"/></linearGradient><clipPath id="cut"><circle cx="120" cy="120" r="100"/></clipPath></defs><rect width="240" height="240" fill="url(#paint)"/><g clip-path="url('#cut')"><path d="M40 90 L70 20 L110 80 L160 20 L200 90 Z" fill="orange"/><ellipse cx="120" cy="140" rx="80" ry="70"/><polygon points="90,130 100,120 110,130"/><text x="120" y="220" text-anchor="middle">Cat &amp; friend</text></g></svg>`;

async function fixture(page: Page) {
  await page.route("**/svg-policy-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><style>:root{--text:rgb(30,40,50)}html[data-theme=dark]{--text:rgb(210,220,230)}</style></head><body><svg width="20" height="20"><rect id="host-paint" class="shared" width="20" height="20" fill="green"/></svg><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {default:SvgBlock}=await import('/src/features/visualizers/SvgBlock.tsx');
const {VisualPreview,visualLanguage}=await import('/src/features/visualizers/VisualPreview.tsx');
const {sanitizeSvg}=await import('/src/features/visualizers/svg-policy.ts');
window.sanitizeSvg=sanitizeSvg;window.visualLanguage=visualLanguage;
const root=ReactDOM.createRoot(document.getElementById('root'));
window.renderSvg=(sources,preview=false)=>root.render(React.createElement(React.Fragment,null,...sources.map((source,i)=>React.createElement(preview?VisualPreview:SvgBlock,{key:i,source,fallback:React.createElement('pre',{'data-testid':'fallback'},source),inline:!preview,language:i?'xml-svg':'svg'}))));
window.ready=true;
</script></body></html>`,
    }),
  );
  await page.goto("/svg-policy-fixture");
  await page.waitForFunction(() => (window as any).ready);
}
async function sanitize(page: Page, source: string, prefix = "test") {
  return page.evaluate(
    ({ source, prefix }) =>
      (window as any).sanitizeSvg(source, prefix) as string | null,
    { source, prefix },
  );
}
async function render(page: Page, sources: string[], preview = false) {
  await page.evaluate(
    ({ sources, preview }) => (window as any).renderSvg(sources, preview),
    { sources, preview },
  );
}

test("SVG policy admits real geometry and rewrites local paint, clip and accessibility IDs", async ({
  page,
}) => {
  await fixture(page);
  const result = await sanitize(page, cat);
  expect(result).not.toBeNull();
  expect(result).toContain('fill="orange"');
  expect(result).toContain('stop-color="burlywood"');
  expect(result).not.toContain('id="paint"');
  expect(result).not.toContain("url(#paint)");
  await render(page, [cat]);
  await expect(page.getByTestId("svg-preview").locator("svg")).toBeVisible();
  expect(
    await page.getByTestId("svg-preview").evaluate((el) => el.tagName),
  ).toBe("SPAN");
  await expect(
    page.getByTestId("svg-preview").locator(":scope > span.visual-svg-surface"),
  ).toHaveCount(1);
  await expect(page.getByTestId("svg-preview").locator("clipPath")).toHaveCount(
    1,
  );
  await expect(page.getByTestId("svg-preview").locator("text")).toHaveText(
    "Cat & friend",
  );
  const aria = await sanitize(
    page,
    '<svg aria-labelledby="caption"><title id="caption">Title</title><rect width="1" height="1"/></svg>',
  );
  expect(aria).toMatch(/aria-labelledby="svg-[\w-]+-i0"/);
  expect(
    await sanitize(page, '<?xml version="1.0" encoding="UTF-8"?><svg/>'),
  ).not.toBeNull();
  expect(
    await sanitize(
      page,
      '<svg><style type="text/css">rect{fill:red}</style><rect/></svg>',
    ),
  ).not.toBeNull();
  expect(
    await sanitize(
      page,
      '<svg width="240" height="120"><rect width="240" height="120"/></svg>',
    ),
  ).toContain('viewBox="0 0 240 120"');
});

test("SVG policy rejects executable, resource, malformed and namespace surfaces", async ({
  page,
}) => {
  await fixture(page);
  const payloads = [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="alert(1)"/>',
    '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">X</div></foreignObject></svg>',
    '<svg><a href="#x"><rect/></a></svg>',
    '<svg><image href="data:image/png;base64,AAAA"/></svg>',
    '<svg><use href="#host-paint"/></svg>',
    '<svg><animate attributeName="fill"/></svg>',
    '<svg><set attributeName="fill"/></svg>',
    "<svg><iframe/></svg>",
    "<svg><object/></svg>",
    "<svg><embed/></svg>",
    "<svg><audio/></svg>",
    "<svg><video/></svg>",
    '<svg href="javascript:alert(1)"/>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#host-paint"/>',
    '<svg src="https://evil.test/a"/>',
    '<svg xml:base="https://evil.test/"/>',
    '<svg><rect fill="url(https://evil.test/x)"/></svg>',
    '<svg><rect fill="url(data:image/svg+xml,x)"/></svg>',
    '<svg><rect fill="url(#host-paint)"/></svg>',
    '<svg><rect fill="url(&quot;#missing&quot;)"/></svg>',
    '<svg><g id="same"/><g id="same"/></svg>',
    '<svg xmlns="urn:evil"><rect/></svg>',
    '<svg xmlns:evil="urn:evil"><evil:rect/></svg>',
    '<svg><rect xmlns="http://www.w3.org/1999/xhtml"/></svg>',
    '<svg xmlns:evil="urn:evil" evil:fill="red"/>',
    '<!DOCTYPE svg [<!ENTITY attack "hi">]><svg><text>&attack;</text></svg>',
    '<?xml-stylesheet href="https://evil.test/style.css"?><svg/>',
    "<svg><rect></svg>",
    "<svg/><svg/>",
    "<html><svg/></html>",
    "<svg><parsererror/></svg>",
  ];
  const results = await page.evaluate(
    (payloads) =>
      payloads.map((source) => ({
        source,
        result: (window as any).sanitizeSvg(source, "test"),
      })),
    payloads,
  );
  expect(results.filter(({ result }) => result !== null)).toEqual([]);
});

test("SVG policy rejects obfuscated CSS, resource CSS and escaping selectors", async ({
  page,
}) => {
  await fixture(page);
  const payloads = [
    '<svg><style>@import "https://evil.test/x";</style></svg>',
    "<svg><style>rect{fill:u\\72l(https://evil.test/x)}</style></svg>",
    "<svg><style>rect{fill:u/**/rl(https://evil.test/x)}</style></svg>",
    "<svg><style>rect{fill:URL( https://evil.test/x )}</style></svg>",
    "<svg><style>rect{fill:expression(alert(1))}</style></svg>",
    "<svg><style>rect{fill:var(--resource)}</style></svg>",
    "<svg><style>rect{position:fixed}</style></svg>",
    "<svg><style>rect{background:url(https://evil.test/x)}</style></svg>",
    "<svg><style>@font-face{font-family:evil;src:url(https://evil.test/x)}</style></svg>",
    "<svg><style>@media all{rect{fill:red}}</style></svg>",
    "<svg><style>body{color:red}</style></svg>",
    "<svg><style>:root{color:red}</style></svg>",
    "<svg><style>svg + *{color:red}</style></svg>",
    "<svg><style>[id]{color:red}</style></svg>",
    '<svg><rect style="fill: u&#114;l(https://evil.test/x)"/></svg>',
    '<svg><rect style="fill: red; --resource: red"/></svg>',
    '<svg><rect style="fill: red; stroke: url(#host-paint)"/></svg>',
  ];
  const results = await page.evaluate(
    (payloads) =>
      payloads.map((source) => ({
        source,
        result: (window as any).sanitizeSvg(source, "test"),
      })),
    payloads,
  );
  expect(results.filter(({ result }) => result !== null)).toEqual([]);
});

test("SVG UTF-8, element and nesting bounds accept the boundary and reject overflow", async ({
  page,
}) => {
  await fixture(page);
  for (const [source, accepted] of [
    ["<svg>" + " ".repeat(65536 - 11) + "</svg>", true],
    ["<svg>" + " ".repeat(65536 - 10) + "</svg>", false],
    ["<svg>" + "猫".repeat(22000) + "</svg>", false],
    ["<svg>" + "<g>".repeat(31) + "</g>".repeat(31) + "</svg>", true],
    ["<svg>" + "<g>".repeat(32) + "</g>".repeat(32) + "</svg>", false],
    ["<svg>" + "<rect/>".repeat(1023) + "</svg>", true],
    ["<svg>" + "<rect/>".repeat(1024) + "</svg>", false],
  ] as const)
    expect((await sanitize(page, source)) !== null).toBe(accepted);
});

test("scoped SVG CSS and per-mount IDs cannot affect host or another graphic", async ({
  page,
}) => {
  await fixture(page);
  const styled =
    '<svg width="100" height="100"><defs><linearGradient id="host-paint"><stop offset="0" stop-color="red"/></linearGradient></defs><style>svg{color:blue} .shared{fill:red} #shape{stroke:green} g > rect{stroke-width:3} .paint{fill:url(#host-paint)}</style><g><rect id="shape" class="shared" width="80" height="80"/></g><circle class="paint" cx="90" cy="90" r="5"/></svg>';
  await render(page, [
    styled,
    '<svg width="100" height="100"><rect id="shape" class="shared" width="80" height="80"/></svg>',
  ]);
  await expect(page.getByTestId("svg-preview")).toHaveCount(2);
  const colors = await page.evaluate(() => {
    const first = document.querySelector('[data-testid="svg-preview"] rect')!;
    const second = document.querySelectorAll(
      '[data-testid="svg-preview"] rect',
    )[1];
    return {
      host: getComputedStyle(document.getElementById("host-paint")!).fill,
      first: getComputedStyle(first).fill,
      stroke: getComputedStyle(first).stroke,
      width: getComputedStyle(first).strokeWidth,
      second: getComputedStyle(second).fill,
    };
  });
  expect(colors).toEqual({
    host: "rgb(0, 128, 0)",
    first: "rgb(255, 0, 0)",
    stroke: "rgb(0, 128, 0)",
    width: "3px",
    second: "rgb(30, 40, 50)",
  });
  const ids = await page
    .locator('[data-testid="svg-preview"] [id]')
    .evaluateAll((els) => els.map((el) => el.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).not.toContain("host-paint");
  expect(ids).not.toContain("shape");
  expect(await sanitize(page, '<svg id="x"/>', ":a")).not.toBe(
    await sanitize(page, '<svg id="x"/>', "a"),
  );
});

test("authored SVG classes cannot activate host overlay or resource styles", async ({
  page,
}) => {
  const resources: string[] = [];
  await page.route("https://evil.test/**", (route) => {
    resources.push(route.request().url());
    return route.fulfill({ status: 200, body: "" });
  });
  await fixture(page);
  await page.addStyleTag({
    content:
      ".menu-click-outside-backdrop{position:fixed;inset:0;width:100vw;height:100vh;z-index:999999}.host-resource{fill:url(https://evil.test/paint.svg#paint)}",
  });
  const source =
    '<svg class="menu-click-outside-backdrop" width="100" height="100"><style>.menu-click-outside-backdrop rect.shared{fill:orange}.not-present{fill:red}</style><rect class="shared" width="80" height="80"/><circle class="host-resource" cx="90" cy="90" r="5"/></svg>';
  await render(page, [source, source]);
  await expect(page.getByTestId("svg-preview")).toHaveCount(2);
  const states = await page
    .locator('[data-testid="svg-preview"] svg')
    .evaluateAll((els) =>
      els.map((el) => ({
        position: getComputedStyle(el).position,
        width: getComputedStyle(el).width,
        className: el.getAttribute("class"),
        rectFill: getComputedStyle(el.querySelector("rect")!).fill,
        circleFill: getComputedStyle(el.querySelector("circle")!).fill,
      })),
    );
  for (const state of states) {
    expect(state.position).toBe("static");
    expect(state.width).toBe("100px");
    expect(state.className).not.toBe("menu-click-outside-backdrop");
    expect(state.rectFill).toBe("rgb(255, 165, 0)");
    expect(state.circleFill).toBe("rgb(30, 40, 50)");
  }
  expect(states[0].className).not.toBe(states[1].className);
  expect(
    await page
      .locator(
        '[data-testid="svg-preview"] .menu-click-outside-backdrop, [data-testid="svg-preview"] .host-resource, [data-testid="svg-preview"] .shared',
      )
      .count(),
  ).toBe(0);
  expect(resources).toEqual([]);
});

test("SVG preview dispatch preserves exact fallback and reacts to source, theme and narrow layout", async ({
  page,
}) => {
  const errors: string[] = [];
  const resources: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/evil\.test/.test(request.url())) resources.push(request.url());
  });
  await fixture(page);
  expect(
    await page.evaluate(() =>
      ["svg", "xml-svg", "SVG", "mermaid", "echarts", "html"].map((language) =>
        (window as any).visualLanguage(language),
      ),
    ),
  ).toEqual([true, true, true, true, true, false]);
  await render(page, [cat, cat], true);
  await expect(page.getByTestId("svg-preview")).toHaveCount(2);
  const scopes = await page
    .locator('[data-testid="svg-preview"] > div > svg')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-svg-scope")));
  expect(new Set(scopes).size).toBe(2);
  const raw =
    '<svg onload="alert(1)">\r\n  <image href="https://evil.test/x"/>\r\n</svg>\r\n';
  await render(page, [raw], true);
  await expect(page.getByTestId("fallback")).toHaveCount(1);
  expect(await page.getByTestId("fallback").textContent()).toBe(raw);
  await render(
    page,
    [
      '<svg width="1200" height="600"><rect width="1200" height="600"/><circle cx="100" cy="100" r="50" fill="orange"/></svg>',
    ],
    true,
  );
  await expect(page.getByTestId("svg-preview")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  const bounds = await page
    .getByTestId("svg-preview")
    .locator("svg")
    .boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeCloseTo(bounds!.width / 2, 0);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  expect(
    await page
      .getByTestId("svg-preview")
      .locator("rect")
      .evaluate((el) => getComputedStyle(el).fill),
  ).toBe("rgb(210, 220, 230)");
  expect(
    await page
      .getByTestId("svg-preview")
      .locator("circle")
      .evaluate((el) => getComputedStyle(el).fill),
  ).toBe("rgb(255, 165, 0)");
  expect(resources).toEqual([]);
  expect(errors).toEqual([]);
});
