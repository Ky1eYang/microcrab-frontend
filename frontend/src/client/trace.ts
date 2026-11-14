// Bounded, in-memory diagnostics only. Never pass DTOs, URLs, paths or bodies.
export interface TraceFields {
  requestId?: string;
  interactionId?: string;
  operationId?: string;
  sessionId?: string;
  projectId?: string;
  method?: string;
  transport?: "http" | "ws" | "host";
  outcome?: "started" | "succeeded" | "failed" | "stale" | "cancelled";
  code?: string;
  elapsedMs?: number;
  count?: number;
  status?: number;
}
export interface TraceEntry extends TraceFields {
  at: string;
  stage: string;
}
const entries: TraceEntry[] = [];
export function traceEvent(stage: string, fields: TraceFields = {}) {
  const entry: TraceEntry = {
    at: new Date().toISOString(),
    stage: stage.slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_"),
  };
  const allowed: (keyof TraceFields)[] = [
    "requestId",
    "interactionId",
    "operationId",
    "sessionId",
    "projectId",
    "method",
    "transport",
    "outcome",
    "code",
    "elapsedMs",
    "count",
    "status",
  ];
  for (const key of allowed) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === "string")
      (entry as unknown as Record<string, unknown>)[key] = value
        .slice(0, 128)
        .replace(/[^a-zA-Z0-9_./:-]/g, "_");
    else if (typeof value === "number" && Number.isFinite(value))
      (entry as unknown as Record<string, unknown>)[key] = Math.max(
        0,
        Math.round(value),
      );
  }
  entries.push(entry);
  if (entries.length > 256) entries.splice(0, entries.length - 256);
  console.debug("[microcrab trace]", entry);
}
/** A safe ring for DevTools/diagnostic tooling; no persistent storage or upload. */
export function diagnosticTrace(): readonly TraceEntry[] {
  return entries.map((entry) => ({ ...entry }));
}
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__microcrabTrace", {
    value: diagnosticTrace,
    configurable: true,
  });
}
