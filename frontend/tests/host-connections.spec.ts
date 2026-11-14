import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

test("detached hydration keeps assigned projects and history without catalog or Host access", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  expect(
    backend.requests.some(
      (request) => request.path === "/api/v1/projects/project-1/agents",
    ),
  ).toBe(false);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "未连接",
  );
});
test("expired pairing has a renewal explanation and SSH stays explicitly unsupported", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await page.getByTestId("header-host-connection").click();
  await page.getByLabel("Host WebSocket 地址").fill("ws://127.0.0.1:8788/host");
  await page.getByLabel("一次性配对码", { exact: false }).fill("expired");
  await page
    .getByRole("button", { name: "配对并连接 Host", exact: true })
    .click();
  await expect(page.getByTestId("host-status")).toContainText("配对码已过期");
  await page
    .getByRole("button", { name: "SSH（暂不支持）", exact: true })
    .click();
  await expect(
    page.getByText("SSH 连接暂不支持。", { exact: false }),
  ).toBeVisible();
  expect(
    backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    ),
  ).toHaveLength(1);
});
test("login route redirects authenticated users to the app without auth loop", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
});

test("native WebSocket relay copies bytes through this page and stores no credentials", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  expect(backend.sessionSockets.length).toBeGreaterThan(0);
  const attach = backend.commands.filter(
    (command) => command.method === "host.relay_attach",
  );
  expect(attach).toHaveLength(1);
  expect(attach[0].params).toMatchObject({
    project_id: "project-1",
    url: "ws://127.0.0.1:8788/host",
    token: "test-pair",
  });
  expect(backend.bridges.length).toBeGreaterThan(0);
  const hostBytes = Buffer.from([0, 17, 255, 128]);
  backend.hostSockets.at(-1)!.send(hostBytes);
  await expect
    .poll(() =>
      backend.relayFrames.filter(Buffer.isBuffer).map((frame) => [...frame]),
    )
    .toContainEqual([...hostBytes]);
  const serverBytes = Buffer.from([127, 0, 42, 254]);
  backend.sockets.at(-1)!.send(serverBytes);
  await expect
    .poll(() =>
      backend.relayFrames.filter(Buffer.isBuffer).map((frame) => [...frame]),
    )
    .toContainEqual([...serverBytes]);
  expect(
    backend.requests.filter((request) =>
      request.path.endsWith("/host/connect"),
    ),
  ).toHaveLength(0);
  expect(
    await page.evaluate(() => JSON.stringify(sessionStorage)),
  ).not.toContain("test-resume");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "test-pair",
  );
  await page.reload();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  expect(backend.bridges.length).toBeGreaterThanOrEqual(2);
  expect(
    backend.commands.filter((command) =>
      ["project.attach", "project.detach", "turn.queue"].includes(
        command.method,
      ),
    ),
  ).toEqual([]);
});

test("server-direct gRPC uses HTTP connect and does not open a bridge socket", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await page.getByTestId("header-host-connection").click();
  await page.getByRole("button", { name: "Server 直连", exact: true }).click();
  await expect(
    page.getByText("关闭页面不会断开这条连接", { exact: false }),
  ).toBeVisible();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("gRPC 地址").fill("http://127.0.0.1:8789");
  await dialog.getByRole("button", { name: "连接 Host", exact: true }).click();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  const connects = backend.requests.filter((request) =>
    request.path.endsWith("/host/connect"),
  );
  expect(connects).toHaveLength(1);
  expect(connects[0].body).toMatchObject({ url: "http://127.0.0.1:8789" });
  expect(
    backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    ),
  ).toHaveLength(0);
  expect(backend.bridges).toHaveLength(0);
});

test("creating a project can attach the server-direct address", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await page.getByTitle("选择项目工作区").click();
  await page.getByTestId("picker-create-project").click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Server 直连", exact: true })
    .click();
  await dialog.getByLabel("项目名称", { exact: true }).fill("Direct project");
  await dialog
    .getByLabel("工作目录 (Workspace Directory)", { exact: true })
    .fill("/workspace/direct");
  await dialog.getByLabel("gRPC 地址").fill("http://127.0.0.1:8789");
  await dialog.getByRole("button", { name: "创建并连接", exact: true }).click();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  expect(
    backend.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/projects",
    ),
  ).toHaveLength(1);
  const connects = backend.requests.filter((request) =>
    request.path.endsWith("/host/connect"),
  );
  expect(connects).toHaveLength(1);
  expect(connects[0].path).toContain("/projects/project-new-1/host/connect");
  expect(connects[0].body).toMatchObject({
    url: "http://127.0.0.1:8789",
    directory: "/workspace/direct",
  });
  expect(backend.bridges).toHaveLength(0);
});
