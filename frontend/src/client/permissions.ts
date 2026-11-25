import type {
  ArgumentPredicate,
  CompiledToolPolicy,
  Permission,
  PermissionAction,
  PermissionMatcher,
  SessionPermissionConfig,
} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown, path: string, allowed: string[]) {
  if (!isRecord(value)) throw Error(`${path}: expected an object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw Error(`${path}.${key}: unknown field`);
  return value;
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
function encodedBudget(value: unknown, path: string) {
  if (bytes(JSON.stringify(value)) > 1024 * 1024)
    throw Error(`${path}: byte budget (1048576) exceeded`);
}
function text(
  value: unknown,
  path: string,
  limit = 4096,
): asserts value is string {
  if (typeof value !== "string") throw Error(`${path}: expected a string`);
  if (bytes(value) > limit)
    throw Error(`${path}: byte budget (${limit}) exceeded`);
}
function action(
  value: unknown,
  path: string,
): asserts value is PermissionAction {
  if (value !== "allow" && value !== "ask" && value !== "deny")
    throw Error(`${path}: expected allow, ask or deny`);
}
function matcher(
  value: unknown,
  path: string,
): asserts value is PermissionMatcher {
  const row = object(value, path, ["kind", "value"]);
  if (row.kind !== "exact" && row.kind !== "glob" && row.kind !== "regex")
    throw Error(`${path}.kind: expected exact, glob or regex`);
  text(row.value, `${path}.value`);
}
function predicates(
  value: unknown,
  path: string,
): asserts value is ArgumentPredicate[] {
  if (!Array.isArray(value)) throw Error(`${path}: expected an array`);
  if (value.length > 16)
    throw Error(`${path}: predicate count budget (16) exceeded`);
  value.forEach((item, index) => {
    const at = `${path}[${index}]`;
    const row = object(item, at, ["pointer", "matcher"]);
    text(row.pointer, `${at}.pointer`, 512);
    if (row.pointer.split("/").length > 33)
      throw Error(`${at}.pointer: pointer depth budget (32) exceeded`);
    if (
      (row.pointer !== "" && !row.pointer.startsWith("/")) ||
      /~(?:[^01]|$)/.test(row.pointer)
    )
      throw Error(`${at}.pointer: expected an RFC 6901 JSON pointer`);
    matcher(row.matcher, `${at}.matcher`);
  });
}
export function validatePermission(
  value: unknown,
  path = "permission",
): asserts value is Permission {
  const row = object(value, path, ["agent", "mode", "tool", "args", "action"]);
  for (const key of ["agent", "mode"])
    if (row[key] != null) text(row[key], `${path}.${key}`, 128);
  if (row.tool != null) {
    matcher(row.tool, `${path}.tool`);
    if (row.tool.kind === "regex")
      throw Error(
        `${path}.tool.kind: regex is only supported for argument predicates`,
      );
  }
  if (row.args !== undefined) predicates(row.args, `${path}.args`);
  action(row.action, `${path}.action`);
}
export function validatePermissionConfig(
  value: unknown,
): asserts value is SessionPermissionConfig {
  encodedBudget(value, "config");
  const row = object(value, "config", [
    "overrides",
    "review",
    "review_model",
    "initialization",
    "agent",
    "mode",
    "defaults",
    "provider_defaults",
  ]);
  let ruleCount = 0;
  for (const key of ["overrides", "defaults", "provider_defaults"]) {
    if (key !== "overrides" && row[key] === undefined) continue;
    const rules = row[key];
    if (!Array.isArray(rules)) throw Error(`config.${key}: expected an array`);
    ruleCount += rules.length;
    if (ruleCount > 256)
      throw Error("config: rule count budget (256) exceeded");
    rules.forEach((rule, index) =>
      validatePermission(rule, `config.${key}[${index}]`),
    );
  }
  if (typeof row.review !== "boolean")
    throw Error("config.review: expected a boolean");
  // Initialization has its own lifecycle gate; omission has the shared Ask default.
  if (row.initialization !== undefined)
    action(row.initialization, "config.initialization");
  for (const key of ["agent", "mode"])
    if (row[key] !== undefined) text(row[key], `config.${key}`, 128);
  if (row.review_model != null) {
    const model = object(row.review_model, "config.review_model", [
      "provider_id",
      "model",
      "variant",
    ]);
    text(model.provider_id, "config.review_model.provider_id", 256);
    text(model.model, "config.review_model.model", 1024);
    if (model.variant !== undefined)
      text(model.variant, "config.review_model.variant", 64);
    for (const key of ["provider_id", "model", "variant"])
      if (
        typeof model[key] === "string" &&
        (!model[key].length || /[\u0000-\u001f\u007f-\u009f]/.test(model[key]))
      )
        throw Error(
          `config.review_model.${key}: expected nonempty text without control characters`,
        );
  }
}

function owners(value: unknown, path: string) {
  if (!Array.isArray(value)) throw Error(`${path}: expected an array`);
  if (value.length > 32)
    throw Error(`${path}: owner count budget (32) exceeded`);
  for (const [index, owner] of value.entries()) {
    const at = `${path}[${index}]`;
    const witness = object(owner, at, [
      "controller",
      "revision",
      "agent",
      "mode",
    ]);
    for (const key of ["controller", "revision"])
      if (!Number.isSafeInteger(witness[key]) || Number(witness[key]) < 0)
        throw Error(`${at}.${key}: expected a nonnegative safe integer`);
    text(witness.agent, `${at}.agent`, 128);
    text(witness.mode, `${at}.mode`, 128);
  }
}

export interface CurrentPermissionList {
  runtime_instance_id: string;
  catalog_revision: string;
  policy_revision: string;
  ancestor_witness: string;
  agent: string;
  mode: string;
  tools: { name: string; policy: CompiledToolPolicy }[];
}

export interface CurrentPermissionResponse {
  view: "current";
  current: CurrentPermissionList;
}

export function validateCurrentPermissionResponse(
  value: unknown,
): asserts value is CurrentPermissionResponse {
  const response = object(value, "permission", ["view", "current"]);
  if (response.view !== "current")
    throw Error("permission.view: expected current");
  validateCurrentPermissions(response.current);
}

function validateCurrentPermissions(
  value: unknown,
): asserts value is CurrentPermissionList {
  const row = object(value, "permission.current", [
    "runtime_instance_id",
    "catalog_revision",
    "policy_revision",
    "ancestor_witness",
    "agent",
    "mode",
    "tools",
  ]);
  for (const field of ["runtime_instance_id", "ancestor_witness"]) {
    const key = row[field];
    text(key, `permission.current.${field}`, 256);
    if (key.length === 0)
      throw Error(`permission.current.${field}: expected a witness`);
  }
  for (const field of ["catalog_revision", "policy_revision"]) {
    const revision = row[field];
    if (
      typeof revision !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(revision) ||
      (revision.length === 20 && revision > "18446744073709551615")
    )
      throw Error(
        `permission.current.${field}: expected a positive u64 string`,
      );
  }
  text(row.agent, "permission.current.agent", 128);
  text(row.mode, "permission.current.mode", 128);
  if (!Array.isArray(row.tools) || row.tools.length > 4096)
    throw Error("permission.current.tools: expected a bounded tool list");
  const seen = new Set<string>();
  for (const [index, value] of row.tools.entries()) {
    const path = `permission.current.tools[${index}]`;
    const tool = object(value, path, ["name", "policy"]);
    text(tool.name, `${path}.name`);
    if (!tool.name || seen.has(tool.name))
      throw Error(`${path}.name: expected a unique name`);
    seen.add(tool.name);
    if (
      isRecord(tool.policy) &&
      (Object.hasOwn(tool.policy, "owners") ||
        Object.hasOwn(tool.policy, "tool"))
    )
      throw Error(`${path}.policy: management-only fields are not allowed`);
    validateCompiledPolicy(tool.policy, `${path}.policy`);
  }
}

export function validatePolicySnapshot(value: unknown): void {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  )
    throw Error("permission.revision: expected a nonnegative safe integer");
  validatePermissionConfig(value.config);
  if (value.view === "management" && value.current !== undefined) {
    validateCurrentPermissions(value.current);
    if (value.current.policy_revision !== String(value.revision))
      throw Error("permission.current: policy revision mismatch");
  }
  if (value.tool_inventory == null) return;
  const inventory = value.tool_inventory;
  if (
    !isRecord(inventory) ||
    typeof inventory.agent !== "string" ||
    !Array.isArray(inventory.modes)
  )
    throw Error("tool_inventory: expected agent and modes");
  for (const [index, mode] of inventory.modes.entries()) {
    const path = `tool_inventory.modes[${index}]`;
    if (
      !isRecord(mode) ||
      typeof mode.name !== "string" ||
      typeof mode.current !== "boolean" ||
      !Array.isArray(mode.tools) ||
      !Array.isArray(mode.compiled)
    )
      throw Error(`${path}: expected name, current, tools and compiled facts`);
    validatePermissionConfig(mode.policy);
    if (mode.owners !== undefined) owners(mode.owners, `${path}.owners`);
    const seen = new Set<string>();
    for (const [rowIndex, row] of mode.compiled.entries()) {
      if (
        !isRecord(row) ||
        !isRecord(row.tool) ||
        row.tool.kind !== "exact" ||
        typeof row.tool.value !== "string"
      )
        throw Error(
          `${path}.compiled[${rowIndex}].tool: expected exact tool selector`,
        );
      const toolName = row.tool.value;
      validateCompiledPolicy(row, `${path}.compiled[${rowIndex}]`);
      if (seen.has(toolName))
        throw Error(`${path}.compiled: duplicate tool ${toolName}`);
      seen.add(toolName);
    }
    for (const tool of mode.tools) {
      if (
        !isRecord(tool) ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string"
      )
        throw Error(`${path}.tools: expected tool name and description`);
      if (!seen.delete(tool.name))
        throw Error(`${path}.compiled: missing facts for ${tool.name}`);
    }
    if (seen.size)
      throw Error(`${path}.compiled: tool absent from registry inventory`);
  }
}
/** Validate declarative facts only; never evaluate arguments or infer authority. */
export function validateCompiledPolicy(
  value: unknown,
  path = "compiled",
  depth = 1,
  budget = { nodes: 0, branches: 0 },
): asserts value is CompiledToolPolicy {
  if (depth === 1) encodedBudget(value, path);
  if (depth > 32 || ++budget.nodes > 1024)
    throw Error(`${path}: compiled policy exceeds display budget`);
  if (!isRecord(value)) throw Error(`${path}: expected an object`);
  const fields =
    value.kind === "static"
      ? ["kind", "action"]
      : value.kind === "conditional"
        ? ["kind", "branches", "default_action"]
        : value.kind === "all_of"
          ? ["kind", "policies"]
          : [];
  // Inventory rows carry the exact tool selector alongside the compiled fields.
  const row = object(value, path, [
    ...fields,
    ...(depth === 1 ? ["tool", "owners"] : []),
  ]);
  if (row.owners !== undefined) owners(row.owners, `${path}.owners`);
  if (row.tool !== undefined) {
    matcher(row.tool, `${path}.tool`);
    if (row.tool.kind !== "exact")
      throw Error(`${path}.tool.kind: expected exact`);
  }
  switch (row.kind) {
    case "static":
      action(row.action, `${path}.action`);
      break;
    case "conditional":
      action(row.default_action, `${path}.default_action`);
      if (!Array.isArray(row.branches))
        throw Error(`${path}.branches: expected an array`);
      row.branches.forEach((item, index) => {
        if (++budget.branches > 4096)
          throw Error(`${path}: compiled policy exceeds display budget`);
        const at = `${path}.branches[${index}]`;
        const branch = object(item, at, ["args", "action", "source"]);
        predicates(branch.args, `${at}.args`);
        action(branch.action, `${at}.action`);
        if (branch.source !== undefined)
          text(branch.source, `${at}.source`, 512);
      });
      break;
    case "all_of":
      if (!Array.isArray(row.policies) || row.policies.length === 0)
        throw Error(`${path}.policies: expected an array`);
      row.policies.forEach((item, index) =>
        validateCompiledPolicy(
          item,
          `${path}.policies[${index}]`,
          depth + 1,
          budget,
        ),
      );
      break;
    default:
      throw Error(`${path}.kind: expected static, conditional or all_of`);
  }
}
