"use client";

import * as React from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

/**
 * What a caller outside the chart can ask it for.
 *
 * Deliberately one method rather than the instance: exporting a picture is a
 * read, and handing out the `ECharts` object would hand out `setOption` with
 * it — the one thing that must keep coming from `option` so the chart is never
 * recreated or fought over (invariant 11).
 */
export interface EChartHandle {
  /**
   * The chart as a PNG data URL, or null before it has initialized.
   *
   * `backgroundColor` is given rather than defaulted because the canvas is
   * transparent: exported without one, the picture is a dark theme's chart on
   * whatever the viewer's image tool puts behind it, which is usually white.
   */
  toPng(backgroundColor: string): string | null;
}

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
  ref,
}: {
  option: EChartsOption;
  className?: string;
  /** Exposes {@link EChartHandle}; omit it and the chart is unreachable. */
  ref?: React.Ref<EChartHandle>;
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

  React.useImperativeHandle(
    ref,
    () => ({
      toPng: (backgroundColor: string) =>
        chartRef.current?.getDataURL({
          type: "png",
          // 2 on a HiDPI screen is what makes the export match what is on it.
          pixelRatio: Math.min(2, globalThis.devicePixelRatio || 1),
          backgroundColor,
        }) ?? null,
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
