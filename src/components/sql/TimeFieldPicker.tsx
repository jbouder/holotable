"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { SourceCatalog } from "@/lib/registry";
import { selectOutputs, timeFieldCandidates, timeFieldWarning } from "@/lib/sql/hints";

/**
 * The panel's `timeField`: which output column the server filters the
 * dashboard's time range on.
 *
 * It was a free-text input, which is how a panel ends up declaring a column
 * the query does not return — the server wraps the statement and filters on
 * `_holo.<timeField>`, so a name that is not in the SELECT list fails at
 * execution with an error about a column nobody typed. The picker offers the
 * names that can actually work: the query's own output columns first, then the
 * catalog's timestamp columns, which are the output columns whenever the query
 * selects `*`.
 *
 * Free text stays available behind "Something else", because the candidates
 * are read by a lexical scan that gives up on expressions it cannot name, and
 * an author who knows better must not be locked out by that. What they get
 * instead is a warning.
 */

const NONE = "";
const CUSTOM = "\u0000custom";

export function TimeFieldPicker({
  value,
  onChange,
  sql,
  catalog,
  id,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  sql: string;
  catalog: SourceCatalog | null;
  id?: string;
}) {
  const candidates = React.useMemo(
    () => timeFieldCandidates(sql, catalog),
    [sql, catalog],
  );
  const warning = React.useMemo(
    () => timeFieldWarning(value, selectOutputs(sql)),
    [value, sql],
  );

  // Free text is a mode, not a value: it has to survive the field being
  // cleared, and it must not be left behind once a listed name is chosen.
  const [custom, setCustom] = React.useState(
    () => value !== undefined && !candidates.includes(value),
  );
  const listed = value !== undefined && candidates.includes(value);

  const options = [
    { value: NONE, label: "None — do not filter by time" },
    ...candidates.map((name) => ({ value: name, label: name })),
    ...(value && !listed ? [{ value, label: `${value} (not in the query)` }] : []),
    { value: CUSTOM, label: "Something else…" },
  ];

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>timeField</Label>
      <Select
        id={id}
        value={custom && !listed ? CUSTOM : (value ?? NONE)}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next === NONE ? undefined : next);
        }}
        options={options}
        className="w-full"
      />
      {custom && !listed && (
        <Input
          aria-label="Custom time field"
          placeholder="column name in the query's output"
          className="font-mono"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      )}
      {warning ? (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ) : (
        <p className="text-xs text-muted">
          The server filters the dashboard&rsquo;s time range on this output column.
        </p>
      )}
    </div>
  );
}
