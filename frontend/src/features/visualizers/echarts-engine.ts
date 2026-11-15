import { init, use } from "echarts/core";
import { LineChart, BarChart, PieChart, ScatterChart } from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
export function createChart(element: HTMLDivElement, theme: string) {
  return init(element, theme === "dark" ? "dark" : undefined, {
    renderer: "canvas",
  });
}
