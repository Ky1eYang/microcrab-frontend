import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const entries = ["before-A", "delayed-H", "chosen-B", "after-C"];
const message = (name: string, round: number) => ({
  id: `range-message-${round}`,
  role: "assistant" as const,
  text: "",
  parts: [],
  tool_calls: [
    { id: `range-call-${round}`, name: "read", arguments: { path: name } },
  ],
  position: { epoch: 0, turn: 1, round },
});

async function setup(page: Page, hydrate = true) {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.session.status = "running";
  snapshot.messages = entries.map((name, index) => message(name, index + 1));
  snapshot.history_view = {
    lineage: "stable-range",
    epoch: 0,
    message_count: 4,
    start_cursor: 0,
    end_cursor: 4,
    turns: [],
  };
  await page.route("**/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const clock = async (round: number, started: number, duration: number) => {
    backend.event("tool", {
      operation_id: "range-op",
      epoch: 0,
      turn: 1,
      round,
      call_id: `range-call-${round}`,
      name: "read",
      phase: "completed",
      execution_id: round,
      started_at_unix_ms: started,
      elapsed_ms: duration,
    });
    await expect(
      page.locator(
        `[data-testid="trajectory-seg"][data-lane="tool"][data-started-ms="${started}"]`,
      ),
    ).toHaveCount(1);
  };
  if (hydrate) {
    await clock(1, 1000, 100);
    await clock(3, 10000, 100);
    await clock(4, 20000, 100);
  }
  return { backend, snapshot, clock };
}

async function chooseMiddle(page: Page, started: number | null) {
  const segment =
    started == null
      ? page.locator('[data-testid="trajectory-seg"][data-lane="tool"]').nth(2)
      : page.locator(
          `[data-testid="trajectory-seg"][data-lane="tool"][data-started-ms="${started}"]`,
        );
  const box = (await segment.boundingBox())!;
  const timeline = (await page.locator(".trajectory-timeline").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, timeline.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, timeline.y + 4, { steps: 8 });
  await page.mouse.up();
}

test("unclocked selected rows retain their identity as observed clocks arrive", async ({
  page,
}) => {
  const { clock } = await setup(page, false);
  await chooseMiddle(page, null);
  const ledger = page.locator(".trajectory-ledger");
  const selection = page.getByTestId("trajectory-selected-range");
  await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
  await expect(ledger.getByTestId("trajectory-entry")).toContainText(
    "chosen-B",
  );
  expect(await selection.getAttribute("data-started-ms")).toBeNull();
  for (const [round, started, duration] of [
    [1, 1000, 100],
    [2, 3000, 1000],
    [3, 10000, 100],
    [4, 20000, 100],
  ]) {
    await clock(round, started, duration);
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
    await expect(ledger.getByTestId("trajectory-entry")).toContainText(
      "chosen-B",
    );
  }
  const started = Number(await selection.getAttribute("data-started-ms"));
  const ended = Number(await selection.getAttribute("data-ended-ms"));
  expect(started).toBeGreaterThan(10010);
  expect(ended).toBeLessThan(10090);
  expect(ended - started).toBeGreaterThan(40);
  await clock(3, 10000, 200);
  await expect(selection).toHaveAttribute("data-started-ms", String(started));
  await expect(selection).toHaveAttribute("data-ended-ms", String(ended));
});

test("cancelled range gestures cannot be rewritten by later pointer movement", async ({
  page,
}) => {
  await setup(page);
  const segment = (await page
    .locator(
      '[data-testid="trajectory-seg"][data-lane="tool"][data-started-ms="10000"]',
    )
    .boundingBox())!;
  const timeline = page.locator(".trajectory-timeline");
  const box = (await timeline.boundingBox())!;
  await page.mouse.move(segment.x + segment.width * 0.2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(segment.x + segment.width * 0.8, box.y + 4, {
    steps: 8,
  });
  const selection = page.getByTestId("trajectory-selected-range");
  const started = await selection.getAttribute("data-started-ms");
  const ended = await selection.getAttribute("data-ended-ms");
  await timeline.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    bubbles: true,
  });
  await page.mouse.move(box.x + box.width * 0.95, box.y + 4, { steps: 5 });
  await page.mouse.up();
  await expect(selection).toHaveAttribute("data-started-ms", started!);
  await expect(selection).toHaveAttribute("data-ended-ms", ended!);
  await expect(
    page.locator(".trajectory-ledger").getByTestId("trajectory-entry"),
  ).toHaveCount(1);
  await expect(
    page.locator(".trajectory-ledger").getByTestId("trajectory-entry"),
  ).toContainText("chosen-B");
});

for (const update of ["append", "historical-clock"] as const) {
  test(`selected observed interval survives ${update} without freezing the live timeline`, async ({
    page,
  }) => {
    const { backend, snapshot, clock } = await setup(page);
    const ledger = page.locator(".trajectory-ledger");
    const selection = page.getByTestId("trajectory-selected-range");
    await chooseMiddle(page, 10000);
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
    await expect(ledger.getByTestId("trajectory-entry")).toContainText(
      "chosen-B",
    );
    const start = await selection.getAttribute("data-started-ms");
    const end = await selection.getAttribute("data-ended-ms");
    expect(Number(start)).toBeGreaterThan(10000);
    expect(Number(end)).toBeLessThan(10100);
    const before = await selection.boundingBox();
    if (update === "append") {
      snapshot.messages.push(message("appended-D", 5));
      snapshot.history_view = {
        ...snapshot.history_view!,
        message_count: 5,
        end_cursor: 5,
      };
      snapshot.session.revision++;
      backend.publish(snapshot);
      await clock(5, 30000, 10000);
    } else {
      // Filling an earlier idle gap changes the compressed coordinates of B.
      await clock(2, 3000, 1000);
    }
    await expect(selection).toHaveAttribute("data-started-ms", start!);
    await expect(selection).toHaveAttribute("data-ended-ms", end!);
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
    await expect(ledger.getByTestId("trajectory-entry")).toContainText(
      "chosen-B",
    );
    await expect
      .poll(async () => {
        const after = await selection.boundingBox();
        return (
          Math.abs(after!.x - before!.x) +
          Math.abs(after!.width - before!.width)
        );
      })
      .toBeGreaterThan(2);
    // Search composes with the chosen interval, rather than redefining it.
    await page.getByRole("searchbox", { name: "搜索轨迹" }).fill("chosen-B");
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "搜索轨迹" }).fill("after-C");
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(0);
    await page.getByRole("searchbox", { name: "搜索轨迹" }).clear();
    // A background click still clears the range and selects a record by time.
    const track = (await page
      .locator('[data-lane="tool"] > div')
      .boundingBox())!;
    const timeline = (await page
      .locator(".trajectory-timeline")
      .boundingBox())!;
    await page.mouse.click(track.x + track.width * 0.9, timeline.y + 4);
    await expect(selection).toHaveCount(0);
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(
      update === "append" ? 5 : 4,
    );
    await chooseMiddle(page, 20000);
    await expect(selection).toHaveCount(1);
    await expect(ledger.getByTestId("trajectory-entry")).toHaveCount(1);
    await expect(ledger.getByTestId("trajectory-entry")).toContainText(
      "after-C",
    );
  });
}
