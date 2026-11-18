import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  page.on("pageerror", (error) => {
    throw error;
  });
  const html =
    '<button id="copy">Copy</button><script>window.result="";window.copy=()=>microcrab.copyText("copied 文本").then(()=>window.result="ok",error=>window.result=error.message);document.getElementById("copy").onclick=window.copy;microcrab.onViewState(()=>{microcrab.copyText("startup").then(()=>window.initialResult="ok",error=>window.initialResult=error.message)});</script>';
  await page.route("**/clipboard-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
<meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {default:dom}=await import('/node_modules/.vite/deps/react-dom.js');
const flushSync=dom.flushSync;
const NativeChannel=MessageChannel; window.channels=[];
window.MessageChannel=class extends NativeChannel {constructor(){super();window.channels.push(this);const post=this.port1.postMessage.bind(this.port1);this.port1.postMessage=value=>{(window.receipts??=[]).push(value);post(value);};}};
const {PluginWebview}=await import('/src/plugins/PluginWebview.tsx');
const root=ReactDOM.createRoot(document.getElementById('root'));
window.props={view:{pluginId:'copy',target:'sidebar',status:'ready',mode:'webview-html',content:${JSON.stringify(html).replace(/</g, "\\u003c")}},scope:{ownerId:'owner',sessionId:'session',instanceGeneration:1,historyGeneration:1,surfaceId:'sidebar:copy'},onAction:()=>{}};
window.render=(patch={})=>{window.props={...window.props,...patch};flushSync(()=>root.render(React.createElement(PluginWebview,window.props)));};window.render();
</script>`,
    }),
  );
  await page.goto("/clipboard-fixture");
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
}
const guest = (page: Page) =>
  page.frames().find((frame) => frame.url() === "about:srcdoc")!;
async function result(page: Page) {
  return guest(page).evaluate(() => (window as any).result);
}

test("real iframe click writes through native parent clipboard while direct guest permissions stay denied", async ({
  page,
  context,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "native-copy";
    button.textContent = "Native parent copy";
    button.onclick = () =>
      navigator.clipboard.writeText("native").then(
        () => ((window as any).nativeResult = "ok"),
        (error) =>
          ((window as any).nativeResult = error.name + ": " + error.message),
      );
    document.body.append(button);
  });
  await page.locator("#native-copy").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).nativeResult))
    .toBeDefined();
  const nativeResult = await page.evaluate(() => (window as any).nativeResult);
  test.info().annotations.push({
    type: "native-parent-clipboard",
    description: nativeResult,
  });
  await context.grantPermissions(["clipboard-write"]);
  await page.frameLocator("iframe").locator("#copy").click();
  await expect.poll(() => result(page)).toBe("ok");
  // Read permission is test-observation only and is granted AFTER the native write.
  await context.grantPermissions(["clipboard-read"]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "copied 文本",
  );
  expect(
    await guest(page).evaluate(async () => {
      try {
        await navigator.clipboard.writeText("guest overwrite");
        return "allowed";
      } catch {
        return "denied";
      }
    }),
  ).toBe("denied");
});

test("no gesture and oversized values reject without native writes", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (window as any).writes = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as any).writes.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  await expect
    .poll(() => guest(page).evaluate(() => (window as any).initialResult))
    .toContain("user activation");
  expect(
    await guest(page).evaluate(async () => {
      try {
        await (window as any).microcrab.copyText("x".repeat(49153));
        return "ok";
      } catch (error) {
        return (error as Error).message;
      }
    }),
  ).toContain("48 KiB");
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test("unavailable and denied native clipboard reject concretely without retry", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.frameLocator("iframe").locator("#copy").click();
  await expect.poll(() => result(page)).toContain("unavailable");
  await page.reload();
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "ready",
  );
  await page.evaluate(() => {
    (window as any).writes = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          (window as any).writes++;
          return Promise.reject(
            new DOMException("Fixture denial", "NotAllowedError"),
          );
        },
      },
    });
  });
  await page.frameLocator("iframe").locator("#copy").click();
  await expect.poll(() => result(page)).toContain("NotAllowedError");
  expect(await page.evaluate(() => (window as any).writes)).toBe(1);
});

test("raw requests cannot claim activation and malformed or replayed identities retire the channel", async ({
  page,
}) => {
  for (const data of [
    { type: "clipboard-write", id: 0, text: "bad" },
    { type: "clipboard-write", id: 1.5, text: "bad" },
    { type: "clipboard-write", id: 1, text: 42 },
    { type: "clipboard-write", id: 1, text: "bad", activation: true },
  ]) {
    await mount(page);
    await page.evaluate(
      (data) =>
        (window as any).channels[0].port1.dispatchEvent(
          new MessageEvent("message", { data }),
        ),
      data,
    );
    await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
      "data-status",
      "retired",
    );
  }
  await mount(page);
  await page.evaluate(() =>
    (window as any).channels[0].port1.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "clipboard-write", id: 1, text: "no gesture" },
      }),
    ),
  );
  expect(
    await page.evaluate(() =>
      (window as any).receipts.filter(
        (entry: any) => entry.type === "clipboard-result",
      ),
    ),
  ).toEqual([
    {
      type: "clipboard-result",
      id: 1,
      ok: false,
      error: "Clipboard mount is not visible and focused",
    },
  ]);
  await page.evaluate(() =>
    (window as any).channels[0].port1.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "clipboard-write", id: 1, text: "replay" },
      }),
    ),
  );
  await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
    "data-status",
    "retired",
  );
});

test("one pending copy and request rate prevent repeated mutations in one gesture", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (window as any).writes = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          (window as any).writes++;
          return new Promise(
            (resolve) => ((window as any).finishCopy = resolve),
          );
        },
      },
    });
  });
  await guest(page).evaluate(() => {
    document.getElementById("copy")!.onclick = () => {
      const api = (window as any).microcrab;
      (window as any).first = api.copyText("first").then(() => {
        (window as any).firstResult = "ok";
        return api
          .copyText("third")
          .catch(
            (error: Error) => ((window as any).thirdResult = error.message),
          );
      });
      api
        .copyText("second")
        .catch(
          (error: Error) => ((window as any).secondResult = error.message),
        );
    };
  });
  await page.frameLocator("iframe").locator("#copy").click();
  await expect
    .poll(() => guest(page).evaluate(() => (window as any).secondResult))
    .toContain("already pending");
  await page.evaluate(() => (window as any).finishCopy());
  await expect
    .poll(() => guest(page).evaluate(() => (window as any).thirdResult))
    .toContain("rate exceeded");
  expect(await page.evaluate(() => (window as any).writes)).toBe(1);
  expect(
    await guest(page).evaluate(async () => {
      try {
        await (window as any).microcrab.copyText("\u0001".repeat(12000));
        return "ok";
      } catch (error) {
        return (error as Error).message;
      }
    }),
  ).toContain("64 KiB envelope");
});

for (const change of ["disabled", "history", "owner", "surface"]) {
  test(`${change} retires pending request and never replays native mutation`, async ({
    page,
  }) => {
    await mount(page);
    await page.evaluate(() => {
      (window as any).writes = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => {
            (window as any).writes++;
            return new Promise(
              (resolve) => ((window as any).finishCopy = resolve),
            );
          },
        },
      });
    });
    await page.frameLocator("iframe").locator("#copy").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).writes))
      .toBe(1);
    await page.evaluate((change) => {
      const w = window as any;
      w.render(
        change === "disabled"
          ? { visible: false }
          : {
              scope: {
                ...w.props.scope,
                ...(change === "history"
                  ? { historyGeneration: 2 }
                  : change === "owner"
                    ? { ownerId: "other" }
                    : { surfaceId: "expanded:copy" }),
              },
            },
      );
      w.finishCopy();
    }, change);
    expect(
      await page.evaluate(() =>
        (window as any).receipts.filter(
          (value: any) => value.type === "host-retired",
        ),
      ),
    ).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        (window as any).receipts.filter(
          (value: any) => value.type === "clipboard-result",
        ),
      ),
    ).toEqual([]);
    expect(await page.evaluate(() => (window as any).writes)).toBe(1);
    if (change !== "disabled")
      await expect(page.getByTestId("plugin-webview")).toHaveAttribute(
        "data-status",
        "ready",
      );
  });
}
