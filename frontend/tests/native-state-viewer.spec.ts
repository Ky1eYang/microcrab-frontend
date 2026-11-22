import { expect, test, type Page } from "@playwright/test";
import {
  buildStateTree,
  findStateNodes,
  stateReference,
} from "../src/features/state-viewer/inspection";
import { nativeBackend } from "./native-fixture";
import { stateInspection } from "./state-inspection-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("reference grammar matches Core syntax and byte/depth limits", () => {
  expect(stateReference("settings.search", "visible", ["/a~b", "0", ""])).toBe(
    "{{var:settings.search:/~1a~0b/0/}}",
  );
  expect(stateReference("SECRET-token", "secret")).toBe(
    "{{secret:SECRET-token}}",
  );
  for (const key of [
    "",
    " leading",
    "1key",
    "a\n",
    "nonascii值",
    "a".repeat(129),
  ])
    expect(stateReference(key, "secret")).toBeUndefined();
  for (const path of [
    ["bad}}suffix"],
    ["ends}"],
    ["é".repeat(256)],
    Array(33).fill("x"),
  ])
    expect(stateReference("ok", "visible", path)).toBeUndefined();
  expect(stateReference("ok", "visible", ["a".repeat(511)])).toBeDefined();
  expect(stateReference("ok", "secret", ["nested"])).toBeUndefined();
  expect(stateReference("ok", "invisible")).toBeUndefined();
  expect(stateReference("ok", "visible", ["a}", "b"])).toBe("{{var:ok:/a}/b}}");
});

test("tree never reads protected payloads and bounds depth and sibling expansion", () => {
  const source = stateInspection(
    { large: Array(5000).fill("safe ordinary string"), later: "small" },
    {
      token: { visibility: "secret" },
      "invalid key": { visibility: "secret" },
    },
  );
  Object.defineProperty(source.values, "token", {
    enumerable: true,
    get() {
      throw Error("protected payload was accessed");
    },
  });
  const tree = buildStateTree(source);
  const token = tree.roots.find(({ label }) => label === "token");
  expect(token?.preview).toBeUndefined();
  expect(token?.reference).toBe("{{secret:token}}");
  expect(
    tree.roots.find(({ label }) => label === "invalid key")?.reference,
  ).toBeUndefined();
  expect(tree.roots.find(({ label }) => label === "later")?.preview).toBe(
    '"small"',
  );
  expect(findStateNodes(tree.roots, "safe ordinary").size).toBeGreaterThan(1);
  expect(tree.nodes.size).toBe(1500);
  expect(tree.limited).toBe(true);
  const deep: Record<string, any> = {};
  let last = deep;
  for (let i = 0; i < 60; i++) last = last.nested = {};
  const nested = buildStateTree(stateInspection({ deep }));
  expect(nested.nodes.size).toBe(33);
  expect(nested.limited).toBe(true);
});

test("capacity uses validated framework values, independent of tree bounds, and never historical custom values", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [`f${i}`, i]),
  );
  const capacity = { buffers: { limit: 2, used: 3, remaining: 0 } };
  const source = stateInspection({ ...fields, execution_capacity: capacity });
  const tree = buildStateTree(source);
  expect(tree.limited).toBe(true);
  expect(tree.executionCapacity.buffers).toEqual(capacity.buffers);
  expect(tree.executionCapacity.pending).toBeUndefined();
  const custom = stateInspection(
    { execution_capacity: capacity },
    { execution_capacity: { visibility: "visible" } },
  );
  expect(buildStateTree(custom).executionCapacity.buffers).toBeUndefined();
});

