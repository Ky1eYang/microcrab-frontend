import type {
  NativeModelSelection,
  ModelProtocol,
  Permission,
  PermissionAction,
} from "./types";
import { isRecord, validatePermission } from "./permissions";

export const LIMIT_FIELDS = [
  "max_rounds",
  "max_tool_calls_per_round",
  "max_context_bytes",
  "max_tool_output_bytes",
  "max_output_tokens",
  "interaction_timeout_ms",
  "max_pending_executions",
  "max_retained_executions",
  "lifecycle_timeout_ms",
  "max_processes",
  "max_execution_buffers",
  "max_retained_processes",
  "output_buffer_bytes",
  "sleep_max_ms",
] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export type Limits = Record<LimitField, number>;
export interface AutoCompactionPolicy {
  enabled: boolean;
  turn_threshold: number;
  round_threshold: number;
  headroom_tokens: number;
}
export interface SettingsOverrides {
  limits?: Partial<Limits>;
  model_selection?: NativeModelSelection;
  agent?: string;
  mode?: string;
  permissions?: Permission[];
  initialization?: PermissionAction;
  review?: boolean;
  review_model?: NativeModelSelection | null;
  auto_compaction?: AutoCompactionPolicy;
  auto_naming?: boolean;
}
export interface SettingsValues extends Omit<
  SettingsOverrides,
  "model_selection" | "agent" | "mode"
> {
  limits: Limits;
  model_selection?: NativeModelSelection | null;
  agent?: string | null;
  mode?: string | null;
}
export interface SettingsSnapshot {
  revision: number;
  overrides: SettingsOverrides;
  effective: SettingsValues;
  sources: Record<string, "admin" | "user" | "project" | "session">;
  constraints: { limits: Limits };
  desired_effective: SettingsValues;
  applied_revision: number;
  application: "defaults_saved" | "applied" | "deferred";
  reason: string | null;
}
export type ReferenceSource =
  | { type: "host_path"; path: string }
  | { type: "host_glob"; root: string; pattern: string }
  | { type: "url" | "directory_url"; url: string };
