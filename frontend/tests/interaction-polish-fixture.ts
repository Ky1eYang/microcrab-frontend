import { type Page } from "@playwright/test";
import type { NativeMessage, PolicySnapshot } from "../src/client/types";
import { nativeBackend } from "./native-fixture";

/* ── shared fixtures ─────────────────────────────────────────────────── */
export function permissionPolicy(): PolicySnapshot {
  const config = {
    agent: "coding",
    mode: "execute",
    overrides: [{ tool: { kind: "exact", value: "pwsh" }, action: "deny" }],
    review: true,
    initialization: "ask",
    defaults: [
      {
        tool: { kind: "exact", value: "pwsh" },
        action: "ask",
      },
    ],
  };
  const tools = [
    {
      name: "pwsh",
      description:
        "Run a PowerShell command in the pinned workspace. Long registered descriptions wrap naturally without truncation.",
    },
    { name: "read", description: "Read a file from the workspace." },
    { name: "write", description: "Write a file in the workspace." },
    {
      name: "mcp__very_long_server_identifier__search_repository_contents",
      description: "Search repository contents through an MCP server.",
    },
  ];
  return {
    revision: 7,
    config,
    tool_inventory: {
      agent: "coding",
      modes: [
        {
          name: "execute",
          current: true,
          tools,
          policy: config,
          compiled: tools.map((tool) => ({
            tool: { kind: "exact", value: tool.name },
            kind: "static",
            action: tool.name === "pwsh" ? "deny" : "allow",
          })),
        },
        {
          name: "plan",
          current: false,
          tools: tools.slice(1, 2),
          policy: { ...config, mode: "plan" },
          compiled: [
            {
              tool: { kind: "exact", value: "read" },
              kind: "static",
              action: "allow",
            },
          ],
        },
        {
          name: "review",
          current: false,
          tools: [],
          policy: { ...config, mode: "review" },
          compiled: [],
        },
      ],
    },
  } as PolicySnapshot;
}

export async function routePermission(
  page: Page,
  options: { hold?: () => Promise<void> } = {},
) {
  await page.route("**/api/v1/sessions/s1/permission", async (route) => {
    if (options.hold) await options.hold();
    await route.fulfill({ json: permissionPolicy() });
  });
}

export const toolHistory = (): NativeMessage[] => {
  const user: NativeMessage = {
    id: "polish-user",
    role: "user",
    text: "Inspect status glyphs",
    parts: [],
    tool_calls: [],
    position: { epoch: 0, turn: 1, round: 0 },
  };
  const call = (id: string, name: string, round: number): NativeMessage => ({
    id: `assistant-${id}`,
    role: "assistant",
    text: "",
    parts: [],
    tool_calls: [{ id, name, arguments: { path: `${name}.txt` } }],
    position: { epoch: 0, turn: 1, round },
  });
  return [
    user,
    call("call-ok", "read_ok", 1),
    {
      id: "result-ok",
      role: "tool",
      text: "ok",
      parts: [],
      tool_calls: [],
      call_id: "call-ok",
      tool_name: "read_ok",
      position: { epoch: 0, turn: 1, round: 1 },
    },
    // No paired result and no execution status: must stay unknown.
    call("call-unknown", "read_unknown", 2),
  ];
};

export async function liveToolOutcomes(
  backend: Awaited<ReturnType<typeof nativeBackend>>,
) {
  const base = { operation_id: "polish-operation", epoch: 0, turn: 1 };
  backend.event("tool", {
    ...base,
    round: 3,
    call_id: "call-run",
    name: "shell_running",
    phase: "started",
    arguments: { command: "sleep 30" },
  });
  backend.event("tool", {
    ...base,
    round: 4,
    call_id: "call-fail",
    name: "shell_failed",
    phase: "failed",
    arguments: { command: "exit 2" },
    result: "exit status 2: permission denied",
  });
  backend.event("tool", {
    ...base,
    round: 5,
    call_id: "call-cancel",
    name: "shell_cancelled",
    phase: "cancelled",
    arguments: { command: "sleep 99" },
  });
}
