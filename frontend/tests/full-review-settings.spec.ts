import { expect, test, type Page } from "@playwright/test";
import { LIMIT_FIELDS } from "../src/client/settings";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { permissionPolicy } from "./interaction-polish-fixture";

async function openPermissions(page: Page) {
  await page.goto("/#session/s1");
  await page.getByTestId("composer-session-permissions").click();
  return page.getByTestId("session-permissions");
}

test("tool search reports no matches and resets across modes and inventory reloads", async ({
  page,
}) => {
  await nativeBackend(page);
  const policy = permissionPolicy();
  policy.tool_inventory!.modes[0].tools.push({
    name: "inspect",
    description: "Inspect metadata",
  });
  policy.tool_inventory!.modes[0].compiled.push({
    tool: { kind: "exact", value: "inspect" },
    kind: "static",
    action: "allow",
  });
  await page.route("**/api/v1/sessions/s1/permission", (route) =>
    route.fulfill({ json: policy }),
  );
  const dialog = await openPermissions(page);
  const search = dialog.getByRole("searchbox");
  await search.fill("no-such-tool");
  await expect(dialog.getByTestId("session-permission-tool")).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("没有匹配结果");
  await dialog.getByRole("tab", { name: "coding · plan", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(dialog.getByTestId("session-permission-tool")).toHaveAttribute(
    "data-tool",
    "read",
  );
  await dialog
    .getByTestId("session-permission-mode")
    .filter({ hasText: "coding · execute" })
    .click();
  await expect(search).toHaveValue("");
  await search.fill("metadata");
  await expect(dialog.getByTestId("session-permission-tool")).toHaveAttribute(
    "data-tool",
    "inspect",
  );
  policy.tool_inventory!.modes[0].tools = [
    { name: "replacement", description: "Replacement tool" },
  ];
  policy.tool_inventory!.modes[0].compiled = [
    {
      tool: { kind: "exact", value: "replacement" },
      kind: "static",
      action: "allow",
    },
  ];
  await dialog.getByTestId("session-permission-reload").click();
  await expect(search).toHaveCount(0);
  await expect(dialog.getByTestId("session-permission-tool")).toHaveAttribute(
    "data-tool",
    "replacement",
  );
});

test("review filtering keeps the selected model and predicate suggestions accept exact free text", async ({
  page,
}) => {
  await nativeBackend(page);
  const policy = permissionPolicy();
  policy.config.review_model = {
    provider_id: "provider",
    model: "model-1",
    variant: "deep",
  };
  const writes: any[] = [];
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 6 }, (_, i) => ({
          id: `model-${i + 1}`,
          name: `Model ${i + 1}`,
          provider_id: "provider",
          variants: ["deep"],
        })),
      },
    }),
  );
  await page.route("**/api/v1/sessions/s1/permission", async (route) => {
    if (route.request().method() === "PUT")
      writes.push(route.request().postDataJSON());
    await route.fulfill({ json: policy });
  });
  const dialog = await openPermissions(page);
  const rule = dialog.getByTestId("permission-predicate-rule").first();
  const agent = rule.locator("input[list]").nth(0);
  const mode = rule.locator("input[list]").nth(1);
  await expect(agent).toHaveAttribute("list", /agents$/);
  await expect(mode).toHaveAttribute("list", /modes$/);
  await agent.fill("custom agent / exact");
  await mode.fill("custom mode : exact");
  await dialog.getByTestId("session-permission-tab-review").click();
  const search = dialog.getByRole("searchbox");
  await search.fill("no-such-model");
  const select = dialog.locator("#session-permission-review-model");
  await expect(select).toHaveValue(
    JSON.stringify(["provider", "model-1", "deep"]),
  );
  await expect(select.locator("option")).toHaveCount(2);
  await expect(dialog.getByRole("status")).toContainText("没有匹配结果");
  await dialog.getByTestId("session-permission-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].expected_revision).toBe(7);
  expect(writes[0].review_model).toEqual(policy.config.review_model);
  expect(writes[0].overrides).toEqual([
    {
      ...policy.config.overrides[0],
      agent: "custom agent / exact",
      mode: "custom mode : exact",
    },
  ]);
});

