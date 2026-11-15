type Option = Record<string, any>;
type Zoom = { start: number; end: number };
/** Only bounded UI choices live at the CodeBlock owner, never chart data/engine objects. */
export class ChartInteractions {
  identity: string | null = null;
  selected: Record<string, boolean> = {};
  zoom: Zoom[] = [];
  private revision = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  private publish() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  ensure(identity: string) {
    if (this.identity === identity) return;
    this.identity = identity;
    this.selected = {};
    this.zoom = [];
    this.publish();
  }
  capture(identity: string, option: Option, rendered: Option) {
    if (this.identity !== identity) return;
    const names = [
      ...new Set<string>([
        ...(option.legend?.data ?? []),
        ...option.series
          .flatMap((series: Option) => [
            series.name,
            ...(series.type === "pie"
              ? series.data.map((point: any) => point?.name)
              : []),
          ])
          .filter((name: unknown) => typeof name === "string"),
      ]),
    ].slice(0, 4080);
    const selection = rendered.legend?.[0]?.selected;
    const selected = Object.fromEntries(
      names
        .filter(
          (name) =>
            !["__proto__", "prototype", "constructor"].includes(name) &&
            typeof selection?.[name] === "boolean",
        )
        .map((name) => [name, selection[name]]),
    );
    const zoom: Zoom[] = (option.dataZoom ?? [])
      .slice(0, 2)
      .map((_: unknown, index: number) => {
        const current = rendered.dataZoom?.[index];
        const bounded = (value: unknown, fallback: number) =>
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 100
            ? value
            : fallback;
        return {
          start: bounded(current?.start, 0),
          end: bounded(current?.end, 100),
        };
      });
    if (
      JSON.stringify([selected, zoom]) ===
      JSON.stringify([this.selected, this.zoom])
    )
      return;
    this.selected = selected;
    this.zoom = zoom;
    this.publish();
  }
}
/** Data values may update in place; structural chart changes establish a fresh identity. */
export function chartIdentity(option: Option): string {
  return JSON.stringify({
    title: option.title,
    legend: option.legend?.data,
    axes: [option.xAxis, option.yAxis].map(
      (axis) => axis && { type: axis.type, name: axis.name },
    ),
    series: option.series.map((series: Option) => ({
      name: series.name,
      type: series.type,
      stack: series.stack,
      slices:
        series.type === "pie"
          ? series.data.map((point: any) => point?.name)
          : undefined,
    })),
    zoom: option.dataZoom?.map((zoom: Option) => zoom.type),
  });
}
