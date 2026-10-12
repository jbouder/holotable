import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyLabelMenu,
  emptyLokiFormState,
  isLabelSelected,
  LABEL_MENU_PAGE,
  type LokiFormState,
  lokiConfigFromFormState,
  lokiConfigText,
  lokiFormStateFromConfigText,
  searchLabelMenu,
  toggleLabel,
  withLabelValues,
} from "@/lib/loki-form";
import { MAX_LABEL_VALUES, MAX_LABELS } from "@/lib/sources/kinds/loki";

/**
 * The Loki source form as data (#563): what config a state describes, where
 * each error lands, the JSON view's round trip, and the label menu with its
 * value hints held to the schema's caps.
 */

function filled(overrides: Partial<LokiFormState> = {}): LokiFormState {
  return {
    ...emptyLokiFormState(),
    url: " https://loki.example.com ",
    labels: [
      { name: "app", values: ["api", "web"] },
      { name: "namespace", values: [] },
    ],
    ...overrides,
  };
}

test("a filled state is a Loki config, trimmed, with the tenant label only when it is set", () => {
  const result = lokiConfigFromFormState(filled());
  assert.ok(result.ok);
  assert.equal(result.config.kind, "loki");
  assert.equal(result.config.url, "https://loki.example.com");
  assert.equal(result.config.rowFilter, undefined);

  const tenant = lokiConfigFromFormState(
    filled({ rowFilterLabel: "tenant", rowFilterClaim: "sub" }),
  );
  assert.ok(tenant.ok);
  assert.deepEqual(tenant.config.rowFilter, { label: "tenant", claim: "sub" });
});

test("each Loki form problem lands on its field, in words", () => {
  const empty = lokiConfigFromFormState(emptyLokiFormState());
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(
    empty.errors.url,
    "Enter the endpoint's URL, such as https://loki.example.com.",
  );
  assert.equal(empty.errors.labels, "Select at least one label for the allowlist.");

  const reserved = lokiConfigFromFormState(
    filled({ rowFilterLabel: "__tenant", rowFilterClaim: "" }),
  );
  assert.equal(reserved.ok, false);
  if (reserved.ok) return;
  assert.ok(reserved.errors["rowFilter.label"]);
  assert.ok(reserved.errors["rowFilter.claim"]);

  // A credential in the URL is refused, as for every HTTP kind.
  assert.equal(
    lokiConfigFromFormState(filled({ url: "https://u:p@loki.example.com" })).ok,
    false,
  );
});

test("the Loki JSON view round-trips, and text that does not parse is reported, not applied", () => {
  const state = filled({ auth: "none", rowFilterLabel: "tenant", rowFilterClaim: "sub" });
  const back = lokiFormStateFromConfigText(lokiConfigText(state));
  assert.ok(back.ok);
  assert.deepEqual(back.state, { ...state, url: "https://loki.example.com" });
  assert.equal(lokiFormStateFromConfigText("{ nope").ok, false);
  // A Prometheus config is not a Loki one.
  const other = lokiFormStateFromConfigText(
    JSON.stringify({ kind: "prometheus", url: "https://p.example.com", auth: "none" }),
  );
  assert.equal(other.ok, false);
});

test("ticking adds a label with no values; discovery fills them, capped; the allowlist cap holds", () => {
  const menu = { ran: true, labels: ["app", "env", "namespace"] };
  assert.deepEqual(searchLabelMenu(menu, " AP "), ["app"]);
  assert.deepEqual(searchLabelMenu(emptyLabelMenu(), "x"), []);
  const many = { ran: true, labels: Array.from({ length: 80 }, (_, i) => `l${i}`) };
  assert.equal(searchLabelMenu(many, "").length, LABEL_MENU_PAGE);

  let state = toggleLabel(emptyLokiFormState(), "app");
  assert.ok(isLabelSelected(state, "app"));
  assert.deepEqual(state.labels, [{ name: "app", values: [] }]);
  const values = Array.from({ length: MAX_LABEL_VALUES + 20 }, (_, i) => `v${i}`);
  state = withLabelValues(state, "app", [...values, "v1"]);
  assert.equal(state.labels[0].values.length, MAX_LABEL_VALUES);
  assert.equal(new Set(state.labels[0].values).size, MAX_LABEL_VALUES);
  // Values for a label untoggled in the meantime are dropped, never added.
  assert.deepEqual(withLabelValues(state, "env", ["prod"]).labels.length, 1);
  assert.ok(lokiConfigFromFormState({ ...filled(), labels: state.labels }).ok);
  state = toggleLabel(state, "app");
  assert.equal(state.labels.length, 0);

  let full = emptyLokiFormState();
  for (let i = 0; i < MAX_LABELS + 5; i++) full = toggleLabel(full, `l${i}`);
  assert.equal(full.labels.length, MAX_LABELS);
});
