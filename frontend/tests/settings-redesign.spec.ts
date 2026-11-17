import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { LIMIT_FIELDS, type PublicProvider } from "../src/client/settings";

import { join } from "node:path";
import { mkdirSync } from "node:fs";
const evidence =
  process.env.MICROCRAB_UI_EVIDENCE_DIR ?? "test-results/visual/ui-redesign";
mkdirSync(evidence, { recursive: true });

const provider = (id = "user:alpha"): PublicProvider => ({
  id,
  scope: "user",
  revision: 3,
  read_only: false,
  name: id.endsWith("alpha") ? "Alpha" : "Beta",
  protocol: "openai-compatible",
  endpoint: "https://provider.example/v1",
  auth: "bearer",
  timeout_ms: 60000,
  max_response_bytes: 1048576,
  api_key_configured: true,
  models: [{ id: "manual-a" }],
  discovered: [
    {
      id: "catalog-a",
      name: "Catalog Alpha",
      variants: ["deep"],
      context_window_tokens: 128000,
    },
  ],
});
function settings() {
  const limits = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, 1048576]),
  );
  return {
    revision: 3,
    overrides: {},
    effective: { limits },
    desired_effective: { limits },
    sources: Object.fromEntries(
      LIMIT_FIELDS.map((field) => [`limits.${field}`, "admin"]),
    ),
    constraints: { limits },
    applied_revision: 3,
    application: "defaults_saved",
    reason: null,
  };
}
async function open(page: Page, tab = "模型服务商") {
  // Under 768px the account card lives in the header-opened drawer.
  const railMenu = page.getByTestId("header-open-rail");
  if (await railMenu.isVisible()) await railMenu.click();
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: tab, exact: true }).click();
}
async function setup(page: Page, items = [provider(), provider("user:beta")]) {
  await nativeBackend(page);
  const writes: any[] = [];
  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({ json: settings() }),
  );
  await page.route("**/api/v1/providers", (route) =>
    route.fulfill({ json: { items } }),
  );
  await page.route("**/api/v1/providers/user%3A*", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    const current = items.find(
      (p) =>
        encodeURIComponent(p.id) === route.request().url().split("/").at(-1),
    )!;
    Object.assign(current, body.provider, { revision: current.revision + 1 });
    await route.fulfill({ json: current });
  });
  await page.goto("/#session/s1");
  await open(page);
  return { writes, items };
}
const model = (page: Page, id: string) =>
  page.locator(`.model-row-card[data-model-id="${id}"]`);

test("private Providers are reachable without editing or copying a startup Provider", async ({
  page,
}) => {
  const shared: PublicProvider = {
    ...provider("gateway"),
    name: "Startup Gateway",
    scope: "admin",
    read_only: true,
    revision: 0,
  };
  const items = [shared, provider()];
  const { writes } = await setup(page, items);
  // The actual Server lists startup Providers first.
  await expect(page.getByTestId("provider-id")).toHaveValue("user:alpha");
  await expect(page.getByTestId("provider-save")).toBeEnabled();
  await page.locator('[data-provider-id="gateway"]').click();
  await expect(page.getByTestId("provider-save")).toBeDisabled();
  await expect(page.getByTestId("provider-discover")).toBeDisabled();
  await expect(page.getByTestId("providers-settings")).toContainText(
    "创建独立的私有配置",
  );

  await page.route("**/api/v1/providers/user%3Agateway", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    expect(route.request().method()).toBe("PUT");
    const current = items.find((item) => item.id === "user:gateway");
    const saved: PublicProvider = {
      ...body.provider,
      id: "user:gateway",
      scope: "user",
      revision: (current?.revision ?? 0) + 1,
      read_only: false,
      api_key_configured: false,
      discovered: [],
    };
    if (current) Object.assign(current, saved);
    else items.push(saved);
    await route.fulfill({ json: saved });
  });
  await page.getByRole("button", { name: "+ 新建服务商", exact: true }).click();
  await expect(page.getByTestId("provider-name")).toHaveValue("");
  await expect(page.getByTestId("provider-endpoint")).toHaveValue("");
  await expect(page.getByTestId("provider-secret")).toHaveCount(0);
  await page.getByTestId("provider-id").fill("admin:gateway");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-id")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(writes).toHaveLength(0);
  await page.getByTestId("provider-id").fill("gateway");
  await page.getByTestId("provider-name").fill("My Gateway");
  await page.getByTestId("provider-endpoint").fill("https://mine.example/v1");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-id")).toHaveValue("user:gateway");
  await expect(page.getByTestId("provider-id")).toBeDisabled();
  expect(writes[0]).toMatchObject({
    expected_revision: 0,
    provider: { models: [] },
  });
  expect(writes[0]).not.toHaveProperty("api_key");

  await page.getByTestId("provider-name").fill("My Renamed Gateway");
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    expected_revision: 1,
    provider: { name: "My Renamed Gateway" },
  });
  expect(writes[1]).not.toHaveProperty("api_key");
  expect(shared.name).toBe("Startup Gateway");
});

