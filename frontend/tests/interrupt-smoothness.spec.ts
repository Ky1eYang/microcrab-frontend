import { test, expect, type Page } from "@playwright/test";
import { connectHostUI } from "./host-fixture";
import { nativeBackend } from "./native-fixture";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

const identity = {
  operation_id: "op1",
  call_id: "call1",
  epoch: 1,
  turn: 2,
  round: 1,
};

async function streaming(page: Page) {
  const backend = await nativeBackend(page);
  backend.snapshot().session.status = "running";
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  const observe = (phase: string, extra = {}) =>
    backend.event("model_observation", { ...identity, phase, ...extra });
  backend.event("session", {
    ...backend.snapshot().session,
    status: "running",
  });
  observe("started");
  observe("reasoning_delta", { text: "THOUGHT_PREFIX" });
  observe("text_delta", { text: "ANSWER_PREFIX" });
  await expect(page.getByText("ANSWER_PREFIX", { exact: true })).toBeVisible();
  await expect(page.getByTestId("think-block")).toHaveAttribute(
    "data-streaming",
    "true",
  );
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  return { backend, observe };
}

/** Clicks Stop in-page and samples the DOM until the live block reads stopped
 * and the composer offers Send; both are relative to the click. */
async function clickStop(page: Page) {
  return page.evaluate(async () => {
    const stop = document.querySelector<HTMLButtonElement>(
      '[data-testid="composer-stop"]',
    )!;
    const stopped = () =>
      document
        .querySelector('[data-testid="think-block"]')
        ?.getAttribute("data-streaming") === "false";
    const ready = () =>
      !document.querySelector('[data-testid="composer-stop"]') &&
      !!document.querySelector(".composer-send-arrow-btn");
    let stopMs: number | null = null;
    let readyMs: number | null = null;
    let start = 0;
    const sample = () => {
      const now = performance.now() - start;
      if (stopMs === null && stopped()) stopMs = now;
      if (readyMs === null && ready()) readyMs = now;
    };
    // Mutation records are delivered right after the commit that made them.
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    start = performance.now();
    stop.click();
    sample();
    while (
      (stopMs === null || readyMs === null) &&
      performance.now() - start < 2000
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    observer.disconnect();
    return { stopMs, readyMs };
  });
}

test("stop finishes the live blocks at once, drops late deltas and is input-ready before the runtime settles", async ({
  page,
}) => {
  const { backend, observe } = await streaming(page);
  await page.evaluate(() => {
    (globalThis as any).__mcRenderCounts = {};
  });
  const settledBefore = await page
    .getByText("历史回答", { exact: true })
    .evaluate((node) => node.outerHTML);
  const timings = await clickStop(page);
  test.info().annotations.push({
    type: "interrupt-latency",
    description: JSON.stringify(timings),
  });
  console.log(`interrupt latency ${JSON.stringify(timings)}`);
  expect(timings.stopMs).not.toBeNull();
  expect(timings.readyMs).not.toBeNull();
  // No server round trip, refresh or attach precedes either state.
  expect(timings.stopMs!).toBeLessThan(250);
  expect(timings.readyMs!).toBeLessThan(250);
  await expect
    .poll(
      () =>
        backend.commands.filter((c) => c.method === "session.interrupt").length,
    )
    .toBe(1);
  const attaches = backend.sessionSockets.length;
  // The runtime is still winding down: its late deltas are never appended.
  observe("reasoning_delta", { text: "LATE_THOUGHT" });
  observe("text_delta", { text: "LATE_ANSWER" });
  await page.waitForTimeout(150);
  await expect(page.getByText("ANSWER_PREFIX", { exact: true })).toBeVisible();
  await expect(page.getByText(/LATE_/)).toHaveCount(0);
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  const counts = await page.evaluate(
    () => (globalThis as any).__mcRenderCounts as Record<string, number>,
  );
  // Only the stopped live blocks re-rendered; settled history did not.
  for (const id of Object.keys(counts))
    expect(id, `re-rendered ${id}`).toMatch(/^preview:/);
  expect(
    await page
      .getByText("历史回答", { exact: true })
      .evaluate((node) => node.outerHTML),
  ).toBe(settledBefore);
  // Settlement is accepted quietly: no refetch and no rewrite of the shown text.
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  backend.event("turn", { id: "op1", status: "interrupted" });
  await expect(page.getByText("ANSWER_PREFIX", { exact: true })).toBeVisible();
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  expect(backend.sessionSockets.length).toBe(attaches);
});

test("a send during the stop's wind-down waits for settlement instead of joining the paused inbox", async ({
  page,
}) => {
  const { backend } = await streaming(page);
  await page.getByTestId("composer-stop").click();
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  await page.getByLabel("消息", { exact: true }).fill("next prompt");
  await page.getByTitle("发送 (Enter)").click();
  await page.waitForTimeout(150);
  expect(
    backend.commands.filter((c) => c.method === "turn.queue"),
  ).toHaveLength(0);
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await expect
    .poll(
      () => backend.commands.filter((c) => c.method === "turn.queue").length,
    )
    .toBe(1);
});

test("a rejected stop restores the busy composer", async ({ page }) => {
  await streaming(page);
  await page.evaluate(() => {
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && data.includes('"session.interrupt"')) {
        const parsed = JSON.parse(data);
        setTimeout(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                v: 1,
                type: "result",
                request_id: parsed.request_id,
                ok: false,
                error: { code: "unavailable", message: "stop refused" },
              }),
            }),
          ),
        );
        return;
      }
      return original.call(this, data);
    };
  });
  await page.getByTestId("composer-stop").click();
  await expect(page.getByText("stop refused")).toBeVisible();
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(page.getByTestId("think-block")).toHaveAttribute(
    "data-streaming",
    "true",
  );
});

