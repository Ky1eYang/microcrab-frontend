import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NativeMessage, NativeOperation } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

function rounds(start: number, count: number): NativeMessage[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return [
      {
        id: `upward-user-${index}`,
        role: "user" as const,
        text: `Question ${index}`,
        parts: [],
        tool_calls: [],
        position: { epoch: 1, turn: index + 1, round: 0 },
      },
      {
        id: `upward-answer-${index}`,
        role: "assistant" as const,
        text: Array.from(
          { length: 16 },
          (_, line) => `Answer ${index}, paragraph ${line}.`,
        ).join("\n\n"),
        parts: [],
        tool_calls: [],
        position: { epoch: 1, turn: index + 1, round: 1 },
      },
    ];
  }).flat();
}

function turnReceipt(
  id: string,
  status: NativeOperation["status"],
): NativeOperation {
  return {
    version: 1,
    id,
    session_id: "s1",
    owner: "test",
    method: "turn.submit",
    payload_hash: id,
    status,
    result: null,
    revision: status === "running" ? 1 : 2,
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}

async function wheelAtStart(page: Page, transcript: Locator) {
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  const box = await transcript.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 50);
  await page.mouse.wheel(0, -160);
}

test("upward scrolling reveals resident turns while preserving side navigation", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = rounds(0, 6);
  await page.goto("/#session/s1");
  const transcript = page.locator("#conversation-transcript");
  const navigation = page.getByRole("navigation", { name: "轮次导航" });
  await expect(transcript.locator(".user-turn")).toHaveCount(2);
  await expect(navigation.getByRole("button")).toHaveCount(6);
  await expect(transcript.getByText("Question 0", { exact: true })).toHaveCount(
    0,
  );

  await wheelAtStart(page, transcript);
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  await expect(transcript.getByText("Question 0", { exact: true })).toHaveCount(
    1,
  );
  await expect(navigation.getByRole("button")).toHaveCount(6);
  const firstTurn = navigation.getByRole("button", {
    name: "第 1 轮：Question 0",
  });
  await firstTurn.focus();
  await firstTurn.press("Enter");
  await expect(
    transcript.getByText("Question 0", { exact: true }),
  ).toBeInViewport();
  await expect(
    navigation.getByRole("button", { name: "第 1 轮：Question 0" }),
  ).toHaveAttribute("aria-current", "true");
  expect(
    backend.commands.filter((command) => command.method === "session.blocks"),
  ).toHaveLength(0);
});

