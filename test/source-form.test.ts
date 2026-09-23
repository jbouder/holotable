import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceConfig } from "@/lib/registry";
import {
  applyDiscovery,
  configFromFormState,
  configTextFromFormState,
  connectionFromFormState,
  defaultTimeField,
  draftFieldErrors,
  emptyFormState,
  emptyMenu,
  menuAfterDiscovery,
  rememberTable,
  formStateFromConfig,
  formStateFromConfigText,
  isTimestampType,
  type SourceFormState,
  tableFieldKey,
  tableRows,
  timeFieldOptions,
  toggleTable,
  updateTable,
} from "@/lib/source-form";

/**
 * The structured source form replaces a JSON textarea, so what it has to
 * prove is that it loses nothing the textarea could express, that an error
 * lands on the field that caused it, and that discovery stays a menu rather
 * than becoming an allowlist by itself.
 */

const config = SourceConfig.parse({
  host: "timescaledb.internal",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: true,
  tables: [
    {
      name: "http_requests",
      description: "One row per request",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "status", type: "smallint", description: "HTTP status code" },
      ],
    },
  ],
});

const discovered = {
  name: "cpu_usage",
  columns: [
    { name: "host", type: "text" },
    { name: "observed_at", type: "timestamp without time zone" },
    { name: "pct", type: "double precision" },
  ],
};

function filled(overrides: Partial<SourceFormState> = {}): SourceFormState {
  return { ...formStateFromConfig(config), ...overrides };
}

test("a config survives the trip through form state unchanged", () => {
  const result = configFromFormState(formStateFromConfig(config));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.config, config);
});

test("the JSON view round-trips a config, descriptions and all", () => {
  const text = configTextFromFormState(formStateFromConfig(config));
  const parsed = formStateFromConfigText(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.state, formStateFromConfig(config));
  // The column description has no form control; it must still be there.
  assert.match(text, /HTTP status code/);
});

test("the JSON view renders a state that does not validate yet", () => {
  const text = configTextFromFormState(filled({ port: "54a2", tables: [] }));
  assert.deepEqual(JSON.parse(text).port, "54a2");
  assert.equal(formStateFromConfigText(text).ok, false);
});

test("invalid JSON and an invalid config are told apart", () => {
  const broken = formStateFromConfigText("{not json");
  assert.equal(broken.ok, false);
  assert.match(broken.ok === false ? broken.error : "", /not valid JSON/);

  const invalid = formStateFromConfigText(JSON.stringify({ ...config, host: "" }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok === false ? invalid.error : "", /^host: /);
});

test("each error attaches to the field that caused it", () => {
  const result = configFromFormState(
    filled({ host: "", port: "70000", database: "", tables: [] }),
  );
  assert.equal(result.ok, false);
  const errors = result.ok ? {} : result.errors;
  assert.deepEqual(Object.keys(errors).sort(), ["database", "host", "port", "tables"]);
  assert.match(errors.host, /Host is required/);
  assert.match(errors.port, /between 1 and 65535/);
  assert.match(errors.tables, /at least one table/);
});

test("a malformed port is one message, not two", () => {
  const result = configFromFormState(filled({ port: "" }));
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.ok ? {} : result.errors), ["port"]);
});

test("an error on a table names the table's field", () => {
  const result = configFromFormState(
    filled({ tables: [{ name: "", columns: config.tables[0].columns }] }),
  );
  assert.equal(result.ok, false);
  assert.ok(tableFieldKey(0, "name") in (result.ok ? {} : result.errors));
});

test("whitespace around a connection field is not part of it", () => {
  const result = configFromFormState(filled({ host: "  db.internal  " }));
  assert.equal(result.ok && result.config.host, "db.internal");
});

test("a placeholder left in a connection field is refused, and says what to replace", () => {
  const state = filled({ host: "<host>", database: "<database>" });
  const connection = connectionFromFormState(state);
  assert.equal(connection.ok, false);
  const errors = connection.ok ? {} : connection.errors;
  assert.match(errors.host ?? "", /Replace the placeholder <host> with the real host/);
  assert.match(errors.database ?? "", /Replace the placeholder <database>/);

  // Saving is refused the same way, not only discovery.
  assert.equal(configFromFormState(state).ok, false);
  // An ordinary hostname is untouched.
  assert.equal(connectionFromFormState(filled({ host: "db.internal" })).ok, true);
});

test("the empty form defaults the port and the schema and allowlists nothing", () => {
  const state = emptyFormState();
  assert.equal(state.port, "5432");
  assert.equal(state.schema, "public");
  assert.deepEqual(state.tables, []);
  assert.equal(connectionFromFormState(state).ok, false);
});

test("discovery can be asked for as soon as the connection alone validates", () => {
  const state = filled({ tables: [] });
  const connection = connectionFromFormState(state);
  assert.equal(connection.ok, true);
  assert.deepEqual(connection.ok && connection.connection, {
    host: "timescaledb.internal",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: true,
  });
  // …and the form still refuses to submit without an allowlist.
  assert.equal(configFromFormState(state).ok, false);
});

test("a connection error attaches to its field too", () => {
  const result = connectionFromFormState(filled({ database: "", port: "nope" }));
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.ok ? {} : result.errors).sort(), [
    "database",
    "port",
  ]);
});

test("the id, name and secret_ref are checked against the create contract", () => {
  assert.deepEqual(
    draftFieldErrors({ id: "ts-metrics", name: "Metrics", secretRef: "TS_METRICS" }),
    {},
  );
  const errors = draftFieldErrors({ id: "", name: "", secretRef: "ts_metrics" });
  assert.deepEqual(Object.keys(errors).sort(), ["id", "name", "secretRef"]);
  assert.match(errors.name, /Name is required/);
  assert.match(errors.secretRef, /UPPER_SNAKE/);
  // Editing cannot change the id, so an absent one is not an error.
  assert.deepEqual(draftFieldErrors({ name: "Metrics", secretRef: "TS_METRICS" }), {});
});

