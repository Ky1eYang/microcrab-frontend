import { test, expect } from "@playwright/test";
import {
  applyEvent,
  applySnapshot,
  createBlock,
} from "../src/client/projector";
import type { NativeEvent } from "../src/client/types";
import {
  auditSelector,
  historicalToolSchema,
} from "../src/features/RequestAudit";
import {
  selectedModelRequests,
  timedTrajectoryBlocks,
} from "../src/features/trajectoryTiming";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

const event = (name: string, data: unknown): NativeEvent => ({
  v: 1,
  type: "event",
  subscription_id: "sub",
  generation: "g",
  sequence: 1,
  session_id: "s1",
  event: name,
  data,
});
test("canonical Google JSON Schema and legacy declarations remain inspectable", () => {
  const schema = {
    type: "object",
    properties: { file_path: { type: "string" } },
    additionalProperties: false,
  };
  expect(
    historicalToolSchema(
      [
        {
          functionDeclarations: [
            { name: "read", parametersJsonSchema: schema },
          ],
        },
      ],
      "read",
    ),
  ).toEqual(schema);
  expect(
    historicalToolSchema(
      [{ function_declarations: [{ name: "read", parameters: schema }] }],
      "read",
    ),
  ).toEqual(schema);
});

const position = { epoch: 2, turn: 1, round: 1 };
const model = {
  request_hash: "request",
  call_id: "provider-call",
  sequence: 1,
  ...position,
  completion: "succeeded" as const,
};

test("selected branch evidence wins over a newer successful sibling and legacy ambiguity stays unknown", () => {
  const selected = {
    ...model,
    request_hash: "selected",
    history_head: "branch-a",
    branch_selected: true,
  };
  const sibling = {
    ...model,
    request_hash: "sibling",
    history_head: "branch-b",
    sequence: 99,
  };
  expect(
    selectedModelRequests([selected, sibling]).get("2:1:1")?.request_hash,
  ).toBe("selected");
  expect(
    selectedModelRequests([{ ...selected, branch_selected: false }, sibling])
      .size,
  ).toBe(0);
});

test("terminal session closes streaming reasoning without fabricating an end clock", () => {
  const transcript = applySnapshot(nativeSnapshot);
  applyEvent(
    transcript,
    event("model_observation", {
      operation_id: "op",
      call_id: "model",
      ...position,
      phase: "reasoning_delta",
      text: "Thinking",
    }),
  );
  const reasoning = transcript.blocks.find(
    (block) => block.kind === "reasoning",
  )!;
  expect(reasoning.stream).toBe("streaming");
  applyEvent(
    transcript,
    event("session", { ...nativeSnapshot.session, status: "idle" }),
  );
  expect(reasoning.stream).toBe("stopped");
  expect(reasoning.endedMs).toBeUndefined();
});

test("user schemas select round one and observed identities bind generation without replacing continuation", () => {
  const user = createBlock("s1", "u", "text", "text", "user");
  user.position = { ...position, round: 0 };
  expect(auditSelector(user, true)).toEqual({ ...position });
  const tool = createBlock("s1", "a", "call", "tool");
  tool.position = position;
  tool.callId = "tool-call";
  tool.tool = {
    name: "read",
    callId: "tool-call",
    input: {},
    status: "completed",
  };
  const blocks = timedTrajectoryBlocks([user, tool], [model], []);
  const boundUser = blocks.find((block) => block.id === user.id)!;
  const boundTool = blocks.find((block) => block.id === tool.id)!;
  expect(auditSelector(boundUser as typeof user, false)).toEqual({
    epoch: 2,
    call_id: "provider-call",
  });
  expect(auditSelector(boundTool as typeof tool, true)).toEqual({
    epoch: 2,
    call_id: "provider-call",
  });
  expect(auditSelector(boundTool as typeof tool, false)).toEqual({
    epoch: 2,
    turn: 1,
    tool_call_id: "tool-call",
  });
});

test("only canonical typed delegate metadata gives a tool assistant identity", () => {
  const transcript = applySnapshot({
    ...nativeSnapshot,
    messages: [
      {
        id: "a",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          { id: "typed", name: "delegate", arguments: {}, builtin: "delegate" },
          { id: "opaque", name: "delegate", arguments: {} },
        ],
        position,
      },
    ],
  });
  expect(transcript.blocks[0].tool?.builtin).toBe("delegate");
  expect(transcript.blocks[1].tool?.builtin).toBeUndefined();
});

test("completed reasoning has no running badge even when audit end clocks are unavailable", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "u",
      role: "user",
      text: "Work",
      parts: [],
      tool_calls: [],
      position,
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const observation = { operation_id: "op", call_id: "provider", ...position };
  backend.event("model_observation", {
    ...observation,
    phase: "reasoning_delta",
    text: "Thinking",
  });
  const reasoning = page.locator(
    '[data-testid="trajectory-entry"][data-kind="thought"]',
  );
  await expect(reasoning).toHaveAttribute("data-status", "running");
  backend.event("model_observation", {
    ...observation,
    phase: "validated",
    text: "Done",
  });
  await expect(reasoning).toHaveAttribute("data-status", "done");
  await reasoning.click();
  await expect(page.getByTestId("trajectory-inspector")).toContainText(
    "已完成",
  );
  await expect(page.getByTestId("trajectory-inspector")).not.toContainText(
    "进行中",
  );
});

test("typed delegate occupies assistant lane and keeps its result payload opaque", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "u",
      role: "user",
      text: "Work",
      parts: [],
      tool_calls: [],
      position,
    },
    {
      id: "a",
      role: "assistant",
      text: null,
      parts: [],
      position,
      tool_calls: [
        { id: "c", name: "delegate", builtin: "delegate", arguments: {} },
      ],
    },
    {
      id: "t",
      role: "tool",
      text: "**opaque result**",
      parts: [],
      tool_calls: [],
      call_id: "c",
      tool_name: "delegate",
      tool_builtin: "delegate",
      position,
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({ json: { status: "missing", attempts: [] } }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(page.locator('[data-lane="sub"] button')).toHaveCount(1);
  await expect(page.locator('[data-lane="tool"] button')).toHaveCount(0);
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="subagent"]')
    .click();
  await expect(page.getByTestId("tool-payload-output")).toContainText(
    "**opaque result**",
  );
});

test("distinct helper calls at the same position remain separate assistant entries", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    {
      id: "u",
      role: "user",
      text: "Work",
      parts: [],
      tool_calls: [],
      position,
    },
  ];
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) =>
    route.fulfill({
      json: {
        status: "available",
        attempts: [1, 2].map((sequence) => ({
          request_hash: `helper-${sequence}`,
          call_id: `review-${sequence}`,
          sequence,
          ...position,
          subagent: "action_review",
          history_head: "branch",
          status: "available",
          completion: "succeeded",
          response: "reviewed",
        })),
      },
    }),
  );
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(
    page.locator(
      '[data-testid="trajectory-entry"][data-kind="internal-assistant"]',
    ),
  ).toHaveCount(2);
});
