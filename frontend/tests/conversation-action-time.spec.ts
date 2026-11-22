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

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`only exact live output indicates progress and uses its terminal clock (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const backend = await nativeBackend(page);
    const view = backend.snapshot();
    view.messages.push({
      id: "new-prompt",
      role: "user",
      text: "A distinct prompt",
      parts: [],
      tool_calls: [],
      position: { epoch: 0, turn: 2, round: 0 },
    });
    const start = new Date("2026-11-08T10:00:00Z");
    await page.clock.setFixedTime(start);
    await page.goto("/#session/s1");
    const history = page.locator(".assistant-turn").filter({ hasText: "历史回答" });
    const historyTime = history.locator(".message-time-label");
    await expect(historyTime).toHaveAttribute("datetime", start.toISOString());
    const receipt = {
      id: "active-answer",
      session_id: "s1",
      method: "turn.submit",
      status: "running",
      updated_at_ms: start.getTime(),
    };
    backend.event("turn", receipt);
    backend.event("session", { ...view.session, status: "running" });
    const progress = page.getByRole("progressbar").and(page.locator(".message-action-progress"));
    await expect(progress).toHaveCount(0);
    const producer = {
      operation_id: receipt.id,
      call_id: "model-1",
      epoch: 0,
      turn: 2,
      round: 1,
    };
    backend.event("model_observation", {
      ...producer,
      phase: "text_delta",
      text: "Live answer prefix",
    });
    const output = page.locator(".assistant-turn").filter({ hasText: "Live answer prefix" });
    await expect(output.locator(".message-action-progress")).toBeVisible();
    await expect(progress).toHaveCount(1);
    await expect(progress).toHaveAccessibleName(/Answer in progress|正在生成回答/);
    await expect(progress).not.toHaveAttribute("value", /./);
    await expect(progress).toHaveCSS(
      "animation-name",
      reducedMotion === "reduce" ? "none" : "message-action-spin",
    );
    if (reducedMotion === "no-preference") {
      // Seek past the old five-second limit and sample a non-complete rotation.
      const motion = await progress.evaluate((element) => {
        const animation = element.getAnimations()[0];
        animation.pause();
        animation.currentTime = 5_250;
        const quarter = getComputedStyle(element).transform;
        animation.currentTime = 5_500;
        return {
          infinite: animation.effect?.getTiming().iterations === Infinity,
          moving: quarter !== getComputedStyle(element).transform,
        };
      });
      expect(motion).toEqual({ infinite: true, moving: true });
    } else {
      expect(await progress.evaluate((element) => element.getAnimations().length)).toBe(0);
    }
    await expect(output.locator(".message-time-label")).toHaveCount(0);
    await expect(page.locator(".user-action-bar .message-action-progress")).toHaveCount(0);
    await expect(historyTime).toHaveAttribute("datetime", start.toISOString());

    backend.event("model_observation", { ...producer, phase: "validated" });
    backend.event("tool", {
      ...producer,
      call_id: "waiting-call",
      name: "read",
      phase: "started",
      started_at_unix_ms: start.getTime(),
    });
    backend.event("session", { ...view.session, status: "idle" });
    await expect(output.locator(".message-action-progress")).toBeVisible();

    // A reversed receipt and a stale tool phase cannot settle or reopen another output.
    backend.event("turn", { ...receipt, id: "unrelated", status: "completed" });
    await expect(output.locator(".message-action-progress")).toBeVisible();
    const browserFinish = new Date("2026-11-08T10:24:00Z");
    const sourceFinish = new Date("2026-11-08T10:23:13Z");
    await page.clock.setFixedTime(browserFinish);
    backend.event("turn", {
      ...receipt,
      status: "completed",
      ...(reducedMotion === "reduce"
        ? { updated_at_ms: sourceFinish.getTime() }
        : { updated_at_ms: undefined }),
    });
    const time = output.locator(".message-time-label");
    const expected = reducedMotion === "reduce" ? sourceFinish : browserFinish;
    await expect(time).toHaveAttribute("datetime", expected.toISOString());
    await expect(time).toHaveAttribute(
      "data-time-source",
      reducedMotion === "reduce" ? "source" : "browser",
    );
    await expect(time).toHaveAttribute(
      "title",
      reducedMotion === "reduce"
        ? "2026-11-08 15:53:13 UTC+05:30"
        : /(?:Completion observed by this browser: |此浏览器观察到的完成时间：)2026-11-08 15:54:00 UTC\+05:30/,
    );
    backend.event("turn", receipt);
    await expect(progress).toHaveCount(0);
    await expect(historyTime).toHaveAttribute("datetime", start.toISOString());
    await page.clock.setFixedTime(new Date("2026-11-08T10:30:00Z"));
    view.session.revision++;
    view.messages.push({
      id: "completed-answer",
      role: "assistant",
      text: "Canonical answer",
      parts: [],
      tool_calls: [],
      position: producer,
    });
    backend.publish(view);
    const canonical = page.locator(".assistant-turn").filter({ hasText: "Canonical answer" });
    await expect(canonical.locator(".message-time-label")).toHaveAttribute("datetime", expected.toISOString());
    await expect(progress).toHaveCount(0);
  });
}
