import { expect, test } from "@playwright/test";
import {
  applySnapshot,
  replayDisplayObservations,
} from "../src/client/projector";
import {
  binding,
  canonical,
  chunk,
  emit,
  graphRows,
  graphTranscript,
  message,
  producer,
  snapshot,
  terminal,
} from "./display-graph-inputs";
import { nativeBackend } from "./native-fixture";

test("full Started/Validated stream hands off without legacy duplicate text or losing thinking", () => {
  const user = message("user", "user", "question");
  const answer = message("answer", "assistant", "answer");
  let transcript = graphTranscript();
  emit(transcript, canonical(1, "user-node", null, user));
  emit(transcript, {
    sequence: 2,
    attempt_id: "attempt",
    event: { ...producer, phase: "started" },
  });
  emit(transcript, chunk(3, "thought", "user-node", "reasoning", "think"));
  emit(transcript, chunk(4, "answer-node", "thought", "text", "answer"));
  const completed = terminal(5, 5, 6);
  completed.event.text = "answer";
  emit(transcript, completed);
  emit(transcript, binding(6, ["thought", "answer-node"], answer));
  expect(
    transcript.blocks.filter((block) => block.payload.text === "answer"),
  ).toHaveLength(1);
  const thoughtId = graphRows(transcript).find(
    (block) => block.kind === "reasoning",
  )!.id;
  const canonicalView = snapshot([user, answer]);
  canonicalView.session.status = "idle";
  const priorTranscript = transcript;
  const prior = structuredClone(transcript);
  transcript = applySnapshot(canonicalView, transcript);
  expect(priorTranscript).toEqual(prior);
  expect(
    graphRows(transcript).find((block) => block.kind === "reasoning")!.id,
  ).toBe(thoughtId);
  expect(
    graphRows(transcript).find((block) => block.kind === "reasoning")!.stream,
  ).toBe("complete");
  expect(
    transcript.blocks.filter((block) => block.payload.text === "answer"),
  ).toHaveLength(1);
});

test("incomplete archive suffix remains incomplete across ordinary canonical projection until exact bytes arrive", () => {
  let transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "prefix"));
  emit(transcript, terminal(3, 13, 0));
  const originalId = graphRows(transcript)[0].id;
  expect(graphRows(transcript)[0].validated).toBe(false);
  transcript = applySnapshot(snapshot(), transcript);
  expect(graphRows(transcript)[0].id).toBe(originalId);
  expect(graphRows(transcript)[0].payload.text).toBe("prefix");
  expect(graphRows(transcript)[0].stream).toBe("stopped");
  replayDisplayObservations(transcript, "s1", [
    chunk(2, "thought", null, "reasoning", " suffix", {
      offset: 6,
      first: 1,
      head: false,
    }),
  ]);
  expect(graphRows(transcript)[0].id).toBe(originalId);
  expect(graphRows(transcript)[0].payload.text).toBe("prefix suffix");
  expect(graphRows(transcript)[0].validated).toBe(true);
});

test("browser completion collapses the same thinking node through canonical idle publication", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const user = message("user", "user", "历史提问");
  const answer = message("answer", "assistant", "SECOND_ANSWER");
  Object.assign(backend.snapshot(), snapshot([user]));
  await page.goto("/#session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  const send = (record: ReturnType<typeof chunk>) =>
    backend.event("model_observation", {
      ...record.event,
      archive_sequence: record.sequence,
      attempt_id: record.attempt_id,
    });
  send(canonical(1, "user-node", null, user));
  send({
    sequence: 2,
    attempt_id: "attempt",
    event: { ...producer, phase: "started" },
  });
  send(chunk(3, "thought", "user-node", "reasoning", "FIRST_THOUGHT"));
  send(chunk(4, "answer-node", "thought", "text", "SECOND_ANSWER"));
  const thought = page.getByTestId("think-block");
  await expect(thought).toBeVisible();
  await thought.evaluate((element) => {
    (element as HTMLElement & { retained?: boolean }).retained = true;
  });
  const completed = terminal(5, 13, 13);
  completed.event.text = "SECOND_ANSWER";
  send(completed);
  send(binding(6, ["thought", "answer-node"], answer));
  const view = snapshot([user, answer]);
  view.session.status = "idle";
  backend.event("blocks.page", {
    messages: view.messages,
    history_view: view.history_view,
  });
  backend.event("session.meta", { session: view.session });
  await expect(thought).toHaveCount(1);
  await expect(thought).toHaveAttribute("data-streaming", "false");
  await expect(page.getByText("SECOND_ANSWER", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("history-reading-changed")).toHaveCount(0);
  expect(
    await thought.evaluate(
      (element) => (element as HTMLElement & { retained?: boolean }).retained,
    ),
  ).toBe(true);
});
