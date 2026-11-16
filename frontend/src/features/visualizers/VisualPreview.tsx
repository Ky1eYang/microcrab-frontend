import { lazy, Suspense, type ReactNode } from "react";
import { safeMermaid } from "./policy";
import type { ChartInteractions } from "./chart-interactions";
import Svg from "./SvgBlock";
const failed = () => ({
  default: ({ fallback }: { source: string; fallback: ReactNode }) => (
    <>{fallback}</>
  ),
});
const Mermaid = lazy(() => import("./MermaidBlock").catch(failed));
const ECharts = lazy(() => import("./EChartsBlock").catch(failed));
export function visualLanguage(language: string) {
  return /^(?:mermaid|mermaid-diagram|echarts|chart|svg|xml-svg)$/.test(
    language.toLowerCase(),
  );
}
export function VisualPreview({
  language,
  source,
  fallback,
  interactions,
}: {
  language: string;
  source: string;
  fallback: ReactNode;
  interactions?: ChartInteractions;
}) {
  const mermaid = /^(?:mermaid|mermaid-diagram)$/.test(language.toLowerCase());
  if (mermaid && !safeMermaid(source)) return <>{fallback}</>;
  return (
    <Suspense fallback={fallback}>
      {mermaid ? (
        <Mermaid source={source} fallback={fallback} />
      ) : /^(?:svg|xml-svg)$/i.test(language) ? (
        <Svg source={source} fallback={fallback} />
      ) : (
        <ECharts
          source={source}
          fallback={fallback}
          interactions={interactions}
        />
      )}
    </Suspense>
  );
}
