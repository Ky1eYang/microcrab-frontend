import { expect, test } from "@playwright/test";
import type { NativeMessage, NativeSnapshot } from "../src/client/types";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";

function rounds(
  start: number,
  count: number,
  branch = "main",
): NativeMessage[] {
  return Array.from({ length: count }, (_, offset) => {
    const turn = start + offset;
    return [
      {
        id: `${branch}-u-${turn}`,
        role: "user" as const,
        text: `${branch} question ${turn}`,
        parts: [],
        tool_calls: [],
        position: { epoch: 0, turn: turn + 1, round: 0 },
      },
      {
        id: `${branch}-a-${turn}`,
        role: "assistant" as const,
        text: `${branch} answer ${turn}`,
        parts: [],
        tool_calls: [],
        position: { epoch: 0, turn: turn + 1, round: 1 },
      },
    ];
  }).flat();
}

function select(
  snapshot: NativeSnapshot,
  start: number,
  count: number,
  lineage = "selected",
  branch = "main",
) {
  snapshot.messages = rounds(start, count, branch);
  snapshot.messages_truncated = start > 0;
  snapshot.next_cursor = start * 2 || null;
  snapshot.history = { checkpoint_id: `${lineage}-${start + count}` };
  snapshot.history_view = {
    lineage,
    epoch: 0,
    start_cursor: start * 2,
    end_cursor: (start + count) * 2,
    message_count: (start + count) * 2,
    turns: [],
  };
}

/** The session.blocks failure for a boundary the selected history lost. */
function stale() {
  return {
    error: {
      code: "stale_history",
      message: "The selected history no longer contains this page boundary",
    },
  };
}

function earlier(page: import("@playwright/test").Page) {
  return page
    .getByRole("navigation", { name: "轮次导航" })
    .getByRole("button", {
      name: "加载更早消息",
      exact: true,
    });
}

test("a stale boundary re-subscribes and pages only the newly selected lineage", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: {
      role: "executor",
      lease_id: "history-lease",
      catalog_digest: "history-catalog",
      definitions: CLIENT_TOOL_DEFINITIONS,
      pending: [],
      calls: [],
    },
  });
  const snapshot = backend.snapshot();
  select(snapshot, 2, 2, "old", "old");
  const requests: Record<string, unknown>[] = [];
  backend.handleBlocks((params) => {
    requests.push(params);
    if (requests.length === 1) {
      select(snapshot, 1, 2, "new", "new");
      return stale();
    }
    return {
      items: rounds(0, 1, "new"),
      truncated: false,
      next_cursor: null,
      history_view: {
        ...snapshot.history_view,
        start_cursor: 0,
        end_cursor: 2,
      },
    };
  });
  await page.goto("/#session/s1");
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "client_tools.bind",
        ).length,
    )
    .toBe(1);
  await connectHostUI(page);
  const binds = backend.commands.filter(
    (command) => command.method === "client_tools.bind",
  ).length;
  const editor = page.getByRole("textbox", { name: "消息", exact: true });
  await editor.fill("Keep this draft");
  const subscriptions = backend.sessionSockets.length;
  const runtimeOpens = backend.requests.filter(
    (request) => request.path.endsWith("/runtime") && request.method === "PUT",
  ).length;
  await earlier(page).click();
  await expect(
    page
      .locator("#conversation-transcript")
      .getByText("new question 0", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveValue("Keep this draft");
  // The replacement subscription closes the old socket and therefore must
  // acquire its own executor lease, without reopening the runtime.
  expect(
    backend.commands.filter(
      (command) => command.method === "client_tools.bind",
    ),
  ).toHaveLength(binds + 1);
  expect(
    backend.requests.filter(
      (request) =>
        request.path.endsWith("/runtime") && request.method === "PUT",
    ),
  ).toHaveLength(runtimeOpens);
  await expect(
    page
      .locator("#conversation-transcript")
      .getByText("old question 2", { exact: true }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0].lineage).toBe("old");
  expect(requests[1].lineage).toBe("new");
  expect(requests[1].before_message_id).toBe("new-u-1");
  expect(backend.sessionSockets).toHaveLength(subscriptions + 1);
  await expect(page.locator(".toast-body")).toHaveCount(0);
});

test("append reconciliation retains loaded pages and retries from their first boundary", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  select(snapshot, 4, 2);
  const requests: Record<string, unknown>[] = [];
  backend.handleBlocks((params) => {
    requests.push(params);
    if (requests.length === 2) {
      select(snapshot, 5, 2);
      return stale();
    }
    const start = requests.length === 1 ? 2 : 0;
    return {
      items: rounds(start, 2),
      truncated: start > 0,
      next_cursor: start * 2 || null,
      history_view: {
        ...snapshot.history_view,
        start_cursor: start * 2,
        end_cursor: (start + 2) * 2,
      },
    };
  });
  await page.goto("/#session/s1");
  await earlier(page).click();
  await expect(
    page
      .locator("#conversation-transcript")
      .getByText("main question 2", { exact: true }),
  ).toBeVisible();
  await earlier(page).click();
  await expect(
    page
      .locator("#conversation-transcript")
      .getByText("main question 0", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#conversation-transcript .user-turn")).toHaveCount(
    7,
  );
  expect(requests).toHaveLength(3);
  expect(requests[2].before_message_id).toBe("main-u-2");
  expect(requests[2].lineage).toBe("selected");
  await expect(page.locator(".toast-body")).toHaveCount(0);
});

test("persistent stale boundaries stop after one refresh and retain localized feedback", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  select(backend.snapshot(), 2, 2);
  let requests = 0;
  backend.handleBlocks(() => {
    requests++;
    return stale();
  });
  await page.goto("/#session/s1");
  await earlier(page).click();
  await expect(page.locator(".toast-body")).toContainText("历史位置仍在变化");
  expect(requests).toBe(2);
  expect(backend.sessionSockets).toHaveLength(2);
  await expect(
    page
      .locator("#conversation-transcript")
      .getByText("main question 2", { exact: true }),
  ).toBeVisible();
});

for (const rejected of [false, true]) {
  test(`a late ${rejected ? "stale rejection" : "page"} cannot restore a departed subscription`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const snapshot = backend.snapshot();
    select(snapshot, 2, 2);
    let pending: ((page: unknown) => void) | undefined;
    backend.handleBlocks(
      () =>
        new Promise((resolve) => {
          pending = resolve;
        }),
    );
    await page.goto("/#session/s1");
    await earlier(page).click();
    await expect.poll(() => !!pending).toBe(true);
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    if (rejected) pending!(stale());
    else
      pending!({
        items: rounds(0, 2),
        truncated: false,
        next_cursor: null,
        history_view: {
          ...snapshot.history_view,
          start_cursor: 0,
          end_cursor: 4,
        },
      });
    await page.waitForLoadState("networkidle");
    await expect(page).not.toHaveURL(/#session\//);
    await expect(
      page
        .locator("#conversation-transcript")
        .getByText("main question 0", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".toast-body")).toHaveCount(0);
    expect(backend.sessionSockets).toHaveLength(1);
  });
}
