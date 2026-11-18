import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ClientBinding, ClientInvocation } from "../src/client/client-tool-controller";

function interaction(tool = "request_secret"): ClientInvocation {
  return { invocation_id: "human-request", parent_session_id: "s1", session_id: "s1", call_id: "human-call",
    tool, arguments: tool === "request_secret"
      ? { reason: "Authenticate the selected service", secrets: [{ key: "TOKEN", label: "Service token" }] }
      : { questions: [{ id: "q", question: "![Scoped preview](picture.png)", options: [{ id: "yes", label: "Accept" }] }], blocking_mode: "deferred" },
    epoch: 0, turn_id: 1, round_id: 1, catalog_digest: "human-catalog", status: "pending",
    interaction: true, blocking_mode: tool === "request_secret" ? "blocking" : "deferred", prepared: true,
    created_at_ms: 1, deadline_ms: 0 };
}
function binding(record: ClientInvocation): ClientBinding {
  return { role: "participant", can_interact: true, participation_id: "exact-pending-reader-capability",
    catalog_digest: record.catalog_digest, definitions: CLIENT_TOOL_DEFINITIONS, calls: [record], pending: [record] };
}

test("participant Secret input is uncontrolled, cleared before settlement and never persisted in browser storage", async ({ page }) => {
  const record = interaction();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const backend = await nativeBackend(page, { clientTools: binding(record),
    extraMethods: ["client_tools.secret", "client_tools.secret_operation", "client_tools.arguments", "client_tools.takeover"],
    sessionCommand: async (command) => {
      if (command.method === "client_tools.secret") {
        await held;
        return { data: { ...record, status: "completed", result: {
          status: "provided", secrets: [{ key: "TOKEN", placeholder: "{{secret:TOKEN}}" }] } } };
      }
      return undefined;
    },
  });
  await page.goto("/#session/s1");
  const input = page.getByLabel("Service token", { exact: true });
  await expect(input).toBeEnabled();
  await input.fill("PRIVATE_BROWSER_SENTINEL");
  expect(await input.evaluate((node) => {
    const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
    return propsKey ? Object.hasOwn((node as any)[propsKey], "value") : false;
  })).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("PRIVATE_BROWSER_SENTINEL");
  await page.getByRole("button", { name: "提供私密值", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeDisabled();
  await expect.poll(() => backend.commands.filter((command) => command.method === "client_tools.secret").length).toBe(1);
  const sent = backend.commands.find((command) => command.method === "client_tools.secret");
  expect(sent?.params).not.toHaveProperty("lease_id");
  expect(sent?.params.values).toEqual({ TOKEN: "PRIVATE_BROWSER_SENTINEL" });
  expect(await page.locator("body").innerText()).not.toContain("PRIVATE_BROWSER_SENTINEL");
  release!();
  await expect(page.getByTestId("secret-request")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("PRIVATE_BROWSER_SENTINEL");
});

test("participant Secret decline sends sanitized result without a secret sideband", async ({ page }) => {
  const backend = await nativeBackend(page, { clientTools: binding(interaction()) });
  await page.goto("/#session/s1");
  await page.getByLabel("Service token", { exact: true }).fill("UNSENT_PRIVATE_VALUE");
  await page.getByRole("button", { name: "拒绝提供", exact: true }).click();
  await expect.poll(() => backend.commands.find((command) => command.method === "client_tools.result")?.params).toEqual({
    invocation_id: "human-request", result: { status: "declined" },
  });
  expect(backend.commands.some((command) => command.method === "client_tools.secret")).toBe(false);
  expect(JSON.stringify(backend.commands)).not.toContain("UNSENT_PRIVATE_VALUE");
});

test("participant question images use exact pending resource capability and revoke on cancellation", async ({ page }) => {
  const record = interaction("ask_user_question");
  const backend = await nativeBackend(page, { clientTools: binding(record) });
  backend.snapshot().history_view = { lineage: "participant-history", epoch: 0, message_count: 2,
    start_cursor: 0, end_cursor: 2, turns: [] };
  let reads = 0;
  await page.route("**/api/v1/sessions/s1/questions/human-request/image?**", async (route) => {
    reads++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("target_session_id")).toBe("s1");
    expect(url.searchParams.get("history_lineage")).toBe("participant-history");
    expect(url.searchParams.get("href")).toBe("picture.png");
    expect(url.href).not.toContain("exact-pending-reader-capability");
    expect(route.request().headers()["x-microcrab-executor-lease"]).toBe("exact-pending-reader-capability");
    await route.fulfill({ contentType: "image/png", body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=", "base64") });
  });
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "加载图片：Scoped preview" }).click();
  await expect(page.locator(".question-body img")).toBeVisible();
  expect(reads).toBe(1);
  backend.event("client_tool.cancel_requested", { call: record });
  await expect(page.locator(".question-body img")).toHaveCount(0);
  expect(backend.commands.some((command) => command.method === "client_tools.arguments")).toBe(false);
});
