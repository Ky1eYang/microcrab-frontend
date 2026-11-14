import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };

const position = { epoch: 0, turn: 1, round: 2 };
const identity = {
  operation_id: "thought-execution-budget",
  call_id: "budget-provider-call",
  ...position,
};
const thoughtTail = "END OF RETAINED BUDGET THOUGHT";
const thoughtPrefix = "Reasoning before retained execution results.\n";
const thoughtFill = "Reasoning must survive execution hydration.\n";
const thought =
  thoughtPrefix +
  thoughtFill
    .repeat(Math.ceil((40 * 1024) / thoughtFill.length))
    .slice(0, 40 * 1024 - thoughtPrefix.length - thoughtTail.length) +
  thoughtTail;
const executions = [31, 32].map((executionId, index) => {
  const tail = `END OF COMPLETE EXECUTION ${executionId}`;
  const prefix = `Retained result ${executionId}\n`;
  const size = 115 * 1024;
  const fill = "Readable retained execution output.\n";
  return {
    executionId,
    callId: `budget-tool-${index + 1}`,
    name: `budget_read_${index + 1}`,
    tail,
    result:
      prefix +
      fill
        .repeat(Math.ceil(size / fill.length))
        .slice(0, size - prefix.length - tail.length) +
      tail,
  };
});

