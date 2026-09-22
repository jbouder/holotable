import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  type CatalogColumn,
  CatalogTable,
  MAX_TABLES,
  SourceConfig,
  SourceConnection,
  SourceDraft,
} from "@/lib/registry";

/**
 * The structured source form, as data.
 *
 * Creating a source used to mean typing a `SourceConfig` into a textarea, so a
 * misspelled key produced a Zod error against a blob of JSON. The form state
 * here is that same config with the connection fields held as *text* — the raw
 * characters a user has typed so far, which is not yet a config — and the
 * conversion back is the only place the two shapes meet.
 *
 * All of it is pure so the form's behaviour is testable without a render: the
 * config a state produces, the field each error attaches to, the JSON view's
 * round trip, and what discovery is allowed to change. The fetch helper at the
 * bottom is the only part that talks to the server, and the server re-validates
 * everything it is sent regardless.
 */

export const DEFAULT_PORT = "5432";
export const DEFAULT_SCHEMA = "public";

export interface SourceFormState {
  host: string;
  /** Text, not a number: "54a2" is a field error, not a silent 0 or NaN. */
  port: string;
  database: string;
  schema: string;
  ssl: boolean;
  /**
   * The allowlist. Full {@link CatalogTable}s rather than names, so a column
   * description the form has no control for still survives a round trip
   * through the JSON view.
   */
  tables: CatalogTable[];
}

export function emptyFormState(): SourceFormState {
  return {
    host: "",
    port: DEFAULT_PORT,
    database: "",
    schema: DEFAULT_SCHEMA,
    ssl: false,
    tables: [],
  };
}

export function formStateFromConfig(config: SourceConfig): SourceFormState {
  return {
    host: config.host,
    port: String(config.port),
    database: config.database,
    schema: config.schema,
    ssl: config.ssl,
    tables: config.tables,
  };
}

/** Errors keyed by the field that caused them; see {@link tableFieldKey}. */
export type FieldErrors = Record<string, string>;

export type FormResult =
  | { ok: true; config: SourceConfig }
  | { ok: false; errors: FieldErrors };

export type ConnectionResult =
  | { ok: true; connection: SourceConnection }
  | { ok: false; errors: FieldErrors };

/**
 * The connection half on its own — what discovery needs, and all it needs.
 * Asking for it separately is what lets the table picker open before an
 * allowlist exists, which is the whole point of discovering one.
 */
export function connectionFromFormState(state: SourceFormState): ConnectionResult {
  const errors: FieldErrors = {};
  const port = claimPort(state, errors);
  const parsed = SourceConnection.safeParse(connectionDraft(state, port));
  if (parsed.success && port !== undefined) return { ok: true, connection: parsed.data };
  if (!parsed.success) collectFieldErrors(parsed.error.issues, errors);
  return { ok: false, errors };
}

const PORT_MESSAGE = "Port must be a whole number between 1 and 65535.";

function parsePort(text: string): number | undefined {
  if (!/^\d+$/.test(text.trim())) return undefined;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Build the config a state describes, or the per-field reasons it cannot.
 *
 * The constraints are `SourceConfig`'s own — this validates by parsing, never
 * by restating a rule the schema already owns — and the issue paths it comes
 * back with are what attaches each message to a field.
 */
export function configFromFormState(state: SourceFormState): FormResult {
  const errors: FieldErrors = {};
  const port = claimPort(state, errors);
  const parsed = SourceConfig.safeParse(configDraft(state, port));
  if (parsed.success && port !== undefined) return { ok: true, config: parsed.data };
  if (!parsed.success) collectFieldErrors(parsed.error.issues, errors);
  return { ok: false, errors };
}

/**
 * The fields that sit beside the config: the id, the display name, and the
 * `secret_ref` naming the env family the credentials come from. Each is
 * checked against its own `SourceDraft` field, so the form and the create
 * route agree on what a valid id is without either restating it.
 *
 * Each field is optional because not every caller has all three: editing a
 * source cannot change its id, and discovery needs only the `secret_ref`.
 */
export function draftFieldErrors(values: {
  id?: string;
  name?: string;
  secretRef?: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  const fields = {
    id: values.id,
    name: values.name,
    secretRef: values.secretRef,
  } as const;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const field = SourceDraft.shape[key as keyof typeof fields];
    const parsed = field.safeParse(value.trim());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue) errors[key] = humanize(key, issue);
    }
  }
  return errors;
}

/**
 * Claim the port's error before the schema can: a non-numeric entry would
 * otherwise come back as "expected number, received undefined", which tells
 * the user nothing they did not already know.
 */
