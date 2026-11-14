import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import {
  liveToolOutcomes,
  routePermission,
  toolHistory,
} from "./interaction-polish-fixture";
import { toolDisplayStatus } from "../src/features/tool-status";

/* ── unit: status mapping ─────────────────────────────────────────────── */
test("tool status mapping never infers success from absent or unknown facts", () => {
  expect(toolDisplayStatus(undefined)).toBe("unknown");
  expect(toolDisplayStatus("")).toBe("unknown");
  expect(toolDisplayStatus("mystery")).toBe("unknown");
  expect(toolDisplayStatus("completed")).toBe("succeeded");
  expect(toolDisplayStatus("error")).toBe("failed");
  expect(toolDisplayStatus("cancelling")).toBe("cancelling");
  expect(toolDisplayStatus("canceled")).toBe("cancelled");
  expect(toolDisplayStatus("interrupted")).toBe("interrupted");
  expect(toolDisplayStatus("awaiting_approval")).toBe("awaiting_approval");
  expect(toolDisplayStatus("waiting")).toBe("waiting");
});

/* ── tool rows ─────────────────────────────────────────────────────────── */
test("tool rows show spinner, check only for explicit success, and distinct failed/cancelled/unknown states", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const current = backend.snapshot();
  current.session.status = "running";
  current.messages = toolHistory();
  await page.goto("/#session/s1");
  await expect(page.getByTestId("chat-message").first()).toContainText(
    "Inspect status glyphs",
  );
  await liveToolOutcomes(backend);
  const group = page.getByTestId("tool-group").first();
  await expect(group).toBeVisible();
  if (
    (await group
      .locator(".tool-accordion-group-header")
      .getAttribute("aria-expanded")) === "false"
  )
    await group.locator(".tool-accordion-group-header").click();
  const row = (name: string) =>
    page.locator(`[data-testid="tool-row"][data-tool="${name}"]`);
  await expect(row("read_ok")).toHaveAttribute("data-status", "succeeded");
  await expect(row("read_unknown")).toHaveAttribute("data-status", "unknown");
  await expect(row("read_unknown")).toContainText("状态未知");
  await expect(row("shell_running")).toHaveAttribute("data-status", "running");
  await expect(row("shell_running")).toHaveAttribute("aria-busy", "true");
  await expect(row("shell_failed")).toHaveAttribute("data-status", "failed");
  await expect(row("shell_failed")).toContainText("失败");
  await expect(row("shell_cancelled")).toHaveAttribute(
    "data-status",
    "cancelled",
  );
  await expect(row("shell_cancelled")).toContainText("已取消");
  // Only the explicit success uses the check glyph; nothing renders the wrench.
  for (const name of [
    "read_unknown",
    "shell_failed",
    "shell_cancelled",
    "shell_running",
  ])
    await expect(
      row(name).getByTestId("tool-status-glyph"),
    ).not.toHaveAttribute("data-status", "succeeded");
  // Failed output keeps the raw diagnostic text unchanged.
  await row("shell_failed").click();
  await expect(page.getByTestId("tool-payload-output").last()).toContainText(
    "exit status 2: permission denied",
  );
  await expect(
    page.locator('[data-testid="tool-group"][data-status="succeeded"]'),
  ).toHaveCount(0);
});

test("reduced motion keeps the running glyph static and its readable state", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const backend = await nativeBackend(page);
  backend.snapshot().session.status = "running";
  backend.snapshot().messages = toolHistory();
  await page.goto("/#session/s1");
  await expect(page.getByTestId("chat-message").first()).toContainText(
    "Inspect status glyphs",
  );
  await liveToolOutcomes(backend);
  const glyph = page.locator(
    '[data-testid="tool-row"][data-tool="shell_running"] [data-testid="tool-status-glyph"] svg',
  );
  await expect(glyph).toBeVisible();
  expect(await glyph.evaluate((el) => getComputedStyle(el).animationName)).toBe(
    "none",
  );
  await expect(
    page.locator('[data-testid="tool-row"][data-tool="shell_running"]'),
  ).toContainText("执行中");
});

