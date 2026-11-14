import { expect, test } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  replayDisplayObservations,
  suspendPreviews,
} from "../src/client/projector";
import { createConversationRegistry } from "../src/client/conversation/registry";
import { publishTranscript } from "../src/client/conversation/assembler";
import {
  binding,
  canonical,
  chunk,
  emit,
  graphRows,
  graphTranscript,
  message,
  snapshot,
} from "./display-graph-inputs";
import { nativeBackend } from "./native-fixture";

test("bounded attach hides only the certified earlier graph prefix and explicit load restores cached nodes", () => {
  const earlier = message("earlier", "user", "earlier");
  const loaded = message("loaded", "user", "loaded");
  const bounded = snapshot([loaded]);
  bounded.history_view = {
    ...bounded.history_view!,
    start_cursor: 1,
    end_cursor: 2,
    message_count: 2,
  };
  bounded.messages_truncated = true;
  let transcript = applySnapshot(bounded);
  replayDisplayObservations(transcript, "s1", [
    canonical(1, "earlier-node", null, earlier),
    canonical(2, "loaded-node", "earlier-node", loaded),
  ]);
  const registry = createConversationRegistry();
  publishTranscript(registry, transcript);
  expect(registry.order).toEqual(["loaded-node"]);
  const cached = registry.getBlock("earlier-node");
  expect(
    transcript.displayGraph!.nodes["earlier-node"].canonical?.message.text,
  ).toBe("earlier");
  transcript = applySnapshot(snapshot([earlier, loaded]), transcript);
  publishTranscript(registry, transcript);
  expect(registry.order).toEqual(["earlier-node", "loaded-node"]);
  expect(registry.getBlock("earlier-node")).toBe(cached);
  registry.dispose();
});

test("bounded window includes all explicitly bound thinking segments for its first loaded response", () => {
  const old = message("old", "user", "old");
  const loaded = message("assistant", "assistant", "answer");
  const bounded = snapshot([loaded]);
  bounded.messages_truncated = true;
  let transcript = applySnapshot(bounded);
  replayDisplayObservations(transcript, "s1", [
    canonical(1, "old", null, old),
    chunk(2, "thought", "old", "reasoning", "thought"),
    chunk(3, "answer", "thought", "text", "answer"),
    binding(4, ["thought", "answer"], loaded),
  ]);
  const registry = createConversationRegistry();
  publishTranscript(registry, transcript);
  expect(registry.order).toEqual(["thought", "answer"]);
  transcript = applySnapshot(bounded, transcript);
  publishTranscript(registry, transcript);
  expect(registry.order).toEqual(["thought", "answer"]);
  registry.dispose();
});

test("transport gaps retain graph bodies and stop unvalidated streaming without claiming completion", () => {
  const transcript = graphTranscript();
  emit(transcript, chunk(1, "thought", null, "reasoning", "retained thought"));
  suspendPreviews(transcript);
  expect(graphRows(transcript)[0].id).toBe("thought");
  expect(graphRows(transcript)[0].payload.text).toBe("retained thought");
  expect(graphRows(transcript)[0].stream).toBe("stopped");
  expect(graphRows(transcript)[0].displayIncomplete).toBe(true);
});

test("graph attach reapplies exact typed execution-child bindings and preserves them on later content", () => {
  const view = snapshot();
  view.executions = [
    {
      execution_id: 7,
      session_id: "s1",
      call_id: "tool",
      tool: "delegate",
      agent: "main",
      mode: null,
      capabilities: { input: false },
      status: "running",
      delegate_child: { session_id: "child", target: "worker" },
    },
  ];
  const transcript = applySnapshot(view);
  const assistant = message("assistant", "assistant", "", {
    tool_calls: [
      { id: "tool", name: "delegate", builtin: "delegate", arguments: {} },
    ],
  });
  const result = message(
    "result",
    "tool",
    JSON.stringify({ execution_id: 7, session_id: "s1" }),
    { call_id: "tool", tool_name: "delegate", tool_builtin: "delegate" },
  );
  replayDisplayObservations(transcript, "s1", [
    chunk(1, "tool-node", null, "tool_call", "{}", {
      extra: { name: "delegate" },
    }),
    binding(2, ["tool-node"], assistant),
    canonical(3, "result-node", "tool-node", result),
  ]);
  expect(graphRows(transcript)[0].kind).toBe("child");
  expect(graphRows(transcript)[0].tool.childSessionId).toBe("child");
  emit(transcript, chunk(4, "later", "result-node", "reasoning", "later"));
  expect(graphRows(transcript)[0].kind).toBe("child");
  expect(graphRows(transcript)[0].tool.childSessionId).toBe("child");
});

test("browser labels incomplete thinking after idle without a provider terminal receipt", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const user = message("user", "user", "历史提问");
  Object.assign(backend.snapshot(), snapshot([user]));
  await page.goto("/#session/s1");
  await expect(page.getByText("历史提问", { exact: true })).toBeVisible();
  const record = chunk(1, "thought", null, "reasoning", "retained");
  backend.event("model_observation", {
    ...record.event,
    archive_sequence: 1,
    attempt_id: record.attempt_id,
  });
  await expect(page.getByTestId("think-block")).toBeVisible();
  backend.event("session", { ...backend.snapshot().session, status: "idle" });
  await expect(page.getByTestId("think-block")).toHaveAttribute(
    "data-incomplete",
    "true",
  );
  await expect(page.getByTestId("think-block")).toContainText("思考记录不完整");
});
