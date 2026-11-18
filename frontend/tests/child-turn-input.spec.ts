import { ChildInputDocuments } from "../src/client/child-input-documents";
import { expect, test, type Page } from "@playwright/test";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";
import {
  childInputAllowed,
  settledReturnChild,
  validateChildTurnOperation,
} from "../src/client/child-turns";
import type { NativeChildDetail } from "../src/client/types";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

const childId = "child-input";
const scope = { parentId: "s1", childId };
function detail(patch: Partial<NativeChildDetail> = {}): NativeChildDetail {
  return {
    id: childId,
    parent_session_id: "s1",
    name: "coding",
    status: "waiting",
    availability: "persisted",
    agent_id: "agt_0123456789abcdef",
    depth: 1,
    interaction: "persistent",
    current_role: "both",
    accepts_user_input: true,
    messages: [
      {
        id: "child-old",
        role: "assistant",
        text: "Child earlier response",
        parts: [],
        tool_calls: [],
      },
    ],
    next_cursor: null,
    messages_truncated: false,
    receipt: null,
    usage: null,
    executions: [],
    history: null,
    ...patch,
  };
}
function receipt(
  id: string,
  status: "accepted" | "completed" | "failed" | "cancelled" = "completed",
) {
  return {
    version: 1,
    id,
    session_id: "s1",
    owner: "u1",
    method: "child.turn.submit",
    payload_hash: "a".repeat(64),
    status,
    result:
      status === "accepted"
        ? {
            child_id: childId,
            server_instance: "11111111-1111-4111-8111-111111111111",
          }
        : status === "completed"
          ? {
              child_id: childId,
              outcome: {
                content: "Done",
                rounds: 1,
                usage: {},
                stop_reason: "model_completed",
                content_truncated: false,
              },
            }
          : {
              child_id: childId,
              error: {
                code: "child_cancelled",
                message: "Child ended after admission",
              },
            },
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}
async function open(page: Page) {
  await page.goto("/#session/s1");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: zh["header.details"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toBeVisible();
}

test("child input requires exact fresh explicit server authority and receipt identity", () => {
  expect(childInputAllowed(detail(), scope)).toBe(true);
  for (const patch of [
    { current_role: "sub_agent" },
    { current_role: null },
    { interaction: "return" },
    { accepts_user_input: false },
    { accepts_user_input: undefined },
    { depth: null },
    { depth: 2 },
    { agent_id: null },
    { parent_session_id: "other" },
    { id: "other" },
    { availability: "pending" },
  ] as Partial<NativeChildDetail>[])
    expect(childInputAllowed(detail(patch), scope)).toBe(false);
  const id = "11111111-1111-4111-8111-111111111111";
  expect(() =>
    validateChildTurnOperation(receipt(id), scope, id, "u1"),
  ).not.toThrow();
  for (const changed of [
    { owner: "other" },
    { session_id: childId },
    { method: "turn.submit" },
    { id: "other" },
    { result: { child_id: "wrong" } },
    { status: "running" },
  ])
    expect(() =>
      validateChildTurnOperation(
        { ...receipt(id), ...changed },
        scope,
        id,
        "u1",
      ),
    ).toThrow(/receipt identity/);
  for (const status of [
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "completed",
  ])
    expect(settledReturnChild(detail({ interaction: "return", status }))).toBe(
      true,
    );
  expect(
    settledReturnChild(detail({ interaction: "return", status: "running" })),
  ).toBe(false);
  expect(
    settledReturnChild(
      detail({ interaction: "persistent", status: "completed" }),
    ),
  ).toBe(false);
});

test("child draft memory is bounded and owner/API changes discard old witnesses", () => {
  const documents = new ChildInputDocuments();
  const api = {};
  const first = documents.open(api, "u1", scope);
  first.text = "private draft";
  first.operation = {
    request: {
      operation_id: "11111111-1111-4111-8111-111111111111",
      input: { parts: [{ type: "text", text: first.text }] },
    },
    text: first.text,
    generation: 0,
  };
  expect(documents.open(api, "u1", scope)).toBe(first);
  for (let index = 1; index < documents.maximumDocuments; index++)
    documents.open(api, "u1", {
      parentId: "s1",
      childId: `child-${index}`,
    }).text = "kept";
  expect(() =>
    documents.open(api, "u1", { parentId: "s1", childId: "overflow" }),
  ).toThrow(/capacity/);
  expect(documents.open(api, "other-owner", scope)).toMatchObject({
    text: "",
    operation: null,
  });
  expect(documents.open({}, "u1", scope)).toMatchObject({
    text: "",
    operation: null,
  });
});

test("entered Both child posts only targeted child input and leaves parent draft/socket/route untouched", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { children: [detail()] });
  const posts: any[] = [];
  let reads = 0;
  await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) => {
    reads++;
    return route.fulfill({ json: detail() });
  });
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    async (route) => {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ json: receipt(posts[0].operation_id) });
    },
  );
  await page.goto("/#session/s1");
  await connectHostUI(page);
  await page.locator(".home-composer-textarea").fill("Parent untouched draft");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: zh["header.details"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toBeEnabled();
  await page.getByTestId("child-input").fill("Child only input");
  await page.getByTestId("child-send").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.completed"],
  );
  await expect(page.getByTestId("child-input")).toHaveValue("");
  expect(posts).toHaveLength(1);
  expect(posts[0].operation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[0].input).toEqual({
    parts: [{ type: "text", text: "Child only input" }],
  });
  expect(reads).toBeGreaterThanOrEqual(3); // entry, fresh authority, exact terminal child refresh
  expect(page.url()).toContain("#session/s1");
  expect(
    backend.commands.some((command) => command.method === "turn.submit"),
  ).toBe(false);
  await page
    .getByRole("button", {
      name: backend.snapshot().session.title,
      exact: true,
    })
    .click();
  await expect(page.getByTestId("child-content-view")).toHaveCount(0);
  await expect(
    page.locator(".home-composer-textarea").filter({ visible: true }),
  ).toHaveValue("Parent untouched draft");
});

