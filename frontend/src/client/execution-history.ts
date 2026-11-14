import type { NativeExecution } from "./types";
import { isRecord } from "./permissions";

/** Retained history is never inferred from State or mixed with another Session. */
export function validateExecutionHistory(
  value: unknown,
  sessionId: string,
): asserts value is NativeExecution[] {
  if (!Array.isArray(value))
    throw Error("executions: expected retained history array");
  const seen = new Set<number>();
  for (const [index, row] of value.entries()) {
    const path = `executions[${index}]`;
    if (!isRecord(row) || row.session_id !== sessionId)
      throw Error(`${path}.session_id: expected selected Session identity`);
    if (
      !Number.isSafeInteger(row.execution_id) ||
      Number(row.execution_id) < 1 ||
      seen.has(Number(row.execution_id))
    )
      throw Error(
        `${path}.execution_id: expected unique positive safe integer`,
      );
    seen.add(Number(row.execution_id));
    for (const key of ["call_id", "agent"])
      if (typeof row[key] !== "string" || !(row[key] as string).length)
        throw Error(`${path}.${key}: expected nonempty string`);
    let initialization = false;
    if (row.subject !== undefined) {
      if (!isRecord(row.subject))
        throw Error(`${path}.subject: expected invocation subject`);
      if (row.subject.kind === "agent_init") {
        initialization = true;
        if (typeof row.subject.component !== "string" || !row.subject.component)
          throw Error(`${path}.subject.component: expected nonempty string`);
        for (const key of ["generation", "attempt"])
          if (
            !Number.isSafeInteger(row.subject[key]) ||
            Number(row.subject[key]) < 1
          )
            throw Error(
              `${path}.subject.${key}: expected positive safe integer`,
            );
      } else if (row.subject.kind !== "tool") {
        throw Error(`${path}.subject.kind: unknown invocation subject`);
      }
    }
    if (typeof row.tool !== "string" || (!initialization && !row.tool))
      throw Error(
        `${path}.tool: expected ${initialization ? "string" : "nonempty string"}`,
      );
    if (
      ![
        "running",
        "waiting",
        "cancelling",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(String(row.status))
    )
      throw Error(`${path}.status: unknown execution status`);
    if (
      !isRecord(row.capabilities) ||
      typeof row.capabilities.input !== "boolean"
    )
      throw Error(`${path}.capabilities.input: expected boolean`);
  }
}
