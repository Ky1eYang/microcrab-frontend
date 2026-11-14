import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { mergeHistoryPage } from "../src/client/loaded-messages";
import type {
  NativeChildDetail,
  NativeHistoryView,
  NativeMessage,
  NativeSnapshot,
} from "../src/client/types";

const record = (index: number): NativeMessage => ({
  id: `gap-${index}`,
  role: "assistant",
  text: `Gap record ${index}`,
  parts: [],
  tool_calls: [159, 219].includes(index)
    ? [
        {
          id: `gap-call-${index}`,
          name: `gap_tool_${index}`,
          arguments: { path: `gap-${index}` },
        },
      ]
    : [],
  position: { epoch: 1, turn: 1, round: index + 1 },
});
const range = (
  start: number,
  end: number,
  total: number,
  lineage = "gap-lineage",
) => ({
  items: Array.from({ length: end - start }, (_, offset) =>
    record(start + offset),
  ),
  truncated: start > 0,
  next_cursor: start || null,
  history_view: {
    lineage,
    epoch: 1,
    start_cursor: start,
    end_cursor: end,
    message_count: total,
    turns: [
      {
        epoch: 1,
        turn: 1,
        tool_calls: total > 219 ? 2 : total > 159 ? 1 : 0,
        ordinary_tool_calls: total > 219 ? 2 : total > 159 ? 1 : 0,
        delegate_calls: 0,
      },
    ],
  },
});
function install(
  snapshot: NativeSnapshot,
  start: number,
  end: number,
  total: number,
  lineage = "gap-lineage",
) {
  const page = range(start, end, total, lineage);
  snapshot.messages = page.items;
  snapshot.messages_truncated = page.truncated;
  snapshot.next_cursor = page.next_cursor;
  snapshot.history_view = page.history_view;
}
async function loadEarlier(
  page: Page,
  host = page.locator("#conversation-transcript"),
) {
  const control = host.getByTestId("conversation-load-earlier");
  if (await control.count()) await control.click();
  else {
    await host.evaluate((element) => {
      element.scrollTop = 0;
    });
    const box = (await host.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.wheel(0, -200);
  }
}

test("gap recovery follows an advancing target through four pages and keeps idle live tools until the actual tail arrives", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  install(snapshot, 0, 10, 10);
  snapshot.session.status = "running";
  const reads: { resolve: (page: unknown) => void; after: number }[] = [];
  backend.handleBlocks((params) => {
    expect(params.lineage).toBe("gap-lineage");
    expect(params.limit).toBe(64);
    return new Promise((resolve) =>
      reads.push({
        resolve,
        after: Number(String(params.after_message_id).split("-").at(-1)),
      }),
    );
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("Gap record 9", { exact: true })).toBeVisible();
  const live = (index: number) =>
    backend.event("tool", {
      epoch: 1,
      turn: 1,
      round: index + 1,
      operation_id: "gap-op",
      call_id: `gap-call-${index}`,
      name: `gap_tool_${index}`,
      phase: "completed",
      arguments: { path: `gap-${index}` },
      result: "observed result",
    });
  live(159);
  install(snapshot, 150, 160, 160);
  backend.publish(structuredClone(snapshot));
  await expect.poll(() => reads.length).toBe(1);
  live(219);
  await expect(page.getByTestId("tool-row")).toHaveCount(2);
  install(snapshot, 210, 220, 220);
  snapshot.session.status = "idle";
  snapshot.session.title = "Idle advancing gap target";
  snapshot.session.revision++;
  backend.publish(structuredClone(snapshot));
  await expect(
    page
      .getByTestId("session-item")
      .filter({ hasText: "Idle advancing gap target" }),
  ).toBeVisible();
  const tools = page.getByTestId("tool-row");
  await expect(tools).toHaveCount(2);
  for (let index = 0; index < 4; index++) {
    await expect.poll(() => reads.length).toBe(index + 1);
    expect(reads[index].after).toBe([9, 73, 137, 201][index]);
    if (index < 3) {
      await expect(
        page.getByText("Gap record 219", { exact: true }),
      ).toHaveCount(0);
      await expect(tools).toHaveCount(2);
      await expect(
        page
          .locator(".tool-accordion-group-header")
          .filter({ hasText: "更早记录未加载" })
          .first(),
      ).toBeVisible();
    }
    const start = reads[index].after + 1;
    reads[index].resolve(range(start, Math.min(start + 64, 220), 220));
  }
  await expect(page.getByText("Gap record 219", { exact: true })).toHaveCount(
    1,
  );
  await expect(tools).toHaveCount(2);
  await expect(
    page
      .locator(".tool-accordion-group-header")
      .filter({ hasText: "更早记录未加载" }),
  ).toHaveCount(0);
  expect(reads).toHaveLength(4);
  // A duplicate target remerge cannot revive a completed gap or reissue reads.
  snapshot.session.title = "Completed target remerge";
  snapshot.session.revision++;
  backend.publish(structuredClone(snapshot));
  await expect(
    page
      .getByTestId("session-item")
      .filter({ hasText: "Completed target remerge" }),
  ).toBeVisible();
  await expect(page.getByText("Gap record 219", { exact: true })).toHaveCount(
    1,
  );
  expect(reads).toHaveLength(4);
});

test("an obsolete forward page cannot reenter a replacement lineage or epoch", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  install(snapshot, 0, 10, 10);
  let pending: ((page: unknown) => void) | undefined;
  let queries = 0;
  backend.handleBlocks(
    () =>
      new Promise((resolve) => {
        pending = resolve;
        queries++;
      }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("Gap record 9", { exact: true })).toBeVisible();
  install(snapshot, 150, 160, 160);
  backend.publish(structuredClone(snapshot));
  await expect.poll(() => queries).toBe(1);
  install(snapshot, 0, 2, 2, "replacement-lineage");
  snapshot.history_view!.epoch = 2;
  snapshot.messages = snapshot.messages.map((message, index) => ({
    ...message,
    id: `replacement-${index}`,
    text: `Replacement ${index}`,
    position: { epoch: 2, turn: 1, round: index + 1 },
  }));
  backend.publish(structuredClone(snapshot));
  await expect(page.getByText("Replacement 1", { exact: true })).toBeVisible();
  pending!(range(10, 74, 160));
  // Let the late page result cross the socket before the next frame.
  await page.waitForTimeout(100);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  snapshot.session.title = "Replacement after stale page";
  snapshot.session.revision++;
  backend.event("session", structuredClone(snapshot.session));
  await expect(
    page
      .getByTestId("session-item")
      .filter({ hasText: "Replacement after stale page" }),
  ).toBeVisible();
  await expect(page.getByText("Replacement 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Gap record 73", { exact: true })).toHaveCount(0);
  expect(queries).toBe(1);
});

test("a failed gap read leaves the target pending and a later snapshot retries from the proven boundary", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  install(snapshot, 0, 10, 10);
  let attempts = 0;
  const boundaries: string[] = [];
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => (failed = resolve));
  backend.handleBlocks((params) => {
    attempts++;
    const after = String(params.after_message_id);
    boundaries.push(after);
    if (attempts === 1) {
      failed();
      return {
        error: { code: "unavailable", message: "Controlled page failure" },
      };
    }
    const start = Number(after.split("-").at(-1)) + 1;
    return range(start, Math.min(start + 64, 160), 160);
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("Gap record 9", { exact: true })).toBeVisible();
  install(snapshot, 150, 160, 160);
  backend.publish(structuredClone(snapshot));
  await failure;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  snapshot.session.title = "Gap page failed before retry";
  snapshot.session.revision++;
  backend.event("session", structuredClone(snapshot.session));
  await expect(
    page
      .getByTestId("session-item")
      .filter({ hasText: "Gap page failed before retry" }),
  ).toBeVisible();
  await expect(page.getByText("Gap record 159", { exact: true })).toHaveCount(
    0,
  );
  expect(attempts).toBe(1);
  // A repeated canonical target, rather than title/status metadata, retries the gap.
  backend.event("blocks.upsert", {
    ids: snapshot.messages.map((message) => message.id),
    messages: structuredClone(snapshot.messages),
    messages_truncated: snapshot.messages_truncated,
    next_cursor: snapshot.next_cursor,
    history_view: snapshot.history_view,
  });
  await expect(page.getByText("Gap record 159", { exact: true })).toHaveCount(
    1,
  );
  expect(boundaries).toEqual(["gap-9", "gap-9", "gap-73", "gap-137"]);
});

