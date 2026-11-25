// These are display labels, never identifiers or accepted argument values. Each
// caller supplies canonical values from one known field/domain and observed set.
export type ReferenceKind =
  "digest" | "host" | "session" | "message" | "init-call";

function splitReference(kind: ReferenceKind, value: string) {
  const pattern = {
    digest: /^()([0-9a-f]{64})(?![\s\S])/i,
    host: /^(device-)([0-9a-f]{64})(?![\s\S])/,
    session: /^()([0-9a-f]{32})(?![\s\S])/,
    message: /^(msg_)([0-9a-f]{64})(?![\s\S])/,
    "init-call": /^(agent-init:[1-9]\d{0,19}:[1-9]\d{0,19}:)([0-9a-f]{64})(?![\s\S])/i,
  }[kind];
  const m = pattern.exec(value);
  return m && { prefix: m[1], hex: m[2].toLowerCase() };
}

/** Distinguish peers with 16/20/24 hex, then a base-36 ordinal in exact sorted
 * order. The ordinal is local to the observed set, not a durable reference. */
export function referenceLabels(
  kind: ReferenceKind,
  values: Iterable<unknown>,
): (value: string) => string {
  const groups = new Map<
    string,
    { value: string; hex: string; prefix: string }[]
  >();
  for (const value of new Set(values)) {
    if (typeof value !== "string") continue;
    const parts = splitReference(kind, value);
    if (!parts) continue;
    const key = parts.prefix + parts.hex.slice(0, 16);
    const group = groups.get(key) ?? [];
    group.push({ value, ...parts });
    groups.set(key, group);
  }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const { hex } of group) {
      for (const length of [20, 24]) {
        const key = hex.slice(0, length);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    group.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const ranks = new Map<string, number>();
    for (const { value, prefix, hex } of group) {
      const length =
        group.length === 1 ? 16 : counts.get(hex.slice(0, 20)) === 1 ? 20 : 24;
      const stem = hex.slice(0, length);
      let suffix = "";
      if (length === 24 && counts.get(stem)! > 1) {
        const ordinal = (ranks.get(stem) ?? 0) + 1;
        ranks.set(stem, ordinal);
        suffix = `~${ordinal.toString(36)}`;
      }
      labels.set(value, `${prefix}${stem}…${suffix}`);
    }
  }
  return (value) => {
    const parts = splitReference(kind, value);
    return labels.get(value) ?? (parts ? `${parts.prefix}${parts.hex.slice(0, 16)}…` : value);
  };
}

export function referenceLabel(kind: ReferenceKind, value: string): string {
  return referenceLabels(kind, [value])(value);
}
