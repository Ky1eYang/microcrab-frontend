import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

async function openAppearance(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".settings-nav-group")).toHaveCount(2);
  await page.getByRole("button", { name: "界面外观", exact: true }).click();
}

test("theme defaults to follow-system and tracks the OS scheme live", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await nativeBackend(page);
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme-pref", "system");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");
  await openAppearance(page);
  await expect(page.getByTestId("theme-option-system")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("theme-option-system")).toBeVisible();
});

test("current layout preferences ignore retired namespace values without rewriting them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("sbclaw.right_rail_collapsed", "false");
    localStorage.setItem("sbclaw.conversation.contentWidth", "1400");
  });
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const { initialState } = await import("/src/state/model.ts");
    const snapshot = () => {
      const state = initialState();
      return {
        collapsed: state.rightRailCollapsed,
        width: state.conversationWidth,
      };
    };
    const defaults = snapshot();
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false");
    localStorage.setItem("microcrab.ui.conversationWidth", "1000");
    return {
      defaults,
      current: snapshot(),
      retired: [
        localStorage.getItem("sbclaw.right_rail_collapsed"),
        localStorage.getItem("sbclaw.conversation.contentWidth"),
      ],
    };
  });
  expect(actual).toEqual({
    defaults: { collapsed: true, width: 820 },
    current: { collapsed: false, width: 1000 },
    retired: ["false", "1400"],
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`explicit ${theme} theme persists across reload and ignores the OS`, async ({
    page,
  }) => {
    const opposite = theme === "light" ? "dark" : "light";
    await page.emulateMedia({ colorScheme: opposite });
    await nativeBackend(page);
    await page.goto("/");
    await openAppearance(page);
    await page.getByTestId(`theme-option-${theme}`).click();
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", theme);
    await expect(html).toHaveAttribute("data-theme-pref", theme);
    expect(
      await page.evaluate(() => localStorage.getItem("microcrab.ui.theme")),
    ).toBe(theme);
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", theme);
    await expect(html).toHaveAttribute("data-theme-pref", theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.emulateMedia({ colorScheme: opposite });
    await expect(html).toHaveAttribute("data-theme", theme);
    await openAppearance(page);
    await page.getByTestId("theme-option-system").click();
    await expect(html).toHaveAttribute("data-theme-pref", "system");
    await expect(html).toHaveAttribute("data-theme", opposite);
    await page.emulateMedia({ colorScheme: theme });
    await expect(html).toHaveAttribute("data-theme", theme);
  });
}
