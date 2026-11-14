import { expect, test, type Page } from "@playwright/test";

// Exercise the real Payload and production CSS in a bounded inspector region.
async function mount(
  page: Page,
  lines: number,
  fillBody = true,
  split = false,
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/payload-layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
const { Payload } = await import('/src/features/Payload.tsx');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
const h = React.createElement;
const content = Array.from({length:${lines}}, (_, i) => 'payload line ' + i).join('\\n');
const payload = h(Payload, {value:content, fillBody:${fillBody}, testid:'fixture-payload'});
const region = ${split} ? h('div', {className:'request-audit'},
  h('div', {className:'request-audit-tokens', 'data-testid':'tokens'}, 'Token usage'),
  h('div', {className:'request-audit-diff', 'data-testid':'region'},
    h('h3', {style:{margin:0}}, 'Request delta'),
    h('p', {style:{margin:0}}, 'Recorded request'), payload))
  : h('div', {style:{height:'100%', overflow:'auto'}, 'data-testid':'region'}, payload);
ReactDOM.createRoot(document.getElementById('fixture')).render(
  h('div', {id:'allocation', style:{height:'640px', width:'600px'}}, region));
</script></body></html>`,
    }),
  );
  await page.goto("/payload-layout");
  await expect(page.getByTestId("fixture-payload")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

test("fill payload uses available height beyond 320px without premature expansion", async ({
  page,
}) => {
  const errors = await mount(page, 24);
  const payload = page.getByTestId("fixture-payload");
  const body = payload.locator("pre");
  await expect(payload.getByTestId("payload-expand")).toHaveCount(0);
  const bounds = await body.evaluate((el) => ({
    height: el.clientHeight,
    content: el.scrollHeight,
  }));
  expect(bounds.height).toBeGreaterThan(320);
  expect(bounds.content).toBeLessThanOrEqual(bounds.height + 1);
  expect(errors).toEqual([]);
});

test("fill payload expands at the bottom, scrolls outside, and remeasures allocation", async ({
  page,
}) => {
  const errors = await mount(page, 24, true, true);
  const payload = page.getByTestId("fixture-payload");
  const toggle = payload.getByTestId("payload-expand");
  const body = payload.locator("pre");
  await expect(toggle).toHaveCount(0);
  await page.locator("#allocation").evaluate((el) => {
    el.style.height = "240px";
  });
  await expect(toggle).toBeVisible();
  await expect(payload).toHaveAttribute("data-collapsed", "true");
  const regionBounds = await page.getByTestId("region").boundingBox();
  const toggleBounds = await toggle.boundingBox();
  expect(toggleBounds!.y + toggleBounds!.height).toBeLessThanOrEqual(
    regionBounds!.y + regionBounds!.height + 1,
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await body.evaluate((el) => el.clientHeight)).toBeGreaterThan(320);
  expect(
    await page
      .getByTestId("region")
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await toggle.click();
  await expect(payload).toHaveAttribute("data-collapsed", "true");
  await page.locator("#allocation").evaluate((el) => {
    el.style.height = "640px";
  });
  await expect(toggle).toHaveCount(0);
  await expect(payload).toHaveAttribute("data-collapsed", "false");
  expect(errors).toEqual([]);
});

test("ordinary chat payload retains the existing 320px collapse threshold", async ({
  page,
}) => {
  const errors = await mount(page, 24, false);
  const payload = page.getByTestId("fixture-payload");
  await expect(payload).toHaveAttribute("data-collapsed", "true");
  await expect(payload.getByTestId("payload-expand")).toBeVisible();
  expect(await payload.locator("pre").evaluate((el) => el.clientHeight)).toBe(
    320,
  );
  await payload.getByTestId("payload-expand").click();
  await expect(payload).toHaveAttribute("data-collapsed", "false");
  expect(
    await payload.locator("pre").evaluate((el) => el.clientHeight),
  ).toBeGreaterThan(320);
  expect(errors).toEqual([]);
});
