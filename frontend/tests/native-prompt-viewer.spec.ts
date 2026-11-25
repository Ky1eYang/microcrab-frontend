import { expect, test, type Page } from "@playwright/test";

// Never record sensitive panel contents in Playwright artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const selection = {
  session_id: "s1",
  history_lineage: "lineage+&? /中",
  epoch: 0,
};
const endpoint = "**/api/v1/sessions/s1/history/prompt?*";
const permissionEndpoint = "**/api/v1/sessions/s1/permission?view=current";

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
      window.pendingPermissions = [];
      const readPermissions = ${inject ? `(scope, signal) => new Promise(resolve => window.pendingPermissions.push({ scope, signal, resolve }))` : "undefined"};
      const readPrompt = ${inject ? `(selection, signal) => new Promise(resolve => window.pendingPrompts.push({ selection, signal, resolve }))` : "undefined"};
      AppStore.prototype.start = function () {
        window.promptStore = this;
        this.update({ page: 'conversation', connection: 'ws', sessionId: 's1', composer: 'Untouched draft', resolvedLocale: 'en',
          authSession: { authenticated: true, principal: { owner: 'owner', expires_at: 9999999999 } },
          transcript: { ...this.state.transcript, historyView: { lineage: ${JSON.stringify(selection.history_lineage)}, epoch: 0 } } });
      };
      function Fixture() {
        const [target, setTarget] = React.useState({ sessionId: 's1', active: ${active} });
        window.setPromptTarget = setTarget;
        return React.createElement(NativePromptViewer, { ...target, readPrompt, readPermissions });
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
const badges = (page: Page) => page.locator(".native-prompt-permission");
const refreshPermissions = (page: Page) =>
  panel(page).getByRole("button", { name: "Refresh permissions" });

const policyTools = Array.from({ length: 6 }, (_, index) => ({
  name:
    index === 0
      ? "ask_user_question"
      : index === 3
        ? "long_".repeat(45)
        : `tool-${index}`,
  description: "Frozen declaration",
  parameters: { type: "object" },
}));
const policies = [
  { kind: "static", action: "allow" },
  { kind: "static", action: "ask" },
  { kind: "static", action: "deny" },
  {
    kind: "conditional",
    default_action: "ask",
    branches: [
      {
        args: [{ pointer: "/x", matcher: { kind: "exact", value: "yes" } }],
        action: "allow",
      },
    ],
  },
  {
    kind: "all_of",
    policies: [
      { kind: "static", action: "allow" },
      { kind: "static", action: "ask" },
    ],
  },
];
const policyRows = policies.map((policy, index) => ({
  name: policyTools[index].name,
  policy,
}));
const current = (tools = policyRows) => ({
  view: "current",
  current: {
    runtime_instance_id: "runtime",
    catalog_revision: "1",
    policy_revision: "1",
    ancestor_witness: "ancestors",
    agent: "",
    mode: "",
    tools,
  },
});
const policyPrompt = {
  ...selection,
  status: "available",
  system: "Frozen system",
  tools: policyTools,
};

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
  await page.route(permissionEndpoint, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "current_runtime_unavailable" } },
    }),
  );
  await mount(page, false, false);
  await expect(panel(page)).toHaveCount(0);
  expect(requests).toEqual([]);
  await target(page, "s1", true);
  const view = panel(page);
  const source = view.getByLabel("SYSTEM source");
  expect(await source.textContent()).toBe(system);
  const buttons = view.locator(".native-prompt-tool");
  await expect(buttons).toHaveCount(20);
  await expect(buttons.first()).toHaveAccessibleName("z-last-sort");
  await expect(buttons.first().locator(".native-prompt-permission")).toHaveText(
    "Permission unavailable",
  );
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
  await view.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(view.getByTestId("object-inspector")).toContainText(
    "9007199254740993",
  );
  await expect(view.getByTestId("object-inspector")).toContainText(
    "<iframe src=/never-load>",
  );
  await expect(
    view.getByRole("button", { name: "Expand array" }),
  ).toBeVisible();
  await view.getByRole("button", { name: "Text", exact: true }).click();
  await expect(parameters).toHaveText(schema);
  await expect(view.locator("img, iframe, a, script")).toHaveCount(0);
  await expect(view).not.toContainText("never render this metadata");
  await expect(view).toContainText(
    "not its frozen schema, past decisions or whether a tool can run",
  );
  await buttons.nth(1).click();
  await expect(buttons.first()).toHaveAttribute("aria-expanded", "false");
  await expect(buttons.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(fields).toHaveCount(0);
  await showJson();
  await expect(parameters).toHaveText("false");
  await view.getByRole("button", { name: "Next declarations" }).click();
  await expect(buttons.locator("code")).toHaveText(["a-20", "a-21"]);
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

test("renders every policy label accessibly on collapsed declarations at narrow width and larger text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route(endpoint, (route) => route.fulfill({ json: policyPrompt }));
  await page.route(permissionEndpoint, (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().postData()).toBeNull();
    return route.fulfill({ json: current([...policyRows].reverse()) });
  });
  await mount(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    document.documentElement.dataset.theme = "light";
  });
  await expect(badges(page)).toHaveText([
    "Allow",
    "Ask",
    "Deny",
    "Depends on arguments",
    "Combined policy",
    "Not currently registered",
  ]);
  const conditional = panel(page).getByRole("button", {
    name: policyTools[3].name,
    exact: true,
  });
  await expect(conditional).toHaveAttribute("aria-expanded", "false");
  await expect(conditional).toHaveAccessibleDescription(
    /Depends on arguments.*invocation arguments/,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    (window as any).promptStore.update({ resolvedLocale: "zh-CN" });
  });
  await expect(badges(page)).toHaveText([
    "允许",
    "需确认",
    "拒绝",
    "视参数而定",
    "组合策略",
    "当前未注册",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("the default frozen reader neither opts into nor consumes permissions", async ({
  page,
}) => {
  await page.route(endpoint, (route) => {
    expect(
      new URL(route.request().url()).searchParams.has("include_permissions"),
    ).toBe(false);
    return route.fulfill({
      json: { ...policyPrompt, current_permissions: { tools: policyRows } },
    });
  });
  await mount(page, false, false);
  const result = await page.evaluate(
    async ({ session_id, history_lineage, epoch }) => {
      const { readFrozenPrompt } = await import(
        "/src/features/prompt-viewer/frozen-prompt.ts" as string
      );
      return readFrozenPrompt(
        (window as any).promptStore.api,
        { sessionId: session_id, lineage: history_lineage, epoch },
        new AbortController().signal,
      );
    },
    selection,
  );
  expect(result).toMatchObject({
    status: "available",
    system: policyPrompt.system,
  });
  expect(result).not.toHaveProperty("currentPermissions");
});

test("current permission readers dedupe only in flight and preserve independent cancellation", async ({
  page,
}) => {
  let requests = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(permissionEndpoint, async (route) => {
    requests++;
    await blocked;
    await route.fulfill({ json: current() });
  });
  await mount(page, false, false);
  await page.evaluate(() => {
    const { api } = (window as any).promptStore;
    const aborted = new AbortController();
    const read = (owner: string, signal: AbortSignal) =>
      api.readCurrentPermissions(owner, "s1", "same-scope", signal).then(
        (list: any) => list.tools.length,
        () => "aborted",
      );
    (window as any).permissionReads = Promise.all([
      read("owner", aborted.signal),
      read("owner", new AbortController().signal),
      read("other-owner", new AbortController().signal),
    ]);
    aborted.abort();
  });
  await expect.poll(() => requests).toBe(2);
  release();
  expect(await page.evaluate(() => (window as any).permissionReads)).toEqual([
    "aborted",
    policyRows.length,
    policyRows.length,
  ]);
  await page.evaluate(() =>
    (window as any).promptStore.api.readCurrentPermissions(
      "owner",
      "s1",
      "same-scope",
      new AbortController().signal,
    ),
  );
  expect(requests).toBe(3);
});

test("bad or unavailable permission reads never replace frozen content", async ({
  page,
}) => {
  let wire: unknown = current();
  let status = 200;
  let frozenReads = 0;
  let permissionReads = 0;
  await page.route(endpoint, (route) => {
    frozenReads++;
    return route.fulfill({ json: policyPrompt });
  });
  await page.route(permissionEndpoint, (route) => {
    permissionReads++;
    return route.fulfill({ status, json: wire });
  });
  await mount(page);
  await expect(badges(page).first()).toHaveText("Allow");
  for (const value of [
    { ...current(), current: null },
    current([policyRows[0], ...policyRows]),
    current([
      { ...policyRows[0], policy: { kind: "static", action: "loading" } },
      ...policyRows.slice(1),
    ]),
    { ...current(), current: { ...current().current, policy_revision: 1 } },
    { ...current(), extra: true },
  ]) {
    wire = value;
    await refreshPermissions(page).click();
    await expect(badges(page)).toHaveText(
      Array(policyTools.length).fill("Permission unavailable"),
    );
    await expect(refreshPermissions(page)).toBeEnabled();
  }
  status = 409;
  wire = { error: { code: "current_runtime_unavailable" } };
  await refreshPermissions(page).click();
  await expect(badges(page)).toHaveText(
    Array(policyTools.length).fill("Permission unavailable"),
  );
  status = 200;
  wire = current([]);
  await refreshPermissions(page).click();
  await expect(badges(page)).toHaveText(
    Array(policyTools.length).fill("Not currently registered"),
  );
  expect(frozenReads).toBe(1);
  expect(permissionReads).toBe(8);
  await expect(panel(page).getByLabel("SYSTEM source")).toHaveText(
    policyPrompt.system,
  );
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

test("refreshes in place, fences stale policy reads, and expires evidence without polling", async ({
  page,
}) => {
  await page.clock.install();
  await mount(page, true);
  const view = panel(page);
  const tools = Array.from({ length: 22 }, (_, index) => ({
    name: `tool-${index}`,
    description: "",
    parameters: '{"z": 2,"a":1}',
  }));
  const pending = () =>
    page.evaluate(() =>
      (window as any).pendingPermissions.map(
        ({ signal }: any) => signal.aborted,
      ),
    );
  const patch = (value: object) =>
    page.evaluate((value) => (window as any).promptStore.update(value), value);
  const resolve = (index: number, policy: string) =>
    page.evaluate(
      ({ index, tools, policy }) => {
        (window as any).pendingPermissions[index].resolve({
          tools: tools.map(({ name }) => ({
            name,
            policy: { kind: "static", action: policy },
          })),
        });
      },
      { index, tools, policy },
    );
  await expect
    .poll(() => page.evaluate(() => (window as any).pendingPrompts.length))
    .toBe(1);
  await page.evaluate(
    (tools) =>
      (window as any).pendingPrompts[0].resolve({
        status: "available",
        system: "Frozen system",
        tools,
      }),
    tools,
  );
  await expect.poll(pending).toEqual([false]);
  await resolve(0, "allow");
  await view.getByRole("button", { name: "Next declarations" }).click();
  const tool = view.getByRole("button", { name: "tool-20", exact: true });
  await tool.click();
  const schema = view.getByRole("button", { name: "Parameters schema (JSON)" });
  await schema.click();
  const source = view.getByLabel("Parameters schema (JSON)");
  await source.focus();
  await expect(badges(page)).toHaveText(["Allow", "Allow"]);
  await patch({ policy: { revision: 1 } });
  await expect.poll(pending).toEqual([true, false]);
  await expect(badges(page)).toHaveText(["Reading policy…", "Reading policy…"]);
  await expect(source).toBeFocused();
  await patch({ modeSelectionPending: true });
  await expect.poll(pending).toEqual([true, true]);
  await expect(badges(page)).toHaveText([
    "Permission unavailable",
    "Permission unavailable",
  ]);
  await patch({
    modeSelectionPending: false,
    sessions: [{ id: "s1", mode: "other" }],
  });
  await expect.poll(pending).toEqual([true, true, false]);
  await resolve(2, "deny");
  await resolve(1, "allow");
  await expect(badges(page)).toHaveText(["Deny", "Deny"]);
  await expect(source).toBeFocused();
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await expect(view.getByRole("status")).toHaveText("21–22 / 22");
  await page.clock.fastForward(30_000);
  await expect(badges(page)).toHaveText([
    "Permission unavailable",
    "Permission unavailable",
  ]);
  expect((await pending()).length).toBe(3);
  const refresh = refreshPermissions(page);
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(refresh).toBeFocused();
  await expect.poll(pending).toEqual([true, true, true, false]);
  await resolve(3, "allow");
  await expect(refresh).toBeEnabled();
  await expect(badges(page)).toHaveText(["Allow", "Allow"]);
  expect(await page.evaluate(() => (window as any).pendingPrompts.length)).toBe(
    1,
  );
  await expect(source).toContainText('"a": 1');
  await refresh.click();
  await expect.poll(pending).toEqual([true, true, true, true, false]);
  await patch({ connection: "disconnected" });
  await expect.poll(pending).toEqual([true, true, true, true, true]);
  await resolve(4, "allow");
  await expect(badges(page)).toHaveText([
    "Permission unavailable",
    "Permission unavailable",
  ]);
  await expect(refresh).toBeFocused();
  await expect(tool).toHaveAttribute("aria-expanded", "true");
  await patch({ connection: "ws" });
  await expect.poll(pending).toEqual([true, true, true, true, true, false]);
  await target(page, "s1", false);
  await expect.poll(pending).toEqual([true, true, true, true, true, true]);
  await resolve(5, "allow");
  await expect(view).toHaveCount(0);
});

test("does not read while the browser document is hidden and aborts on visibility loss", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      get: () => visibility,
    });
    (window as any).setFixtureVisibility = (next: string) => {
      visibility = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await mount(page, true);
  const pending = () =>
    page.evaluate(() =>
      (window as any).pendingPrompts.map(({ signal }: any) => signal.aborted),
    );
  const show = (visibility: string) =>
    page.evaluate(
      (value) => (window as any).setFixtureVisibility(value),
      visibility,
    );
  await expect(panel(page).getByRole("status")).toHaveText(
    "Reading the frozen prompt…",
  );
  expect(await pending()).toEqual([]);
  await show("visible");
  await expect.poll(pending).toEqual([false]);
  await show("hidden");
  await expect.poll(pending).toEqual([true]);
  await page.evaluate(() =>
    (window as any).pendingPrompts[0].resolve({
      status: "available",
      system: "Old response",
      tools: [],
    }),
  );
  await expect(panel(page)).not.toContainText("Old response");
  expect(await pending()).toEqual([true]);
  await show("visible");
  await expect.poll(pending).toEqual([true, false]);
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


test("Prompt distinguishes attach and recovery without reading outside the current scope", async ({ page }) => {
  await mount(page, true);
  const region = panel(page);
  const reads = () => page.evaluate(() =>
    (window as any).pendingPrompts.map(({ signal }: { signal: AbortSignal }) => signal.aborted),
  );
  const update = (patch: Record<string, unknown>) => page.evaluate((value) =>
    (window as any).promptStore.update(value), patch,
  );
  await expect.poll(reads).toEqual([false]);
  await update({ sessionAttachingId: "s2" });
  await expect(region.getByRole("status")).toHaveText("Opening session…");
  await expect.poll(reads).toEqual([true]);
  await update({ sessionAttachingId: null, sessionTransportRecovery: "recovering" });
  await expect(region.getByRole("status")).toContainText("Restoring the Session connection");
  expect(await reads()).toEqual([true]);
  await update({ sessionTransportRecovery: "forbidden" });
  await expect(region.getByRole("status")).toHaveText("The server refused access to this Session connection.");
  await update({ authRequired: true });
  await expect(region.getByRole("status")).toHaveText("The frozen prompt is unavailable in this view.");
  expect(await reads()).toEqual([true]);
  await update({ authRequired: false, sessionTransportRecovery: null });
  await expect.poll(reads).toEqual([true, false]);
});
