import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  page.on("pageerror", (error) =>
    console.error("ActionMenu fixture:", error.message),
  );
  await page.route("**/action-menu-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/action-menu-entry.js"></script></body></html>',
    }),
  );
  await page.route("**/action-menu-entry.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{};
window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
const {default:React} = await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {createRoot} = ReactDOM;
const {ActionMenu} = await import('/src/features/action-menu.tsx');
await import('/src/features/action-menu.css');
await import('/src/styles/tokens.css');
window.menuCalls = [];
const leaf = (id, disabled=false) => ({id,label:id,disabled,onSelect:()=>window.menuCalls.push(id)});
const items = [
 {id:'alpha',label:'Alpha tools',items:[leaf('Unavailable',true),{id:'nested',label:'Nested choices',items:[leaf('First choice'),leaf('Last choice')]},leaf('Alpha action')]},
 {id:'beta',label:'Beta tools',items:[leaf('Beta action')]},
 {id:'disabled',label:'Disabled tools',disabled:true,items:[leaf('Forbidden action')]},
 leaf('Root action'),
];
createRoot(document.getElementById('root')).render(React.createElement('main',null,
 React.createElement('input',{'aria-label':'Composer'}),
 React.createElement(ActionMenu,{items}),
 React.createElement('button',null,'Outside')));
`,
    }),
  );
  await page.goto("/action-menu-fixture");
  await expect(trigger(page)).toBeVisible();
}

const trigger = (page: Page) =>
  page.getByRole("button", { name: "更多操作", exact: true });
const row = (page: Page, name: string) =>
  page.getByRole("menuitem", { name, exact: true });
async function noActions(page: Page) {
  expect(await page.evaluate(() => (window as any).menuCalls)).toEqual([]);
}

test("three levels open on mouse hover and survive portal gaps without focus or selection", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).click();
  await trigger(page).focus();
  await row(page, "Alpha tools").hover();
  await expect(row(page, "Nested choices")).toBeVisible();
  await expect(trigger(page)).toBeFocused();
  const parent = await row(page, "Alpha tools").boundingBox();
  const child = await page
    .getByRole("menu", { name: "Alpha tools", exact: true })
    .boundingBox();
  await page.mouse.move(
    (parent!.x + parent!.width + child!.x) / 2,
    parent!.y + 10,
  );
  await expect(row(page, "Nested choices")).toBeVisible();
  await row(page, "Nested choices").hover();
  await row(page, "First choice").hover();
  await expect(page.getByRole("menu")).toHaveCount(3);
  await expect(trigger(page)).toBeFocused();
  await noActions(page);
  await row(page, "First choice").click();
  expect(await page.evaluate(() => (window as any).menuCalls)).toEqual([
    "First choice",
  ]);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("hover replaces obsolete descendants, skips disabled groups and keeps root on a leaf", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).click();
  await row(page, "Alpha tools").hover();
  await row(page, "Nested choices").hover();
  await expect(row(page, "First choice")).toBeVisible();
  await row(page, "Beta tools").hover();
  await expect(row(page, "Beta action")).toBeVisible();
  await expect(row(page, "First choice")).toHaveCount(0);
  await expect(row(page, "Nested choices")).toHaveCount(0);
  await row(page, "Disabled tools").hover();
  await expect(row(page, "Forbidden action")).toHaveCount(0);
  await row(page, "Root action").hover();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await noActions(page);
});

test("hover preserves composer and currently focused menu row", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).click();
  await page.getByRole("textbox", { name: "Composer" }).focus();
  await row(page, "Alpha tools").hover();
  await expect(page.getByRole("textbox", { name: "Composer" })).toBeFocused();
  await row(page, "Alpha action").focus();
  await row(page, "Nested choices").hover();
  await expect(row(page, "Alpha action")).toBeFocused();
  await row(page, "Last choice").hover();
  await expect(row(page, "Alpha action")).toBeFocused();
  await noActions(page);
});

test("keyboard navigation focuses children, skips disabled rows and restores parent and trigger", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Alpha tools")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Nested choices")).toBeFocused();
  await page.keyboard.press("End");
  await expect(row(page, "Alpha action")).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(row(page, "First choice")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Last choice")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "First choice")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Nested choices")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Alpha tools")).toBeFocused();
  await page.keyboard.press("End");
  await expect(row(page, "Root action")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Beta tools")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger(page)).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await noActions(page);
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "Root action")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).menuCalls)).toEqual([
    "Root action",
  ]);
});

test("keyboard can take over a submenu already opened by hover", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).click();
  await row(page, "Alpha tools").hover();
  await expect(row(page, "Alpha tools")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Nested choices")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger(page)).toBeFocused();
});

test("pointer leaving the menu keeps it open until an outside click", async ({
  page,
}) => {
  await setup(page);
  await trigger(page).click();
  await row(page, "Alpha tools").hover();
  await page.getByRole("button", { name: "Outside", exact: true }).hover();
  await expect(row(page, "Nested choices")).toBeVisible();
  await page.getByRole("button", { name: "Outside", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await noActions(page);
});

test("touch tap opens each submenu without hover at mobile width", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await setup(page);
  await trigger(page).tap();
  await expect(row(page, "Nested choices")).toHaveCount(0);
  await row(page, "Alpha tools").tap();
  await expect(row(page, "First choice")).toHaveCount(0);
  await row(page, "Nested choices").tap();
  await noActions(page);
  const bounds = await page
    .getByRole("menu", { name: "Nested choices", exact: true })
    .boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382);
  await row(page, "Last choice").tap();
  expect(await page.evaluate(() => (window as any).menuCalls)).toEqual([
    "Last choice",
  ]);
  await context.close();
});
