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
export function chartOptionDiagnostic(source: string): {
  option: Record<string, any> | null;
  error?: string;
} {
  try {
    if (bytes(source) > LIMITS.bytes) {
      return { option: null, error: "visual.error.budgetExceeded" };
    }
    let value: any;
    try {
      value = JSON.parse(source);
    } catch {
      return { option: null, error: "visual.error.invalidJson" };
    }
    if (!record(value)) {
      return { option: null, error: "visual.error.unsupported" };
    }

    let nodes = 0;
    try {
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
        if (
          typeof v === "number" &&
          (!Number.isFinite(v) || Math.abs(v) > 1e12)
        )
          throw Error("Number");
        if (v && typeof v === "object")
          Object.entries(v).forEach(([k, x]) => {
            if (["__proto__", "constructor", "prototype"].includes(k))
              throw Error("Key");
            visit(x, depth + 1);
          });
      };
      visit(value);
    } catch (e: any) {
      if (e?.message === "Resource" || e?.message === "Key") {
        return { option: null, error: "visual.error.unsafeContent" };
      }
      return { option: null, error: "visual.error.budgetExceeded" };
    }

    // Compatibility may omit passive unsupported styling, never authored data.
    // Reject the complete preview before sanitizing if its bounded projection
    // would lose series, points, categories, axes or zoom controls.
    if (Array.isArray(value.series) && value.series.length > LIMITS.series)
      return { option: null, error: "visual.error.budgetExceeded" };
    let pointCount = 0;
    if (Array.isArray(value.series)) {
      for (const series of value.series) {
        if (
          !record(series) ||
          !["line", "bar", "scatter", "pie"].includes(series.type) ||
          !Array.isArray(series.data)
        )
          return { option: null, error: "visual.error.unsupported" };
        pointCount += series.data.length;
        if (pointCount > LIMITS.points)
          return { option: null, error: "visual.error.budgetExceeded" };
        if (
          series.data.some(
            (point: any) =>
              !(
                point === null ||
                typeof point === "number" ||
                (Array.isArray(point) &&
                  point.length === 2 &&
                  point.every((item: any) => typeof item === "number")) ||
                (record(point) &&
                  typeof point.name === "string" &&
                  typeof point.value === "number")
              ),
          )
        )
          return { option: null, error: "visual.error.unsupported" };
      }
    }
    for (const axis of [value.xAxis, value.yAxis]) {
      if (Array.isArray(axis) && axis.length > 2)
        return { option: null, error: "visual.error.budgetExceeded" };
      for (const entry of Array.isArray(axis)
        ? axis
        : axis == null
          ? []
          : [axis]) {
        if (!record(entry))
          return { option: null, error: "visual.error.unsupported" };
        if (Array.isArray(entry.data) && entry.data.length > LIMITS.points)
          return { option: null, error: "visual.error.budgetExceeded" };
        if (
          entry.data !== undefined &&
          (!Array.isArray(entry.data) ||
            entry.data.some(
              (item: any) => !["string", "number"].includes(typeof item),
            ))
        )
          return { option: null, error: "visual.error.unsupported" };
      }
    }
    if (Array.isArray(value.dataZoom)) {
      if (value.dataZoom.length > 2)
        return { option: null, error: "visual.error.budgetExceeded" };
      if (
        value.dataZoom.some(
          (zoom: any) =>
            !record(zoom) || !["inside", "slider"].includes(zoom.type),
        )
      )
        return { option: null, error: "visual.error.unsupported" };
    }
    const sanitized: Record<string, any> = {};

    // 1. title: ignore unsupported fields, keep text and subtext
    if (record(value.title)) {
      const title: Record<string, string> = {};
      if (typeof value.title.text === "string") title.text = value.title.text;
      if (typeof value.title.subtext === "string")
        title.subtext = value.title.subtext;
      if (Object.keys(title).length > 0) sanitized.title = title;
    }

    // 2. legend: keep show, data
    if (record(value.legend)) {
      const legend: Record<string, any> = {};
      if (typeof value.legend.show === "boolean")
        legend.show = value.legend.show;
      if (
        Array.isArray(value.legend.data) &&
        value.legend.data.length <= 64 &&
        value.legend.data.every((v: any) => typeof v === "string")
      ) {
        legend.data = value.legend.data;
      }
      if (Object.keys(legend).length > 0) sanitized.legend = legend;
    }

    // 3. tooltip: keep show, trigger
    if (record(value.tooltip)) {
      const tooltip: Record<string, any> = {
        renderMode: "richText",
        confine: true,
      };
      if (typeof value.tooltip.show === "boolean")
        tooltip.show = value.tooltip.show;
      if (["axis", "item", "none"].includes(value.tooltip.trigger)) {
        tooltip.trigger = value.tooltip.trigger;
      }
      sanitized.tooltip = tooltip;
    }

    // 4. xAxis and yAxis: support single object or array (e.g. dual Y axes), ignore extra fields
    const sanitizeAxis = (axisInput: any) => {
      if (!axisInput) return undefined;
      const cleanSingle = (a: any) => {
        const cleaned: Record<string, any> = {};
        if (a.type && ["category", "value"].includes(a.type))
          cleaned.type = a.type;
        if (typeof a.name === "string") cleaned.name = a.name;
        if (typeof a.min === "number") cleaned.min = a.min;
        if (typeof a.max === "number") cleaned.max = a.max;
        if (
          Array.isArray(a.data) &&
          a.data.length <= LIMITS.points &&
          a.data.every((x: any) => ["string", "number"].includes(typeof x))
        ) {
          cleaned.data = a.data;
        }
        return cleaned;
      };

      if (Array.isArray(axisInput)) {
        return axisInput.map(cleanSingle);
      }
      return cleanSingle(axisInput);
    };

    const cleanXAxis = sanitizeAxis(value.xAxis);
    if (cleanXAxis) sanitized.xAxis = cleanXAxis;
    const cleanYAxis = sanitizeAxis(value.yAxis);
    if (cleanYAxis) sanitized.yAxis = cleanYAxis;

    // 5. series: mandatory, sanitize each series and its data
    if (!Array.isArray(value.series) || value.series.length === 0) {
      return { option: null, error: "visual.error.missingSeries" };
    }
    const cleanSeriesList: any[] = [];
    for (const s of value.series) {
      const cleanedSeries: Record<string, any> = {
        type: s.type,
        animation: false,
        progressive: 0,
      };
      if (typeof s.name === "string") cleanedSeries.name = s.name;
      if (typeof s.stack === "string") cleanedSeries.stack = s.stack;
      if (typeof s.smooth === "boolean") cleanedSeries.smooth = s.smooth;
      if (typeof s.yAxisIndex === "number")
        cleanedSeries.yAxisIndex = s.yAxisIndex;
      if (typeof s.xAxisIndex === "number")
        cleanedSeries.xAxisIndex = s.xAxisIndex;
      if (typeof s.symbolSize === "number")
        cleanedSeries.symbolSize = s.symbolSize;

      const cleanData: any[] = [];
      for (const point of s.data) {
        if (point === null || typeof point === "number") {
          cleanData.push(point);
        } else if (
          Array.isArray(point) &&
          point.length === 2 &&
          point.every((x: any) => typeof x === "number")
        ) {
          cleanData.push(point);
        } else if (
          record(point) &&
          typeof point.name === "string" &&
          typeof point.value === "number"
        ) {
          cleanData.push({ name: point.name, value: point.value });
        }
      }
      cleanedSeries.data = cleanData;
      cleanSeriesList.push(cleanedSeries);
    }

    sanitized.series = cleanSeriesList;

    // 6. dataZoom: keep type, start, end
    if (Array.isArray(value.dataZoom)) {
      const cleanZooms = value.dataZoom.map((z: any) => {
        const cleanZ: Record<string, any> = { type: z.type };
        if (typeof z.start === "number" && z.start >= 0 && z.start <= 100)
          cleanZ.start = z.start;
        if (typeof z.end === "number" && z.end >= 0 && z.end <= 100)
          cleanZ.end = z.end;
        return cleanZ;
      });
      if (cleanZooms.length > 0) sanitized.dataZoom = cleanZooms;
    }

    sanitized.animation = false;
    return { option: sanitized };
  } catch {
    return { option: null, error: "visual.error.unsupported" };
  }
}

/** Deliberately small, data-only chart schema. No formatter, resource or HTML surfaces. */
export function chartOption(source: string): Record<string, any> | null {
  return chartOptionDiagnostic(source).option;
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
