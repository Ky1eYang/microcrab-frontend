export const LIMITS = {
  bytes: 32768,
  depth: 12,
  series: 16,
  points: 4000,
  mermaidBytes: 12000,
  mermaidLines: 160,
  mathBytes: 4096,
} as const;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function keys(v: unknown, allowed: string[]): asserts v is Record<string, any> {
  if (!record(v) || Object.keys(v).some((k) => !allowed.includes(k)))
    throw Error("Unsupported option");
}
/** Deliberately small, data-only chart schema. No formatter, resource or HTML surfaces. */
export function chartOption(source: string): Record<string, any> | null {
  try {
    if (bytes(source) > LIMITS.bytes) return null;
    const value = JSON.parse(source);
    let nodes = 0;
    const visit = (v: any, depth = 0) => {
      if (++nodes > 24000 || depth > LIMITS.depth) throw Error("Budget");
      if (
        typeof v === "string" &&
        (v.length > 2000 ||
          /[<>]|(?:https?|data|javascript|file|blob):|\/\/|url\s*\(|image:\/\//i.test(
            v,
          ))
      )
        throw Error("Resource");
      if (typeof v === "number" && (!Number.isFinite(v) || Math.abs(v) > 1e12))
        throw Error("Number");
      if (v && typeof v === "object")
        Object.entries(v).forEach(([k, x]) => {
          if (["__proto__", "constructor", "prototype"].includes(k))
            throw Error("Key");
          visit(x, depth + 1);
        });
    };
    visit(value);
    keys(value, [
      "title",
      "legend",
      "tooltip",
      "xAxis",
      "yAxis",
      "series",
      "dataZoom",
    ]);
    if (value.title) {
      keys(value.title, ["text", "subtext"]);
      if (Object.values(value.title).some((v) => typeof v !== "string"))
        return null;
    }
    if (value.legend) {
      keys(value.legend, ["show", "data"]);
      if (value.legend.show != null && typeof value.legend.show !== "boolean")
        return null;
      if (
        value.legend.data &&
        (!Array.isArray(value.legend.data) ||
          value.legend.data.length > 64 ||
          value.legend.data.some((v: any) => typeof v !== "string"))
      )
        return null;
    }
    if (value.tooltip) {
      keys(value.tooltip, ["show", "trigger"]);
      if (value.tooltip.show != null && typeof value.tooltip.show !== "boolean")
        return null;
      if (
        value.tooltip.trigger &&
        !["axis", "item", "none"].includes(value.tooltip.trigger)
      )
        return null;
      value.tooltip = {
        ...value.tooltip,
        renderMode: "richText",
        confine: true,
      };
    }
    for (const axis of [value.xAxis, value.yAxis])
      if (axis) {
        keys(axis, ["type", "name", "data", "min", "max"]);
        if (axis.type && !["category", "value"].includes(axis.type))
          return null;
        if (axis.name != null && typeof axis.name !== "string") return null;
        for (const k of ["min", "max"])
          if (axis[k] != null && typeof axis[k] !== "number") return null;
        if (
          axis.data &&
          (!Array.isArray(axis.data) ||
            axis.data.length > LIMITS.points ||
            axis.data.some(
              (x: any) => !["string", "number"].includes(typeof x),
            ))
        )
          return null;
      }
    if (
      !Array.isArray(value.series) ||
      !value.series.length ||
      value.series.length > LIMITS.series
    )
      return null;
    let points = 0;
    for (const series of value.series) {
      keys(series, ["name", "type", "data", "stack", "smooth"]);
      if (
        !["line", "bar", "scatter", "pie"].includes(series.type) ||
        !Array.isArray(series.data)
      )
        return null;
      if (
        (series.name != null && typeof series.name !== "string") ||
        (series.stack != null && typeof series.stack !== "string") ||
        (series.smooth != null && typeof series.smooth !== "boolean")
      )
        return null;
      points += series.data.length;
      if (points > LIMITS.points) return null;
      for (const point of series.data) {
        if (point === null || typeof point === "number") continue;
        if (
          Array.isArray(point) &&
          point.length === 2 &&
          point.every((x) => typeof x === "number")
        )
          continue;
        keys(point, ["name", "value"]);
        if (typeof point.name !== "string" || typeof point.value !== "number")
          return null;
      }
      Object.assign(series, { animation: false, progressive: 0 });
    }
    if (value.dataZoom) {
      if (!Array.isArray(value.dataZoom) || value.dataZoom.length > 2)
        return null;
      for (const zoom of value.dataZoom) {
        keys(zoom, ["type", "start", "end"]);
        if (!["inside", "slider"].includes(zoom.type)) return null;
        for (const k of ["start", "end"])
          if (
            zoom[k] != null &&
            (typeof zoom[k] !== "number" || zoom[k] < 0 || zoom[k] > 100)
          )
            return null;
      }
    }
    return { ...value, animation: false };
  } catch {
    return null;
  }
}
export function safeMermaid(source: string): boolean {
  return (
    bytes(source) <= LIMITS.mermaidBytes &&
    source.split(/\r?\n/).length <= LIMITS.mermaidLines &&
    /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?)\b/.test(
      source.trim(),
    ) &&
    !/%%|<|\b(?:click|href|link|style|classDef|linkStyle|init|config|image|icon)\b|(?:https?|data|javascript|file|blob):|\/\//i.test(
      source,
    ) &&
    (source.match(/--|==|->|\[|\(/g)?.length ?? 0) <= 240
  );
}
/** Node offsets include opening/closing fence. No debounce can certify completion. */
export function closedFence(source: string): boolean {
  const lines = source.trimEnd().split(/\r?\n/);
  const open = /^ {0,3}(`{3,}|~{3,})[^`~]*$/.exec(lines[0] ?? "");
  if (!open || lines.length < 2) return false;
  return new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}\\s*$`).test(
    lines.at(-1)!,
  );
}
export function safeMath(source: string): boolean {
  return (
    bytes(source) <= LIMITS.mathBytes &&
    !/\\(?:href|url|includegraphics|html\w*|def|gdef|edef|newcommand|renewcommand|require)\b/i.test(
      source,
    )
  );
}
