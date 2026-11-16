import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const inline = readFileSync(
  new URL("./fixtures/webview/inline.html", import.meta.url),
  "utf8",
);
const malicious = readFileSync(
  new URL("./fixtures/webview/malicious.html", import.meta.url),
  "utf8",
);

async function mount(page: Page, html = inline, theme = "light") {
  let failMount: (error: Error) => void = () => {};
  const browserFailure = new Promise<never>((_, reject) => {
    failMount = reject;
  });
  // Attach a rejection handler before navigation can emit an error.
  const onPageError = (error: Error) =>
    failMount(new Error(`Webview fixture browser error: ${error.message}`));
  page.on("pageerror", onPageError);
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/webview-layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const {default:React} = await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
const {default:dom} = await import('/node_modules/.vite/deps/react-dom.js');
const NativeChannel = window.MessageChannel;
window.fixturePorts = [];
window.bridgeEvents = [];
window.MessageChannel = class extends NativeChannel {
  constructor() {
    super();
    window.fixturePorts.push(this.port1);
    this.port1.addEventListener('message', event => window.bridgeEvents.push('in:'+event.data.type));
    const send = this.port1.postMessage.bind(this.port1);
    this.port1.postMessage = value => { window.bridgeEvents.push('out:'+value.type); send(value); };
  }
};
const {PluginRenderer} = await import('/src/plugins/renderer.tsx');
await import('/src/styles/tokens.css');
document.documentElement.dataset.theme = ${JSON.stringify(theme)};
window.actions = [];
window.changes = [];
window.presentation = {
  view: { pluginId:'fixture',target:'sidebar',status:'ready',mode:'webview-html',tree:null,
    content:${JSON.stringify(html).replace(/</g, "\\u003c")},vars:{credential:'DO-NOT-EXPORT'},viewState:{count:1} },
  webviewScope: { ownerId:'owner',sessionId:'session',instanceGeneration:1,historyGeneration:1,surfaceId:'sidebar:fixture' },
  visible:true,
  onAction: (action,payload) => window.actions.push({action,payload}),
  onVariable: (path,value) => window.changes.push({path,value})
};
const root = ReactDOM.createRoot(document.getElementById('fixture'));
window.updatePresentation = (patch) => {
  window.presentation = {...window.presentation,...patch};
  dom.flushSync(() => root.render(React.createElement(PluginRenderer,window.presentation)));
};
window.unmountPresentation = () => dom.flushSync(() => root.unmount());
window.updatePresentation({});
</script></body></html>`,
    }),
  );
  try {
    await Promise.race([
      (async () => {
        await page.goto("/webview-layout");
        await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
          "data-status",
          "ready",
        );
      })(),
      browserFailure,
    ]);
  } finally {
    page.off("pageerror", onPageError);
  }
}

async function update(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(
    (patch) => (window as any).updatePresentation(patch),
    patch,
  );
}
async function updateView(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const host = window as any;
    host.updatePresentation({ view: { ...host.presentation.view, ...patch } });
  }, patch);
}
async function actions(page: Page) {
  return page.evaluate(() => (window as any).actions);
}

test("host theme reaches first paint and live updates preserve the document, draft, focus and scroll", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mount(
    page,
    `<style>body { margin:0; background:var(--microcrab-bg); color:var(--microcrab-text); } #spacer {height:2000px}</style>
    <input id="draft"><span id="first"></span><span id="theme"></span><div id="spacer"></div>
    <script>
      window.boots = (window.boots || 0) + 1;
      document.getElementById('first').textContent = document.documentElement.dataset.theme;
      microcrab.onThemeChange(scheme => document.getElementById('theme').textContent = scheme);
    </script>`,
    "light",
  );
  const guest = page.frameLocator('[data-testid="plugin-webview"]');
  await expect(guest.locator("#first")).toHaveText("light");
  await expect(guest.locator("body")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await guest.locator("#draft").fill("unsaved draft");
  await guest.locator("body").evaluate(() => window.scrollTo(0, 200));
  const srcdoc = await page
    .getByTestId("plugin-webview")
    .getAttribute("srcdoc");
  for (const scheme of ["dark", "light"]) {
    await page.evaluate(async (scheme) => {
      const path = "/src/client/theme.ts";
      const { applyTheme } = await import(path);
      applyTheme(scheme);
    }, scheme);
    await expect(guest.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(guest.locator("#theme")).toHaveText(scheme);
    await expect(guest.locator("body")).toHaveCSS(
      "background-color",
      scheme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)",
    );
    await expect(guest.locator("#draft")).toHaveValue("unsaved draft");
    expect(
      await guest.locator("body").evaluate(() => ({
        boots: (window as any).boots,
        focused: document.activeElement?.id,
        scroll: window.scrollY,
        scheme: getComputedStyle(document.documentElement).colorScheme,
      })),
    ).toEqual({ boots: 1, focused: "draft", scroll: 200, scheme });
    expect(
      await page.getByTestId("plugin-webview").getAttribute("srcdoc"),
    ).toBe(srcdoc);
  }
  await page.evaluate(async () => {
    const path = "/src/client/theme.ts";
    const { applyTheme, watchSystemTheme } = await import(path);
    applyTheme("system");
    (window as any).stopThemeWatch = watchSystemTheme(() =>
      applyTheme("system"),
    );
  });
  await expect(guest.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(guest.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => (window as any).stopThemeWatch());
});

test("all four targets render scripts, inline CSS/static SVG and only explicit projection without restarting on Vars", async ({
  page,
}) => {
  await mount(page);
  const frame = page.frameLocator('[data-testid="plugin-webview"]');
  await expect(frame.locator("#projection")).toHaveText('{"count":1}');
  expect(
    await page.evaluate(() => (window as any).bridgeEvents.slice(0, 3)),
  ).toEqual(["in:ack", "out:theme", "out:view-state"]);
  await expect(frame.locator("#static-svg")).toBeVisible();
  expect(
    await frame
      .locator("#inline")
      .evaluate((node) => getComputedStyle(node).fontWeight),
  ).toBe("600");
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await frame.locator("#action").click();
  await expect
    .poll(() => actions(page))
    .toEqual([{ action: "fixture.action", payload: { boots: 1 } }]);
  await updateView(page, {
    vars: { credential: "NEW-SECRET" },
    viewState: { count: 2 },
  });
  await expect(frame.locator("#projection")).toHaveText('{"count":2}');
  await frame.locator("#action").click();
  await expect.poll(() => actions(page)).toHaveLength(2);
  expect((await actions(page))[1].payload.boots).toBe(1);
  for (const target of ["expanded-page", "session-tab", "block-slot"]) {
    await updateView(page, { target });
    await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
      "data-status",
      "ready",
    );
    await expect(frame.locator("#projection")).toHaveText('{"count":2}');
  }
});

test("CSP remains first and denies guest parent/storage/resource/API/form channels despite guest meta", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**webview-denied.invalid/**", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await mount(page, malicious);
  await expect
    .poll(() => actions(page))
    .toEqual([
      {
        action: "fixture.security",
        payload: { parent: false, storage: false, parentStorage: false },
      },
    ]);
  expect(
    await page.locator("body").getAttribute("data-compromised"),
  ).toBeNull();
  expect(requests).toEqual([]);
  const srcdoc = await page
    .getByTestId("plugin-webview")
    .getAttribute("srcdoc");
  expect(srcdoc!.indexOf("default-src 'none'")).toBeLessThan(
    srcdoc!.indexOf("default-src *"),
  );
});

test("WebSocket is denied by enforced connect-src with a browser CSP violation receipt", async ({
  page,
}) => {
  // HTTP routing does not observe WebSocket handshakes. A browser-generated
  // enforced-policy violation is the evidence for this independent channel.
  await mount(
    page,
    `<button id="socket">Attempt WebSocket</button><script>
  document.addEventListener('securitypolicyviolation', event => {
    if (event.effectiveDirective === 'connect-src' && event.blockedURI.startsWith('wss://webview-denied.invalid')) {
      microcrab.action('fixture.websocket-csp', {
        effectiveDirective: event.effectiveDirective,
        blockedURI: event.blockedURI,
        disposition: event.disposition,
        originalPolicy: event.originalPolicy
      });
    }
  });
  document.getElementById('socket').onclick = () => {
    try {
      const socket = new WebSocket('wss://webview-denied.invalid/socket');
      socket.onerror = () => {};
    } catch {}
  };
  </script>`,
  );
  await page
    .frameLocator('[data-testid="plugin-webview"]')
    .locator("#socket")
    .click();
  await expect
    .poll(() => actions(page))
    .toEqual(
      expect.arrayContaining([
        {
          action: "fixture.websocket-csp",
          payload: {
            effectiveDirective: "connect-src",
            blockedURI: expect.stringMatching(
              /^wss:\/\/webview-denied\.invalid(?:\/|$)/,
            ),
            disposition: "enforce",
            originalPolicy: expect.stringContaining("connect-src 'none'"),
          },
        },
      ]),
    );
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
});

test("window spoofing never becomes an action and oversized/non-JSON/rate traffic retires a port", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    window.postMessage({ type: "action", action: "spoof", payload: null }, "*");
    const sibling = document.createElement("iframe");
    sibling.srcdoc =
      '<script>parent.postMessage({type:"action",action:"sibling",payload:null},"*")<\/script>';
    document.body.append(sibling);
  });
  await page
    .frameLocator('[data-testid="plugin-webview"]')
    .locator("#action")
    .click();
  await expect.poll(() => actions(page)).toHaveLength(1);
  expect((await actions(page))[0].action).toBe("fixture.action");
  const attacks = [
    { source: "'x'.repeat(70000)", reason: "json-bytes" },
    { source: "new Map()", reason: "json-shape" },
    {
      source: "{deep:".repeat(30) + "null" + "}".repeat(30),
      reason: "json-depth",
    },
  ];
  for (const attack of attacks) {
    await updateView(page, {
      content: `<script>microcrab.onViewState(() => microcrab.action('attack',${attack.source}))</script>`,
    });
    await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
      "data-status",
      "retired",
    );
    await expect(page.getByTestId("plugin-webview-error")).toHaveAttribute(
      "data-reason",
      attack.reason,
    );
  }
  await updateView(page, {
    content:
      "<script>microcrab.onViewState(() => {for(let i=0;i<100;i++)microcrab.action('flood',i)})</script>",
  });
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "retired",
  );
  expect(
    (await actions(page)).filter((entry: any) => entry.action === "attack"),
  ).toEqual([]);
  expect(
    (await actions(page)).filter((entry: any) => entry.action === "flood")
      .length,
  ).toBeLessThanOrEqual(30);
});

test("host shim is immutable and guest closing tags cannot inject into bootstrap", async ({
  page,
}) => {
  const html = `</script></head></body><script>
try { Object.defineProperty(window,'microcrab',{value:{action(){}}}) } catch {}
microcrab.onViewState(state => microcrab.action('shim', {frozen:Object.isFrozen(microcrab),state}));
</script>`;
  await mount(page, html);
  await expect
    .poll(() => actions(page))
    .toEqual([
      { action: "shim", payload: { frozen: true, state: { count: 1 } } },
    ]);
});

test("owner/session/Worker/history/surface fences retire queued old messages and replace the document", async ({
  page,
}) => {
  await mount(page);
  for (const scopePatch of [
    { ownerId: "other" },
    { sessionId: "other-session" },
    { instanceGeneration: 2 },
    { historyGeneration: 2 },
    { surfaceId: "other-surface" },
  ]) {
    await page.evaluate(async (scopePatch) => {
      const host = window as any;
      const iframe = document.querySelector("iframe")!;
      // Keep an old WindowProxy and initiate old guest work before the synchronous fence.
      iframe.contentWindow!.postMessage(
        { type: "action", action: "queued-spoof", payload: null },
        "*",
      );
      const oldPort = host.fixturePorts.at(-1);
      const queued = oldPort.onmessage;
      host.updatePresentation({
        webviewScope: { ...host.presentation.webviewScope, ...scopePatch },
      });
      queued.call(
        oldPort,
        new MessageEvent("message", {
          data: { type: "action", action: "stale", payload: null },
        }),
      );
    }, scopePatch);
    await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
      "data-status",
      "ready",
    );
  }
  expect(await actions(page)).toEqual([]);
  await update(page, { visible: false });
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
  await update(page, { visible: true });
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  await updateView(page, { status: "disabled" });
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
});

test("mode/document switch and unmount revoke old channels; native textarea binds repeat aliases and current explicit payload", async ({
  page,
}) => {
  await mount(page);
  await updateView(page, {
    mode: "native-json",
    tree: {
      type: "repeat",
      props: { items: { $ref: "entries" }, as: "entry" },
      children: [
        { type: "textarea", props: { label: "Draft", bind: "entry.draft" } },
        {
          type: "button",
          props: {
            text: "Save",
            action: "save",
            action_payload: { $ref: "entry" },
          },
        },
      ],
    },
    vars: { entries: [{ draft: "first\nsecond", parsed: { value: null } }] },
  });
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "first\nsecond",
  );
  await page.getByRole("textbox", { name: "Draft" }).fill("replacement\nline");
  expect(await page.evaluate(() => (window as any).changes)).toEqual([
    { path: "entries.0.draft", value: "replacement\nline" },
  ]);
  await updateView(page, {
    vars: { entries: [{ draft: "current", parsed: [null, false, 3] }] },
  });
  await page.getByRole("button", { name: "Save" }).click();
  expect(await actions(page)).toEqual([
    { action: "save", payload: { draft: "current", parsed: [null, false, 3] } },
  ]);
  await updateView(page, { mode: "webview-html", content: inline });
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  await page.evaluate(() => (window as any).unmountPresentation());
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
});

test("oversized documents, missing scope and non-JSON projections fail visibly", async ({
  page,
}) => {
  await mount(page);
  await updateView(page, { content: "x".repeat(512 * 1024 + 1) });
  await expect(page.getByTestId("plugin-webview-error")).toHaveAttribute(
    "data-reason",
    "html-bytes",
  );
  await expect(page.getByTestId("plugin-webview")).toHaveCount(0);
  await updateView(page, { content: inline });
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  await page.evaluate(() => {
    const host = window as any;
    host.updatePresentation({
      view: { ...host.presentation.view, viewState: { value: Infinity } },
    });
  });
  await expect(page.getByTestId("plugin-webview-error")).toHaveAttribute(
    "data-reason",
    "json-shape",
  );
  await update(page, { webviewScope: undefined });
  await expect(page.getByTestId("plugin-webview-error")).toHaveAttribute(
    "data-reason",
    "missing-scope",
  );
});

test("self navigation is a documented residual and its subsequent load retires the bridge", async ({
  page,
}) => {
  await mount(
    page,
    '<button id="navigate" onclick="location.href=\'about:blank\'">Navigate</button>',
  );
  await page
    .frameLocator('[data-testid="plugin-webview"]')
    .locator("#navigate")
    .click();
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "retired",
  );
  await expect(page.getByTestId("plugin-webview-error")).toHaveAttribute(
    "data-reason",
    "navigation",
  );
  expect(await actions(page)).toEqual([]);
});