test("completion folds older resident Turns once, but later completion does not fold history being read", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.messages = rounds(0, 6);
  snapshot.operations = [turnReceipt("history-turn", "running")];
  // Execution statistics can arrive before Session/inbox busy metadata.
  snapshot.inbox = {
    active: false,
    paused: false,
    pending: [],
    deliveries: [],
  } as unknown as typeof snapshot.inbox;
  const statistics = {
    context: {
      scope: "current_selected_context",
      provenance: "context_budget_json_v1",
      epoch: 1,
      pending_epoch: false,
      fingerprint: "measured",
      bytes: 10,
      limit_bytes: 100,
      remaining_bytes: 90,
      categories: {
        system: 1,
        tools: 1,
        state: 1,
        user: 1,
        assistant: 1,
        tool_result: 1,
        framing: 4,
      },
      counts: {
        items: 12,
        tool_definitions: 0,
        pending_tool_calls: 0,
        state_frames: 1,
        user_messages: 6,
        assistant_messages: 6,
        tool_results: 0,
        tool_calls: 0,
        turns: 6,
        steps: 6,
      },
    },
    activity: {
      scope: "selected_context_history",
      turns: 6,
      steps: 6,
      tool_calls: 0,
      operation: null,
      execution: {
        active: true,
        started_at_ms: 1000,
        ended_at_ms: null as number | null,
        elapsed_ms: 0,
      },
    },
    usage: {
      scope: "append_only_consumption",
      main: {},
      aggregate: {},
      main_cache_hit_rate: null,
      aggregate_cache_hit_rate: null,
    },
    provider: {
      scope: "latest_main_provider_attempt",
      available: false,
      audit_sequence: null,
      latest_prompt: null,
      timing: null,
    },
    model: {
      context_window_tokens: null,
      measured_headroom_tokens: null,
      headroom_reason: "model_window_unknown",
    },
  };
  snapshot.statistics = statistics as unknown as typeof snapshot.statistics;
  await page.goto("/#session/s1");
  const transcript = page.locator("#conversation-transcript");
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  const publish = async (title: string) => {
    snapshot.session.title = title;
    snapshot.session.revision++;
    backend.publish(structuredClone(snapshot));
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  };
  // The previous run's completion can arrive after the next run is busy.
  snapshot.session.status = "running";
  snapshot.inbox!.active = false;
  statistics.activity.execution = {
    active: false,
    started_at_ms: 1000,
    ended_at_ms: 1500,
    elapsed_ms: 500,
  };
  await publish("Busy Session completion observed");
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  // The inbox is an independent busy signal even if Session looks idle.
  snapshot.session.status = "idle";
  snapshot.inbox!.active = true;
  statistics.activity.execution.ended_at_ms = 1600;
  await publish("Busy inbox completion observed");
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  snapshot.inbox!.active = false;
  await publish("Stale completion while idle observed");
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  // A bounded snapshot can omit the active receipt. Idle Session/inbox metadata
  // and later statistics clocks still cannot settle that exact Turn.
  snapshot.operations = [];
  snapshot.inbox!.active = false;
  statistics.activity.execution = {
    active: false,
    started_at_ms: 1000,
    ended_at_ms: 2000,
    elapsed_ms: 1000,
  };
  await publish("Active Turn with idle metadata and stale statistics");
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  snapshot.operations = [turnReceipt("history-turn", "completed")];
  backend.publish(snapshot);
  await expect(transcript.locator(".user-turn")).toHaveCount(2);
  const navigation = page.getByRole("navigation", { name: "轮次导航" });
  await navigation.getByRole("button", { name: "第 1 轮：Question 0" }).click();
  const first = transcript.getByText("Question 0", { exact: true });
  await expect(first).toBeInViewport();
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  const before = (await first.boundingBox())!.y;
  snapshot.messages = rounds(0, 7);
  snapshot.operations = [turnReceipt("history-next-turn", "running")];
  snapshot.inbox!.active = true;
  statistics.activity.execution = {
    active: true,
    started_at_ms: 3000,
    ended_at_ms: null,
    elapsed_ms: 0,
  };
  backend.publish(snapshot);
  await expect(transcript.locator(".user-turn")).toHaveCount(7);
  snapshot.inbox!.active = false;
  snapshot.operations = [turnReceipt("history-next-turn", "completed")];
  statistics.activity.execution = {
    active: false,
    started_at_ms: 3000,
    ended_at_ms: 4000,
    elapsed_ms: 1000,
  };
  backend.publish(snapshot);
  await expect(transcript.locator(".user-turn")).toHaveCount(7);
  await expect(first).toBeInViewport();
  expect(Math.abs((await first.boundingBox())!.y - before)).toBeLessThan(3);
  await page
    .getByRole("button", { name: "滚动回最新消息", exact: true })
    .click();
  backend.publish(snapshot);
  await expect(transcript.locator(".user-turn")).toHaveCount(7);
});

test("upward history loading requests one bounded page and keeps the visible message anchored", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = rounds(4, 2);
  backend.snapshot().messages_truncated = true;
  backend.snapshot().next_cursor = 8;
  backend.snapshot().history_view = {
    lineage: "upward-lineage",
    epoch: 1,
    start_cursor: 8,
    end_cursor: 12,
    message_count: 12,
    turns: [],
  };
  const requests: Record<string, unknown>[] = [];
  let release: (() => void) | undefined;
  backend.handleBlocks((params) => {
    requests.push(params);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          items: rounds(0, 4),
          truncated: false,
          next_cursor: null,
          history_view: {
            lineage: "upward-lineage",
            epoch: 1,
            start_cursor: 0,
            end_cursor: 8,
            message_count: 12,
            turns: [],
          },
        });
    });
  });
  await page.goto("/#session/s1");
  const transcript = page.locator("#conversation-transcript");
  const navigation = page.getByRole("navigation", { name: "轮次导航" });
  await expect(transcript.locator(".user-turn")).toHaveCount(2);
  await expect(navigation.getByRole("button")).toHaveCount(3);
  expect(requests).toHaveLength(0);

  await wheelAtStart(page, transcript);
  await expect.poll(() => requests.length).toBe(1);
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBe(0);
  const anchor = transcript
    .locator(".user-turn")
    .filter({ hasText: "Question 4" });
  const before = await anchor.boundingBox();
  expect(before).not.toBeNull();
  // Further upward gestures while the page is outstanding must share its load.
  await page.mouse.wheel(0, -160);
  await page.mouse.wheel(0, -160);
  await page.mouse.wheel(0, -160);
  expect(requests).toHaveLength(1);
  expect(requests[0].before_cursor).toBe(8);
  expect(requests[0].limit).toBe(64);

  release!();
  await expect(transcript.locator(".user-turn")).toHaveCount(6);
  await expect(navigation.getByRole("button")).toHaveCount(6);
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox())!.y - before!.y))
    .toBeLessThan(3);
  // Navigating remains available after prepending and its turn indexes update.
  const firstTurn = navigation.getByRole("button", {
    name: "第 1 轮：Question 0",
  });
  await firstTurn.focus();
  await firstTurn.press("Enter");
  await expect(
    transcript.getByText("Question 0", { exact: true }),
  ).toBeInViewport();
  await page.mouse.wheel(0, -160);
  expect(requests).toHaveLength(1);
});
