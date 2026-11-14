import { expect, test } from "@playwright/test";
import type { NativeSnapshot } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

function history(snapshot: NativeSnapshot, epoch: number) {
  return {
    lineage: "presentation-continuity",
    epoch,
    start_cursor: 0,
    end_cursor: snapshot.messages.length,
    message_count: snapshot.messages.length,
    turns: [],
  };
}

for (const transition of ["first metadata", "forward epoch"] as const) {
  test(`${transition} preserves conversation reading DOM, disclosure and pause without a removal warning`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const snapshot = backend.snapshot();
    snapshot.session.status = "idle";
    snapshot.inbox = { active: false, paused: false, items: [] };
    snapshot.messages = [
      {
        id: "reading-user",
        role: "user",
        text: "Inspect this output",
        parts: [],
        tool_calls: [],
        position: { epoch: 0, turn: 1, round: 0 },
      },
      {
        id: "reading-call",
        role: "assistant",
        text: "",
        parts: [],
        tool_calls: [
          { id: "reading-tool", name: "read_history", arguments: {} },
        ],
        position: { epoch: 0, turn: 1, round: 1 },
      },
      {
        id: "reading-result",
        role: "tool",
        text: "Retained output\n" + "Reading line\n".repeat(90),
        parts: [],
        tool_calls: [],
        call_id: "reading-tool",
        tool_name: "read_history",
        position: { epoch: 0, turn: 1, round: 1 },
      },
      {
        id: "reading-tail",
        role: "assistant",
        text: "Later output\n\n".repeat(100),
        parts: [],
        tool_calls: [],
        position: { epoch: 0, turn: 1, round: 2 },
      },
    ];
    if (transition === "forward epoch")
      snapshot.history_view = history(snapshot, 0);
    else delete snapshot.history_view;
    await page.goto("/#session/s1");
    await page.locator(".tool-accordion-group-header").click();
    const row = page.getByTestId("tool-row");
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await row.evaluate((node) => {
      const host = node.closest<HTMLElement>(".transcript")!;
      host.scrollTop = 40;
      node.focus({ preventScroll: true });
      (window as any).__historyReading = {
        node,
        top: node.getBoundingClientRect().top,
      };
    });
    const next = structuredClone(snapshot);
    next.history_view = history(next, 1);
    backend.publish(next);
    await expect(page.locator("#conversation-transcript")).toHaveAttribute(
      "data-history-epoch",
      "1",
    );
    await expect(page.locator("#conversation-transcript")).toHaveAttribute(
      "data-following",
      "false",
    );
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("history-reading-changed")).toHaveCount(0);
    expect(
      await row.evaluate((node) => ({
        same: node === (window as any).__historyReading.node,
        focused: document.activeElement === node,
        offset:
          Math.abs(
            node.getBoundingClientRect().top -
              (window as any).__historyReading.top,
          ) <= 1,
      })),
    ).toEqual({ same: true, focused: true, offset: true });

    // A same-epoch authoritative rewrite removes the inspected target. Unlike a
    // bounded tail omission, the overlapping removed row emits history.reset.
    const removed = structuredClone(next);
    removed.messages = removed.messages.filter(
      (message) => !["reading-call", "reading-result"].includes(message.id),
    );
    removed.history_view = history(removed, 1);
    backend.publish(removed);
    await expect(page.getByTestId("history-reading-changed")).toBeVisible();
    await expect(row).toHaveCount(0);
  });

  test(`${transition} keeps automatic conversation follow consent`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    const snapshot = backend.snapshot();
    if (transition === "forward epoch")
      snapshot.history_view = history(snapshot, 0);
    else delete snapshot.history_view;
    await page.goto("/#session/s1");
    await expect(page.locator("#conversation-transcript")).toHaveAttribute(
      "data-following",
      "true",
    );
    const next = structuredClone(snapshot);
    next.history_view = history(next, 1);
    backend.publish(next);
    await expect(page.locator("#conversation-transcript")).toHaveAttribute(
      "data-history-epoch",
      "1",
    );
    await expect(page.locator("#conversation-transcript")).toHaveAttribute(
      "data-following",
      "true",
    );
    await expect(page.getByTestId("history-reading-changed")).toHaveCount(0);
  });
}
