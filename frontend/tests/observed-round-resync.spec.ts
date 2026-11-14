import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

async function observedRounds(page: Page) {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.messages[0].position = { epoch: 0, turn: 1, round: 0 };
  snapshot.messages[1].position = { epoch: 0, turn: 1, round: 1 };
  snapshot.history_view = {
    lineage: "observed-round-lineage",
    epoch: 0,
    start_cursor: 0,
    end_cursor: 2,
    message_count: 2,
    turns: [
      {
        epoch: 0,
        turn: 1,
        tool_calls: 0,
        ordinary_tool_calls: 0,
        delegate_calls: 0,
      },
    ],
  };
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  for (const round of [2, 3]) {
    const identity = {
      operation_id: "observed-operation",
      call_id: `observed-call-${round}`,
      epoch: 0,
      turn: 1,
      round,
    };
    backend.event("model_observation", { ...identity, phase: "started" });
    backend.event("model_observation", {
      ...identity,
      phase: "reasoning_delta",
      text: `Retained thinking from round ${round}`,
    });
    backend.event("model_observation", {
      ...identity,
      phase: "text_delta",
      text: `Retained output from round ${round}`,
    });
    backend.event("model_observation", {
      ...identity,
      phase: "validated",
      text: `Retained output from round ${round}`,
    });
  }
  await expect(
    page.getByText("Retained output from round 3", { exact: true }),
  ).toBeAttached();
  await expect(page.getByTestId("think-block")).toHaveCount(2);
  for (const thought of await page.getByTestId("think-block").all()) {
    await expect(thought).toHaveAttribute("data-expanded", "false");
    await thought.getByRole("button").click();
  }
  return backend;
}

for (const trigger of ["gap", "resync"] as const) {
  test(`${trigger} retains observed validated rounds before and after replacement subscription snapshot`, async ({
    page,
  }) => {
    const backend = await observedRounds(page);
    // The resubscribe opens a new session socket; hold its subscribed frame.
    backend.holdNextSubscription();
    if (trigger === "gap")
      backend.event("session", backend.snapshot().session, 2);
    else backend.event("resync_required", {});
    await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
    // Assert during the real resubscribe gap, not only after a fast replacement.
    for (const round of [2, 3]) {
      await expect(
        page.getByText(`Retained thinking from round ${round}`, {
          exact: true,
        }),
      ).toBeAttached();
      await expect(
        page.getByText(`Retained output from round ${round}`, { exact: true }),
      ).toBeAttached();
    }
    const replacement = structuredClone(backend.snapshot());
    replacement.session.title = "Observed round resubscription completed";
    backend.releaseSubscription(0, replacement, {
      subscription_id: "replacement-observation",
      generation: "replacement-generation",
      sequence: 0,
    });
    await expect(
      page
        .getByText("Observed round resubscription completed", { exact: true })
        .first(),
    ).toBeAttached();
    for (const round of [2, 3]) {
      await expect(
        page.getByText(`Retained thinking from round ${round}`, {
          exact: true,
        }),
      ).toBeAttached();
      await expect(
        page.getByText(`Retained output from round ${round}`, { exact: true }),
      ).toBeAttached();
    }
    expect(
      backend.commands.filter((command) =>
        ["turn.submit", "turn.retry", "turn.steer"].includes(command.method),
      ),
    ).toHaveLength(0);
  });
}

test("resync preserves an admitted execution's selected detail DOM while its replacement subscription is pending", async ({
  page,
}) => {
  const backend = await observedRounds(page);
  backend.event("tool", {
    operation_id: "observed-operation",
    epoch: 0,
    turn: 1,
    round: 4,
    call_id: "observed-execution-call",
    execution_id: 7,
    phase: "completed",
    name: "observed_execution",
    arguments: {},
    result: Array.from(
      { length: 70 },
      (_, index) => `Observed execution result line ${index}`,
    ).join("\n"),
  });
  const row = page
    .getByTestId("tool-row")
    .filter({ hasText: "observed_execution" });
  await row.click();
  const body = row
    .locator("..")
    .getByTestId("tool-payload-output")
    .locator("pre");
  await body.focus();
  await body.evaluate((node) => {
    node.scrollTop = 140;
  });
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(140);
  await row.evaluate((node) => {
    const body = node.parentElement!.querySelector(
      '[data-testid="tool-payload-output"] pre',
    )!;
    (window as any).__resyncDetail = {
      row: node,
      body,
      scrollTop: body.scrollTop,
      focus: document.activeElement,
    };
  });
  // The resubscribe opens a new session socket; hold its subscribed frame.
  backend.holdNextSubscription();
  backend.event("resync_required", {});
  await expect.poll(() => backend.pendingSubscriptions.length).toBe(1);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(
    row.locator("..").getByTestId("tool-payload-output"),
  ).toHaveAttribute("data-collapsed", "false");
  expect(
    await row.evaluate((node) => {
      const prior = (window as any).__resyncDetail;
      const body = node.parentElement!.querySelector(
        '[data-testid="tool-payload-output"] pre',
      );
      return {
        row: node === prior.row,
        body: body === prior.body,
        scroll: body?.scrollTop === prior.scrollTop,
        focus: document.activeElement === prior.focus,
      };
    }),
  ).toEqual({ row: true, body: true, scroll: true, focus: true });
  const replacement = structuredClone(backend.snapshot());
  replacement.session.title = "Execution detail resubscription completed";
  backend.releaseSubscription(0, replacement, {
    subscription_id: "replacement-execution",
    generation: "replacement-execution-generation",
    sequence: 0,
  });
  await expect(
    page
      .getByText("Execution detail resubscription completed", { exact: true })
      .first(),
  ).toBeAttached();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  expect(
    await row.evaluate((node) => node === (window as any).__resyncDetail.row),
  ).toBe(true);
});
