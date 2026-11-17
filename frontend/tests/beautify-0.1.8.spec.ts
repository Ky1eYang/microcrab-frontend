import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

const messages = [
  {
    id: "u",
    role: "user",
    text: "Work",
    parts: [],
    tool_calls: [],
    position: { epoch: 2, turn: 1, round: 0 },
  },
  {
    id: "a",
    role: "assistant",
    text: null,
    parts: [],
    tool_calls: [
      { id: "one", name: "pwsh", arguments: { command: "one" } },
      { id: "bad", name: "read", arguments: { path: "missing" } },
    ],
    position: { epoch: 2, turn: 1, round: 1 },
  },
  {
    id: "result-one",
    role: "tool",
    text: "one result",
    parts: [],
    tool_calls: [],
    call_id: "one",
    tool_name: "pwsh",
    position: { epoch: 2, turn: 1, round: 1 },
  },
  {
    id: "result-bad",
    role: "tool",
    text: "ENOENT",
    parts: [],
    tool_calls: [],
    call_id: "bad",
    tool_name: "read",
    status: "failed",
    position: { epoch: 2, turn: 1, round: 1 },
  },
  {
    id: "final",
    role: "assistant",
    text: "Done",
    parts: [],
    tool_calls: [],
    position: { epoch: 2, turn: 1, round: 2 },
  },
];

const model = (
  round: number,
  start: number,
  end: number,
  completion: "succeeded" | "failed" = "succeeded",
) => ({
  request_hash: `model-${round}`,
  sequence: round,
  call_id: `model-${round}`,
  epoch: 2,
  turn: 1,
  round,
  started_at_ms: start,
  ended_at_ms: end,
  completion,
  history_head: "branch",
});

const tool = (
  id: string,
  start: number,
  end: number,
  completion: "succeeded" | "failed" = "succeeded",
) => ({
  kind: "tool",
  sequence: 3,
  epoch: 2,
  turn: 1,
  round: 1,
  tool_call_id: id,
  name: id,
  started_at_ms: start,
  ended_at_ms: end,
  completion,
  history_head: "branch",
});

