/** Bounded diagnostic descriptions, never raw bodies, DTOs or live Error objects.
 * Producers exclude sensitive content before calling this defensive sanitizer. */
const encoder = new TextEncoder();
const seen = new WeakSet<object>();
const SCAN_BYTES = 16 * 1024;
const REDACTED = "[redacted]";

function prefix(text: string, maximum: number): string {
  let bytes = 0;
  let end = 0;
  for (const scalar of text) {
    const width = encoder.encode(scalar).length;
    if (bytes + width > maximum) break;
    bytes += width;
    end += scalar.length;
  }
  return text.slice(0, end);
}
function valueEnd(text: string, start: number, header: boolean): number {
  if (header) {
    const end = text.slice(start).search(/[\r\n]/u);
    return end < 0 ? text.length : start + end;
  }
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") {
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === "\\") at++;
      else if (text[at] === first) return at + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let at = start; at < text.length; at++) {
      if (text[at] === '"' || text[at] === "'") {
        at = valueEnd(text, at, false) - 1;
      } else if (text[at] === "{" || text[at] === "[") depth++;
      else if ((text[at] === "}" || text[at] === "]") && --depth === 0)
        return at + 1;
    }
    return text.length;
  }
  const end = text.slice(start).search(/[\s,;&}\]]/u);
  return end < 0 ? text.length : start + end;
}
const sensitive =
  /^(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|api_?key|token|access_token|refresh_token|id_token|client_secret|jwt_secret|pairing_token|credential|credentials|capability|execute_capability|secret|code|state|nonce|code_verifier|id_token_hint|.*_(?:secret|token|credential))$/iu;
const body =
  /^(?:body|request_body|response_body|payload|prompt|user_input|arguments|tool_args|content|old_string|new_string)$/iu;
