import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("canonical selected invocation IDs restore todo outside bounded message windows and follow travel", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async (snapshot) => {
    const { AppStore } = await import("/src/state/store.ts");
    const store = new AppStore();
    const first = {
      invocation_id: "first",
      session_id: "s1",
      tool: "update_todo_list",
      status: "completed",
      result: {
        todos: [{ content: "first branch beyond page", status: "pending" }],
      },
    };
    const other = {
      ...first,
      invocation_id: "other",
      result: { todos: [{ content: "other branch", status: "cancelled" }] },
    };
    const clear = { ...first, invocation_id: "clear", result: { todos: [] } };
    const controller = (store as any).clientTools;
    controller.binding = {
      role: "observer",
      catalog_digest: "digest",
      definitions: [],
      pending: [],
      calls: [first, other, clear],
    };
    const canonical: any = {
      ...snapshot,
      messages: [],
      messages_truncated: true,
      client_tools: {
        role: "observer",
        definitions: [],
        catalog_digest: "digest",
        pending: [],
        calls: [clear],
        calls_truncated: true,
        total_calls: 3,
        selected_invocation_ids: ["first"],
      },
    };
    (store as any).snapshot(canonical);
    const firstTodos = structuredClone(store.state.transcript.todos);
    canonical.client_tools.selected_invocation_ids = ["other"];
    (store as any).snapshot(canonical);
    const otherTodos = structuredClone(store.state.transcript.todos);
    canonical.client_tools.selected_invocation_ids = ["first", "clear"];
    (store as any).snapshot(canonical);
    const cleared = structuredClone(store.state.transcript.todos);
    const retainedCalls = controller.binding.calls.length;
    store.stop();
    return { firstTodos, otherTodos, cleared, retainedCalls };
  }, backend.snapshot());
  expect(result).toEqual({
    firstTodos: [{ content: "first branch beyond page", status: "pending" }],
    otherTodos: [{ content: "other branch", status: "cancelled" }],
    cleared: [],
    retainedCalls: 3,
  });
});