async function mount(
  page: Page,
  inject = false,
  methods = ["state.inspection"],
) {
  await page.route("**/native-state-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<meta name="viewport" content="width=device-width,initial-scale=1"><div id="fixture"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { AppStore } = await import('/src/state/store.ts');
      const { AppProvider, useAppStore } = await import('/src/state/index.ts');
      const { NativeStateViewer } = await import('/src/features/state-viewer/NativeStateViewer.tsx');
      await import('/src/styles/tokens.css'); await import('/src/styles/components.css'); await import('/src/styles/chrome.css');
      window.pendingState = []; window.copiedState = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => window.copiedState.push(text) } });
      const readInspection = ${inject ? `(id, signal) => new Promise((resolve) => window.pendingState.push({ id, signal, resolve }))` : "undefined"};
      AppStore.prototype.start = function () {
        window.stateStore = this;
        this.update({ page: 'conversation', viewMode: 'state', sessionId: 's1', composer: 'Keep this draft', resolvedLocale: 'en',
          authSession: { authenticated: true, principal: { owner: 'owner', expires_at: 9999999999999 } },
          capabilities: { methods: ${JSON.stringify(methods)}, limits: {} },
           transcript: { ...this.state.transcript, historyView: { lineage: 'first', epoch: 0 } } });
      };
      function Fixture() {
        useAppStore();
        const [target, setTarget] = React.useState({ sessionId: 's1', active: true });
        window.setStateTarget = setTarget;
        return React.createElement(NativeStateViewer, { ...target, readInspection });
      }
      ReactDOM.createRoot(document.querySelector('#fixture')).render(React.createElement(AppProvider, null, React.createElement(Fixture)));
    </script>`,
    }),
  );
  await page.goto("/native-state-fixture");
}

test("native panel inspects a hierarchy and copies references, never protected payloads or draft text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    requests.push(route.request().method());
    return route.fulfill({
      json: stateInspection(
        {
          profile: { "a/b~": ["a searchable city"] },
          hidden: "owner-only",
          token: { SYNTHETIC_RAW_PRIVATE_KEY: "SYNTHETIC_RAW_PRIVATE_VALUE" },
          framework: 1,
        },
        {
          profile: { visibility: "visible", persistence: "persisted" },
          hidden: { visibility: "invisible", persistence: "persisted" },
          token: { visibility: "secret", persistence: "ephemeral" },
          "invalid secret key": { visibility: "secret" },
        },
        "99",
      ),
    });
  });
  await mount(page);
  const panel = page.getByRole("region", { name: "Session State" });
  const search = panel.getByRole("searchbox");
  const copy = panel.getByRole("button", { name: "Copy reference" });
  await panel.getByRole("button", { name: "Expand: profile" }).click();
  await expect(panel.getByRole("button", { name: "a/b~ Array" })).toBeVisible();
  await search.fill("a searchable city");
  await panel.getByRole("button", { name: "0 String" }).click();
  await expect(panel).toContainText("a searchable city");
  await expect(panel.getByText("Custom", { exact: true })).toBeVisible();
  await expect(panel.getByText("99", { exact: true })).toBeVisible();
  await copy.click();
  await expect(panel.getByRole("status")).toHaveText("Reference copied.");
  await search.fill("SYNTHETIC_RAW_PRIVATE");
  await expect(panel).toContainText("No matching State fields.");
  await search.fill("");
  await panel
    .getByRole("button", { name: "token Secret", exact: true })
    .click();
  await expect(panel).toContainText("Secret values cannot be read.");
  expect(
    await panel.evaluate((node) =>
      node.textContent?.includes("SYNTHETIC_RAW_PRIVATE"),
    ),
  ).toBe(false);
  await copy.click();
  for (const name of [
    "hidden String",
    "framework Number",
    "invalid secret key Secret",
  ]) {
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(copy).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).copiedState)).toEqual([
    "{{var:profile:/a~1b~0/0}}",
    "{{secret:token}}",
  ]);
  expect(
    await page.evaluate(
      () => (window as any).stateStore.getSnapshot().composer,
    ),
  ).toBe("Keep this draft");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(requests).toEqual(["GET"]);
});

test("long native inspectors scroll within the conversation at mobile and desktop widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  const backend = await nativeBackend(page, {
    extraMethods: ["state.inspection"],
  });
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) =>
    route.fulfill({
      json: stateInspection(
        Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`field-${i}`, i]),
        ),
      ),
    }),
  );
  await page.route("**/api/v1/sessions/s1/history/prompt?*", (route) =>
    route.fulfill({
      json: {
        session_id: "s1",
        history_lineage: "viewer-layout",
        epoch: 0,
        status: "available",
        system: "One long source line\n".repeat(60),
        tools: Array.from({ length: 21 }, (_, i) => ({
          name: `tool-${i}`,
          description: "",
          parameters: {},
        })),
      },
    }),
  );
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  backend.publish({
    ...backend.snapshot(),
    history_view: {
      lineage: "viewer-layout",
      epoch: 0,
      start_cursor: 0,
      end_cursor: 2,
      message_count: 2,
      turns: [],
    },
  });
  await page.locator("#view-tab-prompt").click();
  const prompt = page.getByRole("region", { name: "Frozen Prompt" });
  const source = prompt.getByLabel("SYSTEM source");
  await expect(source).toBeVisible();
  await expect(source).toHaveCSS("overflow-y", "auto");
  const assertScrollport = async (panel: typeof prompt) => {
    await expect(panel).toHaveCSS("overflow-y", "auto");
    expect(
      await panel.evaluate(
        (node) =>
          node.scrollHeight > node.clientHeight &&
          node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
  };
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 640 });
    const next = prompt.getByRole("button", { name: "Next declarations" });
    await expect(next).toBeEnabled();
    await assertScrollport(prompt);
    await next.scrollIntoViewIfNeeded();
    expect(await prompt.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await next.click();
    await expect(prompt.getByRole("button", { name: "tool-20" })).toBeVisible();

    await page.locator("#view-tab-state").click();
    const state = page.getByRole("region", { name: "Session State" });
    const last = state.getByRole("button", { name: "field-49 Number" });
    await expect(last).toBeVisible();
    await assertScrollport(state);
    await last.click();
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => state.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await page.locator("#view-tab-prompt").click();
  }
});

test("history, owner, child and inactive views revoke stale reads and visible results", async ({
  page,
}) => {
  await mount(page, true);
  const pending = () =>
    page.evaluate(() =>
      ((window as any).pendingState ?? []).map(({ id, signal }: any) => [
        id,
        signal.aborted,
      ]),
    );
  const panel = page.getByRole("region", { name: "Session State" });
  await expect.poll(pending).toEqual([["s1", false]]);
  await page.evaluate(() => {
    const store = (window as any).stateStore;
    const { transcript } = store.getSnapshot();
    store.update({ transcript: { ...transcript, historyResetRevision: 1 } });
  });
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", false],
  ]);
  await page.evaluate(
    ([stale, current]) => {
      (window as any).pendingState[0].resolve(stale);
      (window as any).pendingState[1].resolve(current);
    },
    [stateInspection({ stale: true }), stateInspection({ fresh: true })],
  );
  await expect(
    panel.getByRole("button", { name: "fresh Boolean" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "stale Boolean" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const store = (window as any).stateStore;
    const { authSession } = store.getSnapshot();
    store.update({
      authSession: {
        ...authSession,
        principal: { ...authSession.principal, owner: "replacement" },
      },
    });
  });
  await expect(
    panel.getByRole("button", { name: "fresh Boolean" }),
  ).toHaveCount(0);
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", true],
    ["s1", false],
  ]);
  await page.evaluate(() =>
    (window as any).stateStore.update({
      popup: { type: "subagentDetail", childId: "child" },
    }),
  );
  await expect(panel).toContainText("State inspection is unavailable");
  await expect.poll(pending).toEqual([
    ["s1", true],
    ["s1", true],
    ["s1", true],
  ]);
  await page.evaluate(() => {
    (window as any).setStateTarget({ sessionId: "child", active: true });
    (window as any).stateStore.update({ popup: { type: "none" } });
  });
  await expect(panel).toContainText("State inspection is unavailable");
  await page.evaluate(() =>
    (window as any).setStateTarget({ sessionId: "s1", active: false }),
  );
  await expect(panel).toHaveCount(0);
  expect(await pending()).toHaveLength(3);
});

test("servers without State inspection show unreported capacity without an Execution History section", async ({
  page,
}) => {
  await mount(page, false, []);
  const panel = page.getByRole("region", { name: "Session State" });
  await expect(panel.getByRole("status")).toHaveText(
    "State inspection is unavailable in this view.",
  );
  await expect(
    panel.getByRole("heading", { name: "Runtime execution capacity" }),
  ).toBeVisible();
  await expect(panel.getByText("Not reported", { exact: true })).toHaveCount(2);
  await expect(
    panel.getByRole("heading", { name: "Execution history" }),
  ).toHaveCount(0);
});

test("the actual State tab keeps capacity and mounted Chat without listing executions", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await nativeBackend(page, {
    extraMethods: ["state.inspection", "executions.list"],
  });
  const stateReads: string[] = [];
  const executionReads: string[] = [];
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    stateReads.push(route.request().method());
    return route.fulfill({
      json: stateInspection({
        stable: true,
        execution_capacity: {
          buffers: { limit: 8, used: 7, remaining: 1 },
          pending: { limit: 16, used: "1", remaining: 15 },
        },
      }),
    });
  });
  await page.route(/\/api\/v1\/sessions\/[^/]+\/executions(?:\?|$)/, (route) => {
    executionReads.push(route.request().url());
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.goto("/#/session/s1");
  const transcript = page.locator("#conversation-transcript");
  await expect(transcript.getByText("历史提问", { exact: true })).toBeVisible();
  await transcript.evaluate((node) =>
    node.setAttribute("data-state-regression", "retained"),
  );
  expect(stateReads).toEqual([]);
  const stateTab = page.locator("#view-tab-state");
  await stateTab.focus();
  await page.keyboard.press("Enter");
  await expect(stateTab).toBeFocused();
  const panel = page.getByRole("region", { name: "Session State" });
  const field = panel.getByRole("button", { name: "stable Boolean" });
  await expect(field).toBeVisible();
  await expect(panel.getByText("7 of 8 used · 1 remaining")).toBeVisible();
  await expect(panel.getByText("Not reported", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Execution history" }),
  ).toHaveCount(0);
  await expect(transcript).toBeHidden();
  await expect(transcript).toHaveAttribute("data-state-regression", "retained");

  await panel.getByRole("button", { name: "Refresh State" }).click();
  await expect(field).toBeVisible();
  await page.locator("#view-tab-chat").click();
  await expect(panel).toHaveCount(0);
  await expect(transcript).toBeVisible();
  await expect(transcript).toHaveAttribute("data-state-regression", "retained");
  expect(stateReads).toEqual(["GET", "GET"]);

  await stateTab.click();
  await expect(field).toBeVisible();
  expect(stateReads).toEqual(["GET", "GET", "GET"]);
  expect(executionReads).toEqual([]);
});
