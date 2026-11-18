import { expect, test, type Page } from "@playwright/test";

const names = [
  "Observation workspace",
  "Document <review> & edits",
  "Independent inspector",
];

// Source fixture: real AppProvider, RightRail, PluginSidebar and native renderer;
// only runtime/guest boundaries are mocked, as in plugin-block-variants-ui.
async function setup(page: Page, viewport = 1440, savedWidth = 282) {
  await page.setViewportSize({ width: viewport, height: 1000 });
  await page.route("**/sidebar-responsive-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/sidebar-responsive-entry.js"></script></body></html>',
    }),
  );
  await page.route("**/sidebar-responsive-entry.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppProvider,useAppStore,useAppFields}=await import('/src/state/context.tsx');
const {AppStore}=await import('/src/state/store.ts');
const {RightRail}=await import('/src/features/rightRail.tsx');
const {registerDocumentLeave}=await import('/src/client/document-leave.ts');
await import('/src/styles/tokens.css'); await import('/src/styles/chrome.css');
await import('/src/styles/plugins.css'); await import('/src/styles/client-plugins.css');
AppStore.prototype.start=function(){}; AppStore.prototype.stop=function(){};
let fixture;
function Fixture(){
 const store=useAppStore();
 if(!fixture){
  const entries=${JSON.stringify(names)}.map((name,index)=>({manifest:{id:'arbitrary.'+index,name,targets:['sidebar','expanded-page']},status:'ready',providesTools:index===2}));
  const views=entries.map((_,index)=>({status:'ready',mode:'native-json',instanceGeneration:1,vars:{draft:'draft '+index},tree:{type:'input',props:{label:'Plugin draft',bind:'draft'}}}));
  const disabled=new Set(); const renders=[],releases=[],mounts=[],actions=[];
  const registry={getSnapshot:()=>entries,isEnabled:id=>!disabled.has(id),view:id=>views[Number(id.split('.').at(-1))],
   render:async(id,target,force,descriptor)=>renders.push({id,target,descriptor}),
   setSurfaceVisible:(id,descriptor,visible)=>mounts.push({id,descriptor,visible}),
   releaseSurface:(id,descriptor)=>releases.push({id,descriptor}),
   setVariable:(id,path,value)=>{views[Number(id.split('.').at(-1))].vars[path]=value;store.plugins.publish();},
  };
  store.state={...store.state,authSession:{principal:{owner:'sidebar-owner'}},page:'conversation',sessionId:'s1',rightRailWidth:${savedWidth},railCollapsed:false,rightRailCollapsed:false,rightOverlayOpen:${viewport < 1000},resolvedLocale:'en'};
  store.plugins.registry=registry;
  store.plugins.sync=()=>{}; // Runtime session bootstrap is outside this mounted UI fixture.
  const dispatch=store.dispatch.bind(store);
  store.dispatch=async action=>{actions.push(action);if(action.type==='OpenPlugins'||action.type==='OpenPlugin')return;return dispatch(action);};
  fixture=window.sidebarFixture={store,registry,views,entries,disabled,renders,releases,mounts,actions,
   width:value=>store.dispatch({type:'SetRightRailWidth',value}),
   disable:id=>{disabled.add(id);store.plugins.publish();},
   guard(){let dirty=true;this.guardCalls=0;this.removeGuard=registerDocumentLeave(()=>document.querySelector('.client-plugin-panel'),proceed=>{this.guardCalls++;if(dirty){this.proceed=()=>{dirty=false;proceed();};return false;}return true;});},
  };
 }
 const {state}=useAppFields(['railCollapsed']);
 return React.createElement('div',{className:'shell','data-left-collapsed':state.railCollapsed||undefined},
  React.createElement('nav',{className:'session-rail',style:{flexShrink:0,width:state.railCollapsed?60:260}},'Navigation'),
  React.createElement('main',{className:'main-container'},'Conversation'),React.createElement(RightRail));
}
createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(Fixture)));
`,
    }),
  );
  await page.goto("/sidebar-responsive-fixture");
  await expect(page.getByTestId("client-plugin-sidebar")).toBeVisible();
  await expect(page.getByLabel("Plugin draft")).toHaveValue("draft 0");
}

async function width(page: Page, value: number) {
  await page.evaluate(
    (value) => (window as any).sidebarFixture.width(value),
    value,
  );
}

const chooser = (page: Page) => page.locator(".client-plugin-select");
const rail = (page: Page) => page.locator(".right-sidebar-shell");
const handle = (page: Page) => page.locator("#right-sidebar-resize");

for (const viewport of [1440, 1024]) {
  test(`measured selector preserves surface and draft at ${viewport}px`, async ({
    page,
  }) => {
    await setup(page, viewport);
    await expect(chooser(page)).toBeVisible();
    await expect(chooser(page).locator("option")).toHaveText(names);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    const measure = page.locator(".client-plugin-tabs-measure");
    await expect(measure).toHaveAttribute("aria-hidden", "true");
    await expect(measure).toHaveAttribute("inert", "");
    await expect(measure.locator("button, [role=tab], [tabindex]")).toHaveCount(
      0,
    );
    await chooser(page).selectOption("arbitrary.1");
    await expect(page.getByLabel("Plugin draft")).toHaveValue("draft 1");
    await page.getByLabel("Plugin draft").fill("preserved edited draft");
    const before = await page.evaluate(() => {
      const f = (window as any).sidebarFixture;
      f.input = document.querySelector('input[name="draft"]');
      return {
        renders: f.renders.length,
        releases: f.releases.length,
        descriptor: f.renders.at(-1).descriptor,
      };
    });
    await width(page, Math.floor((viewport * 2) / 3));
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByRole("tab", { name: names[1] })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await width(page, 282);
    await expect(chooser(page)).toHaveValue("arbitrary.1");
    await expect(page.getByLabel("Plugin draft")).toHaveValue(
      "preserved edited draft",
    );
    expect(
      await page.evaluate(() => {
        const f = (window as any).sidebarFixture;
        return {
          sameInput: f.input === document.querySelector('input[name="draft"]'),
          renders: f.renders.length,
          releases: f.releases.length,
          descriptor: f.renders.at(-1).descriptor,
        };
      }),
    ).toEqual({ sameInput: true, ...before });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test(`pointer and keyboard share CSS maximum at ${viewport}px`, async ({
    page,
  }) => {
    await setup(page, viewport);
    const max = Math.floor((viewport * 2) / 3);
    await expect(handle(page)).toHaveAttribute("aria-valuemax", String(max));
    const box = (await handle(page).boundingBox())!;
    await page.mouse.move(box.x + 3, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(0, box.y + 100);
    await page.mouse.up();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", String(max));
    await expect
      .poll(() =>
        rail(page).evaluate((el) =>
          Math.round(el.getBoundingClientRect().width),
        ),
      )
      .toBe(max);
    await handle(page).press("Home");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "280");
    await handle(page).press("End");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", String(max));
    await handle(page).press("ArrowLeft");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", String(max));
    expect(
      await rail(page).evaluate((el) =>
        parseFloat(getComputedStyle(el).maxWidth),
      ),
    ).toBe(max);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("choosing the current default retains its dirty document when a visual provider arrives", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const f = (window as any).sidebarFixture;
    f.later = f.entries.splice(1);
    f.entries[0].providesTools = true;
    f.store.plugins.publish();
  });
  await width(page, 960);
  await page.getByLabel("Plugin draft").fill("early provider draft");
  await page.evaluate(() => (window as any).sidebarFixture.guard());
  const current = page.getByRole("tab", { name: names[0], exact: true });
  await current.click();
  expect(
    await page.evaluate(() => (window as any).sidebarFixture.guardCalls),
  ).toBe(0);
  await page.evaluate(() => {
    const f = (window as any).sidebarFixture;
    f.entries.push(...f.later);
    f.store.plugins.publish();
  });
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Plugin draft")).toHaveValue(
    "early provider draft",
  );
  expect(
    await page.evaluate(() => (window as any).sidebarFixture.guardCalls),
  ).toBe(0);
});

test("both selectors consult the same dirty document guard; disable falls back and manager stays explicit", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window as any).sidebarFixture.guard());
  await chooser(page).selectOption("arbitrary.1");
  await expect(chooser(page)).toHaveValue("arbitrary.0");
  expect(
    await page.evaluate(() => (window as any).sidebarFixture.guardCalls),
  ).toBe(1);
  await page.evaluate(() => (window as any).sidebarFixture.proceed());
  await expect(chooser(page)).toHaveValue("arbitrary.1");
  await page.evaluate(() => {
    const f = (window as any).sidebarFixture;
    f.removeGuard();
    f.guard();
  });
  await width(page, 960);
  await page.getByRole("tab", { name: names[0] }).click();
  await expect(page.getByRole("tab", { name: names[1] })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await page.evaluate(() => (window as any).sidebarFixture.guardCalls),
  ).toBe(1);
  await page.evaluate(() => (window as any).sidebarFixture.proceed());
  await expect(page.getByRole("tab", { name: names[0] })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.evaluate(() =>
    (window as any).sidebarFixture.disable("arbitrary.0"),
  );
  await width(page, 282);
  await expect(chooser(page)).toHaveValue("arbitrary.1");
  expect(
    await page.evaluate(() =>
      (window as any).sidebarFixture.actions.some(
        (a: any) => a.type === "OpenPlugins",
      ),
    ),
  ).toBe(false);
  await page.getByTestId("plugins-manage").click();
  expect(
    await page.evaluate(
      () => (window as any).sidebarFixture.actions.at(-1).type,
    ),
  ).toBe("OpenPlugins");
});

for (const [viewport, saved, expected] of [
  [1440, 4000, 960],
  [1024, 4000, 682],
  [1440, 10, 280],
  [390, 4000, 331],
]) {
  test(`saved width ${saved} clamps to ${expected} at ${viewport}px`, async ({
    page,
  }) => {
    await setup(page, viewport, saved);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).sidebarFixture.store.getSnapshot().rightRailWidth,
        ),
      )
      .toBe(expected);
    await expect
      .poll(() =>
        rail(page).evaluate((el) =>
          Math.round(el.getBoundingClientRect().width),
        ),
      )
      .toBe(expected);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (viewport === 390) {
      await expect(rail(page)).toHaveAttribute("data-overlay", "true");
      await expect(handle(page)).toBeHidden();
      await expect(chooser(page)).toBeVisible();
      await page.getByTestId("right-rail-close").click();
      await expect(rail(page)).toHaveCount(0);
    }
  });
}

test("selector focus transfers on resize while plugin focus stays mounted; manifest labels are measured again", async ({
  page,
}) => {
  await setup(page);
  await width(page, 960);
  const activeTab = page.getByRole("tab", { name: names[0] });
  await activeTab.focus();
  await width(page, 282);
  await expect(chooser(page)).toBeFocused();
  await width(page, 960);
  await expect(activeTab).toBeFocused();
  const input = page.getByLabel("Plugin draft");
  await input.fill("focused draft");
  await input.focus();
  await width(page, 282);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("focused draft");
  await width(page, 960);
  await expect(page.getByRole("tablist")).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).sidebarFixture;
    f.entries[0].manifest.name = "Long manifest label ".repeat(20);
    f.store.plugins.publish();
  });
  await expect(chooser(page)).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("focused draft");
});

test("cancelled drag and lost capture restore width; collapse and expand retain sizing", async ({
  page,
}) => {
  await setup(page);
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + 100);
  await expect(rail(page)).toHaveAttribute("data-resizing", "true");
  expect(
    await rail(page).evaluate((el) => getComputedStyle(el).userSelect),
  ).toBe("none");
  await handle(page).dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "282");
  await expect(rail(page)).toHaveAttribute("data-resizing", "false");
  await page.mouse.move(box.x + 3, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + 100);
  await handle(page).evaluate((el) => el.releasePointerCapture(1));
  await page.mouse.up();
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "282");
  await page.getByTestId("right-rail-close").click();
  await expect(rail(page)).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).sidebarFixture.store.dispatch({ type: "ToggleRightRail" }),
  );
  await expect(rail(page)).toBeVisible();
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "282");
});
