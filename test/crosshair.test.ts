import assert from "node:assert/strict";
import { test } from "node:test";
import * as echarts from "echarts";
import { categoryIndexAt } from "@/components/charts/EChart";

/*
 * Crosshair sync (#517): a dashboard's charts move their pointers together,
 * which starts with reading the category under the pointer. Checked against
 * ECharts itself, rendered headless, because the bug was in what ECharts
 * answers for the question asked.
 */
test("the category under the pointer is read off the grid, and nothing off it", () => {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 600,
    height: 300,
  });
  try {
    chart.setOption({
      grid: { left: 40, right: 20, top: 20, bottom: 30 },
      xAxis: { type: "category", data: ["a", "b", "c", "d", "e"] },
      yAxis: { type: "value" },
      series: [{ type: "line", data: [1, 2, 3, 4, 5] }],
    });
    // The plot spans x 40–580: five categories of 108 px, centred.
    assert.equal(categoryIndexAt(chart, 94, 150), 0);
    assert.equal(categoryIndexAt(chart, 310, 150), 2);
    assert.equal(categoryIndexAt(chart, 570, 150), 4);
    assert.equal(categoryIndexAt(chart, 10, 150), null, "left of the grid");
    assert.equal(categoryIndexAt(chart, 310, 5), null, "above the grid");
    assert.equal(categoryIndexAt(chart, undefined, 150), null);
  } finally {
    chart.dispose();
  }
});