for (const mode of ["sub", "return", "legacy", "revoked"] as const) {
  test(`${mode} child remains read-only with server metadata reason`, async ({
    page,
  }) => {
    const patch: Partial<NativeChildDetail> =
      mode === "sub"
        ? { current_role: "sub_agent" }
        : mode === "return"
          ? { interaction: "return" }
          : mode === "revoked"
            ? { accepts_user_input: false }
            : {
                agent_id: null,
                depth: null,
                interaction: null,
                current_role: null,
                accepts_user_input: undefined,
              };
    await nativeBackend(page, { children: [detail(patch)] });
    const entries: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/enter")) entries.push(request.method());
    });
    await open(page);
    await expect(page.getByTestId("child-input")).toBeDisabled();
    await expect(page.getByTestId("child-send")).toBeDisabled();
    await expect(page.getByTestId("child-input-readonly")).toBeVisible();
    expect(entries).toEqual(
      mode === "return" || mode === "legacy" ? [] : ["POST"],
    );
  });
}

for (const uncertain of [false, true]) {
  test(`explicit persistent entry ${uncertain ? "observes unknown binding" : "reattaches"} and ordinary refresh stays read-only`, async ({
    page,
  }) => {
    await nativeBackend(page, { children: [detail()] });
    let bound = false;
    let entries = 0;
    await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) =>
      route.fulfill({ json: detail({ accepts_user_input: bound }) }),
    );
    await page.route(
      `**/api/v1/sessions/s1/children/${childId}/enter`,
      async (route) => {
        entries++;
        bound = true;
        expect(route.request().postDataJSON()).toEqual({});
        if (uncertain) await route.abort("failed");
        else await route.fulfill({ json: detail() });
      },
    );
    await open(page);
    if (uncertain) {
      await expect(
        page.getByText(zh["childInput.entryUnknown"], { exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("child-input")).toBeDisabled();
    } else await expect(page.getByTestId("child-input")).toBeEnabled();
    await page
      .getByTestId("child-session-dock")
      .getByRole("button", { name: zh["child.refresh"], exact: true })
      .click();
    await expect(page.getByTestId("child-input")).toBeEnabled();
    expect(entries).toBe(1);
  });
}

