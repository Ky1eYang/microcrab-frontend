import { expect, test } from "@playwright/test";
import { applySnapshot } from "../src/client/projector";
import {
  mergeHistoryPage,
  retainLoadedMessages,
} from "../src/client/loaded-messages";
import type {
  NativeHistoryView,
  NativeMessage,
  NativeSnapshot,
} from "../src/client/types";
import { answerTokenUsage } from "../src/features/views";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const position = (turn: number, round = 1) => ({ epoch: 0, turn, round });
const answer = (id: string, turn = 1, round = 1): NativeMessage => ({
  id,
  role: "assistant",
  text: `Answer ${id}`,
  parts: [],
  tool_calls: [],
  position: position(turn, round),
  // A last-round value is deliberately different from the authoritative Turn.
  usage: { input_tokens: 225615, output_tokens: 77, total_tokens: 225692 },
});
const summary = (
  input: number | null,
  output: number | null,
  sequence = 10,
  turn = 1,
) => ({
  epoch: 0,
  turn,
  tool_calls: 0,
  ordinary_tool_calls: 0,
  delegate_calls: 0,
  usage: {
    input_tokens: input,
    output_tokens: output,
    audit_sequence: sequence,
  },
});
const snapshot = (
  messages: NativeMessage[],
  input: number | null = 10,
  output: number | null = 7,
): NativeSnapshot => ({
  ...nativeSnapshot,
  messages: [
    { ...nativeSnapshot.messages[0], position: position(1) },
    ...messages,
  ],
  operations: [],
  usage: { input_tokens: 90000, output_tokens: 90000, total_tokens: 180000 },
  history_view: {
    lineage: "turn-usage-lineage",
    epoch: 0,
    message_count: messages.length + 1,
    start_cursor: 0,
    end_cursor: messages.length + 1,
    turns: [summary(input, output)],
  },
});
const selected = (source: NativeSnapshot) => {
  const transcript = applySnapshot(source);
  return answerTokenUsage(transcript.blocks, transcript.historyView);
};

test("Turn first input and all-round output survive snapshots without summing fragments or last-round usage", () => {
  const first = answer("first");
  first.tool_calls = [
    { id: "read", name: "read", arguments: {} },
    { id: "list", name: "list", arguments: {} },
  ];
  const source = snapshot([first, answer("last", 1, 2)], 10, 7);
  let transcript = applySnapshot(source);
  for (let i = 0; i < 2; i++) transcript = applySnapshot(source, transcript);
  expect(
    transcript.blocks.filter((block) => block.messageId === "first"),
  ).toHaveLength(3);
  expect(answerTokenUsage(transcript.blocks, transcript.historyView)).toEqual({
    input: 10,
    output: 7,
  });
  const last = transcript.blocks.at(-1)!;
  expect(
    answerTokenUsage(
      [last, { ...last, id: "split", kind: "reasoning" }],
      transcript.historyView,
    ),
  ).toEqual({ input: 10, output: 7 });
});

test("an off-page first round and more than 128 rounds use the full selected Turn summary", () => {
  const source = snapshot([answer("last", 1, 300)], 100, 45000);
  source.history_view = {
    ...source.history_view!,
    message_count: 601,
    start_cursor: 600,
    end_cursor: 601,
  };
  source.messages = source.messages.slice(-1);
  source.messages_truncated = true;
  source.next_cursor = 600;
  expect(selected(source)).toEqual({ input: 100, output: 45000 });
  // Page extent and message usage never replace the native full-Turn aggregate.
  source.messages[0].usage = null;
  expect(selected(source)).toEqual({ input: 100, output: 45000 });
});

test("missing Turn evidence cannot borrow completion, receipt or Session usage", () => {
  const source = snapshot([answer("last")]);
  delete source.history_view;
  expect(selected(source)).toBeNull();
  source.history_view = snapshot([]).history_view;
  source.history_view!.turns = [summary(900, 900, 10, 2)];
  expect(selected(source)).toBeNull();
  source.history_view!.turns = [summary(10, 7), summary(20, 8)];
  expect(selected(source)).toBeNull();
});

test("Turn summary unknowns and zero remain independent without arithmetic fallback", () => {
  expect(selected(snapshot([answer("last")], 0, 0))).toEqual({
    input: 0,
    output: 0,
  });
  expect(selected(snapshot([answer("last")], null, 7))).toEqual({
    input: null,
    output: 7,
  });
  expect(selected(snapshot([answer("last")], 10, null))).toEqual({
    input: 10,
    output: null,
  });
  expect(selected(snapshot([answer("last")], null, null))).toBeNull();
  expect(
    selected(snapshot([answer("last")], -1, Number.MAX_SAFE_INTEGER + 1)),
  ).toBeNull();
});

