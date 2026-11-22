import { expect, test, type Page } from "@playwright/test";

// Never record sensitive panel contents in Playwright artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const selection = {
  session_id: "s1",
  history_lineage: "lineage+&? /中",
  epoch: 0,
};
const endpoint = "**/api/v1/sessions/s1/history/prompt?*";

async function mount(page: Page, inject = false, active = true) {
  await page.route("**/native-prompt-fixture", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { AppStore } = await import('/src/state/store.ts');
      const { AppProvider } = await import('/src/state/index.ts');
      const { NativePromptViewer } = await import('/src/features/prompt-viewer/NativePromptViewer.tsx');
      await import('/src/styles/tokens.css'); await import('/src/styles/components.css');
      window.pendingPrompts = [];
      const readPrompt = ${inject ? `(selection, signal) => new Promise(resolve => window.pendingPrompts.push({ selection, signal, resolve }))` : "undefined"};
      AppStore.prototype.start = function () {
        window.promptStore = this;
        this.update({ page: 'conversation', sessionId: 's1', composer: 'Untouched draft', resolvedLocale: 'en',
          authSession: { authenticated: true, principal: { owner: 'owner', expires_at: 9999999999 } },
          transcript: { ...this.state.transcript, historyView: { lineage: ${JSON.stringify(selection.history_lineage)}, epoch: 0 } } });
      };
      function Fixture() {
        const [target, setTarget] = React.useState({ sessionId: 's1', active: ${active} });
        window.setPromptTarget = setTarget;
        return React.createElement(NativePromptViewer, { ...target, readPrompt });
      }
      ReactDOM.createRoot(document.querySelector('#fixture')).render(React.createElement(AppProvider, null, React.createElement(Fixture)));
    </script>`,
    }),
  );
  await page.goto("/native-prompt-fixture");
  await page.waitForFunction(() => !!(window as any).promptStore);
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Frozen Prompt" });

async function target(page: Page, sessionId: string, active: boolean) {
  await page.evaluate(
    ([sessionId, active]) =>
      (window as any).setPromptTarget({ sessionId, active }),
    [sessionId, active],
  );
}

test("reads only on activation and renders exact inert source and ordered bounded declarations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  const system =
    '\n# SYSTEM  \r\n<img src="/never-load" onerror="alert(1)"> [link](https://invalid.example)\n';
  const schema = `{"properties":{"action":{"type":"string","description":"Choose an action"},"input":{"type":["string","null"]}},"required":["action"],"9":9007199254740993,"1":"<iframe src=/never-load>","$ref":"https://invalid.example/schema","array":[${Array(600).fill("false").join(",")}],"tail":null}`;
  const description = " <a href=/never-load>unsafe description</a>  \n";
  const tools = Array.from({ length: 22 }, (_, index) =>
    index === 0
      ? `{"name":"z-last-sort","description":${JSON.stringify(description)},"parameters":${schema},"permission":"never render this metadata"}`
      : `{"name":"a-${index}","description":"","parameters":false}`,
  ).join(",");
  await page.route(endpoint, (route) => {
    const request = route.request();
    const { searchParams } = new URL(request.url());
    requests.push(request.method());
    expect([...searchParams.entries()]).toEqual([
      ["history_lineage", selection.history_lineage],
      ["epoch", "0"],
    ]);
    expect(request.headers()["x-client-tab-id"]).toBeTruthy();
    expect(request.postData()).toBeNull();
    return route.fulfill({
      contentType: "application/json",
      body: `{${JSON.stringify(selection).slice(1, -1)},"status":"available","system":${JSON.stringify(system)},"tools":[${tools}],"provider_request":"never render this metadata"}`,
    });
  });
  await mount(page, false, false);
  await expect(panel(page)).toHaveCount(0);
  expect(requests).toEqual([]);
  await target(page, "s1", true);
  const view = panel(page);
  const source = view.getByLabel("SYSTEM source");
  expect(await source.textContent()).toBe(system);
  const buttons = view.locator(".native-prompt-tool");
  await expect(buttons).toHaveCount(20);
  await expect(buttons.first()).toHaveText("z-last-sort");
  const parameters = view.getByLabel("Parameters schema (JSON)");
  await expect(parameters).toHaveCount(0);
  await buttons.first().focus();
  await page.keyboard.press("Enter");
  await expect(buttons.first()).toHaveAttribute("aria-expanded", "true");
  const fields = view.locator(".native-prompt-fields");
  await expect(fields.locator("dt")).toHaveText([
    "actionstringRequired",
    "inputstring | null",
  ]);
  await expect(fields.getByText("Choose an action")).toBeVisible();
  await expect(parameters).toHaveCount(0);
  const showJson = () =>
    view
      .getByRole("button", { name: "Parameters schema (JSON)", exact: true })
      .click();
  await showJson();
  await expect(parameters).toContainText("9007199254740993");
  expect(await parameters.textContent()).toContain('\n  "properties":');
  await view.getByRole("checkbox", { name: "Show exact source" }).check();
  expect(await parameters.textContent()).toBe(schema);
  expect(
    await view
      .locator(".native-prompt-definition:not([hidden]) > p")
      .first()
      .textContent(),
  ).toBe(description);
  expect(await parameters.locator("span").count()).toBe(400);
  await expect(view.locator("img, iframe, a, script")).toHaveCount(0);
  await expect(view).not.toContainText("never render this metadata");
  await expect(view).toContainText(
    "not permissions or evidence that a tool can run",
  );
  await buttons.nth(1).click();
  await expect(buttons.first()).toHaveAttribute("aria-expanded", "false");
  await expect(buttons.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(fields).toHaveCount(0);
  await showJson();
  await expect(parameters).toHaveText("false");
  await view.getByRole("button", { name: "Next declarations" }).click();
  await expect(buttons).toHaveText(["a-20", "a-21"]);
  await expect(parameters).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as any).promptStore.getSnapshot().composer,
    ),
  ).toBe("Untouched draft");
  expect(requests).toEqual(["GET"]);
});

test("unavailable, stale, invalid and oversized responses never show fallback content", async ({
  page,
}) => {
  let next: Parameters<import("@playwright/test").Route["fulfill"]>[0] = {
    json: {
      ...selection,
      status: "unavailable",
      reason: "missing_evidence",
      system: "DO NOT RENDER",
    },
  };
  await page.route(endpoint, (route) => route.fulfill(next));
  await mount(page);
  const view = panel(page);
  await expect(view.getByRole("status")).toHaveText(
    /No verified frozen prompt/,
  );
  next = {
    status: 409,
    json: { error: { code: "stale_history", message: "DO NOT RENDER" } },
  };
  await view.getByRole("button", { name: "Read again" }).click();
  await expect(view.getByRole("status")).toHaveText(
    /history selection is stale/,
  );
  await expect(view.getByRole("button")).toHaveCount(0);
  async function reopen(text: RegExp) {
    await target(page, "s1", false);
    await expect(view).toHaveCount(0);
    await target(page, "s1", true);
    await expect(view.getByRole("status")).toHaveText(text);
    await expect(view).not.toContainText("DO NOT RENDER");
    await expect(view.locator("pre")).toHaveCount(0);
  }
  next = {
    status: 409,
    json: { error: { code: "busy", message: "DO NOT RENDER" } },
  };
  await reopen(/Could not read/);
  next = {
    json: {
      ...selection,
      epoch: 1,
      status: "available",
      system: "DO NOT RENDER",
      tools: [],
    },
  };
  await reopen(/history selection is stale/);
  next = {
    json: { ...selection, status: "unavailable", reason: "response_limit" },
  };
  await reopen(/response limit/);
  next = { status: 404, json: { error: { message: "DO NOT RENDER" } } };
  await reopen(/No verified frozen prompt/);
  next = {
    json: {
      ...selection,
      status: "available",
      system: "DO NOT RENDER",
      tools: [{ name: "bad" }],
    },
  };
  await reopen(/Could not read/);
  next = {
    json: {
      ...selection,
      status: "available",
      system: "中".repeat(90_000),
      tools: [],
    },
  };
  await reopen(/Could not read/);
  next = { json: { ...selection, status: "available", system: "", tools: [] } };
  await view.getByRole("button", { name: "Read again" }).click();
  await expect(view).toContainText("The frozen SYSTEM source is empty.");
  await expect(view).toContainText("No tools were declared in this prompt.");
});

test("aborts and revokes results across owner, Session, history, child, and panel changes", async ({
  page,
}) => {
  await mount(page, true);
  const view = panel(page);
  const pending = () =>
    page.evaluate(() =>
      (window as any).pendingPrompts.map(({ selection, signal }: any) => ({
        ...selection,
        aborted: signal.aborted,
      })),
    );
  const count = (n: number) =>
    expect.poll(async () => (await pending()).length).toBe(n);
  const resolve = (index: number, system: string) =>
    page.evaluate(
      ([index, system]) =>
        (window as any).pendingPrompts[Number(index)].resolve({
          status: "available",
          system,
          tools: [],
        }),
      [index, system],
    );
  const patch = (value: object) =>
    page.evaluate((value) => (window as any).promptStore.update(value), value);
  const history = (values: object) =>
    page.evaluate((values) => {
      const store = (window as any).promptStore;
      const transcript = store.getSnapshot().transcript;
      const { historyResetRevision, ...view } = values as any;
      store.update({
        transcript: {
          ...transcript,
          historyResetRevision,
          historyView: { ...transcript.historyView, ...view },
        },
      });
    }, values);
  await count(1);
  await history({ lineage: "second" });
  await count(2);
  await history({ epoch: 1 });
  await count(3);
  await history({ historyResetRevision: 1 });
  await count(4);
  expect(await pending()).toEqual([
    {
      sessionId: "s1",
      lineage: selection.history_lineage,
      epoch: 0,
      aborted: true,
    },
    { sessionId: "s1", lineage: "second", epoch: 0, aborted: true },
    { sessionId: "s1", lineage: "second", epoch: 1, aborted: true },
    { sessionId: "s1", lineage: "second", epoch: 1, aborted: false },
  ]);
  await resolve(3, "CURRENT FROZEN");
  await expect(view).toContainText("CURRENT FROZEN");
  await resolve(0, "OLD FROZEN");
  await resolve(1, "OLD FROZEN");
  await resolve(2, "OLD FROZEN");
  await expect(view).not.toContainText("OLD FROZEN");
  await patch({ composer: "Ordinary chat update" });
  await expect(view).toContainText("CURRENT FROZEN");
  await count(4);
  await patch({
    authSession: { authenticated: true, principal: { owner: "new-owner" } },
  });
  await count(5);
  await expect(view).not.toContainText("CURRENT FROZEN");
  await patch({ popup: { type: "subagentDetail" } });
  await expect(view.getByRole("status")).toHaveText(/unavailable in this view/);
  expect((await pending())[4].aborted).toBe(true);
  await patch({ popup: null, sessionAttachingId: "s2" });
  await count(5);
  await patch({ sessionAttachingId: null, sessionId: "s2" });
  await target(page, "s2", true);
  await count(6);
  expect((await pending())[5].sessionId).toBe("s2");
  await target(page, "s2", false);
  await expect(view).toHaveCount(0);
  expect((await pending())[5].aborted).toBe(true);
  await target(page, "s2", true);
  await count(7);
  await patch({ authSession: { authenticated: false } });
  await expect(view.getByRole("status")).toHaveText(/unavailable in this view/);
  expect((await pending())[6].aborted).toBe(true);
});