const turn = (index: number): NativeMessage[] => [
  {
    id: `page-user-${index}`,
    role: "user",
    text: `Paged question ${index}`,
    parts: [],
    tool_calls: [],
    position: { epoch: 1, turn: index, round: 0 },
  },
  {
    id: `page-assistant-${index}`,
    role: "assistant",
    text: "",
    parts: [],
    tool_calls: [
      { id: `page-call-${index}`, name: `page_tool_${index}`, arguments: {} },
    ],
    position: { epoch: 1, turn: index, round: 1 },
  },
  {
    id: `page-result-${index}`,
    role: "tool",
    text: `Output ${index}`,
    parts: [],
    tool_calls: [],
    call_id: `page-call-${index}`,
    tool_name: `page_tool_${index}`,
    position: { epoch: 1, turn: index, round: 1 },
  },
];
const turnView = (
  index: number,
  lineage = "paged-lineage",
): NativeHistoryView => ({
  lineage,
  epoch: 1,
  start_cursor: (index - 1) * 3,
  end_cursor: index * 3,
  message_count: 9,
  turns: [
    {
      epoch: 1,
      turn: index,
      tool_calls: 1,
      ordinary_tool_calls: 1,
      delegate_calls: 0,
    },
  ],
});

test("main earlier pages retain both old and already loaded Turn summaries", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  Object.assign(snapshot, {
    messages: turn(3),
    messages_truncated: true,
    next_cursor: 6,
    history_view: turnView(3),
  });
  let requests = 0;
  backend.handleBlocks((params) => {
    requests++;
    expect(params.before_message_id).toBe("page-user-3");
    expect(params.lineage).toBe("paged-lineage");
    return {
      items: turn(2),
      truncated: true,
      next_cursor: 3,
      history_view: turnView(2),
    };
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByText("Paged question 3", { exact: true }),
  ).toBeVisible();
  await loadEarlier(page);
  await expect(page.getByText("Paged question 2", { exact: true })).toHaveCount(
    1,
  );
  await expect(page.locator(".tool-accordion-group-header")).toHaveCount(2);
  await expect(page.getByTestId("tool-turn-count")).toHaveCount(0);
  await expect(
    page
      .locator(".tool-accordion-group-header")
      .filter({ hasText: "工具调用 1 次" }),
  ).toHaveCount(2);
  await expect(
    page
      .locator(".tool-accordion-group-header")
      .filter({ hasText: "更早记录未加载" }),
  ).toHaveCount(0);
  expect(requests).toBe(1);
});

