"use client";

import * as React from "react";
import { AlertTriangle, DatabaseZap, Loader2 } from "lucide-react";
import type { Panel } from "@/lib/ir";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EChart } from "@/components/charts/EChart";
import { buildChartOption, type PanelData } from "@/components/charts/options";
import { formatValue } from "@/lib/format";
import { cn } from "@/lib/utils";

export type PanelStatus = "loading" | "live" | "stale" | "error" | "tombstoned";

export interface PanelState {
  data: PanelData;
  status: PanelStatus;
  error?: string;
}

const EMPTY: PanelData = { columns: [], rows: [] };

export function PanelView({
  panel,
  state,
}: {
  panel: Panel;
  state?: PanelState;
}) {
  const data = state?.data ?? EMPTY;
  const status = state?.status ?? "loading";

  return (
    <Card className={cn("flex h-full flex-col", status === "stale" && "opacity-60")}>
      <CardHeader>
        <CardTitle>{panel.title}</CardTitle>
        <StatusBadge status={status} />
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <PanelBody panel={panel} data={data} state={state} />
      </CardContent>
    </Card>
  );
}

function PanelBody({
  panel,
  data,
  state,
}: {
  panel: Panel;
  data: PanelData;
  state?: PanelState;
}) {
  if (state?.status === "tombstoned") {
    return (
      <Message icon={<DatabaseZap className="h-5 w-5" />}>
        Data source removed (tombstoned). This panel no longer resolves.
      </Message>
    );
  }
  if (state?.status === "error") {
    return (
      <Message icon={<AlertTriangle className="h-5 w-5 text-danger" />}>
        {state.error ?? "Query failed"}
      </Message>
    );
  }
  if (data.rows.length === 0 && (!state || state.status === "loading")) {
    return (
      <Message icon={<Loader2 className="h-5 w-5 animate-spin" />}>Loading…</Message>
    );
  }

  switch (panel.viz) {
    case "stat":
      return <StatView panel={panel} data={data} />;
    case "table":
      return <TableView data={data} />;
    default:
      return <EChart option={buildChartOption(panel, data)} />;
  }
}

function StatView({ panel, data }: { panel: Panel; data: PanelData }) {
  const last = data.rows[data.rows.length - 1];
  const valueKey =
    data.columns.find((c) => c !== panel.query.timeField && typeof last?.[c] === "number") ??
    data.columns[data.columns.length - 1];
  const value = last?.[valueKey];
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-4xl font-semibold tabular-nums">
        {value === undefined ? "—" : formatValue(value, panel.format)}
      </span>
    </div>
  );
}

function TableView({ data }: { data: PanelData }) {
  return (
    <div className="max-h-full overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-surface-2 text-muted">
          <tr>
            {data.columns.map((c) => (
              <th key={c} className="px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(-100).map((r, i) => (
            <tr key={i} className="border-t border-border">
              {data.columns.map((c) => (
                <td key={c} className="px-2 py-1 tabular-nums">
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Message({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
      {icon}
      <span>{children}</span>
    </div>
  );
}

const STATUS_STYLES: Record<PanelStatus, string> = {
  loading: "bg-surface-2 text-muted",
  live: "bg-success/20 text-success",
  stale: "bg-surface-2 text-muted",
  error: "bg-danger/20 text-danger",
  tombstoned: "bg-danger/20 text-danger",
};

function StatusBadge({ status }: { status: PanelStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        STATUS_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}
