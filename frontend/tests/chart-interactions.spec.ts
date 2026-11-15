import { expect, test } from "@playwright/test";
import {
  ChartInteractions,
  chartIdentity,
} from "../src/features/visualizers/chart-interactions";

test("chart interaction snapshots bound data and fence unrelated identities", () => {
  const store = new ChartInteractions();
  const option = {
    title: { text: "Metrics" },
    legend: { data: ["Count"] },
    series: [{ name: "Count", type: "bar", data: [1, 2] }],
    dataZoom: [{ type: "inside" }],
  };
  const identity = chartIdentity(option);
  expect(
    chartIdentity({
      ...option,
      series: [{ ...option.series[0], data: [8, 9] }],
    }),
  ).toBe(identity);
  store.ensure(identity);
  store.capture(identity, option, {
    legend: [{ selected: { Count: false, injected: false } }],
    dataZoom: [
      { start: 20, end: 80, hugePayload: Array(1000).fill(1) },
      { start: 1, end: 99 },
    ],
  });
  expect(store.selected).toEqual({ Count: false });
  expect(store.zoom).toEqual([{ start: 20, end: 80 }]);
  const other = chartIdentity({ ...option, title: { text: "Unrelated" } });
  store.ensure(other);
  store.capture(identity, option, {
    legend: [{ selected: { Count: false } }],
    dataZoom: [{ start: 20, end: 80 }],
  });
  expect(store.selected).toEqual({});
  expect(store.zoom).toEqual([]);
  store.capture(other, option, { dataZoom: [{ start: NaN, end: 999 }] });
  expect(store.zoom).toEqual([{ start: 0, end: 100 }]);
  const pie = {
    series: [{ type: "pie", data: [{ name: "Slice", value: 2 }] }],
    legend: { show: true },
  };
  const pieIdentity = chartIdentity(pie);
  store.ensure(pieIdentity);
  store.capture(pieIdentity, pie, {
    legend: [{ selected: { Slice: false, ignored: false } }],
  });
  expect(store.selected).toEqual({ Slice: false });
  expect(
    chartIdentity({
      ...pie,
      series: [{ type: "pie", data: [{ name: "Other", value: 2 }] }],
    }),
  ).not.toBe(pieIdentity);
});
