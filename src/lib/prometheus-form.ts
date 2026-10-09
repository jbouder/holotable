import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import {
  MAX_METRICS,
  type PrometheusConfig,
  PrometheusConfig as PrometheusConfigSchema,
  type PrometheusMetric,
} from "@/lib/sources/kinds/prometheus";

/**
 * The Prometheus source form, as data (#386), in the shape of
 * `src/lib/source-form.ts`: the state is the config with its text fields held
 * as typed, and the conversion back is the only place the two meet. Pure,
 * apart from the two fetch helpers at the bottom, so the form's behavior is
 * testable without a render. The server re-validates everything it is sent.
 */

export type PrometheusAuth = PrometheusConfig["auth"];

export interface PrometheusFormState {
  url: string;
  auth: PrometheusAuth;
  /** The allowlist, whole, so a field the form has no control for survives a round trip. */
  metrics: PrometheusMetric[];
  /** The tenant label and the claim it is matched on; both empty for none. */
  rowFilterLabel: string;
  rowFilterClaim: string;
}

export function emptyPrometheusFormState(): PrometheusFormState {
  return { url: "", auth: "bearer", metrics: [], rowFilterLabel: "", rowFilterClaim: "" };
}

export function prometheusFormStateFromConfig(
  cfg: PrometheusConfig,
): PrometheusFormState {
  return {
    url: cfg.url,
    auth: cfg.auth,
    metrics: cfg.metrics,
    rowFilterLabel: cfg.rowFilter?.label ?? "",
    rowFilterClaim: cfg.rowFilter?.claim ?? "",
  };
}

export type FieldErrors = Record<string, string>;

export type PrometheusFormResult =
  | { ok: true; config: PrometheusConfig }
  | { ok: false; errors: FieldErrors };

/** Whether this auth mode names a `secret_ref`: every mode but `none`. */
export function needsSecretRef(auth: PrometheusAuth): boolean {
  return auth !== "none";
}

function draft(state: PrometheusFormState): Record<string, unknown> {
  const label = state.rowFilterLabel.trim();
  const claim = state.rowFilterClaim.trim();
  return {
    kind: "prometheus",
    url: state.url.trim(),
    auth: state.auth,
    metrics: state.metrics,
    ...(label || claim ? { rowFilter: { label, claim } } : {}),
  };
}

const MESSAGES: Record<string, string> = {
  url: "Enter the endpoint's URL, such as https://prometheus.example.com.",
  metrics: "Select at least one metric for the allowlist.",
};

