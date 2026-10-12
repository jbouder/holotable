import {
  discoverFromEndpoint,
  type HttpAuth,
  type HttpDiscoveryInput,
  needsSecretRef,
} from "@/lib/http-source-form";
import {
  type LokiConfig,
  LokiConfig as LokiConfigSchema,
  type LokiLabel,
  MAX_LABEL_VALUES,
  MAX_LABELS,
} from "@/lib/sources/kinds/loki";

/**
 * The Loki source form, as data (#563), in the shape of
 * `src/lib/prometheus-form.ts`: the state is the config with its text fields
 * held as typed, and the conversion back is the only place the two meet.
 * Pure, apart from the two fetch helpers at the bottom, so the form's
 * behavior is testable without a render. The server re-validates everything
 * it is sent.
 */

export type LokiAuth = HttpAuth;

export { needsSecretRef };

export interface LokiFormState {
  url: string;
  auth: LokiAuth;
  /** The label allowlist, whole, each with the values discovery found. */
  labels: LokiLabel[];
  /** The tenant label and the claim it is matched on; both empty for none. */
  rowFilterLabel: string;
  rowFilterClaim: string;
}

export function emptyLokiFormState(): LokiFormState {
  return { url: "", auth: "bearer", labels: [], rowFilterLabel: "", rowFilterClaim: "" };
}

export function lokiFormStateFromConfig(cfg: LokiConfig): LokiFormState {
  return {
    url: cfg.url,
    auth: cfg.auth,
    labels: cfg.labels,
    rowFilterLabel: cfg.rowFilter?.label ?? "",
    rowFilterClaim: cfg.rowFilter?.claim ?? "",
  };
}

export type FieldErrors = Record<string, string>;

export type LokiFormResult =
  | { ok: true; config: LokiConfig }
  | { ok: false; errors: FieldErrors };

function draft(state: LokiFormState): Record<string, unknown> {
  const label = state.rowFilterLabel.trim();
  const claim = state.rowFilterClaim.trim();
  return {
    kind: "loki",
    url: state.url.trim(),
    auth: state.auth,
    labels: state.labels,
    ...(label || claim ? { rowFilter: { label, claim } } : {}),
  };
}

const MESSAGES: Record<string, string> = {
  url: "Enter the endpoint's URL, such as https://loki.example.com.",
  labels: "Select at least one label for the allowlist.",
};

/** The config a state describes, or the per-field reasons it cannot be one. */
export function lokiConfigFromFormState(state: LokiFormState): LokiFormResult {
  const parsed = LokiConfigSchema.safeParse(draft(state));
  if (parsed.success) return { ok: true, config: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key =
      issue.path[0] === "rowFilter"
        ? `rowFilter.${String(issue.path[1] ?? "label")}`
        : String(issue.path[0] ?? "form");
    if (!(key in errors)) errors[key] = MESSAGES[key] ?? issue.message;
  }
  return { ok: false, errors };
}

/** The JSON view's text: the config as it would be saved. */
export function lokiConfigText(state: LokiFormState): string {
  return JSON.stringify(draft(state), null, 2);
}

export type LokiConfigTextResult =
  | { ok: true; state: LokiFormState }
  | { ok: false; error: string };

export function lokiFormStateFromConfigText(text: string): LokiConfigTextResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The config is not valid JSON." };
  }
  const parsed = LokiConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "invalid configuration"}` };
  }
  return { ok: true, state: lokiFormStateFromConfig(parsed.data) };
}

/* ------------------------------------------------------------------------- */
/* The discovery menu                                                         */
/* ------------------------------------------------------------------------- */

export interface LabelMenu {
  /** Whether discovery has run, so an empty menu can say why. */
  ran: boolean;
  labels: string[];
}

export function emptyLabelMenu(): LabelMenu {
  return { ran: false, labels: [] };
}

/** How many matches the menu shows at once, as the metric menu does. */
export const LABEL_MENU_PAGE = 50;

/** The menu narrowed to a search by name. */
export function searchLabelMenu(
  menu: LabelMenu,
  query: string,
  limit = LABEL_MENU_PAGE,
): string[] {
  const q = query.trim().toLowerCase();
  const matches =
    q === "" ? menu.labels : menu.labels.filter((l) => l.toLowerCase().includes(q));
  return matches.slice(0, limit);
}

export function isLabelSelected(state: LokiFormState, name: string): boolean {
  return state.labels.some((l) => l.name === name);
}

/**
 * Tick or untick a label. A ticked one starts with no values; ticking it is
 * what asks the endpoint for them (`withLabelValues`). The allowlist is
 * capped at `MAX_LABELS`, as the schema is, so the menu cannot offer more.
 */
export function toggleLabel(state: LokiFormState, name: string): LokiFormState {
  if (isLabelSelected(state, name)) {
    return { ...state, labels: state.labels.filter((l) => l.name !== name) };
  }
  if (state.labels.length >= MAX_LABELS) return state;
  return { ...state, labels: [...state.labels, { name, values: [] }] };
}

/**
 * The values discovery found for a label, applied if it is still ticked:
 * deduplicated, sorted and capped at `MAX_LABEL_VALUES`, as the schema is.
 */
export function withLabelValues(
  state: LokiFormState,
  name: string,
  values: string[],
): LokiFormState {
  const hints = [...new Set(values)].sort().slice(0, MAX_LABEL_VALUES);
  return {
    ...state,
    labels: state.labels.map((l) => (l.name === name ? { ...l, values: hints } : l)),
  };
}

/* ------------------------------------------------------------------------- */
/* Fetch helpers                                                              */
/* ------------------------------------------------------------------------- */

export type LokiDiscoveryInput = HttpDiscoveryInput;

/** The endpoint's stream label names, over the server's discovery window. */
export function discoverLokiLabelMenu(input: LokiDiscoveryInput) {
  return discoverFromEndpoint("loki", input, {}, (b) =>
    Array.isArray(b.labels)
      ? b.labels.filter((l): l is string => typeof l === "string")
      : [],
  );
}

/** One ticked label's values, as hints. */
export function discoverLokiValues(input: LokiDiscoveryInput, label: string) {
  return discoverFromEndpoint("loki", input, { valuesFor: label }, (b) =>
    Array.isArray(b.values)
      ? b.values.filter((v): v is string => typeof v === "string")
      : [],
  );
}
