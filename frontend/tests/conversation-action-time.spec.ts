import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test.use({ locale: "en-GB", timezoneId: "Asia/Kolkata" });

test("user and answer action bars keep browser fallback time through snapshot updates and reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.clock.install({ time: new Date("2026-11-08T10:00:00Z") });
  await page.clock.setFixedTime(new Date("2026-11-08T10:00:00Z"));
  await page.goto("/#session/s1");
  const user = page.locator(".user-action-bar .message-time-label");
  const answer = page.locator(".assistant-action-bar .message-time-label");
  await expect(user).toHaveAttribute("data-time-source", "browser");
  await expect(answer).toHaveAttribute("data-time-source", "browser");
  await expect(user).toHaveText(/\d{1,2}:\d{2}/);
  await expect(answer).toHaveText(/\d{1,2}:\d{2}/);
  const tooltip = "2026-11-08 15:30:00 UTC+05:30";
  await expect(user).toHaveAttribute("title", tooltip);
  await expect(answer).toHaveAttribute("title", tooltip);
  const userTime = await user.getAttribute("datetime");
  const answerTime = await answer.getAttribute("datetime");
  await page.clock.setFixedTime(new Date("2026-11-08T10:10:00Z"));
  backend.snapshot().session.revision++;
  backend.snapshot().messages[1].text = "更新后的历史回答";
  backend.publish(backend.snapshot());
  await expect(
    page.getByText("更新后的历史回答", { exact: true }),
  ).toBeVisible();
  await expect(user).toHaveAttribute("datetime", userTime!);
  await expect(answer).toHaveAttribute("datetime", answerTime!);
  await expect(answer).toHaveAttribute("title", tooltip);
  await page.reload();
  await expect(user).toHaveAttribute("data-time-source", "browser");
  await expect(answer).toHaveAttribute("data-time-source", "browser");
  await expect(answer).not.toHaveAttribute("datetime", answerTime!);
});

test("authoritative tool timing takes priority over browser display fallback", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/#session/s1");
  await expect(
    page.locator(".assistant-action-bar .message-time-label"),
  ).toHaveAttribute("data-time-source", "browser");
  backend.event("tool", {
    execution_id: 23,
    call_id: "timed-tool",
    name: "read",
    phase: "completed",
    operation_id: "timed-operation",
    epoch: 0,
    turn: 1,
    round: 1,
    started_at_unix_ms: 1794132000000,
    elapsed_ms: 1234,
  });
  const sourceTime = page.locator(
    '.assistant-action-bar .message-time-label[data-time-source="source"]',
  );
  await expect(sourceTime).toHaveCount(1);
  await expect(sourceTime).toHaveAttribute(
    "datetime",
    new Date(1794132001234).toISOString(),
  );
  await expect(sourceTime).toHaveAttribute(
    "title",
    /^2026-11-08 \d{2}:\d{2}:01 UTC\+05:30$/,
  );
});
