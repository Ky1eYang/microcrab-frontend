import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeBackend } from "./native-fixture";

// Read at setup, not module discovery: --list does not require build artifacts.
// These cases accept the Zig guest through the maintained registry, Worker,
// Component inspector and renderer. Only the remote MCP transport is simulated.
const id = "microcrab.mcp-bridge";
const componentPath = process.env.MICROCRAB_TEST_ZIG_MCP_COMPONENT
  ? resolve(process.env.MICROCRAB_TEST_ZIG_MCP_COMPONENT)
  : resolve(
      import.meta.dirname,
      "../../../microcrab-frontend-plugins/zig-out/bin/mcp_bridge.component.wasm",
    );
const endpoint = "https://zig-mcp.example.test/service/mcp";
test.setTimeout(180_000);

type Rpc = { id?: string | number; method: string; params?: any };
type Attempt = { ok: boolean; value?: any; error?: string };
type Transport = {
  latencyMs: number;
  protocol: string;
  ack: 202 | 204;
  schema: Record<string, unknown>;
  fault: "" | "rpc-id" | "protocol" | "budget";
  calls: { rpc: Rpc; headers: Record<string, string> }[];
  output: string;
  hold: boolean;
  release: (() => void) | null;
};

async function remote(page: Page) {
  const transport: Transport = {
    latencyMs: 0,
    protocol: "2025-06-18",
    ack: 202,
    fault: "",
    output: "echo result",
    hold: false,
    release: null,
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    calls: [],
  };
  await page.route("https://zig-mcp.example.test/**", async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, mcp-session-id, mcp-protocol-version",
        },
      });
      return;
    }
    const rpc = route.request().postDataJSON() as Rpc;
    if (transport.latencyMs)
      await new Promise<void>((done) => setTimeout(done, transport.latencyMs));
    const held = transport.hold && rpc.method === "tools/call";
    const headers = route.request().headers();
    if (headers.authorization) headers.authorization = "[redacted]";
    transport.calls.push({ rpc, headers });
    const responseHeaders = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "Mcp-Session-Id",
      "Mcp-Session-Id": "zig-remote-session",
      "content-type": "application/json",
    };
    if (rpc.method.startsWith("notifications/")) {
      await route.fulfill({
        status: transport.ack,
        headers: responseHeaders,
        body: "",
      });
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize")
      result = {
        protocolVersion:
          transport.fault === "protocol" ? "2099-01-01" : transport.protocol,
        capabilities: {},
        serverInfo: { name: "Zig acceptance remote", version: "1" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo source text",
            inputSchema: transport.schema,
          },
        ],
      };
    else if (rpc.method === "tools/call") {
      if (held)
        await new Promise<void>((done) => {
          transport.release = done;
        });
      result = {
        content: [
          {
            type: "text",
            text:
              transport.fault === "budget"
                ? "x".repeat(62 * 1024)
                : transport.output,
          },
        ],
      };
    } else throw new Error(`Unexpected MCP method: ${rpc.method}`);
    try {
      await route.fulfill({
        status: 200,
        headers: responseHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: transport.fault === "rpc-id" ? "wrong-rpc-identity" : rpc.id,
          result,
        }),
      });
    } catch (error) {
      // A held response is deliberately retired by cancellation/history fencing.
      if (!held) throw error;
    }
  });
  return transport;
}

async function setup(page: Page, { seedExcludedGrants = false } = {}) {
  await nativeBackend(page);
  let bytes: Buffer;
  try {
    bytes = readFileSync(componentPath);
  } catch {
    throw new Error(
      `Build the real Zig MCP Component before this acceptance gate: ${componentPath}`,
    );
  }
  expect([...bytes.subarray(0, 8)]).toEqual([0, 97, 115, 109, 13, 0, 1, 0]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `${id}/${sha256}/plugin.wasm`;
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: {
        version: 1,
        plugins: [{ id, file, sha256, default_enabled: true }],
      },
    }),
  );
  await page.route(`**/plugins/${file}`, (route) =>
    route.fulfill({ body: bytes, contentType: "application/wasm" }),
  );
  await page.route("**/zig-mcp-acceptance", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default:React} = await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {PluginRenderer} = await import('/src/plugins/renderer.tsx');
