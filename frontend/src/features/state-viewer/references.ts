import { own, record } from "../../client/state-inspection";
import { referenceLabels, type ReferenceKind } from "../referenceLabels";

type Slot = {
  record: Record<string, unknown>;
  field: string;
  path: readonly string[];
  kind: ReferenceKind;
};

/** Owner inspection descriptors certify the producer. Never inspect custom
 * values, reference metadata, execution output, or generic nested objects. */
export function stateReferenceProjection(
  key: string,
  kind: unknown,
  value: unknown,
  report?: (path: readonly string[], exact: string, label: string) => void,
): unknown {
  const slots: Slot[] = [];
  const add = (
    item: unknown,
    field: string,
    parent: readonly string[] = [],
    kind: ReferenceKind = "digest",
  ) => {
    const row = record(item);
    if (row && typeof own(row, field) === "string")
      slots.push({ record: row, field, path: [...parent, field], kind });
  };
  const list = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];
  if (kind === "reference") {
    list(value).forEach((row, index) => {
      add(row, "content_digest", [String(index)]);
      add(row, "revision", [String(index)]);
    });
  } else if (kind === "framework" && key === "agent_init") {
    add(value, "component");
    list(own(record(value), "cache_points")).forEach((point, index) => {
      const parent = ["cache_points", String(index)];
      add(point, "version", parent);
      add(point, "call_id", parent, "init-call");
    });
  } else if (kind === "framework" && key === "executions") {
    list(value).forEach((execution, index) => {
      const subject = own(record(execution), "subject");
      if (own(record(subject), "kind") === "agent_init") {
        const key = String(index);
        add(subject, "component", [key, "subject"]);
        add(execution, "call_id", [key], "init-call");
      }
    });
  }
  if (!slots.length) return value;
  const labelers = new Map<ReferenceKind, ReturnType<typeof referenceLabels>>();
  for (const kind of new Set(slots.map((slot) => slot.kind)))
    labelers.set(
      kind,
      referenceLabels(
        kind,
        slots
          .filter((slot) => slot.kind === kind)
          .map(({ record, field }) => record[field]),
      ),
    );
  const patches = new Map<object, Record<string, string>>();
  for (const slot of slots) {
    const exact = slot.record[slot.field] as string;
    const label = labelers.get(slot.kind)!(exact);
    if (label !== exact) {
      report?.(slot.path, exact, label);
      const fields = patches.get(slot.record) ?? {};
      fields[slot.field] = label;
      patches.set(slot.record, fields);
    }
  }
  if (!patches.size) return value;
  // Traverse only the typed path prefixes. Untouched child objects (including
  // custom reference metadata and execution results) keep exact identity.
  const patch = (value: unknown) => {
    const row = record(value);
    return row && patches.has(row) ? { ...row, ...patches.get(row) } : value;
  };
  if (kind === "reference") return list(value).map(patch);
  if (key === "agent_init") {
    const row = record(patch(value))!;
    return Array.isArray(row.cache_points)
      ? { ...row, cache_points: row.cache_points.map(patch) }
      : row;
  }
  return list(value).map((execution) => {
    const row = record(patch(execution));
    if (!row) return execution;
    const subject = patch(row.subject);
    return subject === row.subject ? row : { ...row, subject };
  });
}