function sanitize(text: string): string {
  const input = prefix(text, SCAN_BYTES);
  let output = "";
  let at = 0;
  while (at < input.length) {
    const rest = input.slice(at);
    if (rest.startsWith(REDACTED)) {
      output += REDACTED;
      at += REDACTED.length;
      continue;
    }
    if (rest.startsWith("-----BEGIN")) {
      output += REDACTED;
      break;
    }
    const url = /^(?:https?|wss?):\/\/[^\s"'`)>]+/iu.exec(rest)?.[0];
    if (url) {
      output += url
        .replace(/(\/\/)[^/?#]*@/u, `$1${REDACTED}@`)
        .replace(/[?#].*$/u, `?${REDACTED}`);
      at += url.length;
      continue;
    }
    const auth = /^(?:Bearer|Basic)\s+/iu.exec(rest)?.[0];
    if (auth) {
      output += auth + REDACTED;
      at = valueEnd(input, at + auth.length, false);
      continue;
    }
    const token = /^(?:sk-|ghp_|github_pat_|eyJ)[A-Za-z0-9_.-]{16,}/u.exec(
      rest,
    )?.[0];
    if (token) {
      output += REDACTED;
      at += token.length;
      continue;
    }
    const label =
      /^(?:["'`])?(--)?([A-Za-z_][A-Za-z0-9_-]*)(?:["'`])?(\s*[:=]\s*|\s+)/u.exec(
        rest,
      );
    if (label) {
      const key = label[2].replace(/-/gu, "_");
      const assignment = /[:=]/u.test(label[3]) || !!label[1];
      if (assignment && (sensitive.test(key) || body.test(key))) {
        output += label[0] + REDACTED;
        const start = at + label[0].length;
        at = valueEnd(
          input,
          start,
          /^(?:authorization|proxy_authorization|cookie|set_cookie)$/iu.test(
            key,
          ),
        );
        if (body.test(key) && !/^["'`{\[]/u.test(input.slice(start)))
          at = input.length;
        continue;
      }
    }
    const scalar = String.fromCodePoint(input.codePointAt(at)!);
    output += scalar;
    at += scalar.length;
  }
  const cleaned = output.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
    "",
  );
  return input.length < text.length ? `${cleaned}…` : cleaned;
}
export function diagnosticText(value: unknown, maximum = 2048): string {
  const cap = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 0;
  if (!cap || typeof value !== "string") return "";
  const text = sanitize(value);
  if (encoder.encode(text).length <= cap) return text;
  return cap < 3 ? prefix(text, cap) : `${prefix(text, cap - 3)}…`;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function diagnosticMessage(error: unknown): string {
  // Browser JSON parsers can quote the rejected document in SyntaxError.message.
  // Keep parse coordinates when available, never that quoted document.
  if (error instanceof SyntaxError) {
    const position = /(?:position\s+\d+|line\s+\d+\s+column\s+\d+)/iu.exec(
      error.message,
    )?.[0];
    return position
      ? `Invalid JSON syntax at ${position}`
      : "Invalid JSON syntax";
  }
  return diagnosticText(
    typeof error === "string" ? error : record(error)?.message,
  );
}
const numeric = new Set([
  "calls",
  "required_bytes",
  "budget_bytes",
  "required_count",
  "budget_count",
  "line",
  "column",
  "json_line",
  "json_column",
  "provider_status",
  "timeout_ms",
  "elapsed_ms",
  "first_token_ms",
  "streamed_bytes",
  "streamed_chars",
  "requested_timeout_ms",
  "effective_timeout_ms",
  "close_code",
  "attempt",
  "retry_delay_ms",
  "suppressed_count",
  "buffered_bytes",
]);
const descriptions = new Set([
  "reason",
  "kind",
  "category",
  "provider_type",
  "provider_code",
  "tool_code",
  "cause",
  "operation",
  "stage",
  "phase",
  "finish_reason",
  "block_reason",
  "cancel_reason",
  "host_detach_code",
  "host_transport",
  "fallback_carrier",
  "code",
  "message",
  "layer",
  "effects",
  "operation_effects",
  "limit_owner",
  "evidence_id",
]);
/** Closed scalar facts and one nested diagnostic, with independent zero/signed OS values. */
export function diagnosticDetails(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  if (!source) return result;
  for (const key of numeric) {
    const fact = source[key];
    if (typeof fact === "number" && Number.isSafeInteger(fact) && fact >= 0)
      result[key] = fact;
  }
  if (
    typeof source.raw_os_error === "number" &&
    Number.isSafeInteger(source.raw_os_error)
  )
    result.raw_os_error = source.raw_os_error;
  for (const key of descriptions)
    if (typeof source[key] === "string")
      result[key] = diagnosticText(source[key], 512);
  for (const key of ["pre_effect", "retryable", "outcome_unknown"])
    if (typeof source[key] === "boolean") result[key] = source[key];
  if (Array.isArray(source.causes))
    result.causes = source.causes
      .slice(0, 8)
      .filter((cause): cause is string => typeof cause === "string")
      .map((cause) => diagnosticText(cause, 256));
  const nested = record(source.diagnostic);
  if (nested) {
    // Explicitly stop nesting before projecting the same closed scalar vocabulary.
    const scalars: Record<string, unknown> = {};
    for (const key of [
      ...numeric,
      ...descriptions,
      "raw_os_error",
      "pre_effect",
      "retryable",
      "causes",
    ])
      if (Object.hasOwn(nested, key)) scalars[key] = nested[key];
    result.diagnostic = diagnosticDetails(scalars);
  }
  return result;
}
export function silenceDiagnostic(error: unknown): void {
  if (error && (typeof error === "object" || typeof error === "function"))
    seen.add(error);
}
export function reportDiagnostic(
  source: string,
  method: string,
  error: unknown,
  status?: number,
  level: "error" | "warn" | "info" = "error",
): void {
  if (error && (typeof error === "object" || typeof error === "function")) {
    if (seen.has(error)) return;
    seen.add(error);
  }
  const raw = record(error);
  const snapshot: Record<string, unknown> = {
    source: diagnosticText(source, 128),
    method: diagnosticText(method, 128),
    message: diagnosticMessage(error),
  };
  if (typeof raw?.code === "string")
    snapshot.code = diagnosticText(raw.code, 128);
  if (Number.isSafeInteger(status) && status! >= 100 && status! <= 599)
    snapshot.status = status;
  if (raw?.details) snapshot.details = diagnosticDetails(raw.details);
  console[level]("[microcrab diagnostic]", snapshot);
}