async function tokenColor(page: import("@playwright/test").Page, name: string) {
  return page.evaluate((token) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

test.describe("beautify 0.1.8", () => {
  test("timeline segments expose data-status and paint failed current vs muted", async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().messages = messages as any;
    await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
      route.fulfill({
        json: {
          status: "available",
          attempts: [],
          timeline: [
            model(1, 1000, 2000, "failed"),
            model(2, 3000, 3500, "succeeded"),
          ],
          stages: [
            tool("one", 2000, 2400, "succeeded"),
            tool("bad", 2500, 2800, "failed"),
          ],
        },
      }),
    );
    await page.goto("/#session/s1");
    await page.getByRole("tab", { name: "轨迹", exact: true }).click();

    const segs = page.getByTestId("trajectory-seg");
    await expect(segs.first()).toBeVisible();
    const errorSegs = page.locator(
      '[data-testid="trajectory-seg"][data-status="error"], [data-testid="trajectory-seg"][data-status="failed"]',
    );
    await expect(errorSegs.first()).toBeVisible();
    const failed = errorSegs.first();
    await failed.click();
    await expect(failed).toHaveAttribute("data-current", "true");
    const label = await failed.getAttribute("aria-label");
    expect(label || "").toContain("失败");
    await expect(page.getByTestId("trajectory-inspector")).toBeVisible();

    // Probe muted vs solid via the same selectors the CSS uses (segment clicks
    // are tiny and can re-select by playhead time).
    const colors = await page.evaluate(() => {
      const lane = document.querySelector(".trajectory-lane");
      if (!lane) return null;
      const probe = document.createElement("button");
      probe.setAttribute("data-status", "error");
      probe.setAttribute("data-current", "false");
      lane.append(probe);
      const muted = getComputedStyle(probe).backgroundColor;
      probe.setAttribute("data-current", "true");
      const solid = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { muted, solid };
    });
    expect(colors).not.toBeNull();
    expect(colors!.solid).not.toBe(colors!.muted);
    expect(colors!.solid).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("host offline chrome uses warning icon tip-strip and flattened dialog", async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/#session/s1");

    const banner = page.locator(".composer-offline-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveCSS("color", await tokenColor(page, "--text-2"));
    // v0.1.18: status color lives on an 8px dot instead of a warning icon.
    await expect(banner.locator(".expandable-notice-dot")).toHaveCount(1);
    await expect(banner.locator(".expandable-notice-dot")).toHaveCSS(
      "background-color",
      await tokenColor(page, "--warn"),
    );
    await expect(banner).not.toContainText("⚠️");

    // Rail warn appears after an explicit disconnect sets host_connected=false.
    await connectHostUI(page);
    await page.getByTestId("header-host-connection").click();
    const dialog0 = page.getByRole("dialog", {
      name: "连接项目 Host 执行端",
      exact: true,
    });
    await dialog0
      .getByRole("button", { name: "断开连接", exact: true })
      .click();
    await dialog0.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(banner).toBeVisible();

    const warn = page.getByTestId("project-host-warn");
    await expect(warn).toBeVisible();
    await expect(warn).toHaveAttribute(
      "aria-label",
      "项目 Host 执行端离线，会话暂不可用",
    );
    await expect(warn).not.toContainText("离线");
    await expect(warn).not.toContainText("⚠️");

    await warn.click();
    const dialog = page.getByRole("dialog", {
      name: "连接项目 Host 执行端",
      exact: true,
    });
    await expect(dialog).toBeVisible();

    // No second-layer card-in-card: create/note sections are transparent.
    for (const sel of [
      ".host-connect-create",
      ".host-connect-note",
      ".host-connect-workspace",
    ]) {
      const nodes = dialog.locator(sel);
      const n = await nodes.count();
      for (let i = 0; i < n; i++) {
        const bg = await nodes.nth(i).evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, radius: s.borderRadius };
        });
        // transparent / no fill, no rounded inner card
        expect(bg.radius === "0px" || bg.radius === "0").toBeTruthy();
      }
    }

    const hostBtn = page.getByTestId("header-host-connection");
    await expect(hostBtn).toHaveAttribute("data-host-state", /.+/);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  });

  test("session unreachable status uses mono warning icon without emoji", async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().session.reachable = false;
    await page.goto("/#session/s1");

    const mark = page.getByTestId("session-status-unreachable");
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("aria-label", "工作区离线或无法触达");
    await expect(mark).toHaveAttribute("title", "工作区离线或无法触达");
    await expect(mark).not.toContainText("⚠️");
    await expect(mark).not.toContainText("离线");
    await expect(mark.locator("svg")).toHaveCount(1);
  });

  test("child metadata uses Payload and breadcrumbs keep multi-depth grammar", async ({
    page,
  }) => {
    const detail = {
      parent_session_id: "s1",
      id: "child-meta",
      name: "coding",
      status: "unknown",
      availability: "persisted",
      messages: [
        {
          id: "cu",
          role: "user",
          text: "Child request",
          parts: [],
          tool_calls: [],
          position: { epoch: 5, turn: 1, round: 0 },
        },
        {
          id: "cf",
          role: "assistant",
          text: "Child final answer",
          parts: [],
          tool_calls: [],
          position: { epoch: 5, turn: 1, round: 2 },
        },
      ],
      next_cursor: null,
      messages_truncated: false,
      receipt: { ok: true },
      usage: { input: 1, output: 2 },
      executions: [],
      history: { head: "h1" },
    };
    await nativeBackend(page, { children: [detail as any] });
    await page.goto("/#session/s1");
    await page.getByTestId("header-subagents").click();
    await page
      .getByRole("button", { name: "详情", exact: true })
      .first()
      .click();

    const view = page.getByTestId("child-content-view");
    await expect(view).toBeVisible();
    await expect(page.locator(".child-breadcrumbs")).toBeVisible();
    await expect(page.locator(".child-readonly-badge")).toHaveText("只读");

    await view.getByTestId("child-metadata").click();
    const meta = page.getByRole("dialog", { name: "会话信息" });
    await meta.getByText("回执", { exact: true }).click();
    const payload = page.getByTestId("child-receipt-payload");
    await expect(payload).toBeVisible();
    await expect(payload).toHaveAttribute("data-format", "json");
    await expect(
      payload.getByTestId("content-viewer-copyFormatted"),
    ).toBeVisible();
  });
});
