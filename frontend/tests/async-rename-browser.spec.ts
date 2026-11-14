import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("optional rename failure does not become a primary response error", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  const operation = {
    version: 1,
    id: "auto-title",
    session_id: "s1",
    owner: "owner",
    method: "session.auto_rename",
    payload_hash: "fixture",
    status: "failed" as const,
    result: {
      error: { code: "auto_naming_failed", message: "Automatic naming failed" },
    },
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
  snapshot.operations = [operation];
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(
    page.getByText("请求未能成功响应", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Automatic naming failed", { exact: false }),
  ).toHaveCount(0);

  // A real failed primary turn must retain the existing visible error behavior.
  snapshot.operations.push({
    ...operation,
    id: "primary-failed",
    method: "turn.submit",
    result: {
      error: { code: "provider_error", message: "Primary provider failure" },
    },
  });
  backend.publish(snapshot);
  await expect(
    page.getByText("Primary provider failure", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Automatic naming failed", { exact: false }),
  ).toHaveCount(0);
});
