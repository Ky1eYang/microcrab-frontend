import { nativeSnapshot } from "./native-fixture";
import type { NativeExecution, NativeSnapshot } from "../src/client/types";

const child = "0123456789abcdef";
const execution = (status: string): NativeExecution =>
  ({
    execution_id: 7,
    session_id: "s1",
    call_id: "delegate-call",
    tool: "delegate",
    agent: "main",
    mode: null,
    capabilities: { input: false },
    status,
    delegate_child: { session_id: child, target: "worker" },
  }) as NativeExecution;
export function subagentSnapshot(status: string): NativeSnapshot {
  return {
    ...structuredClone(nativeSnapshot),
    executions: [execution(status)],
    messages: [
      {
        id: "u",
        role: "user",
        text: "Inspect child",
        parts: [],
        tool_calls: [],
      },
      {
        id: "a",
        role: "assistant",
        text: null,
        parts: [],
        tool_calls: [
          {
            id: "delegate-call",
            name: "delegate",
            builtin: "delegate",
            arguments: { subagent: "worker", prompt: "Inspect" },
          },
        ],
      },
      {
        id: "t",
        role: "tool",
        text: JSON.stringify({ execution_id: 7, session_id: "s1" }),
        parts: [],
        tool_calls: [],
        call_id: "delegate-call",
        tool_name: "delegate",
        tool_builtin: "delegate",
      },
    ],
  } as NativeSnapshot;
}