test("same child refresh retains draft across role changes and fails closed on changed preflight authority", async ({
  page,
}) => {
  await nativeBackend(page, { children: [detail()] });
  let current = detail();
  let posts = 0;
  await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) =>
    route.fulfill({ json: current }),
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    (route) => {
      posts++;
      return route.fulfill({
        json: receipt(route.request().postDataJSON().operation_id),
      });
    },
  );
  await open(page);
  await page.getByTestId("child-input").fill("Retained child draft");
  current = detail({ current_role: "sub_agent", accepts_user_input: false });
  await page
    .getByTestId("child-session-dock")
    .getByRole("button", { name: zh["child.refresh"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Retained child draft",
  );
  await expect(page.getByTestId("child-input")).toBeDisabled();
  current = detail();
  await page
    .getByTestId("child-session-dock")
    .getByRole("button", { name: zh["child.refresh"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toBeEnabled();
  current = detail({ current_role: "sub_agent", accepts_user_input: false });
  await page.getByTestId("child-send").click();
  await expect(
    page.getByTestId("child-turn-composer").getByRole("alert"),
  ).toContainText("child_input_unavailable");
  expect(posts).toBe(0);
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Retained child draft",
  );
});

test("unknown child submission observes exact durable receipt, 404 preserves draft and never replays POST", async ({
  page,
}) => {
  await nativeBackend(page, { children: [detail()] });
  const posts: any[] = [];
  const gets: string[] = [];
  let found = false;
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    async (route) => {
      posts.push(route.request().postDataJSON());
      await route.abort("failed");
    },
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns/*`,
    (route) => {
      gets.push(route.request().url());
      return found
        ? route.fulfill({ json: receipt(posts[0].operation_id) })
        : route.fulfill({
            status: 404,
            json: {
              error: {
                code: "operation_not_found",
                message: "No recorded child operation",
              },
            },
          });
    },
  );
  await open(page);
  await page.getByTestId("child-input").fill("Unknown child draft");
  await page.getByTestId("child-send").click();
  await expect(
    page.getByText(zh["childInput.unknown"], { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.getByTestId("child-observe-operation").click();
  await expect(
    page.getByTestId("child-turn-composer").getByRole("alert"),
  ).toContainText("operation_not_found");
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Unknown child draft",
  );
  await expect(page.getByTestId("child-send")).toBeDisabled();
  found = true;
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.getByTestId("child-observe-operation").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.completed"],
  );
  await expect(page.getByTestId("child-input")).toHaveValue("");
  expect(posts).toHaveLength(1);
  expect(gets).toHaveLength(2);
  expect(gets.every((url) => url.endsWith(`/${posts[0].operation_id}`))).toBe(
    true,
  );
});

for (const status of ["failed", "cancelled"] as const) {
  test(`terminal ${status} preserves child draft and refreshes only child history`, async ({
    page,
  }) => {
    await nativeBackend(page, { children: [detail()] });
    let reads = 0;
    await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) => {
      reads++;
      return route.fulfill({ json: detail() });
    });
    await page.route(
      `**/api/v1/sessions/s1/children/${childId}/turns`,
      (route) =>
        route.fulfill({
          json: receipt(route.request().postDataJSON().operation_id, status),
        }),
    );
    await open(page);
    await page.getByTestId("child-input").fill("Preserved after failure");
    await page.getByTestId("child-send").click();
    await expect(page.getByTestId("child-operation-status")).toHaveText(
      zh[`childInput.operation.${status}`],
    );
    await expect(page.getByTestId("child-input")).toHaveValue(
      "Preserved after failure",
    );
    await expect(
      page.getByText(zh["childInput.failedMayApply"], { exact: true }),
    ).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(3);
  });
}

test("recovered accepted child interruption preserves draft and never claims failed admission", async ({
  page,
}) => {
  await nativeBackend(page, { children: [detail()] });
  let posts = 0;
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    (route) => {
      posts++;
      return route.fulfill({
        status: 202,
        json: receipt(route.request().postDataJSON().operation_id, "accepted"),
      });
    },
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns/*`,
    (route) =>
      route.fulfill({
        json: {
          ...receipt(route.request().url().split("/").at(-1)!, "failed"),
          result: {
            child_id: childId,
            error: {
              code: "operation_interrupted",
              message: "The prior server instance ended before settlement",
              details: { admission: "unknown" },
            },
          },
        },
      }),
  );
  await open(page);
  await page
    .getByTestId("child-input")
    .fill("Retained across server interruption");
  await page.getByTestId("child-send").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.failed"],
  );
  await expect(
    page.getByTestId("child-turn-composer").getByRole("alert"),
  ).toContainText("operation_interrupted");
  await expect(
    page.getByText(zh["childInput.failedMayApply"], { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Retained across server interruption",
  );
  expect(posts).toBe(1);
});

test("leaving and re-entering an accepted child preserves exact operation lock without another POST", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { children: [detail()] });
  const posts: any[] = [];
  const observations: string[] = [];
  let completed = false;
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    (route) => {
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: receipt(posts[0].operation_id, "accepted"),
      });
    },
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns/*`,
    (route) => {
      observations.push(route.request().url());
      return route.fulfill({
        json: receipt(
          posts[0].operation_id,
          completed ? "completed" : "accepted",
        ),
      });
    },
  );
  await open(page);
  await page.getByTestId("child-input").fill("Accepted before leaving");
  await page.getByTestId("child-send").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.accepted"],
  );
  await page
    .getByRole("button", {
      name: backend.snapshot().session.title,
      exact: true,
    })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page
    .getByRole("button", { name: zh["speakers.discardLeave"], exact: true })
    .click();
  await expect(page.getByTestId("child-content-view")).toHaveCount(0);
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: zh["header.details"], exact: true })
    .click();
  await expect(page.getByTestId("child-observe-operation")).toBeVisible();
  await expect(page.getByTestId("child-send")).toBeDisabled();
  completed = true;
  await page.getByTestId("child-observe-operation").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.completed"],
  );
  expect(posts).toHaveLength(1);
  expect(observations.length).toBeGreaterThanOrEqual(1);
  expect(
    observations.every((url) => url.endsWith(`/${posts[0].operation_id}`)),
  ).toBe(true);
});

test("accepted operation remains observable when current child mode changes to SubAgent", async ({
  page,
}) => {
  await nativeBackend(page, { children: [detail()] });
  let current = detail();
  let posts = 0;
  let completed = false;
  await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) =>
    route.fulfill({ json: current }),
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    (route) => {
      posts++;
      return route.fulfill({
        status: 202,
        json: receipt(route.request().postDataJSON().operation_id, "accepted"),
      });
    },
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns/*`,
    (route) =>
      route.fulfill({
        json: receipt(
          route.request().url().split("/").at(-1)!,
          completed ? "completed" : "accepted",
        ),
      }),
  );
  await open(page);
  await page.getByTestId("child-input").fill("Accepted before role change");
  await page.getByTestId("child-send").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.accepted"],
  );
  current = detail({ current_role: "sub_agent", accepts_user_input: false });
  await page
    .getByTestId("child-session-dock")
    .getByRole("button", { name: zh["child.refresh"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Accepted before role change",
  );
  await expect(page.getByTestId("child-send")).toBeDisabled();
  await expect(page.getByTestId("child-observe-operation")).toBeEnabled();
  completed = true;
  await page.getByTestId("child-observe-operation").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.completed"],
  );
  await expect(page.getByTestId("child-input")).toBeDisabled();
  expect(posts).toBe(1);
});

test("owner replacement fences an in-flight child receipt and clears private draft state", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posted = "";
  await page.route(`**/api/v1/sessions/s1/children/${childId}?*`, (route) =>
    route.fulfill({ json: detail() }),
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    async (route) => {
      posted = route.request().postDataJSON().operation_id;
      await pending;
      await route.fulfill({ json: receipt(posted) });
    },
  );
  await page.route("**/child-owner-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><div id="fixture"></div><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js'); const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');
const {AppProvider,useAppStore}=await import('/src/state/index.ts'); const {AppStore}=await import('/src/state/store.ts'); const {ChildSessionDock}=await import('/src/features/composer/ChildSessionDock.tsx');
AppStore.prototype.start=function(){}; window.__refreshes=0;
function Fixture(){const store=useAppStore();window.__store=store;if(!window.__configured){window.__configured=true;store.state={...store.state,sessionId:'s1',connection:'ws',composer:'PARENT PRIVATE DRAFT',authSession:{authenticated:true,principal:{owner:'u1',expires_at:9999999999999}},popup:{type:'subagentDetail',parentId:'s1',childId:'${childId}',detail:${JSON.stringify(detail())}}};} return React.createElement(ChildSessionDock,{detail:${JSON.stringify(detail())},childId:'${childId}',loading:false,onEarlier:()=>{},onRefresh:()=>window.__refreshes++});}
ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(AppProvider,null,React.createElement(Fixture)));
</script></body></html>`,
    }),
  );
  await page.goto("/child-owner-fixture");
  await page.getByTestId("child-input").fill("OLD OWNER CHILD DRAFT");
  await page.getByTestId("child-send").click();
  await expect.poll(() => posted).not.toBe("");
  await page.evaluate(() => {
    const store = (window as any).__store;
    store.update({
      authSession: {
        authenticated: true,
        principal: { owner: "other-owner", expires_at: 9999999999999 },
      },
    });
  });
  await expect(page.getByTestId("child-input")).toHaveValue("");
  release!();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(await page.evaluate(() => (window as any).__refreshes)).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__store.getSnapshot().composer),
  ).toBe("PARENT PRIVATE DRAFT");
  await expect(page.getByTestId("child-operation-status")).toHaveCount(0);
  await expect(page.getByTestId("child-observe-operation")).toHaveCount(0);
});

