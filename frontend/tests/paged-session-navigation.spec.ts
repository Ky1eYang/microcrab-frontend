import { expect, test } from "@playwright/test";
import type { NativeMessage } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

function tail(count = 35, positioned = true): NativeMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const position = positioned
      ? { epoch: 0, turn: 3, round: index + 1 }
      : undefined;
    return [
      {
        id: `tail-a-${index}`,
        role: "assistant" as const,
        text: `Recorded reply ${index}.\n\n${"Retained conversation paragraph.\n\n".repeat(4)}`,
        parts: [],
        tool_calls: [
          {
            id: `tail-call-${index}`,
            name: "read",
            arguments: { path: `file-${index}` },
          },
        ],
        position,
      },
      {
        id: `tail-r-${index}`,
        role: "tool" as const,
        text: "Recorded result",
        parts: [],
        tool_calls: [],
        call_id: `tail-call-${index}`,
        tool_name: "read",
        position,
      },
    ];
  }).flat();
}

test("a tool-only latest page exposes history navigation and retains a loaded prefix on refresh", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const current = tail(8);
  backend.snapshot().messages = current;
  backend.snapshot().history = { head: "selected-checkpoint" };
  backend.snapshot().messages_truncated = true;
  backend.snapshot().next_cursor = 64;
  backend.snapshot().history_view = {
    lineage: "paged-navigation-lineage",
    epoch: 0,
    start_cursor: 64,
    end_cursor: 80,
    message_count: 80,
    turns: [],
  };
  const requests: Record<string, unknown>[] = [];
  let release: (() => void) | undefined;
  backend.handleBlocks((params) => {
    requests.push(params);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          items:
            requests.length === 1
              ? [
                  {
                    id: "earlier-user",
                    role: "user",
                    text: "Earlier retained prompt",
                    parts: [],
                    tool_calls: [],
                    position: { epoch: 0, turn: 2, round: 0 },
                  },
                  {
                    id: "earlier-answer",
                    role: "assistant",
                    text: "Earlier retained answer",
                    parts: [],
                    tool_calls: [],
                    position: { epoch: 0, turn: 2, round: 1 },
                  },
                  ...Array.from({ length: 30 }, (_, index) => ({
                    id: `earlier-evidence-${index}`,
                    role: "assistant",
                    text: `Earlier range record ${index}`,
                    parts: [],
                    tool_calls: [],
                    position: { epoch: 0, turn: 2, round: index + 2 },
                  })),
                ]
              : Array.from({ length: 32 }, (_, index) => ({
                  id: `oldest-evidence-${index}`,
                  role: "assistant",
                  text: `Oldest range record ${index}`,
                  parts: [],
                  tool_calls: [],
                  position: { epoch: 0, turn: 1, round: index + 1 },
                })),
          history_view: {
            lineage: "paged-navigation-lineage",
            epoch: 0,
            start_cursor: requests.length === 1 ? 32 : 0,
            end_cursor: requests.length === 1 ? 64 : 32,
            message_count: 80,
            turns: [],
          },
          truncated: requests.length === 1,
          next_cursor: requests.length === 1 ? 32 : null,
        });
    });
  });
  await page.goto("/#session/s1");
  const transcript = page.locator("#conversation-transcript");
  const navigation = page.getByRole("navigation", { name: "轮次导航" });
  await expect(transcript.locator(".user-turn")).toHaveCount(0);
  await expect(navigation).toBeVisible();
  const load = navigation.getByRole("button", {
    name: "加载更早消息",
    exact: true,
  });
  const anchor = transcript.getByText("Recorded reply 7.", { exact: true });
  const anchorTop = (await anchor.boundingBox())!.y;
  await load.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByTestId("conversation-load-earlier")).toBeDisabled();
  expect(requests[0].before_cursor).toBe(64);
  expect(requests[0].limit).toBe(64);
  release!();
  await expect(
    transcript.getByText("Earlier retained prompt", { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - anchorTop))
    .toBeLessThan(3);
  await transcript.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        // A DOM scroll is asynchronous. Model a completed reader gesture before the
        // next server event; otherwise the test races its own scroll handler.
        element.addEventListener(
          "scroll",
          () => requestAnimationFrame(() => resolve()),
          { once: true },
        );
        element.scrollTop = 360;
      }),
  );
  const before = await transcript.evaluate((element) => element.scrollTop);
  backend.publish(structuredClone(backend.snapshot()));
  await expect(
    transcript.getByText("Earlier retained prompt", { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBe(before);
  await navigation
    .getByRole("button", { name: "加载更早消息", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].before_cursor).toBe(32);
  release!();
});

for (const positioned of [true, false]) {
  test(`trajectory tail reports ${positioned ? "recorded turn identities" : "unknown turn count honestly"}`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().messages = tail(35, positioned);
    await page.goto("/#session/s1");
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();
    await expect(page.getByTestId("trajectory-turn-count")).toHaveText(
      `${positioned ? 1 : "—"} 轮次`,
    );
    await expect(page.locator(".trajectory-toolbar")).toContainText("35 调用");
    await expect(page.locator(".trajectory-turn-mark").first()).toHaveText(
      positioned ? "第 3 轮" : "—",
    );
  });
}

test("trajectory refresh does not scroll back to an unchanged selection", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = tail(25);
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const entries = page.getByTestId("trajectory-entry");
  await entries.first().click();
  await expect(entries.first()).toHaveAttribute("data-selected", "true");
  const ledger = page.locator(".trajectory-ledger");
  await ledger.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const before = await ledger.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(100);
  backend.publish(structuredClone(backend.snapshot()));
  await expect(entries.first()).toHaveAttribute("data-selected", "true");
  await expect
    .poll(() => ledger.evaluate((element) => element.scrollTop))
    .toBe(before);
});

test("trajectory snapshot preserves a viewport scroll whose native callback is still pending", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = tail(25);
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const entries = page.getByTestId("trajectory-entry");
  await entries.first().click();
  await expect(entries.first()).toHaveAttribute("data-selected", "true");
  await expect(entries.first()).toBeInViewport();
  const ledger = page.locator(".trajectory-ledger");
  const before = await ledger.evaluate((host) => {
    host.dispatchEvent(new Event("scroll"));
    const defer = (event: Event) => {
      if (event.target === host) event.stopImmediatePropagation();
    };
    window.addEventListener("scroll", defer, true);
    (window as any).__releasePendingScroll = () =>
      window.removeEventListener("scroll", defer, true);
    host.scrollTop = host.scrollHeight;
    return host.scrollTop;
  });
  expect(before).toBeGreaterThan(100);
  try {
    const refreshed = structuredClone(backend.snapshot());
    refreshed.session.title = "Pending scroll snapshot";
    backend.publish(refreshed);
    await expect(
      page.getByText("Pending scroll snapshot", { exact: true }).first(),
    ).toBeAttached();
    await expect(entries.first()).toHaveAttribute("data-selected", "true");
    await expect
      .poll(() => ledger.evaluate((host) => host.scrollTop))
      .toBe(before);
  } finally {
    await page.evaluate(() => (window as any).__releasePendingScroll());
  }
});
