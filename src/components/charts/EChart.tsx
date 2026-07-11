"use client";

import * as React from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

/**
 * Thin ECharts wrapper.
 *
 * The chart instance is created ONCE and kept in a ref. Updates apply
 * `setOption` with merge semantics (notMerge=false) so incremental data over
 * the bounded rolling window merges in place — the chart is never recreated on
 * data updates. We use ECharts directly (never Recharts).
 */
export function EChart({
  option,
  className,
}: {
  option: EChartsOption;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, "dark", {
      renderer: "canvas",
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    // Merge update — no recreation.
    chartRef.current?.setOption(option, { notMerge: false, lazyUpdate: true });
  }, [option]);

  return <div ref={containerRef} className={className} style={{ width: "100%", height: "100%" }} />;
}
