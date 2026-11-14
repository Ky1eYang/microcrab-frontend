import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

/** No /src imports or store instrumentation: also runs against the compiled artifact. */
test("production browser Host readiness shows exact cause and nonblocking warning through native wire refresh", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const cause = {
    code: "workspace_conflict",
    message: "Native receipt op-42 differs from pinned workspace witness",
    operation_id: "op-42",
  };
  const warning = {
    code: "heartbeat_backpressure",
    message:
      "Host heartbeat send exceeded 2 second deadline; recent inbound traffic keeps the route connected",
  };
  let snapshot: Record<string, unknown> = {
    connection_generation: "1",
    connected: true,
    ready: false,
    reconciling: false,
    phase: "unready",
    cause,
    transport_warning: null,
  };
  let refreshes = 0;
  await page.route("**/api/v1/projects/*/host-reconcile", async (route) => {
    refreshes++;
    await route.fulfill({
      json: {
        connected: snapshot.connected,
        ready: snapshot.ready,
        reconciling: snapshot.reconciling,
        readiness: snapshot,
        reconciliation_error: snapshot.cause,
      },
    });
  });
  await page.goto("/#session/s1");
  await connectHostUI(page);
  await page.getByTestId("header-host-connection").click();
  const refresh = page.getByRole("button", {
    name: "刷新核对与操作记录",
    exact: true,
  });
  await refresh.click();
  await expect(page.getByTestId("host-status")).toContainText(
    "已连接，尚未就绪",
  );
  await expect(page.getByTestId("host-readiness-phase")).toContainText(
    "unready",
  );
  await expect(page.getByTestId("host-public-cause")).toHaveText(
    `${cause.code}: ${cause.message}`,
  );
  await expect(page.getByTestId("host-recovery-guidance")).toContainText(
    "工作区文件与会话历史不一致",
  );
  await expect(page.getByTestId("host-operations")).toContainText(
    "Original outcome unavailable",
  );
  snapshot = {
    ...snapshot,
    ready: true,
    phase: "ready",
    cause: null,
    transport_warning: warning,
  };
  await refresh.click();
  await expect(page.getByTestId("host-status")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.getByTestId("host-public-cause")).toHaveCount(0);
  await expect(page.getByTestId("host-transport-warning")).toHaveText(
    `${warning.code}: ${warning.message}`,
  );
  snapshot = { ...snapshot, transport_warning: null };
  await refresh.click();
  await expect(page.getByTestId("host-transport-warning")).toHaveCount(0);
  await expect(page.getByTestId("host-status")).toHaveAttribute(
    "data-ready",
    "true",
  );
  expect(refreshes).toBe(3);
  expect(
    backend.commands.filter((command) =>
      ["project.detach", "turn.queue", "turn.retry"].includes(command.method),
    ),
  ).toEqual([]);
});
