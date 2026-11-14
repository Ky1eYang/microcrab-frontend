import { expect, test, type Page } from "@playwright/test";

interface HostReadinessCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface HostReadinessFixture {
  setHost(
    projectId: string,
    catalogReady: boolean,
    catalogError?: string,
  ): void;
  setDisconnected(): void;
  detach(subscriptionId?: string, sequence?: number, generation?: string): void;
  rejectSubmission(): Promise<void>;
  startRejectedSubmission(): void;
  finishRejectedSubmission(): Promise<void>;
  startCatalogRead(): void;
  finishCatalogRead(): Promise<void>;
  snapshot(): {
    calls: HostReadinessCall[];
    rawState: string;
    sessionProject: string;
    draftProject: string;
    composer: string;
    blocks: number;
  };
}

declare global {
  interface Window {
    hostReadinessFixture: HostReadinessFixture;
  }
}

/** Mount production consumers together without starting transport or a model turn. */
async function mount(page: Page) {
  await page.route("**/host-readiness-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><style>body{margin:0}#fixture{min-height:100dvh;display:flex;flex-direction:column;justify-content:space-between}</style></head><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore} = await import('/src/state/store.ts');
const {CommandError} = await import('/src/client/api.ts');
const {AppProvider} = await import('/src/state/context.tsx');
const {Header} = await import('/src/shell/Header.tsx');
const {ComposerStack} = await import('/src/features/composer.tsx');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
await import('/src/styles/chrome.css');
const calls = [];
const agents = [{name:'alpha',component:'alpha.wasm',modes:[{name:'plan',role:'main'}]}];
AppStore.prototype.start = function() {
  const store = this;
  let catalogResolve;
  let catalogRead;
  let deferCatalog = false;
  let rejectSubmission = false;
  let deferSubmission = false;
  let submissionReject;
  let submissionRead;
  // Gap/resync now calls sessionSocket.reconnect(); this fixture never opens a socket, so that call is a no-op.
  store.api.request = async (method, params = {}, sessionId) => {
    calls.push({method, params, sessionId});
    if (method === 'agent.catalog') {
      if (deferCatalog) return new Promise(resolve => {catalogResolve = resolve;});
      return {items: agents};
    }
    if (method === 'turn.queue' && deferSubmission)
      return new Promise((_, reject) => {submissionReject = reject;});
    if (method === 'turn.queue' && rejectSubmission)
      throw new CommandError('host_detached', 'Attach the pinned project Host before execution', false, false, {readiness:{connection_generation:'host-generation',connected:true,ready:false,reconciling:false,phase:'unready',cause:{code:'host_detached',message:'Attach the pinned project Host before execution'}}});
    throw new Error('Unexpected fixture API call: ' + method);
  };
  const host = (projectId, catalogReady, catalogError) => ({projectId,state:'ready',connected:true,catalogReady,catalogError});
  window.hostReadinessFixture = {
    setHost(projectId, catalogReady, catalogError) {
      store.update({hostConnection:host(projectId,catalogReady,catalogError)});
    },
    setDisconnected() {
      store.update({hostConnection:{...host('project-a',true),connected:false}});
    },
    detach(subscriptionId = 'fixture-subscription', sequence = 1, generation = 'fixture-generation') {
      store.receive({v:1,type:'event',subscription_id:subscriptionId,generation,
        sequence,session_id:'session-a',event:'host_detached',data:{suspended:true}});
    },
    async rejectSubmission() {
      rejectSubmission = true;
      await store.dispatch({type:'QueueInput'});
    },
    startRejectedSubmission() {
      deferSubmission = true;
      submissionRead = store.dispatch({type:'QueueInput'});
    },
    async finishRejectedSubmission() {
      submissionReject(new CommandError('host_detached', 'Attach the pinned project Host before execution', false, false, {readiness:{connection_generation:'host-generation',connected:true,ready:false,reconciling:false,phase:'unready',cause:{code:'host_detached',message:'Attach the pinned project Host before execution'}}}));
      await submissionRead;
    },
    startCatalogRead() {
      deferCatalog = true;
      catalogRead = store.loadHostCatalog('project-a');
    },
    async finishCatalogRead() {
      catalogResolve({items:agents});
      await catalogRead;
    },
    snapshot() {
      return {calls:[...calls],rawState:store.state.hostConnection.state,
        sessionProject:store.state.sessions.find(item => item.id === store.state.sessionId)?.projectID,
        draftProject:store.state.draftWorkspace.projectId,composer:store.state.composer,
        blocks:store.state.transcript.blocks.length};
    }
  };
  store.update({connection:'ws',authSession:{authenticated:true},
    capabilities:{methods:['agent.catalog','turn.queue','session.create','session.set_mode'],features:{},limits:{}},
    sessionId:'session-a',sessions:[{id:'session-a',title:'Selected project A session',projectID:'project-a',status:'idle',agent:'alpha',model:{id:'model-a'}}],
    projects:[{id:'project-a',name:'Project A',root:'.'},{id:'project-b',name:'Project B',root:'.'}],
    draftWorkspace:{projectId:'project-b'},hostConnection:host('project-a',false),
    agents,draftAgent:'alpha',draftMode:'plan',composer:'Keep this parent draft',
    transcript:{...store.state.transcript,sessionStatus:'idle'}});
  store.subscription = {subscription_id:'fixture-subscription',generation:'fixture-generation',sequence:0,
    snapshot:{session:{id:'session-a'}}};
};
ReactDOM.createRoot(document.getElementById('fixture')).render(
  React.createElement(AppProvider,null,React.createElement(React.Fragment,null,
    React.createElement(Header),React.createElement(ComposerStack))));
</script></body></html>`,
    }),
  );
  await page.goto("/host-readiness-fixture");
  await expect(page.getByTestId("header-host-connection")).toBeVisible();
}

async function expectNoAutomaticWork(
  page: Page,
  calls: HostReadinessCall[] = [],
) {
  const snapshot = await page.evaluate(() =>
    window.hostReadinessFixture.snapshot(),
  );
  expect(snapshot.calls).toEqual(calls);
  expect(snapshot.composer).toBe("Keep this parent draft");
  expect(snapshot.blocks).toBe(0);
  expect(snapshot.sessionProject).toBe("project-a");
  expect(snapshot.draftProject).toBe("project-b");
}

test("connected Host catalog loading and failure stay consistent between Header and composer until explicit retry succeeds", async ({
  page,
}) => {
  await mount(page);
  const header = page.getByTestId("header-host-connection");
  const banner = page.locator(".composer-offline-banner");
  const input = page.getByRole("textbox", { name: "消息", exact: true });

  expect(
    await page.evaluate(() => window.hostReadinessFixture.snapshot().rawState),
  ).toBe("ready");
  await expect(header).toHaveAttribute("data-host-state", "loading_catalog");
  await expect(header).toContainText("正在加载组件目录");
  await expect(banner).toContainText(/Host\s*已连接/);
  await expect(banner).toContainText(
    /正在加载(?:项目)?组件目录|组件目录.*加载中/,
  );
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute(
    "placeholder",
    "问点什么，输入 / 查看操作",
  );
  await expectNoAutomaticWork(page);

  await page.evaluate(() =>
    window.hostReadinessFixture.setHost(
      "project-a",
      false,
      "fixture catalog unavailable",
    ),
  );
  await expect(header).toHaveAttribute("data-host-state", "catalog_error");
  await expect(header).toContainText("组件目录加载失败");
  await expect(banner).toContainText("组件目录加载失败");
  await expect(input).toBeDisabled();
  const retry = page.getByRole("button", {
    name: "重试加载组件目录",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expectNoAutomaticWork(page);

  await retry.click();
  await expect(header).toHaveAttribute("data-host-state", "ready");
  await expect(header).toContainText("已就绪");
  await expect(banner).toHaveCount(0);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Keep this parent draft");
  await expectNoAutomaticWork(page, [
    {
      method: "agent.catalog",
      params: { project_id: "project-a" },
      sessionId: "session-a",
    },
  ]);
});