/* ── permissions dialog ───────────────────────────────────────────────── */
test("permissions dialog: loading is not labelled saving, safe initial focus, two keyboard tab levels", async ({
  page,
}) => {
  await nativeBackend(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await routePermission(page, {
    hold: async () => {
      if (first) {
        first = false;
        await held;
      }
    },
  });
  await page.goto("/#session/s1");
  await page.getByTestId("composer-session-permissions").click();
  const dialog = page.getByTestId("session-permissions");
  await expect(dialog).toHaveAttribute("data-status", "loading");
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog).toHaveAttribute("data-session-id", "s1");
  await expect(dialog.getByRole("status").first()).toContainText(
    "正在读取权限",
  );
  const save = dialog.getByTestId("session-permission-save");
  await expect(save).toBeDisabled();
  await expect(save).toHaveText("保存并生效");
  await expect(dialog.getByTestId("session-permission-close")).toBeFocused();
  release();
  await expect(dialog).toHaveAttribute("data-status", "ready");

  // Level 1: section tabs — one tab stop, arrows/Home/End.
  const tools = dialog.getByTestId("session-permission-tab-tools");
  const review = dialog.getByTestId("session-permission-tab-review");
  await expect(tools).toHaveAttribute("tabindex", "0");
  await expect(review).toHaveAttribute("tabindex", "-1");
  await tools.focus();
  await page.keyboard.press("ArrowRight");
  await expect(review).toBeFocused();
  await expect(review).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator("#session-permission-review")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(tools).toBeFocused();
  await expect(tools).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(review).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tools).toHaveAttribute("aria-selected", "true");

  // Level 2: mode tabs.
  const modes = dialog.getByTestId("session-permission-mode");
  await expect(modes).toHaveCount(3);
  await modes.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(modes.nth(1)).toBeFocused();
  await expect(modes.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("session-permission-tool")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(modes.nth(2)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(modes.first()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator("#session-permission-tool-list")).toHaveAttribute(
    "aria-labelledby",
    "session-permission-mode-0",
  );
  // One body scroll owner; the shell itself does not scroll.
  const overflow = await dialog.evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(overflow).toBe("hidden");
  await expect(dialog.getByTestId("session-permission-body")).toHaveCSS(
    "overflow-y",
    "auto",
  );
});

test("permissions dialog invalid JSON keeps the draft, marks the field and blocks tab switch", async ({
  page,
}) => {
  await nativeBackend(page);
  await routePermission(page);
  await page.goto("/#session/s1");
  await page.getByTestId("composer-session-permissions").click();
  const dialog = page.getByTestId("session-permissions");
  await dialog.getByTestId("session-permission-advanced").click();
  await expect(
    dialog.getByTestId("session-permission-advanced"),
  ).toHaveAttribute("aria-expanded", "true");
  const editor = dialog.getByRole("textbox", { name: "高级权限 JSON" });
  await editor.fill("{broken");
  await dialog.getByTestId("session-permission-tab-review").click();
  await expect(dialog.getByRole("alert")).toContainText("权限 JSON 无效");
  await expect(editor).toHaveAttribute("aria-invalid", "true");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("{broken");
  await expect(
    dialog.getByTestId("session-permission-tab-tools"),
  ).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toHaveAttribute("data-status", "error");
});

test.describe("narrow permissions footer", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("390px keeps footer actions visible, wrapped and without horizontal overflow", async ({
    page,
  }) => {
    await nativeBackend(page);
    await routePermission(page);
    await page.goto("/#session/s1");
    await page.getByTestId("composer-session-permissions").click();
    const dialog = page.getByTestId("session-permissions");
    await expect(dialog).toHaveAttribute("data-status", "ready");
    const body = dialog.getByTestId("session-permission-body");
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(358 + 1);
    for (const id of ["session-permission-reload", "session-permission-save"]) {
      const b = await dialog.getByTestId(id).boundingBox();
      expect(b!.y + b!.height).toBeLessThanOrEqual(844);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
      expect(b!.height).toBeGreaterThanOrEqual(44);
    }
    const reload = await dialog
      .getByTestId("session-permission-reload")
      .boundingBox();
    const save = await dialog
      .getByTestId("session-permission-save")
      .boundingBox();
    expect(save!.y).toBeGreaterThan(reload!.y);
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(390);
  });
});

