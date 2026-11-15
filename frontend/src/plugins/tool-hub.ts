import type { ClientToolDefinition } from "../client/client-tools";
import type { Json, PluginToolRequest, PluginToolIdentity } from "./types";
export const PLUGIN_META_TOOL_DEFINITION: ClientToolDefinition = {
  name: "plugin",
  description:
    "Discover and invoke an enabled browser plugin. Always include plugin and artifact from the external plugins variable (16-hex reference; full SHA-256 remains accepted for legacy calls). list aggregates enabled servers' tool summaries in pages; limit caps total summaries per page (default 20, max 32). describe(server) lists tools; describe(server, tool) returns schema and may mint call_pin. Prefer call with only pin and arguments plus required plugin/artifact; do not include server/tool/config_pin/schema_pin with pin. Providers without call_pin retain legacy exact server/tool/config_pin/schema_pin calls. Expired references require describe again; never retry an uncertain effect automatically.",
  permissions: [{ tool: { kind: "exact", value: "plugin" }, action: "allow" }],
  reclaimable: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["plugin", "action", "artifact"],
    properties: {
      plugin: { type: "string", maxLength: 128 },
      artifact: { type: "string", pattern: "^[a-f0-9]{16}([a-f0-9]{48})?$" },
      action: { type: "string", enum: ["list", "describe", "call"] },
      server: { type: "string", maxLength: 64 },
      tool: { type: "string", maxLength: 256 },
      cursor: { type: "string", maxLength: 4096 },
      limit: { type: "integer", minimum: 1, maximum: 32 },
      pin: { type: "string", pattern: "^[a-f0-9]{16}$" },
      schema_pin: { type: "string", maxLength: 128 },
      config_pin: { type: "string", maxLength: 128 },
      arguments: { type: "object" },
    },
    oneOf: [
      { properties: { action: { enum: ["list"] }, pin: false } },
      {
        properties: { action: { enum: ["describe"] }, pin: false },
        required: ["server"],
      },
      {
        properties: {
          action: { enum: ["call"] },
          server: false,
          tool: false,
          config_pin: false,
          schema_pin: false,
        },
        required: ["pin"],
      },
      {
        properties: { action: { enum: ["call"] }, pin: false },
        required: ["server", "tool", "config_pin", "schema_pin"],
      },
    ],
  },
};
export function parseToolRequest(value: unknown): PluginToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Plugin request must be an object");
  const p = value as Record<string, Json>;
  const fields = [
    "plugin",
    "action",
    "artifact",
    "server",
    "tool",
    "cursor",
    "limit",
    "pin",
    "schema_pin",
    "config_pin",
    "arguments",
  ];
  if (
    Object.keys(p).some((k) => !fields.includes(k)) ||
    typeof p.plugin !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.plugin) ||
    typeof p.artifact !== "string" ||
    !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(p.artifact) ||
    typeof p.action !== "string" ||
    !["list", "describe", "call"].includes(p.action)
  )
    throw Error("Invalid plugin request identity/action");
  for (const [k, max] of [
    ["server", 64],
    ["tool", 256],
    ["cursor", 4096],
    ["schema_pin", 128],
    ["config_pin", 128],
  ] as const)
    if (
      p[k] !== undefined &&
      (typeof p[k] !== "string" || !p[k] || p[k].length > max)
    )
      throw Error("Invalid plugin request field");
  if (
    p.limit !== undefined &&
    (!Number.isSafeInteger(p.limit) ||
      Number(p.limit) < 1 ||
      Number(p.limit) > 32)
  )
    throw Error("Plugin page limit must be 1..32");
  if (
    p.arguments !== undefined &&
    (!p.arguments ||
      typeof p.arguments !== "object" ||
      Array.isArray(p.arguments))
  )
    throw Error("Plugin arguments must be an object");
  if (
    p.pin !== undefined &&
    (p.action !== "call" ||
      typeof p.pin !== "string" ||
      !/^[a-f0-9]{16}$/.test(p.pin))
  )
    throw Error(
      "A call pin must be 16 lowercase hexadecimal characters and used only with call",
    );
  if (
    p.pin !== undefined &&
    ["server", "tool", "config_pin", "schema_pin"].some(
      (field) => p[field] !== undefined,
    )
  )
    throw Error(
      "A call pin conflicts with supplied target fields; use only pin and arguments plus plugin/artifact",
    );
  if (p.action === "describe" && !p.server)
    throw Error("An exact server is required");
  if (p.action === "call" && !p.pin && (!p.server || !p.tool))
    throw Error("An exact server and tool are required");
  if (p.action === "call" && !p.pin && (!p.schema_pin || !p.config_pin))
    throw Error(
      "Describe the exact tool first; schema and configuration pins are required",
    );
  if (new TextEncoder().encode(JSON.stringify(p)).length > 64 * 1024)
    throw Error("Plugin request exceeds 64 KiB");
  return p as unknown as PluginToolRequest;
}
export function identityKey(i: PluginToolIdentity): string {
  return JSON.stringify([
    i.invocation_id,
    i.session_id,
    i.parent_session_id,
    i.call_id,
    i.catalog_digest,
    i.epoch,
    i.turn_id,
    i.round_id,
    i.history_anchor,
    i.deadline_ms,
    i.artifact,
    i.generation,
    i.history_generation,
  ]);
}
