import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { LIMIT_FIELDS } from "../src/client/settings";

function snapshot(overrides: Record<string, unknown> = {}, revision = 1) {
  const limits = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, 1048576]),
  );
  const effective = {
    limits,
    review: true,
    initialization: "allow",
    auto_naming: true,
    ...overrides,
  };
  return {
    revision,
    overrides,
    effective,
    desired_effective: effective,
    sources: { model_selection: "user" },
    constraints: { limits },
    applied_revision: revision,
    application: "defaults_saved",
    reason: null,
  };
}
async function open(page: Page, tab = "会话默认设置") {
  const onDash = await page.evaluate(() =>
    window.location.hash.startsWith("#/dashboard") ||
    window.location.pathname.endsWith("/dashboard"),
  );
  if (onDash) {
    await expect(page.getByTestId("dashboard")).toBeVisible();
  } else {
    await expect(page.getByTestId("composer").locator("textarea")).toBeVisible();
    const railMenu = page.locator('.shell [data-testid="header-open-rail"]');
    if (await railMenu.isVisible()) {
      await railMenu.click();
      await expect(
        page.locator('.shell [data-testid="nav-dashboard"]').filter({ visible: true }).first(),
      ).toBeVisible();
    }
    await page.locator('.shell [data-testid="nav-dashboard"]').filter({ visible: true }).first().click();
  }
  const dashMenu = page.locator('[data-testid="dashboard"] [data-testid="header-open-rail"]');
  if (await dashMenu.isVisible()) await dashMenu.click();
  await page.getByTestId("dashboard-nav-settings").click();
  const section = tab === "模型服务商" ? "providers" : "defaults";
  await page.getByTestId(`console-settings-tab-${section}`).click();
}
async function setup(page: Page, overrides: Record<string, unknown> = {}) {
  const backend = await nativeBackend(page, { owner: "settings-owner-a" });
  let saved = snapshot(overrides);
  const writes: any[] = [];
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      saved = snapshot(body.overrides, saved.revision + 1);
    }
    await route.fulfill({ json: saved });
  });
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 100 }, (_, index) => ({
          id: `model-${index}`,
          name: `Catalog ${index}`,
          provider_id: index < 50 ? "provider-alpha" : "provider-beta",
          variants: ["reasoning"],
        })),
      },
    }),
  );
  await page.goto("/#session/s1");
  await open(page);
  return { backend, writes };
}

for (const width of [1440, 390]) {
  test(`searchable default model fits the settings viewport at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const model = page
      .getByTestId("settings-model-default")
      .getByRole("combobox");
    await model.fill("provider-beta catalog 87 reasoning");
    const option = page.getByRole("option").filter({ hasText: "Catalog 87" });
    await expect(option).toHaveCount(1);
    await expect(option).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/visual/settings-searchable-default-${width}.png`,
      fullPage: true,
    });
    await option.click();
    await expect(model).toHaveValue("Catalog 87 · provider-beta · reasoning");
  });
}

test("100-model search supports provider, name, ID and variant, keyboard selection saves durable defaults with CAS", async ({
  page,
}) => {
  const { writes, backend } = await setup(page);
  const model = page
    .getByTestId("settings-model-default")
    .getByRole("combobox");
  await expect(page.getByTestId("settings-model-default")).toContainText(
    "新会话默认模型",
  );
  await model.fill("provider-beta catalog 87 model-87 reasoning");
  await expect(
    page.getByRole("option").filter({ hasText: "Catalog 87" }),
  ).toHaveCount(1);
  await model.press("ArrowDown");
  await model.press("ArrowUp");
  await model.press("ArrowDown");
  const activeId = await model.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toContainText("Catalog 87");
  await model.press("Enter");
  await expect(model).toHaveValue("Catalog 87 · provider-beta · reasoning");
  await expect(model).toBeFocused();
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    expected_revision: 1,
    overrides: {
      model_selection: {
        provider_id: "provider-beta",
        model: "model-87",
        variant: "reasoning",
      },
    },
  });
  expect(
    backend.commands.some((command) => command.method === "session.set_model"),
  ).toBe(false);
  await page.reload();
  await open(page);
  await expect(
    page.getByTestId("settings-model-default").getByRole("combobox"),
  ).toHaveValue("Catalog 87 · provider-beta · reasoning");
});