test("the picker lists the allowlist first, then what discovery added", () => {
  const menu = menuAfterDiscovery(emptyMenu(), [discovered, { ...config.tables[0] }]);
  assert.deepEqual(
    tableRows(filled(), menu).map((row) => [
      row.table.name,
      row.selected,
      row.discovered,
    ]),
    [
      ["http_requests", true, true],
      ["cpu_usage", false, true],
    ],
  );
});

test("an allowlisted table is listed before anything has been discovered", () => {
  assert.deepEqual(tableRows(filled(), emptyMenu()), [
    { table: config.tables[0], selected: true, discovered: false },
  ]);
});

test("a table the live schema no longer has stays listed, marked undiscovered", () => {
  const menu = menuAfterDiscovery(emptyMenu(), [discovered]);
  assert.deepEqual(
    tableRows(filled(), menu).map((row) => [row.table.name, row.discovered]),
    [
      ["http_requests", false],
      ["cpu_usage", true],
    ],
  );
  assert.equal(menu.ran, true);
});

test("discovery unticks allowlisted tables the schema does not have, and keeps them listed", () => {
  const placeholder = { name: "events", columns: [{ name: "ts", type: "timestamptz" }] };
  const state = filled({ tables: [config.tables[0], placeholder] });
  const live = { ...discovered, name: "http_requests" };

  const applied = applyDiscovery(state, emptyMenu(), [live, discovered]);

  assert.deepEqual(applied.unticked, ["events"]);
  assert.deepEqual(
    applied.state.tables.map((t) => t.name),
    ["http_requests"],
  );
  // The kept table is the author's, not the discovered copy: its time column
  // and description survive.
  assert.deepEqual(applied.state.tables[0], config.tables[0]);
  assert.deepEqual(
    tableRows(applied.state, applied.menu).map((row) => [
      row.table.name,
      row.selected,
      row.discovered,
    ]),
    [
      ["http_requests", true, true],
      ["cpu_usage", false, true],
      ["events", false, false],
    ],
  );
  // And ticking it again brings it back, columns and all (with its obvious
  // time column, as any tick does).
  const row = tableRows(applied.state, applied.menu).find(
    (r) => r.table.name === "events",
  );
  assert.ok(row);
  assert.deepEqual(toggleTable(applied.state, row.table).tables.at(-1), {
    ...placeholder,
    timeField: "ts",
  });
});

test("discovery never adds to the allowlist", () => {
  const applied = applyDiscovery(filled({ tables: [] }), emptyMenu(), [discovered]);
  assert.deepEqual(applied.state.tables, []);
  assert.deepEqual(applied.unticked, []);
});

test("a remembered table survives being unticked, and comes back whole", () => {
  const before = filled();
  const menu = rememberTable(emptyMenu(), before.tables[0]);
  const after = toggleTable(before, before.tables[0]);
  assert.deepEqual(after.tables, []);

  const row = tableRows(after, menu)[0];
  assert.deepEqual(row, { table: config.tables[0], selected: false, discovered: false });
  // Re-ticking restores the description and the time column it was configured
  // with, not just the name and the columns.
  assert.deepEqual(toggleTable(after, row.table).tables, before.tables);
});

test("remembering a table twice does not list it twice", () => {
  const once = rememberTable(emptyMenu(), discovered);
  assert.equal(rememberTable(once, { ...discovered }), once);
});

test("timestamp columns are recognized by their information_schema spelling", () => {
  for (const type of [
    "timestamp with time zone",
    "timestamp without time zone",
    "timestamptz",
    "date",
    "time without time zone",
  ]) {
    assert.equal(isTimestampType(type), true, type);
  }
  for (const type of ["text", "bigint", "double precision", "timeline"]) {
    assert.equal(isTimestampType(type), false, type);
  }
});

test("a time field is offered from the timestamp columns", () => {
  const options = timeFieldOptions(discovered);
  assert.equal(options.fellBack, false);
  assert.deepEqual(
    options.columns.map((c) => c.name),
    ["observed_at"],
  );
  assert.equal(defaultTimeField(discovered), "observed_at");
});

test("a table with no timestamp column falls back to every column, and says so", () => {
  const epoch = {
    name: "readings",
    columns: [
      { name: "ts", type: "bigint" },
      { name: "device_id", type: "text" },
    ],
  };
  const options = timeFieldOptions(epoch);
  assert.equal(options.fellBack, true);
  assert.deepEqual(
    options.columns.map((c) => c.name),
    ["ts", "device_id"],
  );
  assert.equal(defaultTimeField(epoch), undefined);
});

test("selecting a discovered table is what adds it to the allowlist", () => {
  const state = toggleTable(filled(), discovered);
  assert.deepEqual(
    state.tables.map((t) => t.name),
    ["http_requests", "cpu_usage"],
  );
  assert.equal(state.tables[1].timeField, "observed_at");
  // And selecting it again takes it back out.
  assert.deepEqual(toggleTable(state, discovered).tables, filled().tables);
});

test("toggling never mutates the state it was given", () => {
  const before = filled();
  const snapshot = structuredClone(before);
  toggleTable(before, discovered);
  updateTable(before, "http_requests", { timeField: "other" });
  assert.deepEqual(before, snapshot);
});

test("an emptied description or time field is absent, not blank", () => {
  const state = updateTable(filled(), "http_requests", {
    description: "",
    timeField: "",
  });
  assert.deepEqual(Object.keys(state.tables[0]).sort(), ["columns", "name"]);
  const result = configFromFormState(state);
  assert.equal(result.ok, true);
});