/** The config a state describes, or the per-field reasons it cannot be one. */
export function prometheusConfigFromFormState(
  state: PrometheusFormState,
): PrometheusFormResult {
  const parsed = PrometheusConfigSchema.safeParse(draft(state));
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
export function prometheusConfigText(state: PrometheusFormState): string {
  return JSON.stringify(draft(state), null, 2);
}

export type PrometheusConfigTextResult =
  | { ok: true; state: PrometheusFormState }
  | { ok: false; error: string };

export function prometheusFormStateFromConfigText(
  text: string,
): PrometheusConfigTextResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The config is not valid JSON." };
  }
  const parsed = PrometheusConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${where}${issue?.message ?? "invalid configuration"}` };
  }
  return { ok: true, state: prometheusFormStateFromConfig(parsed.data) };
}

/* ------------------------------------------------------------------------- */
/* The discovery menu                                                         */
/* ------------------------------------------------------------------------- */

/** One metric the endpoint describes. A menu entry, never an allowlist entry until picked. */
export interface DiscoveredMetric {
  name: string;
  type: PrometheusMetric["type"];
  help?: string;
}

export interface MetricMenu {
  /** Whether discovery has run, so an empty menu can say why. */
  ran: boolean;
  metrics: DiscoveredMetric[];
}

export function emptyMetricMenu(): MetricMenu {
  return { ran: false, metrics: [] };
}

/** How many matches the menu shows at once: a real server has thousands. */
export const MENU_PAGE = 50;

/**
 * The menu narrowed to a search, as the catalog browser searches: by name,
 * type and help. A server has thousands of metric families, so the menu is
 * searched, never listed whole.
 */
export function searchMenu(
  menu: MetricMenu,
  query: string,
  limit = MENU_PAGE,
): DiscoveredMetric[] {
  const q = query.trim().toLowerCase();
  const matches =
    q === ""
      ? menu.metrics
      : menu.metrics.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.type.includes(q) ||
            (m.help ?? "").toLowerCase().includes(q),
        );
  return matches.slice(0, limit);
}

export function isSelected(state: PrometheusFormState, name: string): boolean {
  return state.metrics.some((m) => m.name === name);
}

/**
 * Tick or untick a metric. A ticked one starts with no labels; picking it is
 * what asks the endpoint for them (`withLabels`). The allowlist is capped at
 * `MAX_METRICS`, as the schema is, so the menu cannot offer more.
 */
export function toggleMetric(
  state: PrometheusFormState,
  metric: DiscoveredMetric,
): PrometheusFormState {
  if (isSelected(state, metric.name)) {
    return { ...state, metrics: state.metrics.filter((m) => m.name !== metric.name) };
  }
  if (state.metrics.length >= MAX_METRICS) return state;
  return {
    ...state,
    metrics: [
      ...state.metrics,
      {
        name: metric.name,
        type: metric.type,
        ...(metric.help ? { help: metric.help } : {}),
        labels: [],
      },
    ],
  };
}

/** The labels discovery found, applied to the metrics that are still ticked. */
export function withLabels(
  state: PrometheusFormState,
  labels: Record<string, string[]>,
): PrometheusFormState {
  return {
    ...state,
    metrics: state.metrics.map((m) =>
      labels[m.name] ? { ...m, labels: labels[m.name] } : m,
    ),
  };
}

/** Labels every allowlisted metric carries: the candidates for a tenant label. */
export function sharedLabels(state: PrometheusFormState): string[] {
  if (state.metrics.length === 0) return [];
  const [first, ...rest] = state.metrics;
  return first.labels.filter((l) => rest.every((m) => m.labels.includes(l))).sort();
}

/* ------------------------------------------------------------------------- */
/* Fetch helpers                                                              */
/* ------------------------------------------------------------------------- */

export interface PrometheusDiscoveryInput {
  workspaceId: string;
  url: string;
  auth: PrometheusAuth;
  secretRef: string | null;
}

function body(
  input: PrometheusDiscoveryInput,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    kind: "prometheus",
    workspaceId: input.workspaceId,
    url: input.url,
    auth: input.auth,
    ...(input.secretRef ? { secretRef: input.secretRef } : {}),
    ...extra,
  });
}

async function discover<T>(
  input: PrometheusDiscoveryInput,
  extra: Record<string, unknown>,
  pick: (body: Record<string, unknown>) => T,
): Promise<{ ok: true; value: T } | { ok: false; error: ApiError }> {
  try {
    const res = await fetch("/api/sources/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(input, extra),
    });
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    const answer = (await res.json()) as Record<string, unknown>;
    if (answer.ok !== true) {
      return {
        ok: false,
        error: { error: String(answer.error ?? "Discovery failed."), kind: "validation" },
      };
    }
    return { ok: true, value: pick(answer) };
  } catch (err) {
    return { ok: false, error: apiErrorFromThrown(err) };
  }
}

/** The endpoint's metric menu. */
export function discoverPrometheusMetrics(input: PrometheusDiscoveryInput) {
  return discover(input, {}, (b) =>
    Array.isArray(b.metrics) ? (b.metrics as DiscoveredMetric[]) : [],
  );
}

/** The label names of the metrics just picked. */
export function discoverPrometheusLabels(
  input: PrometheusDiscoveryInput,
  metrics: string[],
) {
  return discover(input, { labelsFor: metrics }, (b) =>
    b.labels && typeof b.labels === "object"
      ? (b.labels as Record<string, string[]>)
      : {},
  );
}
