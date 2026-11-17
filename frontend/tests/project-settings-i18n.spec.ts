import { LIMIT_FIELDS } from "../src/client/settings";
import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

async function openProjectSettings(page: import("@playwright/test").Page) {
  const folder = page.locator(".rail-project-folder").first();
  await folder.locator(".rail-project-row").hover();
  await folder.locator(".rail-project-more-btn").click();
  await page.getByTestId("project-menu-settings").click();
  await expect(page.getByTestId("project-settings")).toBeVisible();
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`project settings ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 1440, height: 900 } });

    test("captures dialog tabs and chrome at 1440 and 390", async ({
      page,
    }, testInfo) => {
      await nativeBackend(page);
      await page.goto("/");
      await expect(page.getByTitle("选择项目工作区")).toBeVisible();
      await connectHostUI(page);
      await openProjectSettings(page);

      for (const width of [1440, 390] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByTestId("project-settings-tab-host").click();
        await expect(page.getByTestId("project-settings-pane")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(
            `project-settings-host-${colorScheme}-${width}.png`,
          ),
        });
        for (const tab of ["agents", "models", "prompts", "speakers", "permissions", "references"] as const) {
          await page.getByTestId(`project-settings-tab-${tab}`).click();
          await expect(page.getByTestId("project-settings-pane")).toBeVisible();
          expect(await page.getByTestId("project-settings-pane").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(
              `project-settings-${tab}-${colorScheme}-${width}.png`,
            ),
          });
        }
      }

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId("project-settings-tab-references").click();
      await expect(page.getByTestId("project-ref-save")).toBeDisabled();
      await page.getByTestId("project-settings-tab-agents").click();
      await expect(page.getByTestId("project-agent-upload")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("project-settings")).toHaveCount(0);

      for (const width of [1440, 390] as const) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) {
          // v0.1.18: no resident icon rail below 768px; the Header opens the drawer.
          await expect(page.locator(".session-rail")).toHaveCount(0);
          await expect(page.getByTestId("header-open-rail")).toBeVisible();
          await expect
            .poll(async () => {
              const box = await page
                .locator(".home-composer-box")
                .boundingBox();
              return box?.width ?? 0;
            })
            .toBeGreaterThan(250);
        }
        await expect(page.getByTestId("composer-agent-pill")).toBeVisible();
        await expect(page.getByTestId("composer-model-pill")).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(
            `composer-agent-${colorScheme}-${width}.png`,
          ),
        });
        await page.getByTitle("选择项目工作区").click();
        await expect(page.getByTestId("home-project-picker")).toBeVisible();
        await expect(
          page.getByRole("button", { name: "仅聊天", exact: true }),
        ).toBeVisible();
        await expect(page.locator('[data-host-flavor="browser_sandbox"]')).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`home-picker-${colorScheme}-${width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("home-project-picker")).toHaveCount(0);
      }
    });
  });
}

