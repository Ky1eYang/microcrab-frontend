import { test, expect, type Page } from "@playwright/test";
import { nativeBackend, sendSubscribed } from "./native-fixture";

async function home(page: Page) {
  await nativeBackend(page);
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
}

async function session(page: Page) {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.locator("#conversation-transcript")).toBeVisible();
}

/** Minimal ready-composer mount (subset of composer-wiring-browser). */
async function readyComposer(page: Page) {
  page.on("pageerror", (error) =>
    console.error("Composer fixture runtime:", error.message),
  );
  await page.route("**/composer-wiring-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><style>body{margin:0;min-height:100dvh;box-sizing:border-box;padding:var(--sp-4);display:flex;flex-direction:column;justify-content:flex-end}</style></head><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default: React} = await import('/node_modules/.vite/deps/react.js');
const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppStore} = await import('/src/state/store.ts');
const {AppProvider} = await import('/src/state/context.tsx');
const {ComposerStack} = await import('/src/features/composer.tsx');
const {setActiveLocale} = await import('/src/i18n/index.ts');
setActiveLocale('zh-CN');
await import('/src/styles/tokens.css');
await import('/src/styles/components.css');
const methods = ['checkpoint.create','session.create','session.open','session.set_mode','turn.queue','turn.get','session.compact'];
const native = (id='s', overrides={}) => ({id,title:id,project_id:'p',status:'idle',agent:'alpha',mode:'default',model:'m',revision:7,archived:false,created_at_ms:1,updated_at_ms:1,...overrides});
AppStore.prototype.start = function() {
  const store=this;
  window.h={store,calls:[],async existing(id='s'){ store.upsert(native(id)); await store.attach(id); }};
  store.api.request=async(method,params={},id)=>{
    window.h.calls.push(method);
    if(method==='session.create') return native('s',{agent:params.agent,mode:params.mode});
    return {};
  };
  store.update({connection:'ws',authSession:{authenticated:true},capabilities:{methods,features:{},limits:{command_bytes:262144}},projects:[{id:'p',name:'Project',root:'.'}],draftWorkspace:{projectId:'p'},hostConnection:{projectId:'p',state:'ready',connected:true,transport:'grpc',catalogReady:true},agents:[{name:'alpha',component:'alpha.wasm',modes:[{name:'default',role:'main'}]}],draftAgent:'alpha',draftMode:'default',transcript:{...store.state.transcript,sessionStatus:'idle'}});
};
ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(AppProvider,null,React.createElement(ComposerStack)));
</script></body></html>`,
    }),
  );
  // `existing()` attaches through the Session socket; its first frame is the
  // subscription barrier. Later commands get the old handler's `{}` result.
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/[^/]+\/ws(?:\?.*)?$/,
    (socket) => {
      const id = decodeURIComponent(
        new URL(socket.url()).pathname.split("/")[4],
      );
      socket.onMessage((raw) => {
        const command = JSON.parse(String(raw));
        socket.send(
          JSON.stringify({
            v: 1,
            type: "result",
            request_id: command.request_id,
            ok: true,
            data: {},
          }),
        );
      });
      sendSubscribed(
        socket,
        {
          session: {
            id,
            title: id,
            project_id: "p",
            status: "idle",
            agent: "alpha",
            mode: "default",
            model: "m",
            revision: 7,
            archived: false,
            created_at_ms: 1,
            updated_at_ms: 1,
          },
          messages: [],
          operations: [],
          permission: {
            revision: 0,
            config: { overrides: [], review: false, initialization: "ask" },
          },
          history: null,
          state: {},
          executions: [],
          executions_omitted: false,
        },
        crypto.randomUUID(),
        "generation",
      );
    },
  );
  await page.goto("/composer-wiring-fixture");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.evaluate(async () => {
    await (window as any).h.existing();
  });
}

test.describe("ui polish panels", () => {
  test("(+) opens a full-width composer action menu with 添加 / 指令", async ({
    page,
  }) => {
    await home(page);
    const box = page.getByTestId("composer");
    const trigger = page.getByTitle("快捷操作与工具");
    await trigger.click();
    const menu = page.getByTestId("composer-action-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-mode", "full");
    await expect(menu.getByText("添加", { exact: true })).toBeVisible();
    await expect(menu.getByText("指令", { exact: true })).toBeVisible();
    await expect(menu.getByRole("option", { name: /添加文件/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /压缩/ })).toBeVisible();
    const boxBox = await box.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(boxBox && menuBox).toBeTruthy();
    expect(Math.abs(menuBox!.width - boxBox!.width)).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("/ filters the 指令 section in the same menu", async ({ page }) => {
    await readyComposer(page);
    const editor = page.getByRole("textbox", { name: "消息" });
    await editor.fill("/comp");
    const menu = page.locator("#composer-slash-palette");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-mode", "slash");
    await expect(menu.getByRole("option", { name: /压缩/ })).toBeVisible();
    await expect(menu.getByText("添加", { exact: true })).toHaveCount(0);
    await editor.press("Tab");
    await expect(editor).toHaveValue("/compact ");
  });

  test("slash keyboard dispatches the selected command without a literal user turn", async ({
    page,
  }) => {
    await readyComposer(page);
    const editor = page.getByRole("textbox", { name: "消息" });
    await editor.fill("/check");
    await expect(
      page.getByRole("option", { name: /保存检查点/ }),
    ).toBeEnabled();
    await editor.press("Tab");
    await expect(editor).toHaveValue("/checkpoint");
    await expect(editor).toHaveAttribute(
      "aria-activedescendant",
      "composer-slash-checkpoint",
    );
    await editor.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).h.calls.filter(
              (method: string) => method === "checkpoint.create",
            ).length,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(() => (window as any).h.calls.includes("turn.queue")),
    ).toBe(false);
    await expect(editor).toHaveValue("");
  });

  test("header SubAgents popover uses sentence-case title", async ({
    page,
  }) => {
    await nativeBackend(page, {
      children: [
        {
          parent_session_id: "s1",
          id: "panel-child",
          name: "coding",
          status: "completed",
          availability: "persisted",
          messages: [],
          next_cursor: null,
          messages_truncated: false,
          receipt: null,
          usage: null,
          executions: [],
          history: null,
        },
      ],
    });
    await page.goto("/#session/s1");
    await page.getByTestId("header-subagents").click();
    const header = page.locator(".subagents-menu .popover-menu-header");
    await expect(header).toBeVisible();
    await expect(header).toHaveCSS("text-transform", "none");
  });

  test("offline composer box clips overflow for tip radius", async ({
    page,
  }) => {
    await home(page);
    await expect(page.locator(".composer-offline-banner")).toBeVisible();
    await expect(page.getByTestId("composer")).toHaveAttribute(
      "data-clip",
      "true",
    );
    await expect(page.getByTestId("composer")).toHaveCSS("overflow", "hidden");
  });

  test("payload dialog expand uses the expand glyph", async ({ page }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().messages = [
      {
        id: "panel-user",
        role: "user",
        text: "Inspect payload",
        parts: [],
        tool_calls: [],
        position: { epoch: 1, turn: 1, round: 0 },
      },
      {
        id: "panel-assistant",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          { id: "panel-call", name: "pwsh", arguments: { command: "pwd" } },
        ],
        position: { epoch: 1, turn: 1, round: 1 },
      },
      {
        id: "panel-tool",
        role: "tool",
        text: "Workspace result",
        parts: [],
        tool_calls: [],
        call_id: "panel-call",
        tool_name: "pwsh",
        position: { epoch: 1, turn: 1, round: 1 },
      },
    ];
    await page.goto("/#session/s1");
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await page
      .locator('[data-testid="trajectory-entry"][data-kind="tool"]')
      .first()
      .click();
    await page.getByRole("tab", { name: "参数", exact: true }).click();
    const expand = page
      .getByTestId("trajectory-inspector")
      .getByTestId("payload-dialog-expand");
    await expect(expand).toBeVisible();
    await expand.hover();
    const pathCount = await expand.locator("svg path").count();
    expect(pathCount).toBeGreaterThanOrEqual(4);
  });
});
