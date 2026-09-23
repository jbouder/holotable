"use client";

import type { QueryPlanView as Plan } from "@/lib/query-plan";
import { summarizeLimits } from "@/lib/query-plan";

/**
 * "What actually runs": the statement the server sends, the values it bound,
 * and the session it runs them in.
 *
 * Rendered identically in the editor and in the viewer's SQL dialog, because
 * the point is that there is one answer. Everything here comes from
 * `/api/sql/plan`, which derives it from the same functions execution uses —
 * nothing is described twice.
 */
export function QueryPlanView({ plan, stale }: { plan: Plan; stale?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="border border-border bg-surface-2">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted">
          Statement sent to the database
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-relaxed">
          {plan.executedSql}
        </pre>
      </div>

      {plan.params.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">
            Bound parameters — supplied by the server, not by the panel or the model
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            {plan.params.map((param) => (
              <div key={param.placeholder} className="contents">
                <dt className="font-mono text-muted">{param.placeholder}</dt>
                <dd className="min-w-0 break-words font-mono">
                  {param.value}
                  <span className="ml-2 font-sans text-muted">
                    resolved from {param.from}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="text-xs text-muted">
          No time filter: this panel declares no time field, so the server binds nothing
          and the whole result is capped by the row limit alone.
        </p>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Time field</dt>
        <dd className="truncate font-mono">{plan.timeField ?? "—"}</dd>
        <dt className="text-muted">Limits</dt>
        <dd>{summarizeLimits(plan)}</dd>
        <dt className="text-muted">Session</dt>
        <dd className="min-w-0">
          <ul className="space-y-0.5">
            {plan.session.map((statement) => (
              <li key={statement} className="break-words font-mono">
                {statement}
              </li>
            ))}
          </ul>
        </dd>
      </dl>

      <p className="text-xs text-muted">
        Nothing was executed to produce this. The statement is wrapped, the window is
        resolved and the limits are applied by the server on every run.
        {stale && " The panel has been edited since this was built."}
      </p>
    </div>
  );
}