test("catalog disclosure is pure; editing saves only sparse explicit overrides and retains focus", async ({
  page,
}) => {
  const { writes } = await setup(page);
  const row = model(page, "catalog-a");
  await row
    .getByRole("button", { name: "编辑覆盖 · catalog-a", exact: true })
    .click();
  await expect(row.getByLabel("模型名称", { exact: true })).toHaveValue("");
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].provider.models).toEqual([{ id: "manual-a" }]);
  await row
    .getByRole("button", { name: "编辑覆盖 · catalog-a", exact: true })
    .click();
  await row
    .getByLabel("模型端点覆盖（可选）", { exact: true })
    .pressSequentially("https://custom.example/v1");
  await expect(
    row.getByLabel("模型端点覆盖（可选）", { exact: true }),
  ).toBeFocused();
  await expect(row).toContainText("Catalog Alpha");
  await expect(row).toContainText("128K");
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].provider.models).toEqual([
    { id: "manual-a" },
    { id: "catalog-a", endpoint: "https://custom.example/v1" },
  ]);
});

test("active model ID editor survives search mismatch and duplicate validation reveals the actual row", async ({
  page,
}) => {
  await setup(page);
  const search = page.getByRole("searchbox");
  await search.fill("manual-a");
  let row = model(page, "manual-a");
  await row
    .getByRole("button", { name: "编辑覆盖 · manual-a", exact: true })
    .click();
  const input = row.getByLabel("模型标识", { exact: true });
  await input.press("Control+A");
  await input.pressSequentially("renamed-model");
  await expect(page.locator(".model-expand-grid input").first()).toBeFocused();
  await expect(page.locator(".model-expand-grid input").first()).toHaveValue(
    "renamed-model",
  );
  await search.fill("");
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.locator(".model-expand-grid input").first().fill("renamed-model");
  await expect(model(page, "renamed-model")).toHaveCount(2);
  await search.fill("catalog");
  await page.getByTestId("provider-save").click();
  await expect(
    page.locator('[data-validation-path="provider.models[1].id"]'),
  ).toBeFocused();
  await expect(
    page.locator('[data-validation-path="provider.models[1].id"]'),
  ).toHaveAttribute("aria-invalid", "true");
});

test("provider collapse keeps drafts, delayed reload cannot erase typed draft or new-provider intent", async ({
  page,
}) => {
  await setup(page);
  const head = page.locator('[data-provider-id="user:alpha"]');
  await page.getByTestId("provider-name").fill("Unsaved Alpha");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("provider-discovered")).toBeVisible();
  await expect(head.locator("..")).toHaveAttribute("data-selected", "true");
  const collapsedModel = model(page, "catalog-a");
  await collapsedModel
    .getByRole("button", { name: "编辑覆盖 · catalog-a", exact: true })
    .click();
  await collapsedModel
    .getByLabel("模型名称", { exact: true })
    .fill("Retained while collapsed");
  await head.click();
  await expect(
    collapsedModel.getByLabel("模型名称", { exact: true }),
  ).toHaveValue("Retained while collapsed");
  await expect(page.getByTestId("provider-name")).toHaveValue("Unsaved Alpha");
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/providers", async (route) => {
    await delayed;
    await route.fulfill({ json: { items: [provider()] } });
  });
  await page
    .getByTestId("providers-settings")
    .getByRole("button", { name: "重新加载保存值", exact: true })
    .click();
  await page.getByTestId("provider-name").fill("Typed during reload");
  await page
    .getByRole("combobox")
    .filter({ has: page.locator('option[value="replace"]') })
    .selectOption("replace");
  await page.getByTestId("provider-secret").fill("fixture-only-draft");
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/providers"),
  );
  release();
  await response;
  await expect(page.getByTestId("provider-name")).toHaveValue(
    "Typed during reload",
  );
  await expect(page.getByTestId("provider-secret")).toHaveValue(
    "fixture-only-draft",
  );
  await page.getByRole("button", { name: "+ 新建服务商", exact: true }).click();
  await page.getByTestId("provider-id").fill("user:fresh");
  await expect(page.getByTestId("provider-id")).toHaveValue("user:fresh");
});