const {PluginRegistry} = await import('/src/plugins/registry.ts');
await import('/src/styles/tokens.css');
document.documentElement.dataset.theme = 'light';
const id = 'microcrab.mcp-bridge';
const ownerId = sessionStorage.getItem('zig-mcp-acceptance-owner') || 'zig-mcp-' + crypto.randomUUID();
sessionStorage.setItem('zig-mcp-acceptance-owner', ownerId);
if (${seedExcludedGrants}) {
  // Simulate persisted vault data, not guest vars: the real host computes
  // requires_reenable from an enabled grant bound to different exact bytes.
  const key = 'microcrab.plugin.resources.v1:' + JSON.stringify([location.origin, ownerId, id]);
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([
    {id:'disabled-service', endpoint:${JSON.stringify(endpoint)}, enabled:false, config_pin:'disabled-pin', grant_artifact:${JSON.stringify(sha256)}},
    {id:'previous-artifact-service', endpoint:${JSON.stringify(endpoint)}, enabled:true, config_pin:'old-artifact-pin', grant_artifact:'0'.repeat(64)},
  ]));
}
const registry = new PluginRegistry({serverOrigin:location.origin, ownerId});
await registry.initialize();
let session = 'zig-session';
await registry.setSession(session);
registry.setEnvironment({locale:'en'});
let target = 'setting-page';
let surface = {surface_id:'zig-settings',target};
let sequence = 0;
const root = ReactDOM.createRoot(document.getElementById('fixture'));
const observed = {secretLeak:false, errors:[], actions:[]};
const secretMarker = 'ZIG-TRANSIENT-CREDENTIAL-';
function view(){return registry.view(id,target,surface);}
function draw(){
  const current = view();
  if(JSON.stringify({vars:current.vars, projection:current.viewState, html:current.content}).includes(secretMarker)) observed.secretLeak = true;
  root.render(React.createElement(PluginRenderer, {
    view:current,visible:true,
    webviewScope:{ownerId,sessionId:session,instanceGeneration:current.instanceGeneration || 0,historyGeneration:current.historyGeneration || 0,surfaceId:surface.surface_id},
    onAction:(name,payload)=>{
      observed.actions.push(name);
      registry.action(id,name,payload,surface).catch(e=>observed.errors.push(String(e)));
    },
    onVariable:()=>{throw Error('HTML guest must not write variables');}
  }));
}
registry.subscribe(draw);
const artifact = registry.toolInventory().find(p=>p.id===id)?.artifact;
if(!artifact) throw Error('Real Zig MCP guest missing from inventory');
const controllers = new Map();
async function mount(next){
  registry.releaseSurface(id,surface);
  target=next;
  surface={surface_id:'zig-'+next+'-'+(++sequence),target:next};
  await registry.render(id,target,false,surface);
  draw();
}
function run(request, token){
  const controller = new AbortController();
  if(token) controllers.set(token,controller);
  return registry.executeTool({plugin:id,artifact,...request},{
    invocation_id:crypto.randomUUID(),session_id:session,parent_session_id:session,
    call_id:crypto.randomUUID(),catalog_digest:'zig-browser-acceptance',epoch:1,turn_id:7,round_id:3,deadline_ms:0
  },controller.signal).finally(()=>{if(token)controllers.delete(token);});
}
const concurrentSettings = {surface_id:'zig-concurrent-settings',target:'setting-page'};
window.zigMcp={registry,observed,view,mount,run,
  action:(name,payload)=>registry.action(id,name,payload,surface),
  settingsAction:async(name,payload)=>{
    await registry.render(id,'setting-page',false,concurrentSettings);
    await registry.action(id,name,payload,concurrentSettings);
  },
  settingsView:()=>registry.view(id,'setting-page',concurrentSettings).viewState,
  abort:(token)=>controllers.get(token)?.abort(),
  attempt:async(request)=>{try{return {ok:true,value:await run(request)};}catch(e){return {ok:false,error:String(e)};}},
  session:async(next)=>{session=next;await registry.setSession(next);await mount(target);},
  historyReset:async()=>{registry.observe('history-reset',{});await registry.render(id,target,true,surface);draw();}
};
await registry.render(id,target,false,surface);
draw();
window.zigReady=true;
</script></body></html>`,
    }),
  );
  await page.goto("/zig-mcp-acceptance");
  await page.waitForFunction(() => (window as any).zigReady);
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  const plugin = await page.evaluate(() => {
    const installed = (window as any).zigMcp.registry
      .getSnapshot()
      .find((entry: any) => entry.manifest.id === "microcrab.mcp-bridge");
    return {
      manifest: installed.manifest,
      imports: installed.imports,
      artifact: installed.artifact,
      format: installed.importFormat,
    };
  });
  expect(plugin.manifest).toMatchObject({
    id,
    version: "0.4.1",
    targets: ["sidebar", "setting-page"],
  });
  expect(plugin.artifact).toBe(sha256);
  expect(plugin.imports).toEqual(
    expect.arrayContaining([
      "microcrab:client-plugin/net@0.4.0",
      "microcrab:client-plugin/resources@0.4.0",
    ]),
  );
  return page.getByTestId("plugin-webview").contentFrame();
}

async function configure(page: Page, authorization = "", server = "one") {
  await page.evaluate(
    async ({ endpoint, authorization, server }) => {
      const h = (window as any).zigMcp;
      await h.mount("setting-page");
      await h.action("save-config", {
        id: server,
        endpoint,
        authorization,
        clear_authorization: false,
        enabled: true,
      });
    },
    { endpoint, authorization, server },
  );
  await expect
    .poll(async () =>
      page.evaluate((server) => {
        const value = (window as any).zigMcp.view().viewState;
        return (
          value?.servers?.some(
            (item: any) => item.id === server && item.enabled,
          ) && !value.busy
        );
      }, server),
    )
    .toBe(true);
}
async function run(page: Page, request: Record<string, unknown>) {
  return page.evaluate(async (request) => {
    const h = (window as any).zigMcp;
    try {
      return await h.run(request);
    } catch (error) {
      const plugin = h.registry
        .getSnapshot()
        .find((entry: any) => entry.manifest.id === "microcrab.mcp-bridge");
      throw new Error(
        `${String(error)}; plugin fault: ${plugin?.error || "none"}`,
      );
    }
  }, request);
}
async function attempt(
  page: Page,
  request: Record<string, unknown>,
): Promise<Attempt> {
  return page.evaluate(
    (request) => (window as any).zigMcp.attempt(request),
    request,
  );
}
async function mountSidebar(page: Page) {
  await page.evaluate(() => (window as any).zigMcp.mount("sidebar"));
  const webview = page.getByTestId("plugin-webview");
  await expect(webview).toHaveAttribute("data-status", "ready");
  await expect(webview.contentFrame().getByTestId("mcp-sidebar")).toBeVisible();
  return webview.contentFrame();
}
function dispatched(transport: Transport) {
  return transport.calls.filter(({ rpc }) => rpc.method === "tools/call");
}
async function describe(page: Page) {
  const result = await run(page, {
    action: "describe",
    server: "one",
    tool: "echo",
  });
  expect(result.call_pin).toMatch(/^[a-f0-9]{16}$/);
  return result;
}

test("real Zig settings isolate transient credentials and preserve a live themed iframe; sidebar has observation authority only", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  const frame = await setup(page);
  await frame.getByTestId("add-server").click();
  await frame.getByTestId("server-id").fill("one");
  await frame.getByTestId("server-endpoint").fill(endpoint);
  const source = await page
    .getByTestId("plugin-webview")
    .getAttribute("srcdoc");
  await frame
    .locator("body")
    .evaluate((body) => (body.dataset.retainedDocument = "same-document"));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator("body")).toHaveAttribute(
        "data-retained-document",
        "same-document",
      );
      await expect(frame.getByTestId("server-endpoint")).toHaveValue(endpoint);
      const colors = await page.locator("html").evaluate((root) => {
        const sample = document.createElement("span");
        document.body.append(sample);
        sample.style.color = getComputedStyle(root).getPropertyValue("--bg");
        const background = getComputedStyle(sample).color;
        sample.style.color = getComputedStyle(root).getPropertyValue("--text");
        const color = getComputedStyle(sample).color;
        sample.remove();
        return { background, color };
      });
      await expect(frame.locator("body")).toHaveCSS(
        "background-color",
        colors.background,
      );
      await expect(frame.locator("body")).toHaveCSS("color", colors.color);
      expect(
        await frame
          .locator("html")
          .evaluate((root) => root.scrollWidth <= root.clientWidth),
      ).toBe(true);
      expect(
        await page.getByTestId("plugin-webview").getAttribute("srcdoc"),
      ).toBe(source);
    }
  }
  const credential = "ZIG-TRANSIENT-CREDENTIAL-private-one";
  await frame.getByTestId("server-authorization").fill(credential);
  // Read in the same JS turn as submit: no async host receipt is needed to clear.
  expect(
    await frame.getByTestId("save-config").evaluate((button) => {
      (button as HTMLButtonElement).click();
      return (
        document.getElementById("server-authorization") as HTMLInputElement
      ).value;
    }),
  ).toBe("");
  await expect(frame.getByTestId("server-row")).toHaveCount(1);
  await expect(frame.getByTestId("server-row")).toContainText(endpoint);
  await expect(frame.getByTestId("save-config")).toBeEnabled();
  const safe = await page.evaluate(() => {
    const h = (window as any).zigMcp;
    const installed = h.registry
      .getSnapshot()
      .find((entry: any) => entry.manifest.id === "microcrab.mcp-bridge");
    return {
      leaked: h.observed.secretLeak,
      safeView: JSON.stringify(h.view()),
      errors: h.observed.errors,
      actions: h.observed.actions,
      version: installed.manifest.version,
    };
  });
  expect(safe.leaked).toBe(false);
  expect(safe.safeView).not.toContain(credential);
  expect(safe.errors).toEqual([]);
  expect(
    safe.actions.filter((name: string) => name === "save-config"),
  ).toHaveLength(1);
  expect(logs.join("\n")).not.toContain(credential);
  await frame.getByTestId("remove-server").click();
  await expect(frame.getByTestId("delete-confirm")).toBeVisible();
  await frame.getByTestId("delete-cancel").click();
  await expect(frame.getByTestId("delete-confirm")).toHaveCount(0);
  const sidebar = await mountSidebar(page);
  await expect(
    sidebar.locator(
      "form,input,[data-testid=add-server],[data-testid=server-toggle],[data-testid=save-config]",
    ),
  ).toHaveCount(0);
  await expect(
    sidebar.getByText("Retained-window metrics", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).zigMcp.session(null));
  await expect(
    page.getByTestId("plugin-webview").contentFrame().locator("#no-session"),
  ).toBeVisible();
});

test("real Zig sidebar lists enabled services and only shows health for the current configuration", async ({
  page,
}) => {
  const transport = await remote(page);
  const settings = await setup(page, { seedExcludedGrants: true });
  await configure(page);
  // Verify these grants are in the real guest's settings, not merely absent
  // because the inventory has not loaded.
  await expect(
    settings
      .getByTestId("server-row")
      .filter({
        has: settings.getByRole("heading", {
          name: "disabled-service",
          exact: true,
        }),
      })
      .getByText("Disabled", { exact: true }),
  ).toBeVisible();
  await expect(
    settings
      .getByTestId("server-row")
      .filter({
        has: settings.getByRole("heading", {
          name: "previous-artifact-service",
          exact: true,
        }),
      })
      .getByText("Reauthorization required", { exact: true }),
  ).toBeVisible();

  const sidebar = await mountSidebar(page);
  const services = sidebar.getByTestId("enabled-services");
  const rows = services.getByTestId("enabled-service-row");
  const status = rows.getByTestId("enabled-service-status");
  await expect(services).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText("one", { exact: true })).toBeVisible();
  await expect(status).toHaveText("Not tested");
  expect(
    await page.evaluate(() => (window as any).zigMcp.view().viewState.services),
  ).toEqual([{ id: "one", status: "unchecked" }]);
  await expect(sidebar.getByRole("heading", { level: 1 })).toHaveText(
    "MCP Bridge",
  );
  await expect(
    sidebar.getByRole("heading", { level: 2, name: "Tool call history" }),
  ).toBeVisible();
  await expect(
    sidebar.locator(
      "form,input,[data-testid=refresh-config],[data-testid=add-server],[data-testid=server-toggle],[data-testid=test-connection],[data-testid=remove-server],[data-testid=save-config]",
    ),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: /test connection|remove|save/i }),
  ).toHaveCount(0);
  expect(await services.evaluate((element) => element.outerHTML)).not.toContain(
    "zig-mcp.example.test",
  );
  expect(transport.calls).toHaveLength(0);
  await page.evaluate(() =>
    (window as any).zigMcp.action("test-connection", { id: "one" }),
  );
  await expect(status).toHaveText("Not tested");
  expect(transport.calls).toHaveLength(0);

  // Successful tool calls are retained but must not establish connection health.
  const info = await describe(page);
  await run(page, {
    action: "call",
    pin: info.call_pin,
    arguments: { message: "retained alongside services" },
  });
  const history = sidebar.getByTestId("history-row");
  // Discovery and the subsequent invocation are separate retained records.
  await expect(history).toHaveCount(2);
  await expect(history.first()).toContainText("echo");
  await expect(
    sidebar.getByText("Retained-window metrics", { exact: true }),
  ).toBeVisible();
  await expect(sidebar.getByTestId("metric-total")).toHaveText("2");
  await expect(status).toHaveText("Not tested");

  await sidebar.locator("body").evaluate((body) => {
    body.dataset.retainedDocument = "services";
  });
  const probe = () =>
    page.evaluate(() =>
      (window as any).zigMcp.settingsAction("test-connection", { id: "one" }),
    );
  await probe();
  await expect(status).toHaveText("Connected");
  const [checked] = await page.evaluate(
    () => (window as any).zigMcp.view().viewState.services,
  );
  expect(checked).toEqual({
    id: "one",
    status: "connected",
    tool_count: 1,
    checked_at_ms: expect.any(Number),
  });
  expect(Number.isFinite(checked.checked_at_ms)).toBe(true);
  await expect(sidebar.locator("body")).toHaveAttribute(
    "data-retained-document",
    "services",
  );

  // Changing the actual endpoint while keeping the same service ID must not
  // reuse the completed probe, or discard independent call history.
  const replacement = `${endpoint}/replacement`;
  const requestsBeforeSave = transport.calls.length;
  await page.evaluate(
    (endpoint) =>
      (window as any).zigMcp.settingsAction("save-config", {
        id: "one",
        endpoint,
        authorization: "",
        clear_authorization: false,
        enabled: true,
      }),
    replacement,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { servers, busy } = (window as any).zigMcp.settingsView();
        return busy
          ? null
          : servers.find((server: any) => server.id === "one")?.endpoint;
      }),
    )
    .toBe(replacement);
  await expect(status).toHaveText("Not tested");
  expect(transport.calls).toHaveLength(requestsBeforeSave);
  await expect(history).toHaveCount(2);
  await expect(sidebar.getByTestId("metric-total")).toHaveText("2");

  await probe();
  await expect(status).toHaveText("Connected");
  expect(
    transport.calls.slice(requestsBeforeSave).map(({ rpc }) => rpc.method),
  ).toContain("tools/list");
  await page.evaluate(() => (window as any).zigMcp.session(null));
  await expect(sidebar.locator("#no-session")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByText("one", { exact: true })).toBeVisible();
  await expect(status).toHaveText("Not tested");
  await expect(history).toHaveCount(0);
});

test("real Zig negotiates supported protocols and empty notification ACKs, validates arguments and retires stale schema/config pins before dispatch", async ({
  page,
}) => {
  const transport = await remote(page);
  await setup(page);
  await configure(page, "ZIG-TRANSIENT-CREDENTIAL-transport");
  for (const [index, protocol] of [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
  ].entries()) {
    transport.protocol = protocol;
    transport.ack = index % 2 ? 204 : 202;
    const list = await run(page, { action: "list" });
    expect(list.servers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "one" })]),
    );
    const tools = await run(page, { action: "describe", server: "one" });
    expect(tools.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
    );
    const info = await describe(page);
    const start = transport.calls.length;
    const result = await run(page, {
      action: "call",
      pin: info.call_pin,
      arguments: { message: protocol },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "echo result" }],
    });
    const requests = transport.calls.slice(start);
    expect(
      requests.some(({ rpc }) => rpc.method === "notifications/initialized"),
    ).toBe(true);
    for (const request of requests.filter(
      ({ rpc }) => rpc.method !== "initialize",
    )) {
      expect(request.headers["mcp-protocol-version"]).toBe(protocol);
      expect(request.headers["mcp-session-id"]).toBe("zig-remote-session");
    }
    expect(dispatched(transport).at(-1)!.headers.authorization).toBe(
      "[redacted]",
    );
    expect(dispatched(transport).at(-1)!.rpc.params.arguments).toEqual({
      message: protocol,
    });
  }
  const info = await describe(page);
  const callCount = dispatched(transport).length;
  for (const args of [{}, { message: 2 }, { message: "ok", extra: true }]) {
    const result = await attempt(page, {
      action: "call",
      pin: info.call_pin,
      arguments: args,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/argument|schema/i);
    expect(dispatched(transport)).toHaveLength(callCount);
  }
  transport.schema = {
    ...transport.schema,
    properties: { message: { type: "string", minLength: 2 } },
  };
  const changedSchema = await attempt(page, {
    action: "call",
    pin: info.call_pin,
    arguments: { message: "valid" },
  });
  expect(changedSchema.ok).toBe(false);
  expect(changedSchema.error).toMatch(/schema|pin|changed|stale/i);
  expect(dispatched(transport)).toHaveLength(callCount);
  const refreshed = await describe(page);
  expect(refreshed.call_pin).not.toBe(info.call_pin);
  await configure(page, "ZIG-TRANSIENT-CREDENTIAL-replaced");
  const changedConfig = await attempt(page, {
    action: "call",
    pin: refreshed.call_pin,
    arguments: { message: "valid" },
  });
  expect(changedConfig.ok).toBe(false);
  expect(changedConfig.error).toMatch(
    /configuration|pin|changed|stale|rediscover/i,
  );
  expect(dispatched(transport)).toHaveLength(callCount);
  const sidebar = await mountSidebar(page);
  expect(await sidebar.locator("body").textContent()).not.toContain(
    "ZIG-TRANSIENT-CREDENTIAL-",
  );
  expect(
    await page.evaluate(() => (window as any).zigMcp.observed.secretLeak),
  ).toBe(false);
});

test("real Zig rejects a reference to a non-schema value without trapping or dispatching and accepts a later valid call", async ({ page }) => {
  const transport = await remote(page);
  await setup(page);
  await configure(page);
  const validSchema = transport.schema;
  transport.schema = { type: "object", $ref: "#/title", title: "x" };
  const malformed = await describe(page);
  const count = dispatched(transport).length;
  const rejected = await attempt(page, {
    action: "call", pin: malformed.call_pin, arguments: { message: "blocked" },
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.error).toMatch(/schema|unsupported|reference/i);
  expect(rejected.error).not.toMatch(/trap|unreachable|deadline/i);
  expect(dispatched(transport)).toHaveLength(count);
  expect(await page.evaluate(() => (window as any).zigMcp.registry.getSnapshot().find((entry: any) => entry.manifest.id === "microcrab.mcp-bridge").status)).toBe("ready");
  transport.schema = validSchema;
  const valid = await describe(page);
  expect(await run(page, { action: "call", pin: valid.call_pin, arguments: { message: "recovered" } })).toEqual({ content: [{ type: "text", text: "echo result" }] });
  expect(dispatched(transport)).toHaveLength(count + 1);
});

test("real Zig rejects mismatched RPC identities, unsupported protocol and oversized durable output with concrete errors", async ({
  page,
}) => {
  const transport = await remote(page);
  await setup(page);
  await configure(page);
  transport.fault = "rpc-id";
  const rpcMismatch = await attempt(page, {
    action: "describe",
    server: "one",
    tool: "echo",
  });
  expect(rpcMismatch.ok).toBe(false);
  expect(rpcMismatch.error).toMatch(/rpc|response|identity|id/i);
  expect(dispatched(transport)).toHaveLength(0);
  transport.fault = "protocol";
  const unsupported = await attempt(page, {
    action: "describe",
    server: "one",
    tool: "echo",
  });
  expect(unsupported.ok).toBe(false);
  expect(unsupported.error).toMatch(/protocol|version/i);
  expect(dispatched(transport)).toHaveLength(0);
  transport.fault = "";
  const info = await describe(page);
  transport.fault = "budget";
  const budget = await attempt(page, {
    action: "call",
    pin: info.call_pin,
    arguments: { message: "bounded" },
  });
  expect(budget.ok).toBe(false);
  expect(budget.error).toMatch(/size|budget|limit|60|large/i);
  expect(budget.error!.length).toBeLessThan(4096);
  expect(dispatched(transport)).toHaveLength(1);
  transport.fault = "";
  transport.hold = true;
  const sidebar = await mountSidebar(page);
  await page.evaluate((pin) => {
    const h = (window as any).zigMcp;
    h.cancelledResult = h
      .run(
        { action: "call", pin, arguments: { message: "cancel-observation" } },
        "cancel-observation",
      )
      .then(
        (value: unknown) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
  }, info.call_pin);
  await expect.poll(() => dispatched(transport).length).toBe(2);
  await page.evaluate(() => (window as any).zigMcp.abort("cancel-observation"));
  const cancelled = await page.evaluate(
    () => (window as any).zigMcp.cancelledResult,
  );
  expect(cancelled.ok).toBe(false);
  expect(cancelled.error).toMatch(/outcome.*unknown/i);
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).zigMcp
          .view()
          .viewState.records.some(
            (record: any) =>
              record.status === "cancelled" && record.outcome_unknown,
          ),
      ),
    )
    .toBe(true);
  await expect(
    sidebar
      .getByTestId("history-row")
      .filter({ hasText: "Cancelled" })
      .getByText("Outcome unknown", { exact: true }),
  ).toBeVisible();
  const cleanup = transport.calls.filter(
    ({ rpc }) => rpc.method === "notifications/cancelled",
  );
  expect(cleanup.length).toBeLessThanOrEqual(1);
  transport.release?.();
  expect(dispatched(transport)).toHaveLength(2);
});

test("real Zig dispatched cancellation has an unknown outcome, display clear preserves pending work and history reset fences old calls without replay", async ({
  page,
}) => {
  const transport = await remote(page);
  await setup(page);
  await configure(page);
  const info = await describe(page);
  await mountSidebar(page);
  transport.hold = true;
  await page.evaluate((pin) => {
    const h = (window as any).zigMcp;
    h.pending = h
      .run({ action: "call", pin, arguments: { message: "held" } }, "held")
      .then(
        (value: unknown) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
  }, info.call_pin);
  await expect.poll(() => dispatched(transport).length).toBe(1);
  await page.evaluate(() => (window as any).zigMcp.action("clear-history", {}));
  expect(
    await page.evaluate(
      () => (window as any).zigMcp.view().viewState.total_records,
    ),
  ).toBe(0);
  expect(
    transport.calls.filter(
      ({ rpc }) => rpc.method === "notifications/cancelled",
    ),
  ).toHaveLength(0);
  await page.evaluate(() => (window as any).zigMcp.abort("held"));
  const cancelled = await page.evaluate(() => (window as any).zigMcp.pending);
  expect(cancelled.ok).toBe(false);
  expect(cancelled.error).toMatch(/outcome.*unknown/i);
  transport.release?.();
  await page.evaluate(() =>
    (window as any).zigMcp.action("history-page", { page: 0 }),
  );
  const cancellation = transport.calls.filter(
    ({ rpc }) => rpc.method === "notifications/cancelled",
  );
  expect(cancellation.length).toBeLessThanOrEqual(1);
  if (cancellation.length)
    expect(cancellation[0]!.rpc.params.requestId).toBe(
      dispatched(transport)[0]!.rpc.id,
    );
  expect(dispatched(transport)).toHaveLength(1);
  const afterClear = await page.evaluate(
    () => (window as any).zigMcp.view().viewState,
  );
  expect(afterClear.total_records).toBe(0);
  transport.hold = false;
  const current = await describe(page);
  transport.hold = true;
  await page.evaluate((pin) => {
    const h = (window as any).zigMcp;
    h.stalePending = h
      .run({ action: "call", pin, arguments: { message: "history-fence" } })
      .then(
        (value: unknown) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error: String(error) }),
      );
  }, current.call_pin);
  await expect.poll(() => dispatched(transport).length).toBe(2);
  await page.evaluate(() => (window as any).zigMcp.historyReset());
  const stale = await page.evaluate(() => (window as any).zigMcp.stalePending);
  expect(stale.ok).toBe(false);
  expect(stale.error).toMatch(/retired|history|unknown|stale/i);
  transport.release?.();
  transport.hold = false;
  expect(
    await page.evaluate(
      () => (window as any).zigMcp.view().viewState.total_records,
    ),
  ).toBe(0);
  const oldPin = await attempt(page, {
    action: "call",
    pin: current.call_pin,
    arguments: { message: "must-not-replay" },
  });
  expect(oldPin.ok).toBe(false);
  expect(dispatched(transport)).toHaveLength(2);
  const afterRejectedCall = await page.evaluate(
    () => (window as any).zigMcp.view().viewState,
  );
  expect(afterRejectedCall.total_records).toBe(1);
  expect(afterRejectedCall.records[0]).toMatchObject({
    status: "failed",
    outcome_unknown: false,
  });
});

test("real Zig history retains 128 current-session calls in ten-row pages and exact bounded detail chunks; clear, switch and refresh discard it", async ({
  page,
}) => {
  const transport = await remote(page);
  await setup(page);
  await configure(page);
  const info = await describe(page);
  transport.latencyMs = 40;
  for (let index = 0; index < 129; index++) {
    await run(page, {
      action: "call",
      pin: info.call_pin,
      arguments: { message: `call-${index}` },
    });
  }
  const payload =
    "<script>window.zigToolExecuted=true</script>\n" + "原文🙂 ".repeat(5000);
  transport.output = payload;
  await run(page, {
    action: "call",
    pin: info.call_pin,
    arguments: { message: "large-final-result" },
  });
  const sidebar = await mountSidebar(page);
  await expect(sidebar.getByTestId("history-row")).toHaveCount(10);
  await expect(sidebar.getByTestId("metric-total")).toHaveText("128");
  const initial = await page.evaluate(
    () => (window as any).zigMcp.view().viewState,
  );
  expect(initial).toMatchObject({
    session_id: "zig-session",
    has_session: true,
    page_size: 10,
    page: 0,
    total_records: 128,
    metrics: { total: 128, success_rate: 1 },
  });
  expect(initial.records).toHaveLength(10);
  expect(
    initial.records.every(
      (record: any) =>
        Number.isFinite(record.start_time_ms) &&
        record.start_time_ms > 0 &&
        Number.isFinite(record.duration_ms) &&
        record.duration_ms >= 0 &&
        record.turn_id === 7 &&
        record.round_id === 3,
    ),
  ).toBe(true);
  const retained: any[] = [];
  for (let pageIndex = 0; pageIndex < 13; pageIndex++) {
    await page.evaluate(
      (page) => (window as any).zigMcp.action("history-page", { page }),
      pageIndex,
    );
    const projection = await page.evaluate(
      () => (window as any).zigMcp.view().viewState,
    );
    expect(projection.page).toBe(pageIndex);
    expect(projection.records.length).toBe(pageIndex === 12 ? 8 : 10);
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(
      64 * 1024,
    );
    retained.push(...projection.records);
  }
  expect(new Set(retained.map((record) => record.id)).size).toBe(128);
  expect(
    retained.every(
      (record) => record.status === "completed" && !record.outcome_unknown,
    ),
  ).toBe(true);
  // Host timestamps identify the final call without assuming display order.
  const selected = retained.reduce((latest, record) =>
    record.start_time_ms > latest.start_time_ms ? record : latest,
  );
  await page.evaluate(
    (id) =>
      (window as any).zigMcp.action("inspect-history", {
        id,
        field: "arguments",
        offset: 0,
      }),
    selected.id,
  );
  expect(
    await page.evaluate(
      () => (window as any).zigMcp.view().viewState.detail.source,
    ),
  ).toContain("large-final-result");
  await page.evaluate(
    (page) => (window as any).zigMcp.action("history-page", { page }),
    Math.floor(retained.indexOf(selected) / 10),
  );
  await page.evaluate(
    (id) =>
      (window as any).zigMcp.action("inspect-history", {
        id,
        field: "output",
        offset: 0,
      }),
    selected.id,
  );
  let joined = "";
  let chunks = 0;
  for (;;) {
    const projection = await page.evaluate(
      () => (window as any).zigMcp.view().viewState,
    );
    const detail = projection.detail;
    expect(detail).toMatchObject({
      field: "output",
      omitted: detail.next_offset !== null,
    });
    if (detail.omitted)
      await expect(sidebar.getByTestId("history-truncated")).toBeVisible();
    else await expect(sidebar.getByTestId("history-truncated")).toHaveCount(0);
    await expect
      .poll(() => sidebar.getByTestId("history-detail-source").textContent())
      .toBe(detail.source);
    await expect(
      sidebar.locator("[data-testid=copy-detail],[data-testid=cancel-call]"),
    ).toHaveCount(0);
    expect(detail.offset).toBe(Buffer.byteLength(joined));
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(
      64 * 1024,
    );
    joined += detail.source;
    chunks++;
    if (detail.next_offset === null) {
      expect(Buffer.byteLength(joined)).toBe(detail.total_bytes);
      break;
    }
    expect(detail.next_offset).toBeGreaterThan(detail.offset);
    expect(chunks).toBeLessThan(32);
    await page.evaluate(
      ({ id, offset }) =>
        (window as any).zigMcp.action("inspect-history", {
          id,
          field: "output",
          offset,
        }),
      { id: selected.id, offset: detail.next_offset },
    );
  }
  expect(chunks).toBeGreaterThan(1);
  expect(JSON.parse(joined)).toEqual({
    content: [{ type: "text", text: payload }],
  });
  expect(
    await sidebar
      .locator("body")
      .evaluate(() => (window as any).zigToolExecuted),
  ).toBeUndefined();
  await page.evaluate(() => (window as any).zigMcp.action("close-history", {}));
  expect(
    await page.evaluate(() => (window as any).zigMcp.view().viewState.detail),
  ).toBeNull();
  await page.evaluate(() => (window as any).zigMcp.session("other-session"));
  expect(
    await page.evaluate(
      () => (window as any).zigMcp.view().viewState.total_records,
    ),
  ).toBe(0);
  await page.evaluate(() => (window as any).zigMcp.session("zig-session"));
  expect(
    await page.evaluate(
      () => (window as any).zigMcp.view().viewState.total_records,
    ),
  ).toBe(0);
  await page.reload();
  await page.waitForFunction(() => (window as any).zigReady);
  const empty = await mountSidebar(page);
  await expect(empty.locator("#history-empty")).toBeVisible();
  await page.evaluate(() => (window as any).zigMcp.mount("setting-page"));
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).zigMcp.view().viewState.servers.length,
      ),
    )
    .toBe(1);
  expect(dispatched(transport)).toHaveLength(130);
});
