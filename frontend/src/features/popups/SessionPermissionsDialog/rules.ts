import type {
  NativeModelSelection,
  PolicySnapshot,
  SessionPermissionConfig,
} from "../../../client/types";

import {
  isRecord,
  validatePermissionConfig,
} from "../../../client/permissions";
export { isRecord } from "../../../client/permissions";

export type ToolAction = "allow" | "ask" | "deny";
const actions: readonly string[] = ["allow", "ask", "deny"];

/** Only this exact, unconditional shape belongs to the simple editor. Global,
 * glob and argument-guarded rules remain opaque and ordered. */
export function simpleToolRule(
  raw: unknown,
  agent: string,
  mode: string,
  tool?: string,
): raw is Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.tool)) return false;
  return (
    raw.agent === agent &&
    raw.mode === mode &&
    raw.tool.kind === "exact" &&
    typeof raw.tool.value === "string" &&
    (tool == null || raw.tool.value === tool) &&
    actions.includes(String(raw.action)) &&
    Object.keys(raw.tool).every((key) => ["kind", "value"].includes(key)) &&
    Object.entries(raw).every(
      ([key, value]) =>
        ["agent", "mode", "tool", "action"].includes(key) ||
        (key === "args" && Array.isArray(value) && value.length === 0),
    )
  );
}
export function simpleAction(
  config: SessionPermissionConfig,
  agent: string,
  mode: string,
  tool: string,
): ToolAction | "" {
  const rule = config.overrides
    .filter((row) => simpleToolRule(row, agent, mode, tool))
    .at(-1);
  return isRecord(rule) ? (rule.action as ToolAction) : "";
}
export function setSimpleToolRule(
  config: SessionPermissionConfig,
  agent: string,
  mode: string,
  tool: string,
  action: ToolAction | "",
): SessionPermissionConfig {
  const overrides = config.overrides.filter(
    (row) => !simpleToolRule(row, agent, mode, tool),
  );
  if (action)
    overrides.push({
      agent,
      mode,
      tool: { kind: "exact", value: tool },
      action,
    });
  return { ...config, overrides };
}
export function resetSimpleRules(
  config: SessionPermissionConfig,
  inventory: PolicySnapshot["tool_inventory"],
): SessionPermissionConfig {
  if (!inventory) return config;
  return {
    ...config,
    overrides: config.overrides.filter(
      (row) =>
        !inventory.modes.some((mode) =>
          mode.tools.some((tool) =>
            simpleToolRule(row, inventory.agent, mode.name, tool.name),
          ),
        ),
    ),
  };
}
export function modelKey(
  selection: NativeModelSelection | null | undefined,
): string {
  return selection
    ? JSON.stringify([
        selection.provider_id,
        selection.model,
        selection.variant ?? null,
      ])
    : "";
}
export function parsePermissionDraft(text: string): SessionPermissionConfig {
  const value: unknown = JSON.parse(text);
  validatePermissionConfig(value);
  return { ...value, initialization: value.initialization ?? "allow" };
}
