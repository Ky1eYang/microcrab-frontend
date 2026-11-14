import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

test("project display names survive connection and confirmed removal deletes its conversations", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    projects: [
      { id: "project-1", name: "Friendly project", root: "/not-the-name" },
      { id: "project-2", name: "Other project", root: "/untouched" },
    ],
  });
  let name = "Friendly project";
  let deleted = false;
  const mutations: { method: string; body: any }[] = [];
  await page.route("**/api/v1/capabilities", async (route) => {
    const methods = [
      "server.capabilities",
      "project.list",
      "project.rename",
      "project.delete",
      "model.list",
      "session.list",
      "session.open",
      "agent.catalog",
    ];
    await route.fulfill({
      json: { protocol: 1, methods, features: {}, limits: {} },
    });
  });
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      json: {
        items: deleted
          ? []
          : [
              { id: "project-1", name, root: "/not-the-name" },
              { id: "project-2", name: "Other project", root: "/untouched" },
            ],
      },
    }),
  );
  await page.route("**/api/v1/projects/project-1", (route) => {
    const method = route.request().method();
    const body = route.request().postDataJSON();
    mutations.push({ method, body });
    if (method === "PATCH") {
      name = body.name;
      return route.fulfill({
        json: { id: "project-1", name, root: "/not-the-name" },
      });
    }
    deleted = true;
    return route.fulfill({ json: { deleted: true, project_id: "project-1" } });
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toHaveText(
    /Friendly project/,
  );
  await connectHostUI(page);
  await expect(page.getByTitle("选择项目工作区")).toHaveText(
    /Friendly project/,
  );
  await page
    .locator(".rail-project-row")
    .filter({ hasText: "Friendly project" })
    .hover();
  await page
    .locator(".rail-project-folder")
    .filter({ hasText: "Friendly project" })
    .locator(".rail-project-more-btn")
    .click();
  await page.getByRole("button", { name: "重命名项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Renamed project");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTitle("选择项目工作区")).toContainText(
    "Renamed project",
  );
  const other = page
    .locator(".rail-project-folder")
    .filter({ hasText: "Other project" });
  await other.locator(".rail-project-row").hover();
  await other.locator(".rail-project-more-btn").click();
  await page
    .getByRole("button", { name: "复制项目工作区路径", exact: true })
    .click();
  // The copied value proves a connection did not overwrite the other project's path.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("/untouched");
  await page
    .locator(".rail-project-row")
    .filter({ hasText: "Renamed project" })
    .hover();
  await page
    .locator(".rail-project-folder")
    .filter({ hasText: "Renamed project" })
    .locator(".rail-project-more-btn")
    .click();
  await page.getByRole("button", { name: /删除项目/ }).click();
  await expect(
    page.getByRole("dialog", { name: "删除项目", exact: true }),
  ).toContainText("将被永久删除且无法恢复");
  expect(mutations.filter((m) => m.method === "DELETE")).toHaveLength(0);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(
    page.locator(".rail-project-title").filter({ hasText: "Renamed project" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "删除项目", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("原生会话", { exact: true })).toHaveCount(0);
  await expect(
    page.locator(".rail-project-title").filter({ hasText: "Other project" }),
  ).toHaveCount(1);
  expect(mutations.map((m) => m.method)).toEqual(["PATCH", "DELETE"]);
  expect(mutations[0].body.project_id).toBe("project-1");
  expect(
    backend.commands.some(
      (c) => c.method === "project.delete" || c.method === "project.rename",
    ),
  ).toBe(false);
});

test("forbidden project removal leaves project and history intact", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/api/v1/projects/project-1", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "forbidden",
          message: "Project permission changed",
        },
      },
    }),
  );
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await page.locator(".rail-project-row").hover();
  await page
    .locator(".rail-project-folder")
    .locator(".rail-project-more-btn")
    .click();
  await page.getByRole("button", { name: /删除项目/ }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".toast-body")).toContainText(
    "Project permission changed",
  );
  await expect(page.locator(".rail-project-title")).toHaveText("Assigned");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
});