test("mutation blocks provider selection and model writes; read-only disclosure never manufactures an overlay", async ({
  page,
}) => {
  const admin = {
    ...provider("admin"),
    scope: "admin" as const,
    read_only: true,
  };
  const { writes } = await setup(page, [provider(), admin]);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/providers/user%3Aalpha", async (route) => {
    writes.push(route.request().postDataJSON());
    await delayed;
    await route.fulfill({ json: provider() });
  });
  await page.getByTestId("provider-save").click();
  await expect(page.locator('[data-provider-id="admin"]')).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "添加模型", exact: true }),
  ).toBeDisabled();
  release();
  await expect(page.locator('[data-provider-id="admin"]')).toBeEnabled();
  await page.locator('[data-provider-id="admin"]').click();
  const row = model(page, "catalog-a");
  await row
    .getByRole("button", { name: "编辑覆盖 · catalog-a", exact: true })
    .click();
  await expect(row.getByLabel("模型名称", { exact: true })).toBeDisabled();
  await expect(row.getByTestId("provider-model-row")).toHaveCount(0);
  await expect(row.locator(".mc-state-btn")).toBeDisabled();
  expect(writes).toHaveLength(1);
});

test("initial list arriving after New Provider preserves the new draft", async ({
  page,
}) => {
  await nativeBackend(page);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/providers", async (route) => {
    await delayed;
    await route.fulfill({ json: { items: [provider()] } });
  });
  await page.goto("/#session/s1");
  await open(page);
  await page.getByRole("button", { name: "+ 新建服务商", exact: true }).click();
  await page.getByTestId("provider-id").fill("user:new-before-list");
  await page.getByTestId("provider-name").fill("New draft");
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/providers"),
  );
  release();
  await response;
  await expect(page.locator('[data-provider-id="user:alpha"]')).toBeVisible();
  await expect(page.getByTestId("provider-id")).toHaveValue(
    "user:new-before-list",
  );
  await expect(page.getByTestId("provider-name")).toHaveValue("New draft");
});

test("sparse enablement saves only id/disabled and blank variants preserve catalog facts", async ({
  page,
}) => {
  const p = provider();
  p.models.push({ id: "catalog-a", variants: [] });
  const { writes } = await setup(page, [p]);
  const row = model(page, "catalog-a");
  await expect(row).toContainText("Catalog Alpha");
  await expect(row).toContainText("128K");
  await row.locator(".mc-state-btn").click();
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].provider.models[1]).toEqual({
    id: "catalog-a",
    variants: [],
    disabled: true,
  });
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  const first = page.locator(".model-expand-grid input").first();
  const generated = await first.inputValue();
  await page
    .locator(".model-expand-grid")
    .getByRole("button", { name: "移除", exact: true })
    .click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(page.locator(".model-expand-grid input").first()).toHaveValue(
    generated,
  );
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(
    page.locator(".model-expand-grid input").first(),
  ).not.toHaveValue(generated);
});

test("server field failures reveal filtered model and collapsed provider config without losing draft", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v1/providers/user%3Aalpha", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "invalid_params",
          message: "provider.models[0].endpoint: fixture invalid endpoint",
        },
      },
    }),
  );
  await page.getByRole("searchbox").fill("catalog");
  await page.getByTestId("provider-save").click();
  const endpoint = page.locator(
    '[data-validation-path="provider.models[0].endpoint"]',
  );
  await expect(endpoint).toBeFocused();
  await expect(endpoint).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`approved settings cards fit and render at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("microcrab.ui.theme", theme),
        theme,
      );
      await setup(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("provider-name")).toBeVisible();
      await page.screenshot({
        path: join(evidence, `provider-config-${width}-${theme}.png`),
        fullPage: true,
      });
      await model(page, "catalog-a")
        .getByRole("button", { name: "编辑覆盖 · catalog-a", exact: true })
        .click();
      await expect(page.getByTestId("provider-discovered")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: join(evidence, `providers-${width}-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "会话默认设置", exact: true })
        .click();
      for (const field of LIMIT_FIELDS)
        await expect(page.getByTestId(`limit-${field}`)).toHaveCount(1);
      await page.locator(".limits-groups-stack").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: join(evidence, `limits-${width}-${theme}.png`),
        fullPage: true,
      });
      const tile = page
        .getByTestId("limit-max_rounds")
        .locator("xpath=ancestor::label");
      await page.getByTestId("limit-max_rounds").fill("12");
      await expect(tile).toContainText("生效值：1048576");
      await expect(tile).toContainText("管理员");
      await expect(tile).not.toContainText("生效值：12");
    });
  }
