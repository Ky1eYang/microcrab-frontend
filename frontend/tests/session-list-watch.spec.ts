import { expect, test, type Page } from "@playwright/test";
import type { NativeSnapshot } from "../src/client/types";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

// C13: the sidebar loads `GET /sessions` once and then applies owner-level
// `sessions.changed` increments from `sessions.watch`. Archive, delete and
// rename never reload the list.

const other = (id: string, title: string): NativeSnapshot => ({
  ...structuredClone(nativeSnapshot),
  session: {
    ...structuredClone(nativeSnapshot.session),
    id,
    title,
    updated_at_ms: 1,
  },
  messages: [],
});
const row = (page: Page, title: string) =>
  page.getByTestId("session-item").filter({ hasText: title });
const listReads = (backend: { requests: { method: string; path: string }[] }) =>
  backend.requests.filter(
    (request) =>
      request.method === "GET" && request.path === "/api/v1/sessions",
  ).length;

test("the rail loads the list once and applies remote increments", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    sessions: [other("s2", "第二会话")],
  });
  await page.goto("/#session/s1");
  await expect(row(page, "第二会话")).toBeVisible();
  await expect.poll(() => backend.listWatched()).toBe(true);
  expect(listReads(backend)).toBe(1);
  // A session created elsewhere appears; a rename elsewhere updates in place.
  backend.listEvent(
    "sessions.changed",
    { op: "upsert", session: other("s3", "远端新会话").session },
    "s3",
  );
  await expect(row(page, "远端新会话")).toBeVisible();
  backend.listEvent(
    "sessions.changed",
    {
      op: "upsert",
      session: { ...other("s2", "远端改名").session, revision: 2 },
    },
    "s2",
  );
  await expect(row(page, "远端改名")).toBeVisible();
  await expect(row(page, "第二会话")).toHaveCount(0);
  // An older revision never moves an item backwards.
  backend.listEvent(
    "sessions.changed",
    { op: "upsert", session: other("s2", "过期标题").session },
    "s2",
  );
  // Archive and delete elsewhere remove the rows.
  backend.listEvent(
    "sessions.changed",
    {
      op: "upsert",
      session: {
        ...other("s3", "远端新会话").session,
        archived: true,
        revision: 2,
      },
    },
    "s3",
  );
  backend.listEvent(
    "sessions.changed",
    { op: "remove", session_id: "s2", state: "deleted" },
    "s2",
  );
  await expect(row(page, "远端新会话")).toHaveCount(0);
  await expect(row(page, "远端改名")).toHaveCount(0);
  await expect(row(page, "过期标题")).toHaveCount(0);
  await expect(row(page, "原生会话")).toBeVisible();
  // A failed deletion cleanup is reported without reloading the list.
  backend.listEvent(
    "session.cleanup_failed",
    {
      session_id: "s2",
      stage: "storage",
      cause: { code: "removal_failed", message: "x" },
    },
    "s2",
  );
  await expect(page.locator(".toast-body")).toContainText(
    "已删除会话的清理失败",
  );
  expect(listReads(backend)).toBe(1);
});

test("unavailable list and watch records surface concrete errors without fake sessions", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    sessions: [other("s2", "正常会话")],
  });
  let actualListReads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/v1/sessions"
    )
      actualListReads++;
  });
  await page.route("**/api/v1/sessions", (route) =>
    route.fulfill({
      json: {
        items: [nativeSnapshot.session, other("s2", "正常会话").session],
        unavailable: [
          { id: "broken", reason: "overrides[0].capability: unknown field" },
        ],
        complete: false,
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(row(page, "正常会话")).toBeVisible();
  await expect(page.locator(".toast-body")).toContainText(
    "overrides[0].capability: unknown field",
  );
  await expect(page.getByTestId("session-item")).toHaveCount(2);
  expect(actualListReads).toBe(1);
  backend.listEvent(
    "sessions.changed",
    {
      op: "unavailable",
      session_id: "s2",
      error: {
        code: "session_configuration_unavailable",
        message: "initialization: invalid action",
      },
    },
    "s2",
  );
  await expect(row(page, "正常会话")).toHaveCount(0);
  await expect(row(page, "原生会话")).toBeVisible();
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.locator(".toast-body")).toContainText(
    "initialization: invalid action",
  );
  const generation = await page.locator(".toast-body").textContent();
  backend.listEvent(
    "sessions.changed",
    {
      op: "unavailable",
      session_id: "s2",
      error: {
        code: "session_configuration_unavailable",
        message: "initialization: invalid action",
      },
    },
    "s2",
  );
  await expect(page.locator(".toast-body")).toHaveText(generation!);
  backend.listEvent(
    "sessions.changed",
    { op: "upsert", session: other("s2", "已恢复会话").session },
    "s2",
  );
  await expect(row(page, "已恢复会话")).toBeVisible();
  expect(actualListReads).toBe(1);
});

test("archive settles the rail without a list reload", async ({ page }) => {
  const backend = await nativeBackend(page, {
    sessions: [other("s2", "第二会话")],
  });
  await page.goto("/#session/s1");
  await expect(row(page, "原生会话")).toBeVisible();
  await expect.poll(() => backend.listWatched()).toBe(true);
  const reads = listReads(backend);
  const target = page
    .locator(".session-item-row")
    .filter({ hasText: "原生会话" });
  await target.hover();
  await target.getByTitle("更多操作").click();
  await page.getByRole("button", { name: "归档会话" }).click();
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(row(page, "原生会话")).toHaveCount(0);
  await expect(row(page, "第二会话")).toBeVisible();
  // Let the server's increment arrive; it must not trigger a reload either.
  await page.waitForTimeout(100);
  expect(listReads(backend)).toBe(reads);
  expect(
    backend.commands.filter((command) => command.method === "session.list"),
  ).toHaveLength(0);
});

test("a watch gap resynchronizes with one list read and a new watch", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    sessions: [other("s2", "第二会话")],
  });
  await page.goto("/#session/s1");
  await expect.poll(() => backend.listWatched()).toBe(true);
  // Server registration precedes receipt of sessions.watch and its following
  // HTTP list read. Observe initial list publication before injecting the gap.
  await expect(row(page, "第二会话")).toBeVisible();
  const watches = () =>
    backend.commands.filter((command) => command.method === "sessions.watch")
      .length;
  expect(watches()).toBe(1);
  expect(listReads(backend)).toBe(1);
  backend.listEvent("resync_required", { reason: "slow_consumer" });
  await expect.poll(watches).toBe(2);
  await expect.poll(() => listReads(backend)).toBe(2);
  await expect(row(page, "第二会话")).toBeVisible();
});