export interface ReferencesSnapshot {
  revision: number;
  sources: ReferenceSource[];
}
export interface ModelOverlay {
  id: string;
  name?: string;
  variants?: string[];
  context_window_tokens?: number;
  protocol?: ModelProtocol;
  endpoint?: string;
  auth?: "native" | "bearer";
  disabled?: boolean;
}
export interface ProviderConfig {
  name: string;
  protocol: ModelProtocol;
  endpoint: string;
  auth: "native" | "bearer";
  timeout_ms: number;
  max_response_bytes: number;
  models: ModelOverlay[];
}
export interface PublicProvider extends ProviderConfig {
  id: string;
  scope: "user" | "admin";
  revision: number;
  read_only: boolean;
  api_key_configured: boolean;
  discovered: ModelOverlay[];
}
export interface ProviderWrite {
  expected_revision: number;
  provider: ProviderConfig;
  api_key?: string | null;
}
const own = (value: unknown, path: string, fields: readonly string[]) => {
  if (!isRecord(value)) throw Error(`${path}: expected object`);
  for (const key of Object.keys(value))
    if (!fields.includes(key)) throw Error(`${path}.${key}: unknown field`);
  return value;
};
export function safeInteger(
  value: unknown,
  path: string,
  minimum = 0,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw Error(`${path}: expected safe integer >= ${minimum}`);
}
function endpoint(value: unknown, path: string) {
  if (typeof value !== "string") throw Error(`${path}: expected HTTP(S) URL`);
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error(
      `${path}: expected HTTP(S) URL without credentials or fragment`,
    );
}
function modelSelection(value: unknown, path: string) {
  const row = own(value, path, ["provider_id", "model", "variant"]);
  for (const key of ["provider_id", "model"])
    if (typeof row[key] !== "string" || !(row[key] as string).trim())
      throw Error(`${path}.${key}: expected nonempty string`);
  if (row.variant != null && typeof row.variant !== "string")
    throw Error(`${path}.variant: expected string`);
}
export function validateSettingsOverrides(
  value: unknown,
): asserts value is SettingsOverrides {
  const row = own(value, "settings", [
    "limits",
    "model_selection",
    "agent",
    "mode",
    "permissions",
    "initialization",
    "review",
    "review_model",
    "auto_compaction",
    "auto_naming",
  ]);
  if (row.limits !== undefined) {
    const limits = own(row.limits, "settings.limits", LIMIT_FIELDS);
    for (const [field, limit] of Object.entries(limits)) {
      safeInteger(
        limit,
        `settings.limits.${field}`,
        field === "max_retained_processes" ? 0 : 1,
      );
      if (field === "sleep_max_ms" && Number(limit) > 3600000)
        throw Error("settings.limits.sleep_max_ms: maximum is 3600000");
      if (field === "max_output_tokens" && Number(limit) > 4294967295)
        throw Error("settings.limits.max_output_tokens: exceeds u32");
    }
  }
  for (const field of ["model_selection", "review_model"])
    if (row[field] != null) modelSelection(row[field], `settings.${field}`);
  for (const field of ["review", "auto_naming"])
    if (row[field] !== undefined && typeof row[field] !== "boolean")
      throw Error(`settings.${field}: expected boolean`);
  for (const field of ["agent", "mode"])
    if (
      row[field] !== undefined &&
      (typeof row[field] !== "string" || !(row[field] as string).trim())
    )
      throw Error(`settings.${field}: expected nonempty string`);
  if (
    row.initialization !== undefined &&
    !["allow", "ask", "deny"].includes(String(row.initialization))
  )
    throw Error("settings.initialization: expected allow, ask or deny");
  if (row.permissions !== undefined) {
    if (!Array.isArray(row.permissions) || row.permissions.length > 256)
      throw Error("settings.permissions: expected at most 256 rules");
    row.permissions.forEach((rule, index) =>
      validatePermission(rule, `settings.permissions[${index}]`),
    );
  }
  if (row.auto_compaction !== undefined) {
    const policy = own(row.auto_compaction, "settings.auto_compaction", [
      "enabled",
      "turn_threshold",
      "round_threshold",
      "headroom_tokens",
    ]);
    if (
      typeof policy.enabled !== "boolean" ||
      typeof policy.turn_threshold !== "number" ||
      typeof policy.round_threshold !== "number" ||
      !(
        0 < policy.turn_threshold &&
        policy.turn_threshold < policy.round_threshold &&
        policy.round_threshold < 1
      )
    )
      throw Error(
        "settings.auto_compaction: requires enabled and 0 < turn_threshold < round_threshold < 1",
      );
    safeInteger(
      policy.headroom_tokens,
      "settings.auto_compaction.headroom_tokens",
    );
  }
}
export function validateSettingsSnapshot(
  value: unknown,
): asserts value is SettingsSnapshot {
  if (!isRecord(value)) throw Error("settings: expected object");
  safeInteger(value.revision, "settings.revision");
  validateSettingsOverrides(value.overrides);
  if (
    !isRecord(value.effective) ||
    !isRecord(value.desired_effective) ||
    !isRecord(value.sources) ||
    !isRecord(value.constraints)
  )
    throw Error("settings: missing effective, sources or constraints");
  for (const resolved of [value.effective, value.desired_effective]) {
    const writable = { ...resolved };
    for (const field of ["agent", "mode", "model_selection"])
      if (writable[field] === null) delete writable[field];
    validateSettingsOverrides(writable);
  }
  for (const [field, source] of Object.entries(value.sources))
    if (!["admin", "user", "project", "session"].includes(String(source)))
      throw Error(`settings.sources.${field}: unknown source`);
  if (
    !["defaults_saved", "applied", "deferred"].includes(
      String(value.application),
    )
  )
    throw Error("settings.application: unknown application status");
  if (value.reason !== null && typeof value.reason !== "string")
    throw Error("settings.reason: expected string or null");
  for (const field of LIMIT_FIELDS)
    safeInteger(
      (value.effective.limits as Record<string, unknown>)?.[field],
      `settings.effective.limits.${field}`,
    );
  safeInteger(value.applied_revision, "settings.applied_revision");
  for (const field of LIMIT_FIELDS) {
    safeInteger(
      (value.desired_effective.limits as Record<string, unknown>)?.[field],
      `settings.desired_effective.limits.${field}`,
    );
    safeInteger(
      (value.constraints.limits as Record<string, unknown>)?.[field],
      `settings.constraints.limits.${field}`,
    );
  }
}
export function validateProviderConfig(
  value: unknown,
): asserts value is ProviderConfig {
  const row = own(value, "provider", [
    "name",
    "protocol",
    "endpoint",
    "auth",
    "timeout_ms",
    "max_response_bytes",
    "models",
  ]);
  if (typeof row.name !== "string" || !row.name.trim())
    throw Error("provider.name: expected nonempty string");
  if (
    !["openai-compatible", "openai", "anthropic", "google"].includes(
      String(row.protocol),
    )
  )
    throw Error("provider.protocol: unsupported protocol");
  if (!["native", "bearer"].includes(String(row.auth)))
    throw Error("provider.auth: expected native or bearer");
  endpoint(row.endpoint, "provider.endpoint");
  safeInteger(row.timeout_ms, "provider.timeout_ms", 1);
  safeInteger(row.max_response_bytes, "provider.max_response_bytes", 1);
  if (!Array.isArray(row.models) || row.models.length > 1024)
    throw Error("provider.models: expected at most 1024 models");
  const seen = new Set<string>();
  for (const [index, item] of row.models.entries()) {
    const at = `provider.models[${index}]`;
    const model = own(item, at, [
      "id",
      "name",
      "variants",
      "context_window_tokens",
      "protocol",
      "endpoint",
      "auth",
      "disabled",
    ]);
    if (typeof model.id !== "string" || !model.id.trim() || seen.has(model.id))
      throw Error(`${at}.id: expected unique nonempty model id`);
    seen.add(model.id);
    if (model.name !== undefined && typeof model.name !== "string")
      throw Error(`${at}.name: expected string`);
    if (
      model.variants !== undefined &&
      (!Array.isArray(model.variants) ||
        model.variants.some((v) => typeof v !== "string"))
    )
      throw Error(`${at}.variants: expected strings`);
    if (model.context_window_tokens !== undefined)
      safeInteger(
        model.context_window_tokens,
        `${at}.context_window_tokens`,
        1,
      );
    if (model.endpoint !== undefined)
      endpoint(model.endpoint, `${at}.endpoint`);
    if (
      model.protocol !== undefined &&
      !["openai-compatible", "openai", "anthropic", "google"].includes(
        String(model.protocol),
      )
    )
      throw Error(`${at}.protocol: unsupported protocol`);
    if (
      model.auth !== undefined &&
      !["native", "bearer"].includes(String(model.auth))
    )
      throw Error(`${at}.auth: expected native or bearer`);
    if (model.disabled !== undefined && typeof model.disabled !== "boolean")
      throw Error(`${at}.disabled: expected boolean`);
  }
}
export function validatePublicProvider(
  value: unknown,
): asserts value is PublicProvider {
  const row = own(value, "provider", [
    "id",
    "scope",
    "revision",
    "read_only",
    "name",
    "protocol",
    "endpoint",
    "auth",
    "timeout_ms",
    "max_response_bytes",
    "api_key_configured",
    "models",
    "discovered",
  ]);
  const {
    id,
    scope,
    revision,
    read_only,
    api_key_configured,
    discovered,
    ...config
  } = row;
  if (
    typeof id !== "string" ||
    !id ||
    !["user", "admin"].includes(String(scope)) ||
    typeof read_only !== "boolean" ||
    typeof api_key_configured !== "boolean"
  )
    throw Error("provider: malformed safe public metadata");
  safeInteger(revision, "provider.revision");
  validateProviderConfig(config);
  validateProviderConfig({ ...config, models: discovered });
}
export function validateReferences(
  value: unknown,
): asserts value is ReferencesSnapshot {
  const row = own(value, "references", ["revision", "sources"]);
  safeInteger(row.revision, "references.revision");
  if (!Array.isArray(row.sources) || row.sources.length > 128)
    throw Error("references.sources: expected at most 128 sources");
  for (const [index, item] of row.sources.entries()) {
    if (!isRecord(item))
      throw Error(`references.sources[${index}]: expected object`);
    const fields =
      item.type === "host_path"
        ? ["type", "path"]
        : item.type === "host_glob"
          ? ["type", "root", "pattern"]
          : ["type", "url"];
    const source = own(item, `references.sources[${index}]`, fields);
    if (
      !["host_path", "host_glob", "url", "directory_url"].includes(
        String(source.type),
      )
    )
      throw Error("references: unsupported source type");
    for (const field of fields.filter((f) => f !== "type"))
      if (
        typeof source[field] !== "string" ||
        !(source[field] as string).trim()
      )
        throw Error(
          `references.sources[${index}].${field}: expected nonempty string`,
        );
    if ("url" in source)
      endpoint(source.url, `references.sources[${index}].url`);
  }
}