test.describe("permission policy editor", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("preserves scoped and conditional rules through Session UI edits and JSON switches", async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const scoped = {
      agent: "coding",
      mode: "build",
      tool: { kind: "glob", value: "file_*" },
      args: [
        { pointer: "/path", matcher: { kind: "glob", value: "docs/**" } },

        { pointer: "/overwrite", matcher: { kind: "exact", value: "false" } },
      ],
      action: "ask",
    };
    const scopedExact = {
      ...scoped,
      tool: { kind: "exact", value: "write_file" },
      action: "allow",
    };
    const conditional = {
      tool: { kind: "exact", value: "shell" },
      args: [
        {
          pointer: "/command",
          matcher: { kind: "glob", value: "git status*" },
        },
      ],
      action: "ask",
    };
    const simple = {
      tool: { kind: "exact", value: "read_file" },
      args: [],
      action: "ask",
    };
    const config = {
      agent: "coding",
      mode: "plan",
      defaults: [scoped],
      provider_defaults: [conditional],
      review: true,
      initialization: "ask",
      overrides: [scoped, simple, conditional, scopedExact],
    };
    const inventory = {
      agent: "coding",
      modes: [
        {
          name: "plan",
          current: true,
          tools: [{ name: "read_file", description: "Pinned reader" }],
          policy: config,
          compiled: [
            {
              tool: { kind: "exact", value: "read_file" },
              kind: "static",
              action: "ask",
            },
          ],
        },
      ],
    };
    backend.snapshot().permission = {
      revision: 11,
      config: structuredClone(config),
      tool_inventory: inventory,
    };
    const projectDefaults = {
      revision: 4,
      overrides: {},
      effective: {
        limits: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 64])),
        review: true,
        initialization: "allow",
      },
      desired_effective: {
        limits: Object.fromEntries(LIMIT_FIELDS.map((field) => [field, 64])),
        review: true,
        initialization: "allow",
      },
      sources: Object.fromEntries(
        LIMIT_FIELDS.map((field) => [`limits.${field}`, "admin"]),
      ),
      constraints: {
        limits: Object.fromEntries(
          LIMIT_FIELDS.map((field) => [field, 3600000]),
        ),
      },
      applied_revision: 4,
      application: "defaults_saved",
      reason: null,
    };
    await page.route("**/api/v1/projects/project-1/settings", async (route) => {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: projectDefaults });
    });
    const writes: any[] = [];
    await page.route("**/api/v1/sessions/s1/permission", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      const body = route.request().postDataJSON();
      writes.push(body);
      backend.snapshot().permission = {
        revision: 11 + writes.length,
        config: {
          ...config,
          overrides: body.overrides,
          review: body.review,
          review_model: body.review_model,
          initialization: body.initialization,
        },
        tool_inventory: inventory,
      };
      await route.fulfill({ json: backend.snapshot().permission });
    });
    await page.goto("/#/session/s1");
    await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
    await openProjectSettings(page);
    await page.getByTestId("project-settings-tab-permissions").click();
    const project = page.getByTestId("project-settings");
    await expect(project.locator("textarea")).toHaveCount(0);
    await expect(project.getByTestId("external-speakers")).toHaveCount(0);
    await expect(project.getByTestId("settings-model-default")).toHaveCount(0);
    await page.getByTestId("project-settings-tab-models").click();
    const defaults = project.getByTestId("owner-settings-project");
    await expect(defaults.getByTestId("settings-save")).toBeEnabled();
    await expect(defaults.getByTestId("settings-revisions")).toContainText(
      "期望版本 4 · 已应用版本 4",
    );
    await expect(defaults.getByTestId("limit-max_processes")).toHaveValue("");
    await expect(defaults.getByTestId("settings-application")).toContainText(
      "默认值已保存",
    );
    await expect(defaults.getByLabel("操作审查", { exact: true })).toHaveValue(
      "",
    );
    await page.getByTestId("project-settings-tab-permissions").click();
    await project
      .getByRole("button", { name: "打开当前会话权限", exact: true })
      .click();
    const dialog = page.getByTestId("session-permissions");
    const advanced = dialog.getByRole("button", {
      name: "高级权限 JSON",
      exact: true,
    });
    await advanced.click();
    const json = dialog.getByRole("textbox", { name: "高级权限 JSON" });
    expect(JSON.parse(await json.inputValue())).toEqual({
      ...config,
      review_model: null,
    });
    const edited = { ...config, review: false, review_model: null };
    await json.fill(JSON.stringify(edited));
    await advanced.click();
    await dialog
      .getByRole("combobox", { name: "read_file 的调用策略" })
      .selectOption("deny");
    await dialog.getByTestId("session-permission-save").click();
    await expect.poll(() => writes.length).toBe(1);
    const generated = {
      agent: "coding",
      mode: "plan",
      tool: { kind: "exact", value: "read_file" },
      action: "deny",
    };
    expect(writes[0]).toEqual({
      expected_revision: 11,
      initialization: "ask",
      review: false,
      review_model: null,
      overrides: [scoped, simple, conditional, scopedExact, generated],
    });
    await expect(dialog.getByTestId("session-permission-save")).toBeEnabled();
    await advanced.click();
    expect(JSON.parse(await json.inputValue())).toEqual(
      backend.snapshot().permission.config,
    );
    await dialog.getByTestId("session-permission-save").click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].expected_revision).toBe(12);
    expect(writes[1].overrides).toEqual(writes[0].overrides);
    await expect(dialog.getByTestId("session-permission-save")).toBeEnabled();
    await json.fill("{broken");
    await advanced.click();
    await expect(json).toHaveValue("{broken");
    await expect(dialog.getByRole("alert")).toContainText("权限 JSON 无效");
    expect(writes).toHaveLength(2);
  });

  test("fences delayed permission responses by session, attachment and revision", async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const results = await page.evaluate(async () => {
      const { AppStore } = await import("/src/state/store.ts");
      const results = [];
      for (const change of ["session", "attachment", "revision"]) {
        const store: any = new AppStore();
        const original = {
          revision: 3,
          config: { overrides: [], review: true, initialization: "ask" },
        };
        const response = {
          revision: 4,
          config: { overrides: [], review: false, initialization: "ask" },
        };
        store.update({
          sessionId: "s1",
          policy: original,
          capabilities: {
            protocol: 1,
            methods: ["permission.set"],
            features: {},
            limits: {},
          },
        });
        let finish!: (value: unknown) => void;
        let destination: string | undefined;
        store.api.request = (
          _method: string,
          _params: unknown,
          sessionId: string,
        ) => {
          destination = sessionId;
          return new Promise((resolve) => {
            finish = resolve;
          });
        };
        const pending = store.dispatch({
          type: "SetPermissions",
          expectedRevision: 3,
          overrides: [],
          review: false,
        });
        if (change === "session")
          store.update({ sessionId: "s2", policy: original });
        if (change === "attachment") store.attaching++;
        if (change === "revision")
          store.update({ policy: { ...original, revision: 5 } });
        finish(response);
        const returned = await pending;
        results.push({
          change,
          destination,
          revision: store.state.policy.revision,
          returned,
        });
        store.stop();
      }
      return results;
    });
    expect(
      results.map(({ change, destination, revision }) => ({
        change,
        destination,
        revision,
      })),
    ).toEqual([
      { change: "session", destination: "s1", revision: 3 },
      { change: "attachment", destination: "s1", revision: 3 },
      { change: "revision", destination: "s1", revision: 5 },
    ]);
    for (const result of results) expect(result.returned.revision).toBe(4);
  });

  test("preserves the server error and dirty draft when loading Session policy fails", async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/#/session/s1");
    await page.getByTestId("composer-session-permissions").click();
    const dialog = page.getByTestId("session-permissions");
    await dialog
      .getByRole("button", { name: "高级权限 JSON", exact: true })
      .click();
    const json = dialog.getByRole("textbox", { name: "高级权限 JSON" });
    const draft = JSON.stringify({
      review: true,
      review_model: null,
      overrides: [{ tool: { kind: "exact", value: "shell" }, action: "deny" }],
    });
    await json.fill(draft);
    await page.route("**/api/v1/sessions/s1/permission", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "host_unavailable",
            message: "Policy reload unavailable",
          },
        },
      });
    });
    await dialog
      .getByRole("button", { name: "重新载入最新策略", exact: true })
      .click();
    const load = dialog.getByRole("button", {
      name: "确认重新载入并替换草稿",
      exact: true,
    });
    await load.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Policy reload unavailable",
    );
    await expect(json).toHaveValue(draft);
    await expect(load).toBeEnabled();
    await expect(dialog.getByTestId("session-permission-save")).toBeEnabled();
  });

  test("pins open revision across live changes and explicitly reloads actual Session policy", async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    await page.goto("/#/session/s1");
    await page.getByTestId("composer-session-permissions").click();
    const dialog = page.getByTestId("session-permissions");
    await dialog
      .getByRole("button", { name: "高级权限 JSON", exact: true })
      .click();
    const json = dialog.getByRole("textbox", { name: "高级权限 JSON" });
    const opened = JSON.parse(await json.inputValue());
    const latest = {
      revision: 4,
      config: {
        review: false,
        initialization: "ask",
        overrides: [
          {
            tool: { kind: "glob", value: "file_*" },
            action: "allow",
          },
        ],
      },
    };
    backend.snapshot().permission = latest;
    backend.event("permission", latest);
    expect(JSON.parse(await json.inputValue())).toEqual(opened);
    const draft = { ...latest.config, review: true };
    await json.fill(JSON.stringify(draft));
    const newer = {
      revision: 5,
      config: {
        review: false,
        initialization: "ask",
        overrides: [
          {
            tool: { kind: "exact", value: "shell" },
            args: [
              {
                pointer: "/path",
                matcher: { kind: "glob", value: "/assigned/**" },
              },
            ],
            action: "ask",
          },
        ],
      },
    };
    backend.snapshot().permission = newer;
    backend.event("permission", newer);
    await dialog.getByTestId("session-permission-save").click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Permission revision changed",
    );
    expect(JSON.parse(await json.inputValue())).toEqual(draft);
    const writes = () =>
      backend.requests.filter(
        (request) =>
          request.path.endsWith("/permission") && request.method === "PUT",
      );
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.expected_revision).toBe(3);
    backend.snapshot().permission = { ...newer, revision: 6 };
    const reads = () =>
      backend.requests.filter(
        (request) =>
          request.path.endsWith("/permission") && request.method === "GET",
      ).length;
    const before = reads();
    await dialog
      .getByRole("button", { name: "重新载入最新策略", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "确认重新载入并替换草稿", exact: true })
      .click();
    await expect
      .poll(async () => JSON.parse(await json.inputValue()))
      .toEqual({ ...newer.config, review_model: null });
    expect(reads()).toBeGreaterThan(before);
    await dialog.getByTestId("session-permission-save").click();
    await expect.poll(() => writes().length).toBe(2);
    expect(writes()[1].body.expected_revision).toBe(6);
  });
});

test.describe("locale appearance", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("switches language in appearance settings", async ({
    page,
  }, testInfo) => {
    await nativeBackend(page);
    await page.goto("/");
    await page.locator(".user-card-btn").first().click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
    await page.getByRole("button", { name: "界面外观" }).click();
    await expect(page.getByTestId("locale-option-en")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("appearance-locale-zh-1440.png"),
    });
    await page.getByTestId("locale-option-en").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.screenshot({
      path: testInfo.outputPath("appearance-locale-en-1440.png"),
    });
    await page.getByTestId("locale-option-zh-CN").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  });
});