function claimPort(state: SourceFormState, errors: FieldErrors): number | undefined {
  const port = parsePort(state.port);
  if (port === undefined) errors.port = PORT_MESSAGE;
  return port;
}

function collectFieldErrors(
  issues: readonly { code: string; message: string; path: readonly PropertyKey[] }[],
  into: FieldErrors,
): void {
  for (const issue of issues) {
    const key = fieldKey(issue.path);
    if (!(key in into)) into[key] = humanize(key, issue);
  }
}

/** The `FieldErrors` key for one table's field: `tables.0.timeField`. */
export function tableFieldKey(index: number, field: keyof CatalogTable): string {
  return `tables.${index}.${field}`;
}

function fieldKey(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "form";
}

const LABELS: Record<string, string> = {
  id: "Source id",
  name: "Name",
  secretRef: "secret_ref",
  host: "Host",
  port: "Port",
  database: "Database",
  schema: "Schema",
};

/**
 * Zod's default text is written for a developer reading a stack trace ("Too
 * small: expected string to have >=1 characters"). The two cases a form
 * actually produces get a sentence instead; anything else — a length cap, a
 * type the JSON view smuggled in — keeps the schema's own wording, which is
 * more specific than a generic fallback would be.
 */
function humanize(key: string, issue: { code: string; message: string }): string {
  if (key === "tables" && issue.code === "too_small") {
    return "Select at least one table for the allowlist.";
  }
  const label = LABELS[key];
  if (label && (issue.code === "too_small" || issue.code === "invalid_type")) {
    return `${label} is required.`;
  }
  return issue.message;
}

/** The config a state describes, keyed in `SourceConfig`'s own order. */
function configDraft(state: SourceFormState, port: unknown): Record<string, unknown> {
  return { ...connectionDraft(state, port), tables: state.tables };
}

function connectionDraft(state: SourceFormState, port: unknown): Record<string, unknown> {
  return {
    host: state.host.trim(),
    port,
    database: state.database.trim(),
    schema: state.schema.trim(),
    ssl: state.ssl,
  };
}

/**
 * The Advanced view's text. A state that does not validate still has to render
 * as JSON — that is the point of the escape hatch — so the port goes out as
 * whatever was typed when it is not a number.
 */
export function configTextFromFormState(state: SourceFormState): string {
  const port = parsePort(state.port);
  return JSON.stringify(configDraft(state, port ?? state.port), null, 2);
}

export type ConfigTextResult =
  | { ok: true; state: SourceFormState }
  | { ok: false; error: string };

