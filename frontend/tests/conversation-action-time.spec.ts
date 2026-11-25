import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import {
  binding,
  canonical,
  chunk,
  message,
  snapshot,
  terminal,
} from "./display-graph-inputs";
import type { NativeDisplayRecord } from "../src/client/types";

test.use({ locale: "en-GB", timezoneId: "Asia/Kolkata" });

const sourceFinish = new Date("2026-11-08T10:23:13Z");

function pushRecord(
  backend: Awaited<ReturnType<typeof nativeBackend>>,
  record: NativeDisplayRecord,
) {
  backend.event("display.batch", {
    history_lineage: "selected",
    after: 0,
    scanned_through: record.sequence,
    high_water: record.sequence,
    next_cursor: null,
    coverage: "available",
    records: [record],
  });
}

test("untimed Assistant history is unknown and user fallback is unchanged through reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  const start = new Date("2026-11-08T10:00:00Z");
  await page.clock.setFixedTime(start);
  await page.goto("/#session/s1");
  const user = page.locator(".user-action-bar .message-time-label");
  const answer = page.locator(".assistant-action-bar .message-time-label");
  await expect(user).toHaveAttribute("data-time-source", "browser");
  await expect(user).toHaveAttribute("datetime", start.toISOString());
  await expect(user).toHaveAttribute("title", "2026-11-08 15:30:00 UTC+05:30");
  await expect(answer).toHaveText("Time unknown");
  await expect(answer).not.toHaveAttribute("datetime", /./);

  const next = new Date("2026-11-08T10:10:00Z");
  await page.clock.setFixedTime(next);
  backend.snapshot().session.revision++;
  backend.snapshot().messages[1].text = "Updated history";
  backend.publish(backend.snapshot());
  await expect(
    page.getByText("Updated history", { exact: true }),
  ).toBeVisible();
  await expect(user).toHaveAttribute("datetime", start.toISOString());
  await expect(answer).toHaveAttribute("data-time-source", "unknown");
  await page.reload();
  await expect(user).toHaveAttribute("datetime", next.toISOString());
  await expect(answer).toHaveAttribute("data-time-source", "unknown");
});

test("the unknown-time label is localized in Chinese", async ({ page }) => {
  await nativeBackend(page);
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "zh-CN"),
  );
  await page.goto("/#session/s1");
  await expect(
    page.locator(".assistant-action-bar .message-time-label"),
  ).toHaveText("时间未知");
});