test("settled return child disappears from header entry while current inspection stays mounted", async ({
  page,
}) => {
  const returned = detail({
    interaction: "return",
    accepts_user_input: false,
    status: "running",
  });
  await nativeBackend(page, { children: [returned] });
  let status = "running";
  await page.route("**/api/v1/sessions/s1/children?*", (route) =>
    route.fulfill({
      json: {
        parent_session_id: "s1",
        children: [{ ...returned, status }],
        next_cursor: null,
        limit: 100,
      },
    }),
  );
  await open(page);
  await expect(page.getByTestId("child-input")).toBeDisabled();
  status = "completed";
  await page.getByTestId("header-subagents").click();
  await expect(page.locator(".subagent-menu-item")).toHaveCount(0);
  await expect(page.getByTestId("child-content-view")).toBeVisible();
  await expect(page.getByTestId("child-input")).toBeDisabled();
});

test("accepted child operation polls GET only and parent breadcrumb protects its draft", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { children: [detail()] });
  let post = 0;
  let get = 0;
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns`,
    (route) => {
      post++;
      return route.fulfill({
        status: 202,
        json: receipt(route.request().postDataJSON().operation_id, "accepted"),
      });
    },
  );
  await page.route(
    `**/api/v1/sessions/s1/children/${childId}/turns/*`,
    (route) => {
      get++;
      return route.fulfill({
        json: receipt(route.request().url().split("/").at(-1)!),
      });
    },
  );
  await open(page);
  await page.getByTestId("child-input").fill("Accepted draft");
  await page.getByTestId("child-send").click();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.accepted"],
  );
  await expect(page.getByTestId("child-send")).toBeDisabled();
  await expect(page.getByTestId("child-operation-status")).toHaveText(
    zh["childInput.operation.completed"],
  );
  expect(post).toBe(1);
  expect(get).toBe(1);
  await page.getByTestId("child-input").fill("Unsaved child draft");
  await page
    .getByRole("button", {
      name: backend.snapshot().session.title,
      exact: true,
    })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page
    .getByRole("button", { name: zh["speakers.keepEditing"], exact: true })
    .click();
  await expect(page.getByTestId("child-input")).toHaveValue(
    "Unsaved child draft",
  );
  await expect(page.getByTestId("child-content-view")).toBeVisible();
});