test("distinct Turns, epochs and failed suffix previews do not change the selected Turn scope", () => {
  const source = snapshot([answer("first"), answer("second", 2)], 10, 7);
  source.history_view!.turns.push(summary(20, 15, 12, 2));
  const transcript = applySnapshot(source);
  const first = transcript.blocks.filter((block) => block.position?.turn === 1);
  const second = transcript.blocks.filter(
    (block) => block.position?.turn === 2,
  );
  expect(answerTokenUsage(first, transcript.historyView)).toEqual({
    input: 10,
    output: 7,
  });
  expect(answerTokenUsage(second, transcript.historyView)).toEqual({
    input: 20,
    output: 15,
  });
  const failed = {
    ...second[0],
    id: "failed",
    position: position(3),
    payload: {
      ...second[0].payload,
      failure: { code: "failed", message: "incomplete" },
    },
  };
  expect(answerTokenUsage([...first, failed], transcript.historyView)).toEqual({
    input: 10,
    output: 7,
  });
  expect(
    answerTokenUsage(
      first.map((block) => ({
        ...block,
        position: { ...block.position!, epoch: 1 },
      })),
      transcript.historyView,
    ),
  ).toBeNull();
});

test("delayed history pages retain newer audit usage while a newer unknown clears stale known counts", () => {
  const previous = snapshot([answer("last")]);
  previous.history_view!.turns[0] = summary(10, 7, 30);
  const page = (turn: NativeHistoryView["turns"][number]) => ({
    items: previous.messages,
    history_view: { ...previous.history_view!, turns: [turn] },
    truncated: false,
    next_cursor: null,
  });
  const stale = mergeHistoryPage(previous, page(summary(10, 3, 20)))!;
  expect(selected(stale)).toEqual({ input: 10, output: 7 });
  const unknown = mergeHistoryPage(stale, page(summary(null, null, 40)))!;
  expect(selected(unknown)).toBeNull();
  const recovered = mergeHistoryPage(unknown, page(summary(10, 9, 50)))!;
  expect(selected(recovered)).toEqual({ input: 10, output: 9 });
  const changed = {
    ...previous,
    history_view: {
      ...previous.history_view!,
      lineage: "other",
      turns: [summary(90, 99, 1)],
    },
  };
  expect(selected(retainLoadedMessages(changed, recovered))).toEqual({
    input: 90,
    output: 99,
  });
});

test("browser badge shows all-round Turn output and first input through updates, partial pages and reload", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  Object.assign(
    backend.snapshot(),
    snapshot([answer("first"), answer("last", 1, 2)]),
  );
  await page.goto("/#session/s1");
  const bar = page.locator(".assistant-action-bar");
  const badge = bar.getByTestId("answer-token-usage");
  const details = (input: string, output: string) =>
    `本次提问首次输入：${input} tokens\n本次提问累计输出：${output} tokens`;
  await expect(badge).toHaveText("7 tokens");
  await expect(bar.getByTitle("复制回答")).toHaveCount(1);
  await page.getByText("Answer last", { exact: true }).hover();
  await badge.hover();
  await expect(badge).toHaveAttribute("title", details("10", "7"));
  await page.reload();
  await expect(badge).toHaveText("7 tokens");
  const update = (
    input: number | null,
    output: number | null,
    sequence: number,
  ) => {
    backend.snapshot().history_view!.turns[0] = summary(
      input,
      output,
      sequence,
    );
    backend.publish(backend.snapshot());
  };
  update(10, null, 11);
  await expect(badge).toHaveText("- tokens");
  await expect(badge).toHaveAttribute("title", details("10", "-"));
  update(null, 7, 12);
  await expect(badge).toHaveText("7 tokens");
  await expect(badge).toHaveAttribute("title", details("-", "7"));
  update(0, 0, 13);
  await expect(badge).toHaveText("0 tokens");
  update(null, null, 14);
  await expect(badge).toHaveCount(0);
  const toolOnly = answer("tool-only", 1, 3);
  toolOnly.text = null;
  toolOnly.tool_calls = [{ id: "tool-round", name: "read", arguments: {} }];
  backend.snapshot().messages.push(toolOnly);
  backend.snapshot().history_view!.message_count++;
  backend.snapshot().history_view!.end_cursor++;
  update(10, 15, 15);
  await expect(badge).toHaveText("15 tokens");
  await expect(badge).toHaveAttribute("title", details("10", "15"));
  // Reload only the last round: first input and prior output are still in the summary.
  backend.snapshot().messages = [toolOnly];
  backend.snapshot().history_view!.start_cursor = 3;
  backend.snapshot().messages_truncated = true;
  backend.snapshot().next_cursor = 3;
  update(5087, 1842, 16);
  await page.reload();
  await expect(badge).toHaveText("1,842 tokens");
  await expect(badge).toHaveAttribute("title", details("5,087", "1,842"));
});
