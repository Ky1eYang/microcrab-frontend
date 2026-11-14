import { expect, test, type Route } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("execution refresh keeps inspected body mounted, applies observed text and does not reread immutable arguments", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [
    {
      execution_id: 23,
      session_id: "s1",
      call_id: "c23",
      tool: "reader",
      agent: "universal",
      status: "running",
      started_at_unix_ms: 100,
      capabilities: { input: false },
      output_availability: "none",
      arguments_available: true,
      result_available: true,
    },
  ];
  let argumentsReads = 0;
  const originalText =
    "Observed original result\n" +
    Array.from({ length: 100 }, (_, index) => `retained line ${index}`).join(
      "\n",
    );
  let resultText = originalText;
  let hold = false;
  const pending: Route[] = [];
  const fulfill = async (route: Route) => {
    const field = new URL(route.request().url()).searchParams.get("field");
    if (field === "arguments") argumentsReads++;
    const text = field === "arguments" ? "Immutable arguments" : resultText;
    await route.fulfill({
      json: {
        session_id: "s1",
        execution_id: 23,
        call_id: "c23",
        field,
        content: text,
        cursor: 0,
        next_cursor: text.length,
        end_cursor: text.length,
        revision: 1,
        available: true,
        source_hash: "a".repeat(64),
      },
    });
  };
  await page.route(
    "**/api/v1/sessions/s1/executions/23/content?*",
    async (route) => {
      if (hold) pending.push(route);
      else await fulfill(route);
    },
  );
  await page.goto("/#session/s1");
  await page.getByTestId("header-executions").click();
  await page.getByTestId("header-execution-23").click();
  const peek = page.getByTestId("execution-peek");
  const body = peek
    .locator(".payload-body")
    .filter({ hasText: "Observed original result" });
  await expect(body).toBeVisible();
  await body.evaluate((node) => {
    (node as HTMLElement).focus({ preventScroll: true });
    const host = node.closest(".content-dialog-body")!;
    host.scrollTop = 200;
    const range = document.createRange();
    const textNode = document
      .createTreeWalker(node, NodeFilter.SHOW_TEXT)
      .nextNode()!;
    range.setStart(textNode, 0);
    range.setEnd(textNode, "Observed original result".length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    (window as any).__inspectedExecutionBody = node;
    (window as any).__inspectionScroll = host.scrollTop;
  });
  hold = true;
  const automatic = structuredClone(backend.snapshot());
  automatic.executions![0].elapsed_ms = 1000;
  backend.publish(automatic);
  await expect.poll(() => pending.length).toBe(1);
  await expect(body).toBeVisible();
  expect(
    await body.evaluate((node) => ({
      same: node === (window as any).__inspectedExecutionBody,
      focused: document.activeElement === node,
      selected:
        !window.getSelection()!.isCollapsed &&
        window.getSelection()!.toString() === "Observed original result",
      scroll: Math.abs(
        node.closest(".content-dialog-body")!.scrollTop -
          (window as any).__inspectionScroll,
      ),
    })),
  ).toEqual({ same: true, focused: true, selected: true, scroll: 0 });
  resultText =
    "Observed updated result" +
    originalText.slice("Observed original result".length);
  hold = false;
  await fulfill(pending.shift()!);
  const documentViewer = body.locator(
    "xpath=ancestor::*[@data-testid='content-viewer'][1]",
  );
  await expect(documentViewer).toHaveAttribute("data-paused", "true");
  await expect(body).toHaveText(originalText);
  // Explicit resume adopts new content. Programmatic activation keeps the
  // existing reading focus so native subtree retention remains independently checked.
  await documentViewer
    .getByTestId("content-viewer-resume")
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    peek.locator(".payload-body").filter({ hasText: resultText }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      connected: (window as any).__inspectedExecutionBody.isConnected,
      focused:
        document.activeElement === (window as any).__inspectedExecutionBody,
      scroll: Math.abs(
        (window as any).__inspectedExecutionBody.closest(".content-dialog-body")
          .scrollTop - (window as any).__inspectionScroll,
      ),
    })),
  ).toEqual({ connected: true, focused: true, scroll: 0 });
  expect(argumentsReads).toBe(1);
  const next = structuredClone(backend.snapshot());
  next.history = { checkpoint: "new-linear-head" };
  backend.publish(next);
  await expect(peek).toBeVisible();
  expect(
    await page.evaluate(() => ({
      connected: (window as any).__inspectedExecutionBody.isConnected,
      focused:
        document.activeElement === (window as any).__inspectedExecutionBody,
      scroll: Math.abs(
        (window as any).__inspectedExecutionBody.closest(".content-dialog-body")
          .scrollTop - (window as any).__inspectionScroll,
      ),
    })),
  ).toEqual({ connected: true, focused: true, scroll: 0 });
  expect(argumentsReads).toBe(1);

  // Bounded execution snapshots may omit a row temporarily. When the exact
  // invocation returns, restore its cached arguments without another read.
  const omitted = structuredClone(next);
  omitted.executions = [];
  backend.publish(omitted);
  await expect(peek.getByTestId("execution-peek-refresh")).toBeDisabled();
  await expect(
    peek.getByText("Immutable arguments", { exact: true }),
  ).toHaveCount(0);
  backend.publish(next);
  await expect(
    peek.getByText("Immutable arguments", { exact: true }),
  ).toBeVisible();
  expect(argumentsReads).toBe(1);
});

test("trajectory keeps exact inspected survivor and tab across history authority change but revokes a removed row", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = [
    {
      id: "inspection-result",
      role: "tool",
      text: "Historical observed output",
      parts: [],
      tool_calls: [],
      call_id: "old-call",
      position: { epoch: 0, turn: 1, round: 1 },
    },
  ];
  snapshot.history_view = {
    lineage: "inspection-one",
    epoch: 0,
    message_count: 1,
    start_cursor: 0,
    end_cursor: 1,
    turns: [],
  };
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await page.getByTestId("trajectory-entry").first().click();
  const inspector = page.getByTestId("trajectory-inspector");
  await inspector.getByRole("tab", { name: "结果", exact: true }).click();
  await inspector.evaluate(
    (node) => ((window as any).__inspectedTrajectory = node),
  );
  const forward = structuredClone(snapshot);
  forward.history_view!.epoch = 1;
  backend.publish(forward);
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .locator(".trajectory-view")
      .getByText("历史已变更，当前查看的内容可能已移除。", { exact: true }),
  ).toHaveCount(0);
  const next = structuredClone(forward);
  next.history_view!.lineage = "inspection-two";
  backend.publish(next);
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByRole("tab", { name: "结果", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await inspector.evaluate(
      (node) => node === (window as any).__inspectedTrajectory,
    ),
  ).toBe(true);
  const branch = structuredClone(next);
  branch.history_view!.lineage = "inspection-branch";
  branch.messages[0].id = "another-invocation-result";
  branch.messages[0].text = "Different branch output";
  backend.publish(branch);
  await expect(inspector).toHaveCount(0);
  await expect(
    page
      .locator(".trajectory-view")
      .getByText("历史已变更，当前查看的内容可能已移除。", { exact: true }),
  ).toBeVisible();
});