test("child earlier pages retain old and newer Turn evidence under exact parent authority", async ({
  page,
}) => {
  const detail: NativeChildDetail = {
    parent_session_id: "s1",
    id: "child-evidence",
    name: "coding",
    status: "unknown",
    availability: "persisted",
    messages: turn(3),
    next_cursor: 6,
    messages_truncated: true,
    history_view: turnView(3, "child-lineage"),
    history: null,
    receipt: null,
    usage: null,
    executions: [],
  };
  const backend = await nativeBackend(page, { children: [detail] });
  let reads = 0;
  await page.route(
    "**/api/v1/sessions/s1/children/child-evidence?*",
    (route) => {
      reads++;
      const query = new URL(route.request().url()).searchParams;
      if (!query.has("before_message_id"))
        return route.fulfill({ json: detail });
      expect(query.get("lineage")).toBe("child-lineage");
      return route.fulfill({
        json: {
          ...detail,
          messages: turn(2),
          next_cursor: 3,
          history_view: turnView(2, "child-lineage"),
        },
      });
    },
  );
  await page.goto("/#session/s1");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const child = page.getByRole("region", { name: "子代理内容", exact: true });
  await expect(
    child.getByText("Paged question 3", { exact: true }),
  ).toHaveCount(1);
  await child.getByTestId("conversation-load-earlier").click();
  await expect(
    child.getByText("Paged question 2", { exact: true }),
  ).toHaveCount(1);
  await expect(child.locator(".tool-accordion-group-header")).toHaveCount(2);
  await expect(child.getByTestId("tool-turn-count")).toHaveCount(0);
  await expect(
    child
      .locator(".tool-accordion-group-header")
      .filter({ hasText: "工具调用 1 次" }),
  ).toHaveCount(2);
  await expect(
    child
      .locator(".tool-accordion-group-header")
      .filter({ hasText: "更早记录未加载" }),
  ).toHaveCount(0);
  expect(reads).toBe(2);
  // Child inspection must not open a session socket of its own.
  expect(
    backend.sessionSockets.every(
      (socket) =>
        decodeURIComponent(new URL(socket.url()).pathname.split("/")[4]) ===
        "s1",
    ),
  ).toBe(true);
});

test("page merge rejects missing, epoch-mismatched, conflicting and disjoint evidence", () => {
  const current = {
    session: { id: "s1" },
    messages: range(10, 20, 30).items,
    history_view: range(10, 20, 30).history_view,
    messages_truncated: true,
    next_cursor: 10,
  };
  expect(
    mergeHistoryPage(current, { ...range(0, 10, 30), history_view: undefined }),
  ).toBeNull();
  expect(
    mergeHistoryPage(current, {
      ...range(0, 10, 30),
      history_view: { ...range(0, 10, 30).history_view, epoch: 2 },
    }),
  ).toBeNull();
  expect(mergeHistoryPage(current, range(0, 5, 30))).toBeNull();
  const conflict = range(15, 25, 30);
  conflict.items[0].id = "wrong-covered-identity";
  expect(mergeHistoryPage(current, conflict)).toBeNull();
});
