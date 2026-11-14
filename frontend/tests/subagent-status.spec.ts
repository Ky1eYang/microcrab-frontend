import { expect, test } from "@playwright/test";
import { applySnapshot } from "../src/client/projector";
import { childDisplayStatus } from "../src/features/tool-status";
import { nativeBackend } from "./native-fixture";
import { subagentSnapshot } from "./subagent-fixture";
import type { NativeExecution, NativeSnapshot } from "../src/client/types";

test("child display mapping keeps cancelled/interrupted distinct and never infers success", () => {
  expect(childDisplayStatus(undefined)).toBe("unknown");
  expect(childDisplayStatus("")).toBe("unknown");
  expect(childDisplayStatus("weird")).toBe("unknown");
  expect(childDisplayStatus("idle")).toBe("idle");
  expect(childDisplayStatus("pending")).toBe("loading");
  expect(childDisplayStatus("running")).toBe("running");
  expect(childDisplayStatus("cancelling")).toBe("cancelling");
  expect(childDisplayStatus("succeeded")).toBe("succeeded");
  expect(childDisplayStatus("failed")).toBe("failed");
  expect(childDisplayStatus("cancelled")).toBe("cancelled");
  expect(childDisplayStatus("interrupted")).toBe("interrupted");
});

test("execution-bound child projection preserves each terminal outcome", () => {
  const expected: Record<string, string> = {
    running: "running",
    waiting: "running",
    cancelling: "cancelling",
    succeeded: "completed",
    failed: "failed",
    cancelled: "cancelled",
    interrupted: "interrupted",
    mystery: "unknown",
  };
  for (const [status, projected] of Object.entries(expected)) {
    const block = applySnapshot(subagentSnapshot(status)).blocks.find(
      (b) => b.callId === "delegate-call",
    )!;
    expect(block.tool?.status, status).toBe(projected);
  }
});

for (const [status, label, kind] of [
  ["cancelled", "已取消", "cancelled"],
  ["interrupted", "已中断", "interrupted"],
  ["failed", "失败", "failed"],
  ["succeeded", "完成", "succeeded"],
  ["running", "执行中", "running"],
] as const)
  test(`subagent group row shows ${status} with readable label and no false check`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    Object.assign(backend.snapshot(), subagentSnapshot(status));
    await page.goto("/#session/s1");
    await page
      .locator(".subagent-accordion-group .tool-accordion-group-header")
      .click();
    const row = page.locator(".subagent-group-item");
    const state = row.getByTestId("subagent-item-status");
    await expect(state).toHaveAttribute("data-status", kind);
    await expect(state).toHaveText(label);
    if (kind !== "succeeded")
      await expect(row.locator(".subagent-status-dot-sm.completed")).toHaveCount(0);
  });

test("child card without any status fact is unknown, not completed", async () => {
  const { subagentCardRawStatus } = await import("../src/features/views");
  const base = {
    id: "b",
    kind: "child",
    role: "assistant",
    stream: "complete",
    payload: { text: "worker" },
    tool: { name: "task", input: {} },
  } as any;
  expect(childDisplayStatus(subagentCardRawStatus(base))).toBe("unknown");
  expect(
    childDisplayStatus(subagentCardRawStatus({ ...base, stream: "streaming" })),
  ).toBe("running");
  expect(
    childDisplayStatus(
      subagentCardRawStatus({ ...base, payload: { text: "worker · cancelled" } }),
    ),
  ).toBe("cancelled");
});
