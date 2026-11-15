import { expect, test, type Page } from "@playwright/test";

async function mount(
  page: Page,
  width = 1440,
  height = 900,
  locale = "zh-CN",
  theme = "light",
) {
  await page.setViewportSize({ width, height });
  await page.route("**/picker-cascade-fixture", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main style="padding:16px"><button id="outside">Outside</button><div id="root"></div></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore}=await import('/src/state/store.ts'); const {AppProvider}=await import('/src/state/context.tsx');
const {WorkspacePicker}=await import('/src/features/home/WorkspacePicker/index.tsx');
for (const style of ['client-plugins','plugins','tokens','chrome','components','interaction-polish','dashboard']) await import('/src/styles/' + style + '.css');
const projects = Array.from({length:18},(_,i)=>({id:'p'+i,name:i===0?'设计系统 / Long project name with preserved identity':'Project '+i,root:'/work/tree-'+i,host_id:i===17?undefined:i<3?'host-a':'host-b',host_connected:i===0?true:i===4?false:undefined}));
AppStore.prototype.start=function(){
 this.update({authSession:{authenticated:true,principal:{owner:'picker-owner'}},projects,connection:'ws',draftWorkspace:{kind:'chat_only'},sessions:[{id:'session-fixed',title:'Recent',projectID:'p0',status:'idle',lastActiveAt:10}],hostConnection:{projectId:'p0',state:'ready',connected:true,catalogReady:true}});
 const store=this,calls=[],actions=[];
 this.api.request=async(method)=>{calls.push(method);throw Error('unexpected API '+method)};
 this.api.disconnectHost=async()=>calls.push('disconnect');
 const dispatch=this.dispatch.bind(this);
 this.dispatch=async(action)=>{actions.push(action);if(action.type==='SelectKnownProject')return; if(action.type==='SelectDraftWorkspace'){this.update({draftWorkspace:action.value});return;} return dispatch(action);};
 window.pickerCascade={store,calls,actions};
 void store.dispatch({type:'SetLocale',value:${JSON.stringify(locale)}});
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(WorkspacePicker)));
document.documentElement.dataset.theme=${JSON.stringify(theme)};
</script></body></html>`,
    }),
  );
  await page.goto("/picker-cascade-fixture");
  await page.locator(".home-workspace-badge-btn").click();
}
const host = (page: Page, id: string) =>
  page.locator(`button[data-host-id="${id}"]`);
const pane = (page: Page) => page.getByTestId("picker-host-submenu");

test("hover previews without focus theft; click enters same Host; arrows and nested Escape remain pane scoped", async ({
  page,
}) => {
  await mount(page);
  const trigger = page.locator(".home-workspace-badge-btn");
  await expect(trigger).toBeFocused();
  await host(page, "host-a").hover();
  await expect(pane(page)).toBeVisible();
  await expect(trigger).toBeFocused();
  await host(page, "host-a").click();
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await expect(host(page, "host-a")).toHaveAttribute("aria-expanded", "true");
  await expect(
    pane(page).locator('[data-project-id="p0"] .picker-project-status'),
  ).toHaveCount(0);
  await expect(
    pane(page).locator('[data-project-id="p0"] .ws-project-folder-icon'),
  ).toBeVisible();
  await search.fill("tree-1");
  await search.press("ArrowDown");
  await expect(pane(page).locator('[data-project-id="p1"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(pane(page).locator('[data-project-id="p1"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(host(page, "host-a")).toBeFocused();
  await expect(pane(page)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(host(page, "host-b")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(search).toBeFocused();
  await expect(pane(page).locator('[data-project-id="p4"]')).toContainText(
    "离线",
  );
  await search.fill("tree-4");
  await expect(pane(page).locator(".workspace-flyout-foot")).toContainText(
    "1/14",
  );
  await page.keyboard.press("Escape");
  await expect(host(page, "host-b")).toBeFocused();
  await host(page, "host-a").click();
  await expect(search).toHaveValue("tree-1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("home-project-picker")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      calls: (window as any).pickerCascade.calls,
      owner: (window as any).pickerCascade.store.state.authSession.principal
        .owner,
      session: (window as any).pickerCascade.store.state.sessions[0].id,
      host: (window as any).pickerCascade.store.state.hostConnection.projectId,
    })),
  ).toEqual({
    calls: [],
    owner: "picker-owner",
    session: "session-fixed",
    host: "p0",
  });
});

test("unassigned empty Host identity opens with keyboard and exact focus restoration; query navigation retains edits", async ({
  page,
}) => {
  await mount(page);
  await host(page, "").focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("no match");
  await search.press("ArrowDown");
  await expect(search).toBeFocused();
  await expect(pane(page).getByRole("status")).toBeVisible();
  await search.fill("tree-17");
  await search.press("ArrowLeft");
  await expect(search).toHaveValue("tree-17");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await expect(pane(page).locator('[data-project-id="p17"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(host(page, "")).toBeFocused();
  await expect(pane(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).pickerCascade.calls),
  ).toEqual([]);
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
  test(`approved geometry, scroll reachability and current modes at ${width} ${theme} in short viewport`, async ({
    page,
  }, testInfo) => {
    await mount(
      page,
      width,
      480,
      width === 390 ? "en" : "zh-CN",
      theme,
    );
    await host(page, "host-b").click();
    await expect(page.getByRole("searchbox")).toBeFocused();
    const geometry = await page.evaluate(() => {
      const left = document.querySelector(".workspace-primary-pane")!,
        right = document.querySelector(".workspace-flyout-pane")!,
        menu = document.querySelector(".workspace-cascading-menu")!,
        list = document.querySelector(".workspace-project-list")!;
      return {
        left: left.getBoundingClientRect().width,
        right: right.getBoundingClientRect().width,
        radius: getComputedStyle(left).borderRadius,
        padding: getComputedStyle(left).padding,
        gap: getComputedStyle(menu).gap,
        listMax: getComputedStyle(list).maxHeight,
        border: getComputedStyle(right).borderWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry).toEqual({
      left: width === 390 ? 300 : 244,
      right: width === 390 ? 300 : 288,
      radius: "10px",
      padding: "6px",
      gap: "6px",
      listMax: "204px",
      border: "1px",
      overflow: false,
    });
    await page.screenshot({ path: testInfo.outputPath(`picker-${width}-${theme}-top.png`) });
    const last = pane(page).locator('[data-project-id="p16"]');
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await pane(page).locator(".workspace-flyout-foot").scrollIntoViewIfNeeded();
    await expect(pane(page).locator(".workspace-flyout-foot")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`picker-${width}-${theme}.png`) });
    await page.getByRole("searchbox").press("Escape");
    const sandbox = page.locator('[data-host-flavor="browser_sandbox"]');
    await sandbox.scrollIntoViewIfNeeded();
    await expect(sandbox).toBeInViewport();
    await expect(
      page.locator('[data-host-flavor="chat_only"]'),
    ).toHaveAttribute("data-active", "true");
    await sandbox.click();
    expect(
      await page.evaluate(() =>
        (window as any).pickerCascade.actions.filter(
          (action: any) => action.type === "SelectDraftWorkspace",
        ),
      ),
    ).toEqual([
      { type: "SelectDraftWorkspace", value: { kind: "browser_sandbox" } },
    ]);
    expect(
      await page.evaluate(() => (window as any).pickerCascade.calls),
    ).toEqual([]);
  });
  }
}

test("touch opens and switches one Host without hover or native Host effects", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 700 },
  });
  const page = await context.newPage();
  await mount(page, 390, 700);
  await host(page, "host-a").tap();
  await expect(page.getByRole("searchbox")).toBeFocused();
  await host(page, "host-b").tap();
  await expect(host(page, "host-b")).toHaveAttribute("aria-expanded", "true");
  await expect(host(page, "host-a")).toHaveAttribute("aria-expanded", "false");
  await expect(pane(page)).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toBeFocused();
  expect(
    await page.evaluate(() => (window as any).pickerCascade.calls),
  ).toEqual([]);
  await context.close();
});