test("the last admitted response can be tool-only or untimed; tool results do not own the clock", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const view = backend.snapshot();
  view.messages[1].response_completed_at_ms = 1794132000000;
  const call = message("tool-only", "assistant", "", {
    position: { epoch: 0, turn: 1, round: 2 },
    tool_calls: [{ id: "timed-tool", name: "read", arguments: {} }],
    response_completed_at_ms: sourceFinish.getTime(),
  });
  view.messages.push(
    call,
    message("result", "tool", "result body", {
      position: call.position,
      call_id: "timed-tool",
      response_completed_at_ms: 1794132001234,
    }),
  );
  await page.goto("/#session/s1");
  const time = page.locator(".assistant-action-bar .message-time-label");
  await expect(time).toHaveCount(1);
  await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
  backend.event("tool", {
    execution_id: 23,
    call_id: "timed-tool",
    name: "read",
    phase: "completed",
    operation_id: "timed-operation",
    ...call.position,
    started_at_unix_ms: 1794132000000,
    elapsed_ms: 1234,
  });
  await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
  view.session.revision++;
  view.messages.push(
    message("untimed", "assistant", "Newer untimed response", {
      position: { epoch: 0, turn: 1, round: 3 },
    }),
  );
  backend.publish(view);
  await expect(
    page.getByText("Newer untimed response", { exact: true }),
  ).toBeVisible();
  await expect(time).toHaveAttribute("data-time-source", "unknown");
  await expect(time).not.toHaveAttribute("datetime", /./);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`delayed admission clock does not settle the spinner and survives handoff (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const backend = await nativeBackend(page);
    const history = message("first-answer", "assistant", "Historical answer");
    const question = message("new-prompt", "user", "A distinct prompt", {
      position: { epoch: 0, turn: 2, round: 0 },
    });
    const view = backend.snapshot();
    const rows = [
      message("old-prompt", "user", "Old question"),
      history,
      question,
    ];
    Object.assign(view, snapshot(rows));
    view.session.status = "idle";
    const start = new Date("2026-11-08T10:00:00Z");
    await page.clock.setFixedTime(start);
    await page.goto("/#session/s1");
    const historyTime = page
      .locator(".assistant-turn")
      .filter({ hasText: "Historical answer" })
      .locator(".message-time-label");
    await expect(historyTime).toHaveAttribute("data-time-source", "unknown");

    const receipt = {
      id: "active-answer",
      session_id: "s1",
      method: "turn.submit",
      status: "running",
      updated_at_ms: start.getTime(),
    };
    backend.event("turn", receipt);
    backend.event("session", { ...view.session, status: "running" });
    const progress = page.locator(
      ".assistant-action-bar .message-action-progress",
    );
    await expect(progress).toHaveCount(0);
    // Replay placement anchors the live graph after the exact current input.
    pushRecord(backend, canonical(1, "new-prompt-node", null, question));
    pushRecord(
      backend,
      chunk(2, "live-answer", "new-prompt-node", "text", "Live answer prefix", {
        extra: {
          operation_id: receipt.id,
          turn: 2,
          response_completed_at_ms: 1,
        },
      }),
    );
    const output = page
      .locator(".assistant-turn")
      .filter({ hasText: "Live answer prefix" });
    await expect(output.locator(".message-action-progress")).toBeVisible();
    await expect(progress).toHaveAccessibleName(
      /Answer in progress|正在生成回答/,
    );
    await expect(progress).not.toHaveAttribute("value", /./);
    await expect(progress).toHaveCSS(
      "animation-name",
      reducedMotion === "reduce" ? "none" : "message-action-spin",
    );
    if (reducedMotion === "no-preference") {
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
      expect(
        await progress.evaluate((element) => element.getAnimations().length),
      ).toBe(0);
    }
    await expect(output.locator(".message-time-label")).toHaveCount(0);
    await expect(
      page.locator(".user-action-bar .message-action-progress"),
    ).toHaveCount(0);

    const accepted = message(
      "completed-answer",
      "assistant",
      "Live answer prefix",
      {
        position: { epoch: 0, turn: 2, round: 1 },
      },
    );
    // The provider terminal and foreground receipt are different from admission.
    pushRecord(backend, terminal(3, 0, 18));
    await page.clock.setFixedTime(new Date("2026-11-08T10:29:00Z"));
    const admit = binding(4, ["live-answer"], accepted);
    admit.event.response_completed_at_ms = sourceFinish.getTime();
    pushRecord(backend, admit);
    pushRecord(backend, {
      ...admit,
      sequence: 5,
      event: { ...admit.event, response_completed_at_ms: 123 },
    });
    backend.event("tool", {
      ...accepted.position,
      operation_id: receipt.id,
      call_id: "waiting-call",
      name: "read",
      phase: "started",
      started_at_unix_ms: start.getTime(),
    });
    backend.event("session", { ...view.session, status: "idle" });
    backend.event("turn", { ...receipt, id: "unrelated", status: "completed" });
    await expect(output.locator(".message-action-progress")).toBeVisible();
    await expect(output.locator(".message-time-label")).toHaveCount(0);
    backend.event("turn", {
      ...receipt,
      status: "completed",
      updated_at_ms: Date.parse("2026-11-08T10:47:00Z"),
    });

    const time = output.locator(".message-time-label");
    await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
    await expect(time).toHaveAttribute("data-time-source", "source");
    await expect(time).toHaveAttribute(
      "title",
      "2026-11-08 15:53:13 UTC+05:30",
    );
    backend.event("turn", receipt);
    view.session.revision++;
    view.messages.push({
      ...accepted,
      response_completed_at_ms: sourceFinish.getTime(),
    });
    view.history_view!.end_cursor++;
    view.history_view!.message_count++;
    backend.publish(view);
    await expect(progress).toHaveCount(0);
    await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
    await page.reload();
    await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
    await page.goto("/#new");
    await page.goto("/#session/s1");
    await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
  });
}

test("newer failed preview omits the earlier admitted timestamp", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const view = backend.snapshot();
  view.messages[1].response_completed_at_ms = sourceFinish.getTime();
  await page.goto("/#session/s1");
  await expect(
    page.locator(".assistant-action-bar .message-time-label"),
  ).toHaveAttribute("datetime", sourceFinish.toISOString());
  const producer = {
    call_id: "newer",
    operation_id: "failed-op",
    epoch: 0,
    turn: 1,
    round: 2,
  };
  backend.event("model_observation", {
    ...producer,
    phase: "text_delta",
    text: "Unadmitted preview",
  });
  backend.event("model_observation", {
    ...producer,
    phase: "invalidated",
    reason: "cancelled",
  });
  const turn = page
    .locator(".assistant-turn")
    .filter({ hasText: "Unadmitted preview" });
  await expect(turn.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(turn.locator(".message-time-label")).toHaveCount(0);
});

test("explicit earlier-page fetch projects the canonical completion clock", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const before = [
    message("earlier-question", "user", "Earlier question"),
    message("earlier-answer", "assistant", "Earlier answer", {
      response_completed_at_ms: sourceFinish.getTime(),
    }),
  ];
  const recent = message("recent", "user", "Recent question", {
    position: { epoch: 0, turn: 2, round: 0 },
  });
  const view = backend.snapshot();
  Object.assign(view, snapshot([recent]));
  view.session.status = "idle";
  view.history_view = {
    ...view.history_view!,
    start_cursor: 2,
    end_cursor: 3,
    message_count: 3,
  };
  view.messages_truncated = true;
  view.next_cursor = 2;
  backend.handleBlocks((params) => {
    expect(params.before_cursor).toBe(2);
    return {
      items: before,
      truncated: false,
      next_cursor: null,
      history_view: { ...view.history_view!, start_cursor: 0, end_cursor: 2 },
    };
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByText("Recent question", { exact: true }),
  ).toBeVisible();
  await page.getByTestId("conversation-load-earlier").click();
  const time = page
    .locator(".assistant-turn")
    .filter({ hasText: "Earlier answer" })
    .locator(".message-time-label");
  await expect(time).toHaveAttribute("datetime", sourceFinish.toISOString());
});
