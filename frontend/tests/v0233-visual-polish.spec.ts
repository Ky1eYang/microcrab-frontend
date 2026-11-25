import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

function luminance(rgb: string) {
  const parts = rgb.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  const [r, g, b] = parts.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

for (const scheme of ["light", "dark"] as const) {
  test(`scrollbar thumb meets >=3:1 non-text contrast and color-scheme meta is set (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await nativeBackend(page);
    await page.goto("/");
    await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
      "content",
      "light dark",
    );
    const colors = await page.evaluate(() => {
      const probe = (v: string) => {
        const el = document.createElement("span");
        el.style.color = `var(${v})`;
        document.body.append(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      };
      return {
        thumb: probe("--scrollbar-thumb"),
        bg: probe("--bg"),
        surface: probe("--surface"),
        scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
      };
    });
    expect(colors.scrollbarWidth).toBe("thin");
    expect(contrast(colors.thumb, colors.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.thumb, colors.surface)).toBeGreaterThanOrEqual(3);
  });
}

test("home recent sessions render cards, scope switch, and clean timestamps without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend = await nativeBackend(page);
  Object.assign(backend.snapshot().session, {
    title: "Current workspace task",
    created_at_ms: 1,
    updated_at_ms: 2,
  });
  await page.goto("/");
  const section = page.getByTestId("recent-sessions");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("recent-session-card")).toHaveCount(1);
  await expect(section).toContainText("Current workspace task");
  // Epoch-adjacent timestamp renders "—" instead of "20774d".
  await expect(section).toContainText("—");
  await expect(section).not.toContainText("20774d");
  await page.getByTestId("recent-scope-all").click();
  await expect(section.getByTestId("recent-session-card")).toHaveCount(1);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("tool group glyphs, trajectory status glyphs, and inline retry render cleanly", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { extraMethods: ["turn.retry"] });
  backend.snapshot().messages = [
    {
      id: "u1",
      role: "user",
      text: "Run tools",
      parts: [],
      tool_calls: [],
    },
    {
      id: "a1",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        { id: "c1", name: "read", arguments: { path: "ok" } },
        { id: "c2", name: "read", arguments: { path: "missing" } },
      ],
    },
    {
      id: "t1",
      role: "tool",
      text: "ok",
      parts: [],
      tool_calls: [],
      call_id: "c1",
      tool_name: "read",
    },
    {
      id: "t2",
      role: "tool",
      text: "ENOENT",
      parts: [],
      tool_calls: [],
      call_id: "c2",
      tool_name: "read",
    },
  ];
  backend.snapshot().operations = [
    {
      version: 1,
      id: "op-retry-1",
      session_id: "s1",
      owner: "u1",
      method: "turn.submit",
      payload_hash: "fixture",
      status: "failed",
      revision: 1,
      created_at_ms: 10,
      updated_at_ms: 11,
      result: {
        error: { code: "provider_error", message: "Upstream failed" },
        after_message_id: "t2",
        position: { epoch: 0, turn: 1, round: 2 },
        retry_ready: true,
      },
    },
  ];
  Object.assign(backend.snapshot().session, {
    retry_ready: true,
    retry_operation_id: "op-retry-1",
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("operation-failure")).toBeVisible();
  backend.event("tool", {
    execution_id: 2,
    call_id: "c2",
    name: "read",
    phase: "failed",
    epoch: 0,
    turn: 1,
    round: 1,
    started_at_unix_ms: 1000,
    elapsed_ms: 50,
  });
  await expect(page.getByTestId("tool-group-outcomes")).toBeVisible();
  await expect(
    page.getByTestId("tool-group-outcomes").locator(".tool-group-glyph"),
  ).toHaveAttribute("data-status", "failed");
  const failure = page.getByTestId("operation-failure");
  await expect(failure).toBeVisible();
  await expect(failure.getByTestId("retry-model-request")).toBeVisible();

  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(
    page.locator('[data-testid="trajectory-status-glyph"][data-status="failed"]'),
  ).toBeVisible();
});
