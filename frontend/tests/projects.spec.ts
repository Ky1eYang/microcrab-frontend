import { connectHostUI } from "./host-fixture";
import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
test("session creation sends only an assigned project and UUID operation identity", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toContainText("Assigned");
  await connectHostUI(page);
  await page.getByLabel("消息", { exact: true }).fill("hello native");
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.requests.find(
          (request) =>
            request.method === "POST" && request.path === "/api/v1/sessions",
        )?.body.project_id,
    )
    .toBe("project-1");
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  const params = backend.requests.find(
    (request) =>
      request.method === "POST" && request.path === "/api/v1/sessions",
  )!.body;
  expect(
    backend.commands.some((command) => command.method === "session.create"),
  ).toBe(false);
  expect(params.component).toBe("component-sha256");
  expect(backend.nativeUrls).toHaveLength(1);
  expect(params.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(params).not.toHaveProperty("host");
  expect(params).not.toHaveProperty("path");
  expect(params).not.toHaveProperty("clientWorkspace");
});

test("uncertain HTTP create refreshes the list and blocks accidental resubmission", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const creations: any[] = [];
  await page.route("**/api/v1/sessions", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creations.push(route.request().postDataJSON());
    return route.abort("connectionreset");
  });
  await page.goto("/");
  await connectHostUI(page);
  const before = backend.requests.filter(
    (request) =>
      request.path === "/api/v1/sessions" && request.method === "GET",
  ).length;
  await page.getByLabel("消息", { exact: true }).fill("create once");
  await page.getByTitle("发送 (Enter)").click();
  await expect(page.locator(".toast-body")).toContainText("会话创建结果未知");
  expect(
    backend.requests.filter(
      (request) =>
        request.path === "/api/v1/sessions" && request.method === "GET",
    ).length,
  ).toBeGreaterThan(before);
  await page.getByLabel("消息", { exact: true }).fill("create once");
  await page.getByTitle("发送 (Enter)").click();
  await expect(page.locator(".toast-body")).toContainText("会话创建结果未知");
  expect(creations).toHaveLength(1);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
});
