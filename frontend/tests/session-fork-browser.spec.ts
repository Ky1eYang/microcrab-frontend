import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

// Exercises the real menu, HTTP adapter, mutation guard, navigation and page loader.
test("fork allocates once, attaches independently and preserves paginated inherited root history", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["session.fork"] });
  const source = structuredClone(backend.snapshot().session);
  const forks: any[] = [];
  let finishFork: (() => Promise<void>) | undefined;
  await page.route("**/api/v1/sessions/s1/fork", async (route) => {
    forks.push(route.request().postDataJSON());
    finishFork = async () => {
      const snapshot = backend.snapshot();
      snapshot.session = {
        ...source,
        id: "fork-1",
        title: "原生会话分叉",
        revision: 1,
      };
      snapshot.history_available = { undo: false, redo: false };
      snapshot.messages_truncated = true;
      snapshot.next_cursor = 2;
      snapshot.history_view = {
        lineage: "fork-history-lineage",
        epoch: 0,
        start_cursor: 2,
        end_cursor: 4,
        message_count: 4,
        turns: [],
      };
      await route.fulfill({ json: snapshot.session });
    };
  });
  const pages: Record<string, unknown>[] = [];
  backend.handleBlocks((params, sessionId) => {
    if (sessionId !== "fork-1")
      return { items: [], truncated: false, next_cursor: null };
    pages.push(params);
    return {
      items: [
        {
          id: "inherited-earlier",
          role: "user",
          text: "继承的更早提问",
          parts: [],
          tool_calls: [],
        },
        {
          id: "inherited-earlier-answer",
          role: "assistant",
          text: "继承的更早回答",
          parts: [],
          tool_calls: [],
        },
      ],
      history_view: {
        lineage: "fork-history-lineage",
        epoch: 0,
        start_cursor: 0,
        end_cursor: 2,
        message_count: 4,
        turns: [],
      },
      truncated: false,
      next_cursor: null,
    };
  });
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  const row = page.getByTestId("session-item").filter({ hasText: "原生会话" });
  await row.hover();
  await row.getByTitle("更多操作").click();
  await expect(
    page.getByRole("button", { name: "分叉会话", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "分叉会话", exact: true }).click();
  await expect.poll(() => forks.length).toBe(1);
  await row.hover();
  await row.getByTitle("更多操作").click();
  await expect(
    page.getByRole("button", { name: "分叉会话", exact: true }),
  ).toBeDisabled();
  expect(forks[0]).toEqual({
    operation_id: expect.any(String),
    expected_revision: source.revision,
  });
  expect(forks[0].operation_id).toMatch(/^[0-9a-f-]{36}$/);
  await finishFork!();
  await expect(page).toHaveURL(/#session\/fork-1$/);
  await expect(page.locator(".action-undo-btn").first()).toBeDisabled();
  await expect(page.getByText(source.title, { exact: true })).toBeVisible();
  await page.getByTitle("快捷操作与工具").click();
  await expect(page.getByRole("option", { name: /撤销上一轮/ })).toBeDisabled();
  await expect(page.getByRole("option", { name: /重做上一轮/ })).toBeDisabled();
  await page.getByRole("option", { name: /加载更早历史/ }).click();
  await expect(page.getByText("继承的更早提问", { exact: true })).toBeVisible();
  expect(pages).toHaveLength(1);
  expect(pages[0].before_cursor).toBe(2);
  expect(forks).toHaveLength(1);
  expect(
    backend.requests.filter((r) => r.path.includes("history/travel")),
  ).toHaveLength(0);
  expect(
    decodeURIComponent(
      new URL(backend.sessionSockets.at(-1)!.url()).pathname.split("/")[4],
    ),
  ).toBe("fork-1");
});

test("unknown fork outcome retains source and never allocates or replays again", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["session.fork"] });
  let attempts = 0;
  await page.route("**/api/v1/sessions/s1/fork", (route) => {
    attempts++;
    return route.fulfill({
      status: 503,
      json: {
        error: { code: "outcome_unknown", message: "outcome unavailable" },
      },
    });
  });
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  const row = page.getByTestId("session-item").filter({ hasText: "原生会话" });
  await row.hover();
  await row.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "分叉会话", exact: true }).click();
  await expect(page.getByText(/分叉结果未知。请刷新会话列表/)).toBeVisible();
  await expect(page).toHaveURL(/#session\/s1$/);
  await row.hover();
  await row.getByTitle("更多操作").click();
  await expect(
    page.getByRole("button", { name: "分叉会话", exact: true }),
  ).toBeDisabled();
  expect(attempts).toBe(1);
  expect(backend.sessionSockets).toHaveLength(1);
});

test("fork capability stays disabled on legacy servers and missing history availability keeps old undo behavior", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  await expect(page.locator(".action-undo-btn").first()).toBeEnabled();
  const row = page.getByTestId("session-item").filter({ hasText: "原生会话" });
  await row.hover();
  await row.getByTitle("更多操作").click();
  await expect(
    page.getByRole("button", { name: "分叉会话", exact: true }),
  ).toBeDisabled();
});

test("busy source cannot fork even when the backend advertises the command", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["session.fork"] });
  backend.snapshot().session.status = "running";
  await page.goto("/#/session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  const row = page.getByTestId("session-item").filter({ hasText: "原生会话" });
  await row.hover();
  await row.getByTitle("更多操作").click();
  await expect(
    page.getByRole("button", { name: "分叉会话", exact: true }),
  ).toBeDisabled();
  expect(backend.requests.filter((r) => r.path.endsWith("/fork"))).toHaveLength(
    0,
  );
});

test("confirmed allocation survives failed target attach and own-history availability enables travel", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.update({
      sessionId: "s1",
      connection: "ws",
      authSession: { authenticated: true },
      capabilities: { methods: ["session.fork", "history.travel"] },
    });
    store.subscription = { snapshot };
    store.snapshot(snapshot);
    let allocations = 0,
      attaches = 0,
      travels = 0;
    const target = { ...snapshot.session, id: "fork-1" };
    store.api.request = async (method: string) => {
      if (method === "session.fork") {
        allocations++;
        return target;
      }
      if (method === "history.travel") {
        travels++;
        return snapshot;
      }
      throw Error(`Unexpected method ${method}`);
    };
    store.attach = async (id: string) => {
      if (id !== "fork-1") throw Error("Wrong target");
      attaches++;
      if (attaches === 1) throw Error("Subscription unavailable");
      store.update({ sessionId: id });
    };
    await store.dispatch({ type: "ForkSession", value: "s1" });
    const retainedTarget = store.state.forkTargets.s1;
    await store.dispatch({ type: "ForkSession", value: "s1" });
    const root = {
      ...snapshot,
      session: target,
      history_available: { undo: false, redo: false },
    };
    store.snapshot(root);
    await store.dispatch({ type: "HistoryUndo" });
    const rootTravels = travels;
    store.snapshot({ ...root, history_available: { undo: true, redo: false } });
    await store.dispatch({ type: "HistoryUndo" });
    store.stop();
    return { allocations, attaches, retainedTarget, rootTravels, travels };
  }, backend.snapshot());
  expect(result).toEqual({
    allocations: 1,
    attaches: 2,
    retainedTarget: "fork-1",
    rootTravels: 0,
    travels: 1,
  });
});