for (const width of [1440, 390]) {
  test(`project selector preserves unavailable values and temporary queries, explicitly clears mode, and handles Escape at ${width}px`, async ({
    page,
  }) => {
    await nativeBackend(page);
    const limits = Object.fromEntries(
      LIMIT_FIELDS.map((field) => [field, 1048576]),
    );
    const snapshot = {
      revision: 3,
      overrides: { agent: "missing-agent", mode: "missing-mode" } as Record<
        string,
        string
      >,
      effective: { limits, agent: "missing-agent", mode: "missing-mode" },
      desired_effective: { limits },
      sources: {},
      constraints: { limits },
      applied_revision: 3,
      application: "defaults_saved",
      reason: null,
    };
    const writes: any[] = [];
    await page.route("**/api/v1/projects/project-1/settings", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        snapshot.overrides = body.overrides;
        snapshot.revision++;
      }
      await route.fulfill({ json: snapshot });
    });
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const folder = page.locator(".rail-project-folder").first();
    await folder.locator(".rail-project-row").hover();
    await folder.locator(".rail-project-more-btn").click();
    await page.getByTestId("project-menu-settings").click();
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.getByTestId("project-settings");
    await dialog.getByTestId("project-settings-tab-permissions").click();
    const owner = dialog.getByTestId("owner-settings-project");
    const combo = owner.getByRole("combobox", { name: "Agent", exact: true });
    const mode = owner.getByRole("combobox", { name: "模式", exact: true });
    await expect(combo).toHaveValue(/missing-agent/);
    await expect(mode).toHaveValue(/missing-mode/);
    await combo.click();
    await combo.fill("temporary unmatched query");
    await expect(dialog.getByRole("listbox").getByRole("status")).toContainText(
      "没有匹配结果",
    );
    await combo.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(combo).toHaveAttribute("aria-expanded", "false");
    await expect(combo).toHaveValue(/missing-agent/);
    await owner.getByTestId("settings-save").click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({
      expected_revision: 3,
      overrides: { agent: "missing-agent", mode: "missing-mode" },
    });
    await combo.click();
    await dialog.getByRole("option", { name: "coding", exact: true }).click();
    await expect(mode).not.toHaveValue(/missing-mode/);
    await owner.getByTestId("settings-save").click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({
      expected_revision: 4,
      overrides: { agent: "coding" },
    });
    await combo.click();
    await expect(combo).toHaveAttribute("aria-expanded", "true");
    await combo.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(combo).toHaveAttribute("aria-expanded", "false");
    await combo.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

for (const outcome of ["saved", "failed"] as const) {
  test(`pending owner settings freeze every draft control until ${outcome} receipt`, async ({
    page,
  }) => {
    await nativeBackend(page);
    const limits = Object.fromEntries(
      LIMIT_FIELDS.map((field) => [field, 1048576]),
    );
    const overrides = {
      permissions: [],
      auto_compaction: {
        enabled: true,
        turn_threshold: 0.8,
        round_threshold: 0.95,
        headroom_tokens: 0,
      },
    };
    let snapshot = {
      revision: 3,
      overrides,
      effective: { limits, ...overrides },
      desired_effective: { limits, ...overrides },
      sources: {},
      constraints: { limits },
      applied_revision: 3,
      application: "defaults_saved",
      reason: null,
    };
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: any[] = [];
    await page.route("**/api/v1/settings", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        await receipt;
        if (outcome === "failed") {
          await route.fulfill({
            status: 400,
            json: {
              error: { code: "invalid_params", message: "fixture write refused" },
            },
          });
          return;
        }
        snapshot = {
          ...snapshot,
          overrides: body.overrides,
          revision: 4,
          applied_revision: 4,
        };
      }
      await route.fulfill({ json: snapshot });
    });
    await page.goto("/#session/s1");
    await page.getByRole("button", { name: "Test User", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "会话默认设置", exact: true }).click();
    const owner = page.getByTestId("owner-settings-user");
    const limit = owner.getByTestId("limit-max_rounds");
    await limit.fill("23");
    await owner.getByTestId("settings-save").click();
    await expect.poll(() => writes.length).toBe(1);
    const controls = owner.locator("input, select, textarea");
    expect(await controls.count()).toBeGreaterThan(20);
    await expect
      .poll(() =>
        controls.evaluateAll((nodes) =>
          nodes.every((node) => (node as HTMLInputElement).disabled),
        ),
      )
      .toBe(true);
    expect(writes[0].overrides.limits.max_rounds).toBe(23);
    release();
    await expect(limit).toBeEnabled();
    await expect(limit).toHaveValue("23");
    await expect(owner).toHaveAttribute("aria-busy", "false");
    if (outcome === "failed")
      await expect(owner.getByRole("alert")).toContainText(
        "fixture write refused",
      );
    else
      await expect(owner.getByRole("status")).toContainText("已保存");
  });
}
