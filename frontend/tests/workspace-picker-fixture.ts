import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/* Shared mount for the workspace picker specs: 18 projects on two Hosts plus
 * one unassigned, seven recent sessions, and a same-origin sandbox runtime
 * route in one of five modes. */

export type Sandbox = "available" | "missing" | "fetchable" | "hold" | "hidden";

const ENTRY =
  "export const BrowserHost = { create() { throw Error('fixture'); } };\n";
const ENTRY_HASH = createHash("sha256").update(ENTRY).digest("hex");
const HASH = "b".repeat(64);
const MANIFEST = {
  schema: 1,
  kind: "browser-host",
  wasmsh_version: "0.5.1",
  hash: HASH,
  entry: "supervisor.mjs",
  base_url: `/browser-host/${HASH}/`,
  files: [
    {
      path: "supervisor.mjs",
      sha256: ENTRY_HASH,
      size: Buffer.byteLength(ENTRY),
    },
  ],
};

export async function mount(
  page: Page,
  {
    width = 1440,
    height = 900,
    locale = "zh-CN",
    theme = "light",
    sandbox = "available" as Sandbox,
  } = {},
) {
  await page.setViewportSize({ width, height });
  if (sandbox === "hidden")
    await page.addInitScript(() => {
      (WebAssembly as any).Suspending = undefined;
    });
  let manifestCalls = 0;
  await page.route("**/browser-host/current.json", async (route) => {
    manifestCalls++;
    if (sandbox === "available") return route.fulfill({ json: MANIFEST });
    if (sandbox === "hold" && manifestCalls > 1) return;
    if (sandbox === "fetchable" && manifestCalls > 1)
      return route.fulfill({ json: MANIFEST });
    return route.fulfill({ status: 404, body: "missing" });
  });
  await page.route(`**/browser-host/${HASH}/supervisor.mjs`, (route) =>
    route.fulfill({ contentType: "text/javascript", body: ENTRY }),
  );
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
const projects = Array.from({length:18},(_,i)=>({id:'p'+i,name:i===0?'设计系统 / Long project name with preserved identity':'Project '+i,root:i===17?'':'/work/tree-'+i,host_id:i===17?undefined:i<3?'host-a':'host-b',host_connected:i===0?true:i===4?false:undefined}));
const sessions = [0,4,5,6,7,8,9].map((p,i)=>({id:'s'+i,title:'Recent '+i,projectID:'p'+p,status:'idle',lastActiveAt:100-i}));
AppStore.prototype.start=function(){
 this.update({authSession:{authenticated:true,principal:{owner:'picker-owner'}},projects,connection:'ws',draftWorkspace:{kind:'chat_only'},sessions,hostConnection:{projectId:'p0',state:'ready',connected:true,catalogReady:true}});
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
  await expect(page.getByTestId("home-project-picker")).toBeVisible();
}
export const picker = (page: Page) => page.getByTestId("home-project-picker");
export const actions = (page: Page, type: string) =>
  page.evaluate(
    (type) =>
      (window as any).pickerCascade.actions.filter(
        (action: any) => action.type === type,
      ),
    type,
  );
