import { expect, test, type Route } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import type { NativeChildDetail, NativeMessage } from "../src/client/types";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

test("child refresh keeps inspected loaded history mounted while pending and retains it across an overlapping tail", async ({
  page,
}) => {
  const messages: NativeMessage[] = [
    {
      id: "cr-user",
      role: "user",
      text: "Earlier child request",
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: 1, round: 0 },
    },
    {
      id: "cr-call",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        { id: "cr-tool", name: "pwsh", arguments: { command: "Get-Date" } },
      ],
      position: { epoch: 2, turn: 1, round: 1 },
    },
    {
      id: "cr-result",
      role: "tool",
      text: "Inspected earlier tool output",
      parts: [],
      tool_calls: [],
      call_id: "cr-tool",
      tool_name: "pwsh",
      position: { epoch: 2, turn: 1, round: 1 },
    },
    ...Array.from({ length: 4 }, (_, index): NativeMessage => ({
      id: `cr-tail-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Child tail ${index}\n` + "Retained later content. ".repeat(100),
      parts: [],
      tool_calls: [],
      position: { epoch: 2, turn: index + 2, round: 1 },
    })),
  ];
  const detail = (
    start: number,
    end: number,
    total = 6,
  ): NativeChildDetail => ({
    parent_session_id: "s1",
    id: "child-refresh",
    name: "coding",
    status: "busy",
    availability: "persisted",
    messages: messages.slice(start, end),
    next_cursor: start ? start : null,
    messages_truncated: start > 0,
    receipt: null,
    usage: null,
    executions: [],
    history: null,
    history_view: {
      lineage: "child-refresh-linear",
      epoch: 2,
      message_count: total,
      start_cursor: start,
      end_cursor: end,
      turns: [],
    },
  });
  await nativeBackend(page, { children: [detail(3, 6)] });
  let reads = 0;
  let pending: Route | undefined;
  await page.route(
    "**/api/v1/sessions/s1/children/child-refresh?*",
    async (route) => {
      reads++;
      const url = new URL(route.request().url());
      if (url.searchParams.has("before_cursor"))
        return route.fulfill({ json: detail(0, 4) });
      if (reads === 1) return route.fulfill({ json: detail(3, 6) });
      pending = route;
    },
  );
  await page.goto("/#session/s1");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const child = page.getByRole("region", { name: "子代理内容", exact: true });
  await child
    .getByTestId("child-session-dock")
    .getByRole("button", { name: zh["child.earlier"], exact: true })
    .click();
  const group = child.locator(".tool-accordion-group-header");
  await expect(group).toHaveCount(1);
  await group.click();
  const row = child.getByTestId("tool-row");
  await row.click();
  await expect(child.getByTestId("tool-payload-output")).toContainText(
    "Inspected earlier tool output",
  );
  await row.evaluate(async (node) => {
    const host = node.closest(".transcript")!;
    const scrolled = new Promise<void>((resolve) =>
      host.addEventListener("scroll", () => resolve(), { once: true }),
    );
    host.scrollTop = host.scrollTop === 40 ? 41 : 40;
    await scrolled;
    (node as HTMLElement).focus({ preventScroll: true });
    (window as any).__childRefresh = {
      node,
      host,
      top: node.getBoundingClientRect().top,
    };
    if (host.scrollTop <= 0)
      throw new Error("fixture requires a nonzero reading scroll position");
  });
  // Invoke the real refresh control without moving focus away from inspection.
  await child
    .getByRole("button", { name: zh["child.refresh"], exact: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  expect(
    await row.evaluate((node) => ({
      same: node === (window as any).__childRefresh.node,
      focus: document.activeElement === node,
      scrollStable:
        Math.abs(
          node.getBoundingClientRect().top - (window as any).__childRefresh.top,
        ) <= 1,
    })),
  ).toEqual({ same: true, focus: true, scrollStable: true });
  await pending!.fulfill({ json: detail(4, 7, 7) });
  await expect(
    child.getByText("Child tail 3", { exact: false }),
  ).toBeAttached();
  await expect(child.getByTestId("tool-payload-output")).toContainText(
    "Inspected earlier tool output",
  );
  await expect(row).toHaveAttribute("aria-expanded", "true");
  expect(
    await row.evaluate((node) => ({
      same: node === (window as any).__childRefresh.node,
      focus: document.activeElement === node,
      scrollStable:
        Math.abs(
          node.getBoundingClientRect().top - (window as any).__childRefresh.top,
        ) <= 1,
    })),
  ).toEqual({ same: true, focus: true, scrollStable: true });
  pending = undefined;
  await child
    .getByRole("button", { name: zh["child.refresh"], exact: true })
    .evaluate((node) => (node as HTMLButtonElement).click());
  await expect.poll(() => Boolean(pending)).toBe(true);
  const forward = detail(0, 7, 7);
  forward.history_view!.epoch = 3;
  await pending!.fulfill({ json: forward });
  // Disclosure and warning absence are already true while the request is in
  // flight. Observe its rendered epoch so the continuity check measures the
  // accepted refresh rather than the preceding loading commit.
  await expect(child.locator(".transcript")).toHaveAttribute(
    "data-history-epoch",
    "3",
  );
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(child.getByTestId("history-reading-changed")).toHaveCount(0);
  const continuity = await row.evaluate((node) => {
    const previous = (window as any).__childRefresh;
    return {
      same: node === previous.node,
      focus: document.activeElement === node,
      top: node.getBoundingClientRect().top,
      previousTop: previous.top,
      scrollTop: previous.host.scrollTop,
      scrollHeight: previous.host.scrollHeight,
    };
  });
  expect(continuity.same).toBe(true);
  expect(continuity.focus).toBe(true);
  expect(
    Math.abs(continuity.top - continuity.previousTop),
    JSON.stringify(continuity),
  ).toBeLessThanOrEqual(1);
});
