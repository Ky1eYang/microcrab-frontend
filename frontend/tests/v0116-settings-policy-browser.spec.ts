import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { LIMIT_FIELDS } from "../src/client/settings";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding } from "../src/client/client-tool-controller";

const limits = Object.fromEntries(
  LIMIT_FIELDS.map((field) => [
    field,
    field === "max_output_tokens" ? 4096 : 64,
  ]),
);
function settings(
  overrides = {},
  revision = 1,
  application = "defaults_saved",
) {
  const effective = {
    limits,
    review: true,
    initialization: "allow",
    auto_naming: true,
    auto_compaction: {
      enabled: true,
      turn_threshold: 0.8,
      round_threshold: 0.95,
      headroom_tokens: 0,
    },
  };
  return {
    revision,
    overrides,
    effective,
    desired_effective: effective,
    sources: Object.fromEntries(
      LIMIT_FIELDS.map((field) => [`limits.${field}`, "admin"]),
    ),
    constraints: {
      limits: Object.fromEntries(
        LIMIT_FIELDS.map((field) => [
          field,
          field === "sleep_max_ms" ? 3600000 : 100000000,
        ]),
      ),
    },
    applied_revision: application === "deferred" ? revision - 1 : revision,
    application,
    reason: application === "deferred" ? "Waiting for next Turn" : null,
  };
}
async function openSettings(
  page: import("@playwright/test").Page,
  tab: string,
) {
  if (tab === "模型服务商" || tab === "会话默认设置") {
    const railMenu = page.locator('.shell [data-testid="header-open-rail"]');
    if (await railMenu.isVisible()) await railMenu.click();
    await page.locator('.shell [data-testid="nav-dashboard"]').first().click();
    const dashMenu = page.locator('[data-testid="dashboard"] [data-testid="header-open-rail"]');
    if (await dashMenu.isVisible()) await dashMenu.click();
    await page.getByTestId("dashboard-nav-settings").click();
    const section = tab === "模型服务商" ? "providers" : "defaults";
    await page.getByTestId(`console-settings-tab-${section}`).click();
    return;
  }
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: tab, exact: true }).click();
}

test("user defaults save exact independent limits and reset removes overrides without live application", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  let value = settings();
  const writes: any[] = [];
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      value = settings(body.overrides, value.revision + 1);
    }
    await route.fulfill({ json: value });
  });
  await page.goto("/#session/s1");
  await openSettings(page, "会话默认设置");
  await page.getByTestId("limit-max_processes").fill("2");
  await page.getByTestId("limit-max_execution_buffers").fill("7");
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    expected_revision: 1,
    overrides: { limits: { max_processes: 2, max_execution_buffers: 7 } },
  });
  await page
    .getByRole("button", { name: "重置所有覆盖值", exact: true })
    .click();
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ expected_revision: 2, overrides: {} });
  expect(
    backend.requests.some(
      (request) =>
        request.method === "PUT" &&
        request.path.includes("/sessions/s1/settings"),
    ),
  ).toBe(false);
});

test("live Session settings show deferred revision and concrete application reason", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/api/v1/sessions/s1/settings", async (route) =>
    route.fulfill({
      json: settings(
        {},
        route.request().method() === "PUT" ? 2 : 1,
        route.request().method() === "PUT" ? "deferred" : "applied",
      ),
    }),
  );
  await page.goto("/#session/s1");
  await openSettings(page, "当前会话配置");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-application")).toContainText(
    "等待生效",
  );
  await expect(page.getByTestId("settings-application")).toContainText(
    "Waiting for next Turn",
  );
  await expect(page.getByTestId("settings-revisions")).toContainText(
    "期望版本 2 · 已应用版本 1",
  );
});

test("Provider credential writes never read back and discovery is distinct from metadata refresh", async ({
  page,
}) => {
  await nativeBackend(page);
  let provider = {
    id: "user:mine",
    scope: "user",
    revision: 1,
    read_only: false,
    name: "Mine",
    protocol: "openai-compatible",
    endpoint: "https://provider.example/v1",
    auth: "bearer",
    timeout_ms: 60000,
    max_response_bytes: 1048576,
    models: [],
    discovered: [],
    api_key_configured: true,
  };
  const writes: any[] = [];
  let discoveries = 0;
  await page.route("**/api/v1/providers", async (route) =>
    route.fulfill({ json: { items: [provider] } }),
  );
  await page.route("**/api/v1/providers/user%3Amine", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      provider = {
        ...provider,
        ...body.provider,
        revision: provider.revision + 1,
      };
    }
    await route.fulfill({ json: provider });
  });
  await page.route(
    "**/api/v1/providers/user%3Amine/discover",
    async (route) => {
      discoveries++;
      await route.fulfill({ json: provider });
    },
  );
  await page.goto("/#session/s1");
  await openSettings(page, "模型服务商");
  await expect(page.locator('[data-provider-id="user:mine"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByTestId("provider-secret")).toHaveCount(0);
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty("api_key");
  await page
    .getByRole("combobox")
    .filter({ has: page.locator('option[value="replace"]') })
    .selectOption("replace");
  await page.getByTestId("provider-secret").fill("new-secret-value");
  await page.getByTestId("provider-save").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].api_key).toBe("new-secret-value");
  expect(writes[1].provider).not.toHaveProperty("api_key");
  await expect(page.getByTestId("provider-secret")).toHaveCount(0);
  await page.getByTestId("provider-discover").click();
  await expect.poll(() => discoveries).toBe(1);
  await expect(page.getByTestId("providers-settings")).not.toContainText(
    "new-secret-value",
  );
});

