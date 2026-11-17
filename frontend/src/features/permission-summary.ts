/**
 * Tool-generic "Will run" summary for permission cards.
 *
 * The summary is driven only by an optional schema annotation and by the
 * shape of the arguments. It never branches on the tool name.
 *
 *   { "x-microcrab-summary": { "arg": "command", "kind": "command" } }
 *
 * The annotation may sit on the schema root (with `arg`) or on a property
 * (where `arg` defaults to that property's name, and `true` means kind text).
 */
export type SummaryKind = "command" | "path" | "url" | "text";
export const SUMMARY_ANNOTATION = "x-microcrab-summary";
export const SUMMARY_FIELD_MAX = 200;
export const SUMMARY_ARGUMENTS_MAX_CHARS = 2048;
export const SUMMARY_ARGUMENTS_MAX_LINES = 12;

export interface PermissionSummary {
  /** Presentation hint; `arguments` is the full-arguments fallback. */
  kind: SummaryKind | "arguments";
  text: string;
  /** Present when the value came from a single argument field. */
  arg?: string;
  source: "annotation" | "field" | "arguments";
  truncated: boolean;
}

const KINDS = new Set<SummaryKind>(["command", "path", "url", "text"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function annotationValue(
  raw: unknown,
  fallbackArg?: string,
): { arg: string; kind: SummaryKind } | null {
  if (raw === true && fallbackArg) return { arg: fallbackArg, kind: "text" };
  if (!plainObject(raw)) return null;
  const arg =
    typeof raw.arg === "string" && raw.arg ? raw.arg : (fallbackArg ?? "");
  if (!arg) return null;
  const kind =
    typeof raw.kind === "string" && KINDS.has(raw.kind as SummaryKind)
      ? (raw.kind as SummaryKind)
      : "text";
  return { arg, kind };
}

/** Read the optional vendor annotation from a JSON schema, if any. */
export function readSummaryAnnotation(
  schema: unknown,
): { arg: string; kind: SummaryKind } | null {
  if (!plainObject(schema)) return null;
  const root = annotationValue(schema[SUMMARY_ANNOTATION]);
  if (root) return root;
  const properties = schema.properties;
  if (!plainObject(properties)) return null;
  for (const [name, property] of Object.entries(properties)) {
    if (!plainObject(property)) continue;
    const found = annotationValue(property[SUMMARY_ANNOTATION], name);
    if (found) return found;
  }
  return null;
}

/** Long unbroken alphabet runs or data URLs read as payload blobs, not intent. */
export function looksLikeBlob(value: string) {
  if (/^data:[^,]*;base64,/i.test(value)) return true;
  return /^[A-Za-z0-9+/=_-]{48,}$/.test(value);
}

function shortField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= SUMMARY_FIELD_MAX &&
    !/[\r\n]/.test(value) &&
    !looksLikeBlob(value)
  );
}

function clampArguments(text: string) {
  let result = text;
  let truncated = false;
  const lines = result.split("\n");
  if (lines.length > SUMMARY_ARGUMENTS_MAX_LINES) {
    result = lines.slice(0, SUMMARY_ARGUMENTS_MAX_LINES).join("\n");
    truncated = true;
  }
  if (result.length > SUMMARY_ARGUMENTS_MAX_CHARS) {
    result = result.slice(0, SUMMARY_ARGUMENTS_MAX_CHARS);
    truncated = true;
  }
  return { text: truncated ? `${result.trimEnd()}…` : result, truncated };
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text || text === "{}" || text === "[]") return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Summarize what an approved call will execute. Returns null when there is
 * nothing meaningful to show (the folded JSON remains the full record).
 */
export function permissionSummary(
  args: unknown,
  schema?: unknown,
): PermissionSummary | null {
  const annotation = readSummaryAnnotation(schema);
  if (annotation && plainObject(args)) {
    const value = args[annotation.arg];
    if (typeof value === "string" && value.trim()) {
      const { text, truncated } = clampArguments(value);
      return {
        kind: annotation.kind,
        text,
        arg: annotation.arg,
        source: "annotation",
        truncated,
      };
    }
  }
  if (plainObject(args)) {
    for (const [arg, value] of Object.entries(args))
      if (shortField(value))
        return {
          kind: "text",
          text: value,
          arg,
          source: "field",
          truncated: false,
        };
  }
  const full = serialize(args);
  if (full === null) return null;
  const { text, truncated } = clampArguments(full);
  return { kind: "arguments", text, source: "arguments", truncated };
}

/** Look up a tool's input schema in a catalog of `{ name, parameters | input_schema | inputSchema }`. */
export function toolInputSchema(
  catalog: readonly unknown[] | undefined | null,
  tool: string,
): unknown {
  for (const entry of catalog ?? []) {
    if (!plainObject(entry) || entry.name !== tool) continue;
    return entry.input_schema ?? entry.inputSchema ?? entry.parameters;
  }
  return undefined;
}
