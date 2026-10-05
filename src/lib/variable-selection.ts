import { z } from "zod";
import { type Variable, VARIABLE_VALUES_MAX, VariableName, VariableText } from "@/lib/ir";
import type { VariableValue, VariableValues } from "@/lib/sql/variables";

/**
 * What a viewer has picked for a dashboard's variables (#67), and how the
 * server turns a request's picks into values it will bind.
 *
 * The browser half (reading and writing `var-<name>` in a URL) and the rule
 * the server applies (every value must be one the variable allows) live
 * together so they cannot disagree about the shape. Nothing here runs a
 * query: the allowed values come in through `optionsOf`, which on the server
 * is `variableOptions` in `src/lib/variables.ts`.
 */

/**
 * Values an editor's preview binds (#67), as a request body carries them. The
 * editor may run any SELECT it can write, so these are not checked against an
 * allowlist; they are held to the IR's shape and, like every value, only ever
 * bound as parameters.
 */
export const VariableValuesBody = z
  .record(
    VariableName,
    z.union([VariableText, z.array(VariableText).max(VARIABLE_VALUES_MAX)]),
  )
  .refine((v) => Object.keys(v).length <= 10, "at most 10 variables");

/** `?var-host=a&var-host=b`: one parameter per selected value. */
export const VARIABLE_PARAM_PREFIX = "var-";

/** A variable as the viewer's picker shows it. */
export interface VariableChoice {
  name: string;
  label: string;
  multi: boolean;
  options: string[];
  /** Why the variable offers nothing: its query failed. Shown, never thrown. */
  error?: string;
}

/** Picks by name, as a request carries them: unchecked strings. */
export type Selection = Record<string, string[]>;

/** The `var-*` parameters of a URL, or of a page's search params. */
export function selectionFromParams(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): Selection {
  const out: Selection = {};
  const entries =
    params instanceof URLSearchParams
      ? [...params.entries()]
      : Object.entries(params).flatMap(([k, v]) =>
          v === undefined ? [] : [v].flat().map((x): [string, string] => [k, x]),
        );
  for (const [key, value] of entries) {
    if (!key.startsWith(VARIABLE_PARAM_PREFIX)) continue;
    const name = key.slice(VARIABLE_PARAM_PREFIX.length);
    out[name] = [...(out[name] ?? []), value];
  }
  return out;
}

/** A selection as `var-*` parameters, in variable order. */
export function selectionParams(selection: Selection): [string, string][] {
  return Object.entries(selection).flatMap(([name, values]) =>
    values.map((v): [string, string] => [`${VARIABLE_PARAM_PREFIX}${name}`, v]),
  );
}

/** A selection as resolved values, which is what the poller key and the bind need. */
export function asSelection(values: VariableValues): Selection {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? [v] : [...v]]),
  );
}

/** A stable key for a set of values: two viewers share a poller only on equal keys. */
export function valuesKey(values: VariableValues): string {
  return JSON.stringify(
    Object.entries(values)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, typeof v === "string" ? v : [...v]]),
  );
}

/** A request named a value the variable does not allow. The viewer's to fix. */
export class VariableSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariableSelectionError";
  }
}

/**
 * A variable's selection before anyone picks: its default, or else its first
 * value (every value, for none, would be a surprise; one is the safe start).
 */
export function defaultValue(
  variable: Variable,
  options: readonly string[],
): VariableValue | undefined {
  if (variable.default !== undefined) {
    if (!variable.multi) return variable.default as string;
    return [variable.default].flat();
  }
  const first = options[0];
  if (first === undefined) return variable.multi ? [] : undefined;
  return variable.multi ? [first] : first;
}

/**
 * The values to bind, from what a request picked. Every declared variable gets
 * one: its pick when it made one, its default otherwise. A pick must be one
 * the variable allows (`optionsOf`), a single-value variable takes one, and a
 * name the dashboard does not declare is ignored rather than bound.
 */
export async function resolveSelection(
  variables: readonly Variable[],
  requested: Selection,
  optionsOf: (variable: Variable) => Promise<readonly string[]>,
): Promise<VariableValues> {
  const out: Record<string, VariableValue> = {};
  for (const variable of variables) {
    const picked = requested[variable.name] ?? [];
    const options = await optionsOf(variable);
    if (picked.length === 0) {
      const fallback = defaultValue(variable, options);
      if (fallback === undefined) {
        throw new VariableSelectionError(
          `variable :${variable.name} has no value to show; it offers none and has no default`,
        );
      }
      out[variable.name] = fallback;
      continue;
    }
    if (!variable.multi && picked.length > 1) {
      throw new VariableSelectionError(`variable :${variable.name} takes one value`);
    }
    const allowed = new Set(options);
    const refused = picked.find((v) => !allowed.has(v));
    if (refused !== undefined) {
      throw new VariableSelectionError(
        `${JSON.stringify(refused.slice(0, 64))} is not a value of :${variable.name}`,
      );
    }
    out[variable.name] = variable.multi ? [...new Set(picked)] : picked[0];
  }
  return out;
}