/* ── locale switching ─────────────────────────────────────────────────── */
test("live locale switch updates tool status, rail labels and dialog chrome without touching raw output", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().session.status = "running";
  backend.snapshot().messages = toolHistory();
  await routePermission(page);
  await page.goto("/#session/s1");
  await expect(page.getByTestId("chat-message").first()).toContainText(
    "Inspect status glyphs",
  );
  await liveToolOutcomes(backend);
  const failed = page.locator(
    '[data-testid="tool-row"][data-tool="shell_failed"]',
  );
  await expect(failed).toContainText("失败");
  await page.locator(".user-card-btn").first().click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "界面外观" }).click();
  await page.getByTestId("locale-option-en").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.keyboard.press("Escape");
  await expect(failed).toContainText("Failed");
  await expect(failed).toContainText("shell_failed");
  await expect(
    page.locator('[data-testid="tool-row"][data-tool="read_unknown"]'),
  ).toContainText("Status unavailable");
  await expect(
    page
      .locator('[aria-label="Sessions"], [aria-label="Sessions (collapsed)"]')
      .first(),
  ).toBeAttached();
  await expect(page.locator('[aria-label="会话列表"]')).toHaveCount(0);
  await failed.click();
  await expect(page.getByTestId("tool-payload-output").last()).toContainText(
    "exit status 2: permission denied",
  );
  await page.getByTestId("composer-session-permissions").click();
  const dialog = page.getByTestId("session-permissions");
  await expect(
    dialog.getByRole("heading", { name: "Session permissions" }),
  ).toBeVisible();
  await expect(dialog.getByTestId("session-permission-save")).toHaveText(
    "Save and apply",
  );
  // Server-provided tool names/descriptions stay untouched.
  await expect(
    dialog.getByText("Read a file from the workspace."),
  ).toBeVisible();
});

for (const locale of ["zh-CN", "en"] as const)
  test.describe(`narrow busy composer ${locale}`, () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test("model/agent pills, Stop, Insert and Queue never overlap and stay reachable", async ({
      page,
    }) => {
      await page.addInitScript(
        (lo) => localStorage.setItem("microcrab.ui.locale", lo),
        locale,
      );
      const backend = await nativeBackend(page);
      backend.snapshot().session.status = "running";
      backend.snapshot().inbox = {
        items: [],
        active: true,
        paused: false,
      } as any;
      await page.goto("/#session/s1");
      await connectHostUI(page);
      const textarea = page.getByTestId("composer").locator("textarea");
      await textarea.fill("draft in progress");
      const ids = [
        ".composer-agent-pill",
        ".composer-model-pill",
        '[data-testid="composer-stop"]',
        '[data-testid="steer-input"]',
        '[data-testid="queue-input"]',
      ];
      await expect(page.locator(ids[3])).toBeVisible();
      const composer = await page.getByTestId("composer").boundingBox();
      const boxes = [] as {
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
      for (const id of ids) {
        const box = await page.locator(id).first().boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(composer!.x - 1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          composer!.x + composer!.width + 1,
        );
        boxes.push(box!);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i],
            b = boxes[j];
          const overlap =
            a.x < b.x + b.width - 0.5 &&
            b.x < a.x + a.width - 0.5 &&
            a.y < b.y + b.height - 0.5 &&
            b.y < a.y + a.height - 0.5;
          expect(overlap, `${ids[i]} overlaps ${ids[j]}`).toBe(false);
        }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      // Keyboard path: controls remain native buttons in the tab order.
      for (const id of ids.slice(2))
        await expect(page.locator(id)).not.toHaveAttribute("tabindex", "-1");
      await page.locator('[data-testid="composer-stop"]').focus();
      await expect(page.locator('[data-testid="composer-stop"]')).toBeFocused();
      await expect(
        page.locator('[data-testid="composer-stop"]'),
      ).toHaveAttribute("aria-label", /.+/);
    });
  });
