import { test, expect } from "@playwright/test";
import {
  ClientToolController,
  type ClientBinding,
  type ClientInvocation,
} from "../src/client/client-tool-controller";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type { ApiClient } from "../src/client/api";

test("child prepare and result use the authorized leased parent while immutable records retain child identity", async () => {
  const child: ClientInvocation = {
    invocation_id: "child_invocation",
    parent_session_id: "parent_resource",
    session_id: "actual_child",
    call_id: "child_call",
    tool: "ask_user_question",
    arguments: {
      questions: [
        {
          id: "q",
          question: "Child question",
          options: [{ id: "a", label: "Explicit answer", recommended: true }],
        },
      ],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "digest",
    status: "pending",
    created_at_ms: 1,
    deadline_ms: 0,
    interaction: true,
    blocking_mode: "blocking",
    prepared: false,
  };
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "parent_lease",
    catalog_digest: "digest",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [child],
    calls: [child],
  };
  const commands: { method: string; sessionId?: string; params: any }[] = [];
  const api = {
    request: async (method: string, params: any, sessionId?: string) => {
      commands.push({ method, sessionId, params });
      // Mirrors native Manager authorization: children have no directory record.
      if (sessionId !== "parent_resource") throw Error("not_found");
      if (method === "client_tools.bind") return structuredClone(binding);
      if (method === "client_tools.prepare")
        return {
          ...child,
          prepared: true,
          timeout_result: params.timeout_result,
        };
      return { ...child, status: "completed", result: params.result };
    },
  } as unknown as ApiClient;
  const errors: unknown[] = [];
  const controller = new ClientToolController(
    api,
    () => {},
    (error) => errors.push(error),
  );
  await controller.bind("parent_resource", binding);
  await expect
    .poll(
      () =>
        commands.filter((command) => command.method === "client_tools.prepare")
          .length,
    )
    .toBe(1);
  expect(controller.binding?.calls[0].session_id).toBe("actual_child");
  await controller.answer(
    "child_invocation",
    [{ id: "q", option_ids: ["a"] }],
    false,
  );
  expect(
    commands.map((command) => [command.method, command.sessionId]),
  ).toEqual([
    ["client_tools.bind", "parent_resource"],
    ["client_tools.prepare", "parent_resource"],
    ["client_tools.result", "parent_resource"],
  ]);
  expect(commands[1].params.invocation_id).toBe("child_invocation");
  expect(commands[2].params.invocation_id).toBe("child_invocation");
  expect(controller.binding?.calls[0].session_id).toBe("actual_child");
  expect(controller.binding?.calls[0].status).toBe("completed");
  expect(errors).toEqual([]);
});