test("Escape closes only model suggestions and unavailable selection survives; appearance contains no draft model control", async ({
  page,
}) => {
  const { writes } = await setup(page, {
    model_selection: {
      provider_id: "removed",
      model: "offline-model",
      variant: "legacy",
    },
  });
  const model = page
    .getByTestId("settings-model-default")
    .getByRole("combobox");
  await expect(model).toHaveValue(/offline-model.*legacy.*不可用/);
  await model.click();
  await model.fill("no-such-model");
  await expect(
    page.getByText("没有匹配的模型，请尝试其他名称或服务商。"),
  ).toBeVisible();
  await model.press("Escape");
  await expect(model).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(model).toHaveValue(/offline-model/);
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].overrides.model_selection).toEqual({
    provider_id: "removed",
    model: "offline-model",
    variant: "legacy",
  });
  await page.getByTestId("dashboard-back").click();
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "界面外观", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "默认模型", exact: true }),
  ).toHaveCount(0);
});

test("recents persist minimal identities only within their owner and review current-model remains null", async ({
  page,
}) => {
  const { writes } = await setup(page);
  const model = page
    .getByTestId("settings-model-default")
    .getByRole("combobox");
  await model.fill("model-91 reasoning");
  await model.press("ArrowDown");
  await model.press("Enter");
  const review = page.getByRole("combobox", { name: "审查模型", exact: true });
  await review.click();
  await expect(page.getByText("最近选择", { exact: true })).toBeVisible();
  await review.press("ArrowDown");
  await review.press("Enter");
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].overrides.review_model).toBeNull();
  const entries = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("microcrab.settingsUX.models.v1:"),
    ),
  );
  expect(entries).toHaveLength(1);
  expect(entries[0][0]).toContain("settings-owner-a");
  expect(JSON.parse(entries[0][1])).toEqual([
    JSON.stringify(["provider-beta", "model-91", "reasoning"]),
  ]);
  await page.reload();
  await open(page);
  await page
    .getByTestId("settings-model-default")
    .getByRole("combobox")
    .click();
  await expect(page.getByText("最近选择", { exact: true })).toBeVisible();
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        principal: {
          owner: "settings-owner-b",
          subject: "sub1",
          display_name: "Test User",
          expires_at: 9999999999,
        },
      },
    }),
  );
  await page.reload();
  await open(page);
  await page
    .getByTestId("settings-model-default")
    .getByRole("combobox")
    .click();
  await expect(page.getByText("最近选择", { exact: true })).toHaveCount(0);
});

test("Sidebar plugin management entry opens dedicated management and returns to conversation", async ({
  page,
}) => {
  await nativeBackend(page, { owner: "settings-owner-a" });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("composer").locator("textarea")).toBeVisible();
  await page.locator(".header-right-toggle-btn").click();
  await page.getByTestId("plugins-manage").click();
  const manager = page.getByTestId("client-plugins-manager");
  await expect(manager).toBeVisible();
  await expect(page.getByTestId("content-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/session\/s1\/plugins$/);
  await manager.getByRole("button", { name: "返回", exact: true }).click();
  await expect(manager).toHaveCount(0);
  await expect(page).toHaveURL(/session\/s1$/);
});

test("provider and settings validation focus actual invalid controls with nearby concrete feedback", async ({
  page,
}) => {
  await setup(page);
  const limit = page.getByTestId("limit-output_buffer_bytes");
  await limit.fill("0");
  await page.getByTestId("settings-save").click();
  await expect(limit).toBeFocused();
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".settings-field-error")).toContainText(
    "output_buffer_bytes",
  );
  await limit.fill("524288");
  await expect(page.getByTestId("owner-settings-user")).toContainText(
    "512 KiB",
  );
  await page.route("**/api/v1/providers", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.getByTestId("console-settings-tab-providers").click();
  await page.getByRole("button", { name: "+ 新建服务商", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.locator('[data-validation-path="provider.models[0].id"]').fill("");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-id")).toBeFocused();
  await expect(page.locator(".settings-field-error")).toContainText(
    "服务商标识",
  );
  await page.getByTestId("provider-id").fill("user:mine");
  await page.getByTestId("provider-name").fill("Mine");
  await page.getByTestId("provider-endpoint").fill("invalid-url");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-endpoint")).toBeFocused();
  await expect(page.locator(".settings-field-error")).toContainText("HTTP(S)");
  await page.getByTestId("provider-endpoint").fill("https://example.test/v1");
  await page.getByTestId("provider-save").click();
  await expect(
    page.locator('[data-validation-path="provider.models[0].id"]'),
  ).toBeFocused();
  await expect(page.locator(".settings-field-error")).toContainText(
    "unique nonempty model id",
  );
});