const executor: ClientBinding = {
  role: "executor",
  lease_id: "lease_review",
  catalog_digest: "review",
  definitions: CLIENT_TOOL_DEFINITIONS,
  calls: [],
  pending: [],
};

test("review grace updates deadline but leaves accepted user decision authoritative", async ({
  page,
}) => {
  const request = {
    request_id: "ask-review",
    parent_session_id: "s1",
    session_id: "child",
    owning_session_id: "child",
    controller_id: 7,
    call_id: "call",
    agent: "coding",
    mode: "execute",
    tool: "shell",
    arguments: { command: "echo hi" },
    revision: 1,
    phase: "waiting_user" as const,
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 1000,
  };
  const backend = await nativeBackend(page, {
    clientTools: executor,
    permissionRequests: [request],
  });
  await page.goto("/#session/s1");
  await expect(page.getByTestId("permission-request")).toBeVisible();
  backend.event("permission.updated", {
    request: {
      ...request,
      phase: "review_grace",
      expires_at_ms: Date.now() + 5000,
      review: { action: "deny", reason: "review reason" },
    },
  });
  await expect(page.getByTestId("permission-review")).toContainText(
    "review reason",
  );
  await expect(page.getByTestId("permission-review-countdown")).toContainText(
    "用户选择优先",
  );
  await page.getByRole("button", { name: "允许本次", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.filter(
          (command) => command.method === "permission.reply",
        ).length,
    )
    .toBe(1);
  expect(
    backend.commands.find((command) => command.method === "permission.reply")
      ?.params,
  ).toEqual({
    request_id: "ask-review",
    lease_id: "lease_review",
    decision: "allow",
  });
});

test("future grant has independent countdown, exact scope and timeout never accepts", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { clientTools: executor });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  backend.event("permission.proposal.requested", {
    proposal: {
      proposal_id: "future-1",
      parent_session_id: "s1",
      session_id: "child",
      controller_id: 7,
      revision: 1,
      agent: "coding",
      mode: "execute",
      tool: "read",
      args: [
        { pointer: "/path", matcher: { kind: "regex", value: "docs/.*" } },
      ],
      created_at_ms: Date.now(),
      expires_at_ms: Date.now() + 1000,
    },
  });
  const dialog = page.getByTestId("permission-proposal");
  await expect(dialog).toContainText("当前操作已获准并独立继续");
  await expect(dialog).toContainText("child");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 3000 });
  expect(
    backend.commands.filter(
      (command) => command.method === "permission.proposal.reply",
    ),
  ).toHaveLength(0);
});

test("Project references persist PersonalLibrary mounts then refresh only the explicit selected Session", async ({
  page,
}) => {
  await nativeBackend(page);
  const refA = "ref_0123456789aaaaaa";
  const refB = "ref_0123456789bbbbbb";
  let saved = {
    project_id: "project-1",
    ref_ids: [refA],
    items: [
      {
        id: refA,
        title: "AGENTS.md",
        source_kind: "shortcut_host_path",
        source: { type: "host_path", path: "AGENTS.md" },
        media_type: "text/markdown",
        revision: "1_a",
        read_only: false,
        created_at_unix_ms: 1,
        updated_at_unix_ms: 1,
        mounted_sessions: [],
        mounted_projects: ["project-1"],
      },
    ],
  };
  const writes: any[] = [];
  const refreshes: any[] = [];
  await page.route("**/api/v1/users/u1/library/objects**", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        json: {
          id: refB,
          title: "docs/guide.md",
          source_kind: "shortcut_host_path",
          source: {
            kind: "shortcut",
            target: { type: "host_path", path: "docs/guide.md" },
          },
          media_type: "text/markdown",
          revision: "1_b",
          read_only: false,
          created_at_unix_ms: 2,
          updated_at_unix_ms: 2,
          mounted_sessions: [],
          mounted_projects: [],
        },
      });
    }
    return route.fulfill({
      json: {
        items: saved.items,
        quota: {
          used_bytes: 0,
          max_bytes: 256 * 1024 * 1024,
          object_count: 1,
          max_entries: 2048,
        },
      },
    });
  });
  await page.route("**/api/v1/projects/project-1/references", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      writes.push(body);
      saved = { ...saved, ref_ids: body.ref_ids };
    }
    await route.fulfill({ json: saved });
  });
  await page.route(
    "**/api/v1/sessions/s1/references/refresh",
    async (route) => {
      refreshes.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          project_revision: 0,
          applied: true,
          boundary: "next_state_patch",
        },
      });
    },
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  const folder = page.locator(".rail-project-folder").first();
  await folder.locator(".rail-project-row").hover();
  await folder.locator(".rail-project-more-btn").click();
  await page.getByTestId("project-menu-settings").click();
  await page.getByTestId("project-settings-tab-references").click();
  await expect(page.getByTestId("project-ref-row")).toContainText("AGENTS.md");
  await page.getByLabel("路径", { exact: true }).fill("docs/guide.md");
  await page.getByRole("button", { name: "添加参考源", exact: true }).click();
  await page.getByTestId("project-ref-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    ref_ids: [refA, refB],
  });
  expect(refreshes).toHaveLength(0);
  await page.getByTestId("project-ref-refresh").click();
  await expect.poll(() => refreshes.length).toBe(1);
  expect(refreshes[0]).toEqual({});
});
