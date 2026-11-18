import { expect, test } from "@playwright/test";

test("plugin readiness waits for inventory and the latest exact selected Session", async ({
  page,
}) => {
  await page.route("**/plugin-readiness-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/plugin-readiness-fixture");
  const actual = await page.evaluate(async () => {
    const bridgePath = "/src/state/client-plugins.ts",
      registryPath = "/src/plugins/registry.ts",
      storePath = "/src/state/store.ts";
    const { ClientPlugins } = await import(bridgePath);
    const { PluginRegistry } = await import(registryPath);
    const { AppStore } = await import(storePath);
    let failInventory = false;
    let releaseInventory!: () => void,
      releaseSession!: () => void,
      started!: () => void;
    const inventory = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const session = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const syncing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalInitialize = PluginRegistry.prototype.initialize;
    const originalSession = PluginRegistry.prototype.setSession;
    const calls: (string | null)[] = [];
    PluginRegistry.prototype.initialize = () =>
      failInventory
        ? Promise.reject(Error("fixture inventory unavailable"))
        : inventory;
    PluginRegistry.prototype.setSession = async (id: string | null) => {
      calls.push(id);
      started();
      await session;
    };
    const store = new AppStore();
    const bridge = new ClientPlugins(() => store.api);
    const state = {
      ...store.getSnapshot(),
      apiBase: location.origin + "/",
      authSession: {
        authenticated: true,
        principal: { owner: "readiness-owner" },
      },
      sessionId: "old-session",
    };
    try {
      bridge.sync(state);
      const beforeInventory = [
        bridge.initializing,
        bridge.isReadyFor("old-session"),
      ];
      bridge.sync({ ...state, sessionId: "selected-session" });
      releaseInventory();
      await syncing;
      const beforeSession = [
        bridge.initializing,
        bridge.isReadyFor("selected-session"),
        bridge.isReadyFor("old-session"),
      ];
      releaseSession();
      await (bridge as any).ready;
      // Flush the readiness publication queued on the same synchronization receipt.
      await Promise.resolve();
      const afterSession = [
        bridge.initializing,
        bridge.isReadyFor("selected-session"),
        bridge.isReadyFor("old-session"),
      ];
      bridge.sync({
        ...state,
        sessionId: "selected-session",
        resolvedTheme: "dark",
      });
      const afterTheme = bridge.isReadyFor("selected-session");
      bridge.dispose();
      failInventory = true;
      bridge.sync(state);
      await (bridge as any).ready.catch(() => {});
      await Promise.resolve();
      const failed = [
        bridge.initializing,
        bridge.isReadyFor("old-session"),
        bridge.error,
      ];
      failInventory = false;
      bridge.retrySynchronization(state);
      await (bridge as any).ready;
      await Promise.resolve();
      return {
        beforeInventory,
        beforeSession,
        afterSession,
        afterTheme,
        calls,
        failed,
        recovered: bridge.isReadyFor("old-session"),
      };
    } finally {
      bridge.dispose();
      PluginRegistry.prototype.initialize = originalInitialize;
      PluginRegistry.prototype.setSession = originalSession;
    }
  });
  expect(actual).toEqual({
    beforeInventory: [true, false],
    beforeSession: [true, false, false],
    afterSession: [false, true, false],
    afterTheme: true,
    calls: ["selected-session", "old-session"],
    failed: [false, false, "Error: fixture inventory unavailable"],
    recovered: true,
  });
});

test("plugin chooser waits for exact readiness before accepting tabs or synthetic select changes", async ({
  page,
}) => {
  await page.route("**/chooser-readiness-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/chooser-readiness-entry.js"></script></body></html>',
    }),
  );
  await page.route("**/chooser-readiness-entry.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type;
window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:{createRoot}}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppProvider,useAppStore}=await import('/src/state/context.tsx');
const {AppStore}=await import('/src/state/store.ts');
const {PluginSidebar}=await import('/src/plugins/PluginSidebar.tsx');
await import('/src/styles/tokens.css'); await import('/src/styles/client-plugins.css');
AppStore.prototype.start=function(){}; AppStore.prototype.stop=function(){};
let fixture;
function Fixture(){
 const store=useAppStore();
 if(!fixture){
  const entries=['First observation provider','Second observation provider'].map((name,index)=>({
   manifest:{id:'provider.'+index,name,targets:['sidebar']},status:'ready',providesTools:false,
  }));
  const views=entries.map((_,index)=>({status:'ready',mode:'native-json',instanceGeneration:1,
   vars:{draft:'draft '+index},tree:{type:'input',props:{label:'Ready draft',bind:'draft'}}}));
  store.state={...store.state,authSession:{principal:{owner:'chooser-owner'}},page:'conversation',sessionId:'s1',resolvedLocale:'en',rightRailCollapsed:false,rightOverlayOpen:false};
  store.plugins.registry={getSnapshot:()=>entries,isEnabled:()=>true,
   setSurfaceVisible(){},releaseSurface(){},render:async()=>{},
   view:id=>views[Number(id.split('.').at(-1))],
   setVariable:(id,path,value)=>{views[Number(id.split('.').at(-1))].vars[path]=value;store.plugins.publish();},
  };
  store.plugins.sync=()=>{};
  store.plugins.session='s1';store.plugins.syncedSession=undefined;store.plugins.initializing=true;
  fixture=window.chooserReadiness={store,
   width:value=>{document.querySelector('[data-testid="chooser-width"]').style.width=value+'px';},
   release:()=>{store.plugins.syncedSession='s1';store.plugins.initializing=false;store.plugins.publish();},
   theme:()=>store.update({resolvedTheme:'dark'}),
  };
 }
 return React.createElement('div',{'data-testid':'chooser-width',style:{width:1000}},React.createElement(PluginSidebar));
}
createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,React.createElement(Fixture)));
`,
    }),
  );
  await page.goto("/chooser-readiness-fixture");
  const firstTab = page.getByRole("tab", {
    name: "First observation provider",
    exact: true,
  });
  const secondTab = page.getByRole("tab", {
    name: "Second observation provider",
    exact: true,
  });
  await expect(firstTab).toBeDisabled();
  await expect(secondTab).toBeDisabled();
  await secondTab.evaluate((button) =>
    button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await page.evaluate(() => (window as any).chooserReadiness.width(240));
  const select = page.locator("select.client-plugin-select");
  await expect(select).toBeVisible();
  await expect(select).toBeDisabled();
  await select.evaluate((element) => {
    (element as HTMLSelectElement).value = "provider.1";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => (window as any).chooserReadiness.release());
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("provider.0");
  await expect(page.getByLabel("Ready draft")).toHaveValue("draft 0");
  await select.selectOption("provider.1");
  await expect(page.getByLabel("Ready draft")).toHaveValue("draft 1");
  await page.getByLabel("Ready draft").fill("retained ready draft");
  await page.evaluate(() => {
    const fixture = (window as any).chooserReadiness;
    fixture.theme();
    fixture.width(1000);
  });
  await expect(secondTab).toBeEnabled();
  await expect(secondTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Ready draft")).toHaveValue(
    "retained ready draft",
  );
});
