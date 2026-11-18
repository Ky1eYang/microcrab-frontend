import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EChartsType } from "echarts/core";
import { chartOptionDiagnostic } from "./policy";
import { ChartInteractions, chartIdentity } from "./chart-interactions";
import { useVisualTheme } from "./theme";
import { t } from "../../i18n";
import { Icon } from "../shared";
export default function EChartsBlock({
  source,
  fallback,
  interactions,
}: {
  source: string;
  fallback: React.ReactNode;
  interactions?: ChartInteractions;
}) {
  const local = useRef<ChartInteractions | null>(null);
  if (!local.current) local.current = new ChartInteractions();
  const owner = interactions ?? local.current;
  const revision = useSyncExternalStore(
    owner.subscribe,
    owner.snapshot,
    owner.snapshot,
  );
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const applied = useRef<{
    identity: string;
    option: Record<string, any>;
    revision: number;
  } | null>(null);
  const applying = useRef(false);
  const theme = useVisualTheme();
  const diagnostic = useMemo(() => chartOptionDiagnostic(source), [source]);
  const option = diagnostic.option;
  const identity = useMemo(
    () => (option ? chartIdentity(option) : null),
    [option],
  );
  const [activated, setActivated] = useState(!!option);
  useEffect(() => {
    if (option) setActivated(true);
  }, [option]);
  const [ready, setReady] = useState(false);
  const [valid, setValid] = useState(false);
  useEffect(() => {
    let stale = false;
    const element = container.current!;
    const observer = new ResizeObserver(() => {
      try {
        chart.current?.resize();
      } catch {
        /* disposed */
      }
    });
    observer.observe(element);
    setReady(false);
    applied.current = null;
    if (activated)
      void import("./echarts-engine")
        .then((engine) => {
          if (stale) return;
          const instance = engine.createChart(element, theme);
          chart.current = instance;
          const capture = () => {
            if (applying.current || stale || !applied.current) return;
            try {
              owner.capture(
                applied.current.identity,
                applied.current.option,
                instance.getOption() ?? {},
              );
              applied.current.revision = owner.snapshot();
            } catch {
              /* disposed/stale */
            }
          };
          for (const event of [
            "legendselectchanged",
            "legendselected",
            "legendunselected",
            "legendselectall",
            "legendinverseselect",
            "datazoom",
          ])
            instance.on(event, capture);
          setReady(true);
        })
        .catch(() => {
          if (!stale) setReady(false);
        });
    return () => {
      stale = true;
      observer.disconnect();
      chart.current?.dispose();
      chart.current = null;
      applied.current = null;
    };
  }, [theme, activated, owner]);
  useEffect(() => {
    if (!ready || !chart.current || !option || !identity) {
      setValid(false);
      return;
    }
    try {
      owner.ensure(identity);
      // The emitting instance already has these choices; do not reset its active drag.
      if (
        applied.current?.option === option &&
        applied.current.identity === identity &&
        applied.current.revision === owner.snapshot()
      ) {
        setValid(true);
        return;
      }
      const changedIdentity = applied.current?.identity !== identity;
      applying.current = true;
      chart.current.setOption(
        {
          ...option,
          ...(option.legend
            ? { legend: { ...option.legend, selected: owner.selected } }
            : {}),
          ...(option.dataZoom
            ? {
                dataZoom: option.dataZoom.map((zoom: any, index: number) => ({
                  ...zoom,
                  ...owner.zoom[index],
                })),
              }
            : {}),
        },
        {
          notMerge: changedIdentity,
          replaceMerge: ["series", "xAxis", "yAxis", "legend", "dataZoom"],
          lazyUpdate: false,
        },
      );
      applied.current = { identity, option, revision: owner.snapshot() };
      setValid(true);
    } catch {
      setValid(false);
    } finally {
      applying.current = false;
    }
  }, [option, identity, ready, owner, revision]);
  const errorMessage = !option
    ? t(diagnostic.error || "visual.error.unsupported")
    : t("visual.error.renderFailed");

  return (
    <div className="visual-chart-frame">
      <div
        ref={container}
        className="visual-chart"
        data-testid="echarts-preview"
        data-valid={valid && !!option}
      />
      {(!valid || !option) && fallback}
      {(!valid || !option) && (
        <div className="visual-preview-error" data-testid="echarts-error">
          <div className="visual-preview-error-header">
            <Icon name="warning" size={16} />
            <span>{t("visual.error.renderFailed")}</span>
          </div>
          <div className="visual-preview-error-body">{errorMessage}</div>
          <div className="visual-preview-error-hint">
            {t("visual.error.switchToRaw")}
          </div>
        </div>
      )}
    </div>
  );
}
