import { expect, test, type Page } from "@playwright/test";
import { nativeSnapshot, sendSubscribed } from "./native-fixture";

async function mount(
  page: Page,
  options: {
    savedProject?: string;
    fail?: boolean;
    hold?: boolean;
    restore?: boolean;
    restoreNative?: boolean;
    locale?: "zh-CN" | "en";
  } = {},
) {
  await page.route("**/default-browser-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore} = await import('/src/state/store.ts');
const {AppProvider} = await import('/src/state/context.tsx');
const {hostPreferenceScope} = await import('/src/client/host-locators.ts');
const {Header} = await import('/src/shell/Header.tsx');
const {HomePage} = await import('/src/shell/HomePage.tsx');
const {SessionRail} = await import('/src/shell/SessionRail.tsx');
const {nativeSnapshot} = await import('/tests/native-fixture.ts');
const options = ${JSON.stringify(options)};
AppStore.prototype.start = function() {
  const store = this, calls = [], browserCalls = [];
  const auth = {authenticated:true,principal:{owner:'default-owner'}};
  const project = {id:'native-project',name:'Native project',root:'/native'};
  const session = {...nativeSnapshot.session,id:'restored-browser',project_id:options.restoreNative ? project.id : null};
  const snapshot = {...nativeSnapshot,session,messages:[],operations:[]};
  const agents = [{name:'coding',component:'browser-component',modes:[{name:'plan',role:'main_agent'}]}];
  let fail = options.fail, release;
  const gate = options.hold ? new Promise(resolve => {release = resolve;}) : Promise.resolve();
  store.update({authSession:auth, railCollapsed:false});
  if (options.locale) void store.dispatch({type:'SetLocale',value:options.locale});
  const preference = 'microcrab.host-project.v2:' + hostPreferenceScope(store.api.base,auth);
  if (options.savedProject !== undefined) localStorage.setItem(preference, options.savedProject);
  store.refreshPermissions = async () => {};
  store.roundLimits.refresh = () => {};
  store.api.disconnectHost = async () => {};
  store.api.connectBrowserConversation = async (id,owner) => {
    browserCalls.push({id,owner});
    await gate;
    if (fail) throw Error('fixture browser runtime unavailable');
  };
  store.api.request = async (method,params={},sessionId) => {
    calls.push({method,params,sessionId});
    if (method === 'server.capabilities') return {protocol:1,methods:['project.list','model.list','session.list','agent.catalog','session.open'],features:{},limits:{}};
    if (method === 'project.list') return {items:[project]};
    if (method === 'model.list') return {items:[{id:'model',provider_id:'provider',name:'Model',variants:[]}]};
    if (method === 'session.list') return {items: options.restore ? [session] : [], unavailable: [], complete: true};
    if (method === 'agent.catalog') return {items:agents};
    if (method === 'session.open') return snapshot;
    throw Error('Unexpected fixture call: ' + method);
  };
  const read = () => ({project:store.state.draftWorkspace.projectId,kind:store.state.draftWorkspace.kind,
    sessionId:store.state.sessionId,host:store.state.hostConnection,agent:store.state.draftAgent,
    draftId:store.draftConversationId,preference:localStorage.getItem(preference),browserCalls:[...browserCalls],calls:[...calls]});
  window.defaultBrowserFixture = {
    ready:store.bootstrap(store.lifecycle), read,
    release:() => release?.(),
    newChat:() => store.dispatch({type:'NewChat'}),
    selectBrowser:() => store.dispatch({type:'SelectDraftWorkspace',value:{kind:'none'}}),
    selectProject:() => store.dispatch({type:'SelectKnownProject',value:project.id}),
    bootstrap:() => store.bootstrap(store.lifecycle),
    nextLifecycle:() => {store.lifecycle++; return store.bootstrap(store.lifecycle);},
    changeOwner:() => {store.update({authSession:{authenticated:true,principal:{owner:'replacement-owner'}}}); return store.bootstrap(store.lifecycle);},
    retry:() => {fail = false; return store.dispatch({type:'ReconnectBrowserHost'});},
  };
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppProvider,null,
  React.createElement(React.Fragment,null,React.createElement(SessionRail),React.createElement(Header),React.createElement(HomePage))));
</script></body></html>`,
    }),
  );
  // Attach opens the selected Session's socket; its first frame is the
  // subscription barrier. Closing the socket releases the subscription.
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/[^/]+\/ws(?:\?.*)?$/,
    (socket) => {
      const id = decodeURIComponent(
        new URL(socket.url()).pathname.split("/")[4],
      );
      const snapshot = {
        ...nativeSnapshot,
        session: {
          ...nativeSnapshot.session,
          id,
          project_id: options.restoreNative ? "native-project" : null,
        },
        messages: [],
        operations: [],
      };
      socket.onMessage((raw) => {
        const command = JSON.parse(String(raw));
        socket.send(
          JSON.stringify(
            command.method === "session.open"
              ? {
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: true,
                  data: snapshot,
                }
              : {
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: false,
                  error: {
                    code: "unsupported_method",
                    message: `Unexpected fixture call: ${command.method}`,
                  },
                },
          ),
        );
      });
      sendSubscribed(socket, snapshot, "subscription", "generation");
    },
  );
  await page.goto(
    `/default-browser-fixture${options.restore ? "#session/restored-browser" : ""}`,
  );
  await page.waitForFunction(() => !!(window as any).defaultBrowserFixture);
}
const read = (page: Page) =>
  page.evaluate(() => (window as any).defaultBrowserFixture.read());
const ready = (page: Page) =>
  page.evaluate(() => (window as any).defaultBrowserFixture.ready);

test("fresh startup defaults to browser workspace with nonempty Project catalog and prepares only once", async ({
  page,
}) => {
  await mount(page);
  await ready(page);
  await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
  await expect(page.getByTitle("选择项目工作区")).toContainText("无项目");
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeEnabled();
  const before = await read(page);
  expect(before.kind).toBe("none");
  expect(before.project).toBeUndefined();
  expect(before.agent).toBe("coding");
  expect(before.browserCalls).toEqual([
    { id: before.draftId, owner: "default-owner" },
  ]);
  await page.evaluate(async () => {
    await (window as any).defaultBrowserFixture.selectBrowser();
    await (window as any).defaultBrowserFixture.bootstrap();
  });
  const after = await read(page);
  expect(after.draftId).toBe(before.draftId);
  expect(after.browserCalls).toEqual(before.browserCalls);
  expect(
    after.calls.filter((call: any) => call.method === "agent.catalog"),
  ).toHaveLength(1);
  expect(
    after.calls.some((call: any) =>
      ["session.create", "turn.submit", "project.attach"].includes(call.method),
    ),
  ).toBe(false);
});

test("pending browser startup shows preparation without Project connection controls and deduplicates concurrent selection", async ({
  page,
}) => {
  await mount(page, { hold: true });
  await expect(page.locator(".composer-offline-banner")).toContainText(
    "正在准备浏览器工作区",
  );
  await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "连接 Host", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    void (window as any).defaultBrowserFixture.selectBrowser();
  });
  expect((await read(page)).browserCalls).toHaveLength(1);
  await page.evaluate(() => (window as any).defaultBrowserFixture.release());
  await ready(page);
  await expect(page.locator(".composer-offline-banner")).toHaveCount(0);
});

test("failed default browser startup stays projectless and retries the same workspace explicitly", async ({
  page,
}) => {
  await mount(page, { fail: true });
  await ready(page);
  await expect(page.locator(".composer-offline-banner")).toContainText(
    "浏览器工作区暂不可用",
  );
  await expect(page.locator(".composer-offline-banner")).toContainText(
    "fixture browser runtime unavailable",
  );
  await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
  const before = await read(page);
  expect(before.project).toBeUndefined();
  await page.evaluate(() => (window as any).defaultBrowserFixture.retry());
  const after = await read(page);
  expect(after.browserCalls.map((call: any) => call.id)).toEqual([
    before.draftId,
    before.draftId,
  ]);
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeEnabled();
});

test("NewChat allocates a fresh browser workspace while a restored projectless Session reuses its pinned ID", async ({
  page,
}) => {
  await mount(page, { restore: true });
  await ready(page);
  const restored = await read(page);
  expect(restored.browserCalls).toEqual([
    { id: "restored-browser", owner: "default-owner" },
  ]);
  expect(
    restored.calls
      .filter((call: any) => call.method === "session.open")
      .map((call: any) => call.sessionId),
  ).toEqual(["restored-browser"]);
  await page.evaluate(() => (window as any).defaultBrowserFixture.newChat());
  const next = await read(page);
  expect(next.sessionId).toBeNull();
  expect(next.draftId).not.toBe("restored-browser");
  expect(next.browserCalls.map((call: any) => call.id)).toEqual([
    "restored-browser",
    next.draftId,
  ]);
  await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
  expect(next.calls.some((call: any) => call.method === "session.create")).toBe(
    false,
  );
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`Sessions (+) leaves an active native Project for No Project, while Project (+) remains explicit (${locale})`, async ({
    page,
  }) => {
    await mount(page, {
      savedProject: "native-project",
      restore: true,
      restoreNative: true,
      hold: true,
      locale,
    });
    await ready(page);
    const native = await read(page);
    expect(native.sessionId).toBe("restored-browser");
    expect(native.project).toBe("native-project");
    expect(native.browserCalls).toHaveLength(0);
    await expect(page.getByTestId("header-host-connection")).toBeVisible();

    await page.getByTestId("sessions-new-chat").click();
    const pending = await read(page);
    expect(pending.sessionId).toBeNull();
    expect(pending.kind).toBe("none");
    expect(pending.project).toBeUndefined();
    expect(pending.preference).toBe("");
    expect(pending.host.state).toBe("connecting");
    expect(pending.browserCalls).toEqual([
      { id: pending.draftId, owner: "default-owner" },
    ]);
    await expect(page.getByTestId("header-host-connection")).toHaveCount(0);
    await expect(page.locator(".home-composer-textarea")).toBeDisabled();
    const picker = page.locator(".home-workspace-badge-btn");
    const noProject = locale === "en" ? "No Project" : "无项目";
    await expect(picker).toHaveText(noProject);
    await picker.click();
    const option = page.getByTestId("home-project-picker").getByRole("button", {
      name: noProject,
      exact: true,
    });
    await expect(option).toHaveAttribute("data-active", "true");
    await expect(option.locator(".ws-item-check")).toBeVisible();
    await expect(page.getByTestId("home-project-picker")).not.toContainText(
      locale === "en" ? "Browser workspace" : "浏览器工作区",
    );
    await option.click();
    expect((await read(page)).browserCalls).toEqual(pending.browserCalls);
    await page.evaluate(() => (window as any).defaultBrowserFixture.release());
    await expect.poll(async () => (await read(page)).host.state).toBe("ready");
    await expect(page.locator(".home-composer-textarea")).toBeEnabled();
    expect((await read(page)).host.catalogReady).toBe(true);

    await page.locator(".rail-project-add-btn").click();
    await expect(picker).toHaveText("Native project");
    await expect(page.getByTestId("header-host-connection")).toBeVisible();
    const project = await read(page);
    expect(project.sessionId).toBeNull();
    expect(project.project).toBe("native-project");
    expect(project.preference).toBe("native-project");
    expect(project.draftId).toBeNull();
    expect(project.browserCalls).toEqual(pending.browserCalls);
    expect(
      project.calls.some((call: any) =>
        ["session.create", "turn.submit", "project.attach"].includes(
          call.method,
        ),
      ),
    ).toBe(false);
  });
}

for (const savedProject of ["native-project", "deleted-project"]) {
  test(`saved explicit Project selection is ${savedProject === "native-project" ? "retained" : "not replaced by the first catalog Project when invalid"}`, async ({
    page,
  }) => {
    await mount(page, { savedProject });
    await ready(page);
    const state = await read(page);
    if (savedProject === "native-project") {
      expect(state.project).toBe(savedProject);
      expect(state.browserCalls).toHaveLength(0);
      await expect(page.getByTestId("header-host-connection")).toBeVisible();
      await expect(page.locator(".composer-offline-banner")).toContainText(
        "项目宿主机执行端离线",
      );
      await page.evaluate(() =>
        (window as any).defaultBrowserFixture.newChat(),
      );
      expect((await read(page)).project).toBe(savedProject);
      expect((await read(page)).browserCalls).toHaveLength(0);
    } else {
      expect(state.project).toBeUndefined();
      expect(state.browserCalls).toHaveLength(1);
    }
  });
}

test("a late browser preparation cannot overwrite an explicit Project switch", async ({
  page,
}) => {
  await mount(page, { hold: true });
  await expect(page.locator(".composer-offline-banner")).toContainText(
    "正在准备浏览器工作区",
  );
  await page.evaluate(() =>
    (window as any).defaultBrowserFixture.selectProject(),
  );
  await page.evaluate(() => (window as any).defaultBrowserFixture.release());
  await ready(page);
  const state = await read(page);
  expect(state.project).toBe("native-project");
  expect(state.host.projectId).toBe("native-project");
  expect(state.host.state).toBe("detached");
  expect(
    state.calls.filter((call: any) => call.method === "agent.catalog"),
  ).toHaveLength(0);
  await expect(page.getByTestId("header-host-connection")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toBeDisabled();
});

for (const action of ["nextLifecycle", "changeOwner"]) {
  test(`browser preparation after ${action} ${action === "changeOwner" ? "allocates an isolated owner workspace" : "reuses the same owner workspace"}`, async ({
    page,
  }) => {
    await mount(page);
    await ready(page);
    const before = await read(page);
    await page.evaluate(
      (action) => (window as any).defaultBrowserFixture[action](),
      action,
    );
    const after = await read(page);
    if (action === "changeOwner")
      expect(after.draftId).not.toBe(before.draftId);
    else expect(after.draftId).toBe(before.draftId);
    expect(after.browserCalls).toEqual([
      { id: before.draftId, owner: "default-owner" },
      {
        id: after.draftId,
        owner: action === "changeOwner" ? "replacement-owner" : "default-owner",
      },
    ]);
    expect(
      after.calls.some((call: any) =>
        ["session.create", "turn.submit"].includes(call.method),
      ),
    ).toBe(false);
  });
}