test("repeated sends while Stop settles queue once and navigation cancels the deferred send", async ({
  page,
}) => {
  const { backend } = await streaming(page);
  await page.getByTestId("composer-stop").click();
  await page.getByLabel("消息", { exact: true }).fill("deferred exactly once");
  await page.getByTitle("发送 (Enter)").click();
  await page.getByLabel("消息", { exact: true }).press("Enter");
  await page.getByLabel("消息", { exact: true }).press("Enter");
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  expect(
    backend.commands.find((command) => command.method === "turn.queue").params
      .input.parts[0].text,
  ).toBe("deferred exactly once");
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await page.getByTestId("composer-stop").click();
  await page
    .getByLabel("消息", { exact: true })
    .fill("must stay with departed session");
  await page.getByTitle("发送 (Enter)").click();
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page).not.toHaveURL(/#session\//);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(1);
});

test("Send waiting for Stop expires without submitting later settlement and keeps its draft", async ({
  page,
}) => {
  const { backend } = await streaming(page);
  await page.clock.install();
  await page.getByTestId("composer-stop").click();
  const editor = page.getByLabel("消息", { exact: true });
  await editor.fill("explicit intent may expire");
  await page.getByTitle("发送 (Enter)").click();
  await page.clock.fastForward(10_001);
  await expect(page.locator(".toast-body")).toContainText(
    zh["composer.stopPending"],
  );
  await expect(editor).toHaveValue("explicit intent may expire");
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await page.clock.runFor(30);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
  await expect(editor).toHaveValue("explicit intent may expire");
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
});

test("editing a draft during Stop wait cancels the captured Send intent", async ({
  page,
}) => {
  const { backend } = await streaming(page);
  await page.getByTestId("composer-stop").click();
  const editor = page.getByLabel("消息", { exact: true });
  await editor.fill("captured original intent");
  await page.getByTitle("发送 (Enter)").click();
  await editor.fill("replacement draft requires a new Send");
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(editor).toHaveValue("replacement draft requires a new Send");
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(0);
  await page.getByTitle("发送 (Enter)").click();
  await expect
    .poll(
      () =>
        backend.commands.filter((command) => command.method === "turn.queue")
          .length,
    )
    .toBe(1);
  expect(
    backend.commands.find((command) => command.method === "turn.queue").params
      .input.parts[0].text,
  ).toBe("replacement draft requires a new Send");
});