/** Parse the Advanced view back into form state. */
export function formStateFromConfigText(text: string): ConfigTextResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The connection config is not valid JSON." };
  }
  const parsed = SourceConfig.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${fieldKey(issue.path)}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "invalid configuration"}` };
  }
  return { ok: true, state: formStateFromConfig(parsed.data) };
}

/**
 * Whether a column's declared type can carry a time. `data_type` is
 * `information_schema`'s spelling — "timestamp with time zone", "date", "time
 * without time zone" — so the prefix is the whole test.
 */
export function isTimestampType(type: string): boolean {
  return /^(timestamptz|timestamp|date|time)\b/i.test(type.trim());
}

/**
 * The columns offered for a table's `timeField`.
 *
 * Timestamp-typed columns, which is what the field means. A table with none —
 * a hypertable keyed on an epoch `bigint`, say — falls back to its full column
 * list rather than becoming unconfigurable in the form; `fellBack` is what the
 * UI says so out loud.
 */
export function timeFieldOptions(table: CatalogTable): {
  columns: CatalogColumn[];
  fellBack: boolean;
} {
  const timestamps = table.columns.filter((column) => isTimestampType(column.type));
  return timestamps.length > 0
    ? { columns: timestamps, fellBack: false }
    : { columns: table.columns, fellBack: true };
}

/** The time column a newly selected table starts with, if one is obvious. */
export function defaultTimeField(table: CatalogTable): string | undefined {
  return table.columns.find((column) => isTimestampType(column.type))?.name;
}

/**
 * Add or remove a discovered table.
 *
 * Selection is the allowlist, so it is always explicit: discovery hands the
 * form a menu and this is the only way a table joins the config from it. An
 * existing entry's description and chosen time field survive a re-discovery
 * because removal is what drops them, not a refresh.
 */
export function toggleTable(
  state: SourceFormState,
  discovered: CatalogTable,
): SourceFormState {
  const selected = state.tables.some((table) => table.name === discovered.name);
  if (selected) {
    return {
      ...state,
      tables: state.tables.filter((table) => table.name !== discovered.name),
    };
  }
  if (state.tables.length >= MAX_TABLES) return state;
  return {
    ...state,
    tables: [
      ...state.tables,
      pruneTable({
        ...discovered,
        // A menu row carries back whatever it was configured with before it
        // was unticked; a freshly discovered one gets its obvious time column.
        timeField: discovered.timeField ?? defaultTimeField(discovered),
      }),
    ],
  };
}

export interface TableRow {
  table: CatalogTable;
  selected: boolean;
  /** Returned by the last discovery — false for a table only the config knows. */
  discovered: boolean;
}

/**
 * Every table the picker can offer, and which of them the live schema last
 * confirmed.
 *
 * The menu outlives the allowlist on purpose: unticking a table takes it out
 * of the config but must not take its column list off the screen, or an
 * accidental click would cost a round trip to the database to undo.
 */
export interface TableMenu {
  tables: CatalogTable[];
  /** Names the last discovery returned. Empty until one has run. */
  discovered: string[];
  ran: boolean;
}

export function emptyMenu(): TableMenu {
  return { tables: [], discovered: [], ran: false };
}

/** Fold a discovery result into the menu, without forgetting what it omitted. */
export function menuAfterDiscovery(menu: TableMenu, tables: CatalogTable[]): TableMenu {
  const found = new Set(tables.map((table) => table.name));
  return {
    tables: [...tables, ...menu.tables.filter((table) => !found.has(table.name))],
    discovered: [...found],
    ran: true,
  };
}

/** Keep a table on the menu — what an untick calls so the row survives it. */
export function rememberTable(menu: TableMenu, table: CatalogTable): TableMenu {
  if (menu.tables.some((known) => known.name === table.name)) return menu;
  return { ...menu, tables: [...menu.tables, table] };
}

/**
 * The rows the picker renders: the allowlist in its own order, then whatever
 * else is on the menu.
 *
 * A table the drafter or the JSON view put in the config is listed before any
 * discovery has run — otherwise opening the picker would look like it had
 * dropped it — and is marked as not discovered, which is how a name the live
 * schema does not have shows up as the typo it is.
 */
export function tableRows(state: SourceFormState, menu: TableMenu): TableRow[] {
  const discovered = new Set(menu.discovered);
  const selected = new Set(state.tables.map((table) => table.name));
  return [
    ...state.tables.map((table) => ({
      table,
      selected: true,
      discovered: discovered.has(table.name),
    })),
    ...menu.tables
      .filter((table) => !selected.has(table.name))
      .map((table) => ({
        table,
        selected: false,
        discovered: discovered.has(table.name),
      })),
  ];
}

/** Patch one selected table, by name. */
export function updateTable(
  state: SourceFormState,
  name: string,
  patch: Partial<CatalogTable>,
): SourceFormState {
  return {
    ...state,
    tables: state.tables.map((table) =>
      table.name === name ? pruneTable({ ...table, ...patch }) : table,
    ),
  };
}

/** An empty description or time field is absent, not the empty string. */
function pruneTable(table: CatalogTable): CatalogTable {
  const next = { ...table };
  if (!next.description) delete next.description;
  if (!next.timeField) delete next.timeField;
  return next;
}

export type DiscoverOutcome =
  | { ok: true; tables: CatalogTable[] }
  | { ok: false; error: ApiError };

/**
 * Ask the server which tables the source's read-only user can see.
 *
 * A connection or credential failure arrives as a `200` body — the author
 * typed the host and the `secret_ref`, so the message is theirs to act on —
 * and becomes a `validation` error here. A transport failure stays whatever
 * `readApiError` made of it.
 */
export async function discoverSourceTables(
  input: { workspaceId: string; secretRef: string; connection: SourceConnection },
  init?: { signal?: AbortSignal },
): Promise<DiscoverOutcome> {
  try {
    const res = await fetch("/api/sources/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: init?.signal,
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return readDiscovery(await res.json());
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** A discovery body is trusted no further than its shape. */
function readDiscovery(body: unknown): DiscoverOutcome {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (record.ok !== true) {
    const message =
      typeof record.error === "string" && record.error
        ? record.error
        : "could not reach the database";
    return { ok: false, error: { error: message, kind: "validation" } };
  }
  const tables = CatalogTable.array().safeParse(record.tables);
  return tables.success
    ? { ok: true, tables: tables.data }
    : {
        ok: false,
        error: { error: "the discovery result was malformed", kind: "unknown" },
      };
}