async function output(page: Page, name: string) {
  const row = page.getByTestId("tool-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  return row.locator("..").getByTestId("tool-payload-output");
}

for (const streamedCalls of [true, false]) {
  test(`hydrated execution results cannot erase completed THOUGHT (${streamedCalls ? "streamed call deltas" : "metadata-only calls"})`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page, {
      extraMethods: ["executions.content"],
    });
    const snapshot = backend.snapshot();
    snapshot.session.status = "running";
    snapshot.messages[0].position = { ...position, round: 0 };
    snapshot.messages[1].position = { ...position, round: 1 };
    snapshot.history_view = {
      lineage: "thought-execution-budget-lineage",
      epoch: 0,
      start_cursor: 0,
      end_cursor: snapshot.messages.length,
      message_count: snapshot.messages.length,
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
    const resultReads: string[] = [];
    await page.route(
      "**/api/v1/sessions/s1/executions/*/content?*",
      async (route) => {
        const url = new URL(route.request().url());
        const executionId = Number(url.pathname.split("/").at(-2));
        const execution = executions.find(
          (item) => item.executionId === executionId,
        )!;
        const field = url.searchParams.get("field")!;
        const cursor = Number(url.searchParams.get("cursor"));
        const maxBytes = Number(url.searchParams.get("max_bytes"));
        const source =
          field === "arguments"
            ? JSON.stringify({ path: `fixture-${executionId}` })
            : execution.result;
        const next = Math.min(cursor + maxBytes, source.length);
        if (field === "result") resultReads.push(`${executionId}:${cursor}`);
        await route.fulfill({
          json: {
            session_id: "s1",
            execution_id: executionId,
            call_id: execution.callId,
            field,
            content: source.slice(cursor, next),
            cursor,
            next_cursor: next,
            end_cursor: source.length,
            revision: 1,
            source_hash: `${executionId}-${field}-source`,
            available: true,
          },
        });
      },
    );
    await page.goto("/#session/s1");
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    backend.event("model_observation", { ...identity, phase: "started" });
    backend.event("model_observation", {
      ...identity,
      phase: "reasoning_delta",
      text: thought,
    });
    const block = page.getByTestId("think-block");
    await expect(block).toHaveAttribute("data-streaming", "true");
    await expect(block).toContainText(thoughtTail);
    if (streamedCalls) {
      for (const [index, execution] of executions.entries()) {
        backend.event("model_observation", {
          ...identity,
          phase: "tool_call_delta",
          index,
          id: execution.callId,
          name: execution.name,
          arguments: JSON.stringify({
            path: `fixture-${execution.executionId}`,
          }),
        });
      }
    }
    backend.event("model_observation", {
      ...identity,
      phase: "validated",
      text: "",
    });
    await expect(block).toHaveAttribute("data-streaming", "false");
    await expect(block).toHaveAttribute("data-expanded", "false");
    await expect(
      block.getByText(zh["think.done"], { exact: true }),
    ).toBeVisible();
    for (const execution of executions) {
      // Native progress carries metadata only; retained bodies arrive over HTTP.
      backend.event("tool", {
        operation_id: identity.operation_id,
        ...position,
        execution_id: execution.executionId,
        call_id: execution.callId,
        name: execution.name,
        phase: "completed",
        arguments_available: true,
        result_available: true,
        preview_omitted: true,
      });
    }
    for (const execution of executions) {
      const payload = await output(page, execution.name);
      // The tail is absent from the first 64 KiB page. Wait for the UI, not only
      // the HTTP handler, so the next observation sees fully hydrated results.
      await expect(payload).toContainText(execution.tail);
      await expect(payload).toHaveAttribute("data-variant", "trajectory");
      await payload.locator("pre").evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      await expect
        .poll(() =>
          payload
            .locator("pre")
            .evaluate(
              (body) => body.scrollHeight - body.clientHeight - body.scrollTop,
            ),
        )
        .toBeLessThanOrEqual(1);
      await payload.getByTestId("payload-dialog-expand").click();
      const dialog = page.getByRole("dialog", {
        name: `${execution.name} · ${zh["tools.output"]}`,
        exact: true,
      });
      await expect(dialog).toContainText(execution.tail);
      await expect(
        dialog.getByTestId("content-viewer-copyFormatted"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(payload).toHaveAttribute("data-collapsed", "false");
    }
    expect(resultReads.sort()).toEqual([
      "31:0",
      "31:65536",
      "32:0",
      "32:65536",
    ]);
    // No canonical snapshot has covered this invocation yet. The empty request
    // start is followed by a tiny visible delta to acknowledge event processing.
    backend.event("model_observation", {
      ...identity,
      call_id: "budget-next-provider-call",
      round: 3,
      phase: "started",
    });
    backend.event("model_observation", {
      ...identity,
      call_id: "budget-next-provider-call",
      round: 3,
      phase: "text_delta",
      text: "Next budget round is visible",
    });
    await expect(
      page.getByText("Next budget round is visible", { exact: true }),
    ).toBeVisible();
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-expanded", "false");
    await block.getByRole("button").click();
    await expect(block).toContainText(thoughtTail);
    for (const execution of executions)
      await expect(await output(page, execution.name)).toContainText(
        execution.tail,
      );

    const canonical = structuredClone(snapshot);
    canonical.messages.push({
      id: "budget-canonical-response",
      role: "assistant",
      text: "",
      parts: [],
      position,
      tool_calls: executions.map((execution) => ({
        id: execution.callId,
        name: execution.name,
        arguments: { path: `fixture-${execution.executionId}` },
      })),
    });
    for (const execution of executions) {
      canonical.messages.push({
        id: `budget-canonical-result-${execution.executionId}`,
        role: "tool",
        text: execution.result.slice(0, 8192),
        parts: [],
        tool_calls: [],
        call_id: execution.callId,
        tool_name: execution.name,
        position,
        content_truncated: true,
      });
    }
    canonical.history_view = {
      ...canonical.history_view!,
      end_cursor: canonical.messages.length,
      message_count: canonical.messages.length,
      turns: [
        {
          epoch: 0,
          turn: 1,
          tool_calls: 2,
          ordinary_tool_calls: 2,
          delegate_calls: 0,
        },
      ],
    };
    canonical.session.title = "Budget canonical handoff";
    // Keep future fixture subscriptions consistent with the delivered Hub value.
    Object.assign(snapshot, canonical);
    backend.publish(canonical);
    await expect(
      page.getByText("Budget canonical handoff", { exact: true }).first(),
    ).toBeAttached();
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-streaming", "false");
    await expect(block).toContainText(thoughtTail);
    await expect(page.getByTestId("tool-row")).toHaveCount(2);

    const replacement = structuredClone(canonical);
    replacement.history_view!.lineage = "replacement-budget-lineage";
    Object.assign(snapshot, replacement);
    backend.publish(replacement);
    await expect(block).toHaveCount(0);
    await expect(page.getByTestId("tool-row")).toHaveCount(2);
  });
}
