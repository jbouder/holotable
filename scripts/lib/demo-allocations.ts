import { SPEC_VERSION } from "@/lib/ir";

/**
 * The project allocations demo: who is staffed on what, week by week.
 *
 * Three small tables in the `metrics` schema, behind the `ts-people` source:
 * `people` and `projects` (no time column: they are dimensions) and
 * `allocations`, one row per person, project and week, each week a Monday at
 * 00:00 UTC. The weeks run from {@link ALLOCATION_WEEKS_BACK} before the
 * current one to {@link ALLOCATION_WEEKS_AHEAD} after it: past weeks carry
 * logged `actual_hours`, the current week and later only the plan.
 *
 * The rows are a pure function of the current week, so the seeder rewrites
 * them on start and again when the week turns over (`scripts/seed.ts`), and
 * `test/demo-dashboards.test.ts` holds the spec to the guard without a
 * database. The staffing below is written out by hand so the dashboard has
 * stories to tell: an engineer double-booked as Delta ramps up, a pilot that
 * winds down and leaves a data scientist on the bench, part-timers whose
 * percentages are of fewer hours.
 */

export const ALLOCATIONS_SOURCE_ID = "ts-people";
export const ALLOCATIONS_SOURCE_NAME = "Demo TimescaleDB staffing";
export const ALLOCATIONS_DASHBOARD_TITLE = "Demo project allocations";

export const ALLOCATION_WEEKS_BACK = 26;
export const ALLOCATION_WEEKS_AHEAD = 12;

const WEEK_MS = 7 * 86_400_000;
/** 1970-01-05, the first Monday of the epoch. */
const FIRST_MONDAY_MS = 4 * 86_400_000;

export const TEAMS = ["platform", "data", "design", "web", "delivery"] as const;
type Team = (typeof TEAMS)[number];

/** [person, name, team, role, location, weekly capacity in hours]. */
export const PEOPLE: [string, string, Team, string, string, number][] = [
  ["avery", "Avery Chen", "platform", "Tech lead", "Toronto", 40],
  ["jordan", "Jordan Patel", "platform", "Senior engineer", "Austin", 40],
  ["sam", "Sam Okafor", "platform", "Engineer", "Lagos", 40],
  ["riley", "Riley Novak", "platform", "Engineer", "Prague", 40],
  ["morgan", "Morgan Silva", "platform", "Site reliability engineer", "Lisbon", 40],
  ["casey", "Casey Moreau", "data", "Data lead", "Montréal", 40],
  ["devon", "Devon Ito", "data", "Data scientist", "Osaka", 40],
  ["harper", "Harper Lindqvist", "data", "Data engineer", "Stockholm", 40],
  ["quinn", "Quinn Adeyemi", "data", "Data engineer", "London", 32],
  ["rowan", "Rowan Castillo", "design", "Design lead", "Mexico City", 40],
  ["sky", "Sky Hartmann", "design", "Product designer", "Berlin", 40],
  ["emerson", "Emerson Kaur", "design", "UX researcher", "Vancouver", 32],
  ["taylor", "Taylor Brooks", "web", "Tech lead", "Denver", 40],
  ["jamie", "Jamie Romero", "web", "Senior engineer", "Madrid", 40],
  ["alex", "Alex Nakamura", "web", "Engineer", "Seattle", 40],
  ["reese", "Reese Dubois", "web", "Engineer", "Lyon", 40],
  ["parker", "Parker Owusu", "web", "Engineer", "Accra", 40],
  ["blake", "Blake Larsen", "delivery", "Project manager", "Oslo", 40],
  ["drew", "Drew Fontaine", "delivery", "Project manager", "Chicago", 40],
  ["kendall", "Kendall Ahmed", "delivery", "Delivery lead", "Dubai", 40],
];

/** [project, name, client, status, billable, budget in hours (null: none)]. */
export const PROJECTS: [string, string, string, string, boolean, number | null][] = [
  ["atlas", "Atlas checkout rebuild", "Northwind", "active", true, 9000],
  ["beacon", "Beacon analytics", "Contoso", "active", true, 4500],
  ["cobalt", "Cobalt data platform", "Internal", "active", false, 4000],
  ["delta", "Delta mobile app", "Fabrikam", "starting", true, 5000],
  ["ember", "Ember support retainer", "Northwind", "active", true, 2500],
  ["forge", "Forge design system", "Internal", "active", false, 2000],
  ["harbor", "Harbor ML pilot", "Contoso", "closing", true, 1900],
  ["internal", "Internal & admin", "Internal", "ongoing", false, null],
];

/**
 * [person, project, percent of their capacity, first week, last week], weeks
 * relative to the current one (0) and clamped to the seeded range. Everyone
 * also spends {@link INTERNAL_PCT} on internal work, every week, unless an
 * assignment here says otherwise.
 */
const ASSIGNMENTS: [string, string, number, number, number][] = [
  ["avery", "atlas", 40, -26, 12],
  ["avery", "cobalt", 50, -26, 12],
  // Still on Atlas as Delta starts: double-booked for eight weeks.
  ["jordan", "atlas", 80, -26, 6],
  ["jordan", "delta", 50, -2, 12],
  ["sam", "cobalt", 60, -20, 12],
  ["sam", "ember", 30, -26, 12],
  ["riley", "atlas", 50, -26, 12],
  ["riley", "harbor", 40, -26, 1],
  ["morgan", "ember", 40, -26, 12],
  ["morgan", "cobalt", 30, -26, 12],
  ["casey", "beacon", 50, -26, 12],
  ["casey", "harbor", 40, -26, 1],
  // Harbor ends next week, and nothing has been found for Devon after it.
  ["devon", "harbor", 70, -26, 1],
  ["devon", "beacon", 20, -26, 12],
  ["harper", "cobalt", 70, -26, 12],
  ["harper", "beacon", 30, -10, 12],
  ["quinn", "beacon", 90, -26, 12],
  ["rowan", "forge", 50, -26, 12],
  ["rowan", "atlas", 20, -26, -4],
  ["rowan", "delta", 40, -4, 12],
  ["sky", "atlas", 60, -26, 4],
  ["sky", "delta", 40, 0, 12],
  ["sky", "forge", 10, -26, 12],
  ["emerson", "beacon", 40, -26, 12],
  ["emerson", "delta", 50, -6, 12],
  ["taylor", "atlas", 60, -26, 12],
  ["taylor", "delta", 30, -4, 12],
  ["jamie", "atlas", 90, -26, 12],
  ["alex", "ember", 40, -26, 12],
  ["alex", "atlas", 50, -16, 12],
  // Off Atlas, and five weeks on the bench before Delta.
  ["reese", "atlas", 50, -26, -8],
  ["reese", "delta", 80, -2, 12],
  ["parker", "forge", 60, -26, 12],
  ["parker", "ember", 20, -26, 12],
  ["blake", "atlas", 50, -26, 12],
  ["blake", "ember", 20, -26, 12],
  ["blake", "delta", 30, 0, 12],
  ["drew", "beacon", 40, -26, 12],
  ["drew", "harbor", 40, -26, 1],
  ["drew", "cobalt", 10, -26, 12],
  ["kendall", "internal", 30, -26, 12],
  ["kendall", "atlas", 20, -26, 12],
  ["kendall", "beacon", 20, -26, 12],
  ["kendall", "delta", 20, -4, 12],
];

/** Everyone's standing share of internal work and admin. */
const INTERNAL_PCT = 10;

export interface PersonRow {
  person: string;
  name: string;
  team: string;
  role: string;
  location: string;
  capacity_hours: number;
}

export interface ProjectRow {
  project: string;
  name: string;
  client: string;
  status: string;
  billable: boolean;
  budget_hours: number | null;
}

export interface AllocationRow {
  week: Date;
  person: string;
  project: string;
  allocation_pct: number;
  planned_hours: number;
  /** Logged hours; null for the current week and later. */
  actual_hours: number | null;
}

export const personRows = (): PersonRow[] =>
  PEOPLE.map(([person, name, team, role, location, capacity_hours]) => ({
    person,
    name,
    team,
    role,
    location,
    capacity_hours,
  }));

export const projectRows = (): ProjectRow[] =>
  PROJECTS.map(([project, name, client, status, billable, budget_hours]) => ({
    project,
    name,
    client,
    status,
    billable,
    budget_hours,
  }));

/** The Monday, 00:00 UTC, that starts the week `at` falls in. */
export function weekStart(at: number): number {
  return at - ((((at - FIRST_MONDAY_MS) % WEEK_MS) + WEEK_MS) % WEEK_MS);
}

/** A stable number in [0, 1) for a key: the same week logs the same hours. */
function noise(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

/**
 * Every allocation row, as of `now`. A past week logs within 15% of its plan,
 * and about one person-week in twelve is a week off: under a fifth of it.
 */
export function allocationRows(now = Date.now()): AllocationRow[] {
  const thisWeek = weekStart(now);
  const capacity = new Map(PEOPLE.map(([person, , , , , hours]) => [person, hours]));
  const ownInternal = new Set(
    ASSIGNMENTS.filter(([, project]) => project === "internal").map(([person]) => person),
  );
  const standing: [string, string, number, number, number][] = PEOPLE.filter(
    ([person]) => !ownInternal.has(person),
  ).map(([person]) => [
    person,
    "internal",
    INTERNAL_PCT,
    -ALLOCATION_WEEKS_BACK,
    ALLOCATION_WEEKS_AHEAD,
  ]);
  const rows: AllocationRow[] = [];
  for (const [person, project, pct, first, last] of [...standing, ...ASSIGNMENTS]) {
    const hours = capacity.get(person) ?? 40;
    const from = Math.max(first, -ALLOCATION_WEEKS_BACK);
    const to = Math.min(last, ALLOCATION_WEEKS_AHEAD);
    for (let offset = from; offset <= to; offset++) {
      const week = thisWeek + offset * WEEK_MS;
      const planned = Math.round(hours * pct) / 100;
      let actual: number | null = null;
      if (offset < 0) {
        const off = noise(`${person}:${week}`) < 1 / 12;
        const factor = off ? 0.15 : 0.85 + noise(`${person}:${project}:${week}`) * 0.3;
        actual = Math.round(planned * factor * 2) / 2;
      }
      rows.push({
        week: new Date(week),
        person,
        project,
        allocation_pct: pct,
        planned_hours: planned,
        actual_hours: actual,
      });
    }
  }
  return rows.sort((a, b) => a.week.getTime() - b.week.getTime());
}

/** The catalog the seeder registers for {@link ALLOCATIONS_SOURCE_ID}. */
export const ALLOCATION_TABLES = [
  {
    name: "people",
    description: "everyone who can be staffed, one row a person",
    columns: [
      { name: "person", type: "text", description: "id, as in allocations.person" },
      { name: "name", type: "text" },
      {
        name: "team",
        type: "text",
        description: "platform, data, design, web or delivery",
      },
      { name: "role", type: "text" },
      { name: "location", type: "text" },
      { name: "capacity_hours", type: "integer", description: "hours a week" },
    ],
  },
  {
    name: "projects",
    description: "what people are staffed on, one row a project",
    columns: [
      { name: "project", type: "text", description: "id, as in allocations.project" },
      { name: "name", type: "text" },
      { name: "client", type: "text", description: "Internal for internal work" },
      {
        name: "status",
        type: "text",
        description: "starting, active, closing or ongoing",
      },
      { name: "billable", type: "boolean" },
      {
        name: "budget_hours",
        type: "integer",
        description: "null for internal work and admin",
      },
    ],
  },
  {
    name: "allocations",
    description:
      "who is planned on what, one row per person, project and week (Monday, 00:00 UTC); future weeks are planned only",
    timeField: "week",
    columns: [
      { name: "week", type: "timestamp with time zone" },
      { name: "person", type: "text" },
      { name: "project", type: "text" },
      {
        name: "allocation_pct",
        type: "double precision",
        description: "percent of the person's weekly capacity",
      },
      { name: "planned_hours", type: "double precision" },
      {
        name: "actual_hours",
        type: "double precision",
        description: "hours logged; null for the current week and later",
      },
    ],
  },
];

/** The `team` picker every staffing panel filters on. */
const TEAM_VARIABLE = {
  name: "team",
  label: "Team",
  type: "enum",
  values: [...TEAMS],
  multi: true,
  default: [...TEAMS],
} as const;

/** Allocations joined to their people, narrowed to the picked teams. */
const STAFFED =
  "allocations a JOIN people p ON p.person = a.person WHERE p.team = ANY(:team)";

/** Load bands: under 60% is spare capacity, over 100% double-booked. */
const LOAD_THRESHOLDS = [
  { value: 0, color: "warning" },
  { value: 60, color: "success" },
  { value: 101, color: "danger" },
] as const;

/** Each client project's planned hours as a column, for a stacked series. */
const HOURS_BY_PROJECT = PROJECTS.map(
  ([project, name]) =>
    `sum(a.planned_hours) FILTER (WHERE a.project = '${project}') AS "${name}"`,
).join(", ");

/** Who is staffed on what, how loaded everyone is, and what is coming. */
export function allocationsSpec() {
  return {
    specVersion: SPEC_VERSION,
    title: ALLOCATIONS_DASHBOARD_TITLE,
    timeRange: { from: "now-12w", to: "now" },
    refreshIntervalMs: 300000,
    variables: [TEAM_VARIABLE],
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Project allocations",
            "",
            "Who is staffed on what, week by week. **Load** is the share of a person's weekly capacity planned on projects: amber is under 60% (room for more), red over 100% (double-booked). Past weeks also carry the hours people logged; the current week and later are the plan. Pick teams above to narrow every panel but the project budgets.",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 2 },
      },
      {
        id: "headcount",
        title: "People",
        viz: "stat",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          sql: "SELECT count(*) AS people FROM people WHERE team = ANY(:team)",
        },
        format: "number",
        options: { decimals: 0 },
        layout: { x: 0, y: 2, w: 3, h: 3 },
      },
      {
        id: "utilization",
        title: "Utilization",
        description: "Planned hours over everyone's capacity, by week.",
        viz: "stat",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, 100.0 * sum(a.planned_hours) / (SELECT sum(capacity_hours) FROM people WHERE team = ANY(:team)) AS utilization FROM ${STAFFED} GROUP BY a.week ORDER BY a.week`,
        },
        format: "percent",
        options: { sparkline: true, decimals: 0, thresholds: LOAD_THRESHOLDS },
        layout: { x: 3, y: 2, w: 3, h: 3 },
      },
      {
        id: "billable",
        title: "Billable share",
        description: "Planned hours on client work, by week.",
        viz: "stat",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, 100.0 * sum(a.planned_hours) FILTER (WHERE pr.billable) / sum(a.planned_hours) AS billable_pct FROM allocations a JOIN people p ON p.person = a.person JOIN projects pr ON pr.project = a.project WHERE p.team = ANY(:team) GROUP BY a.week ORDER BY a.week`,
        },
        format: "percent",
        options: {
          sparkline: true,
          decimals: 0,
          thresholds: [
            { value: 0, color: "danger" },
            { value: 50, color: "warning" },
            { value: 70, color: "success" },
          ],
        },
        layout: { x: 6, y: 2, w: 3, h: 3 },
      },
      {
        id: "over-allocated",
        title: "Double-booked",
        description: "People planned over 100% of their capacity, by week.",
        viz: "stat",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `WITH load AS (SELECT a.week, a.person, sum(a.allocation_pct) AS pct FROM ${STAFFED} GROUP BY a.week, a.person) SELECT week, count(*) FILTER (WHERE pct > 100) AS people FROM load GROUP BY week ORDER BY week`,
        },
        format: "number",
        options: {
          sparkline: true,
          decimals: 0,
          thresholds: [
            { value: 0, color: "success" },
            { value: 1, color: "warning" },
            { value: 3, color: "danger" },
          ],
        },
        layout: { x: 9, y: 2, w: 3, h: 3 },
      },
      {
        id: "hours-by-project",
        title: "Planned hours by project",
        viz: "bar",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, ${HOURS_BY_PROJECT} FROM ${STAFFED} GROUP BY a.week ORDER BY a.week`,
        },
        format: "number",
        options: { stacked: true, legend: "top", unit: "h", decimals: 0 },
        layout: { x: 0, y: 5, w: 8, h: 5 },
      },
      {
        id: "team-utilization",
        title: "Utilization by team",
        description: "This week's planned hours over each team's capacity.",
        viz: "gauge",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `WITH capacity AS (SELECT team, sum(capacity_hours) AS hours FROM people GROUP BY team) SELECT a.week, p.team, 100.0 * sum(a.planned_hours) / c.hours AS utilization FROM allocations a JOIN people p ON p.person = a.person JOIN capacity c ON c.team = p.team WHERE p.team = ANY(:team) GROUP BY a.week, p.team, c.hours ORDER BY a.week, p.team`,
        },
        format: "percent",
        options: {
          variant: "bar",
          value: "utilization",
          min: 0,
          max: 120,
          decimals: 0,
          thresholds: LOAD_THRESHOLDS,
        },
        layout: { x: 8, y: 5, w: 4, h: 5 },
      },
      {
        id: "load-heat",
        title: "Load, by person and week",
        viz: "heatmap",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, p.name, sum(a.allocation_pct) AS load FROM ${STAFFED} GROUP BY a.week, p.name ORDER BY a.week, p.name`,
        },
        format: "percent",
        layout: { x: 0, y: 10, w: 8, h: 6 },
      },
      {
        id: "load-now",
        title: "Load this week",
        viz: "status-grid",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, p.name, sum(a.allocation_pct) AS load FROM ${STAFFED} GROUP BY a.week, p.name ORDER BY a.week`,
        },
        format: "percent",
        options: {
          entity: "name",
          value: "load",
          sort: "value",
          columns: 2,
          decimals: 0,
          thresholds: LOAD_THRESHOLDS,
        },
        layout: { x: 8, y: 10, w: 4, h: 6 },
      },
      {
        id: "planned-vs-actual",
        title: "Planned against logged hours",
        description: "Weeks with logged hours: the current week has none yet.",
        viz: "line",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: `SELECT a.week, sum(a.planned_hours) AS planned, sum(a.actual_hours) AS logged FROM ${STAFFED} GROUP BY a.week HAVING count(a.actual_hours) > 0 ORDER BY a.week`,
        },
        format: "number",
        options: { legend: "top", unit: "h", decimals: 0 },
        layout: { x: 0, y: 16, w: 6, h: 4 },
      },
      {
        id: "team-flow",
        title: "Where each team's hours go",
        viz: "sankey",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: "SELECT a.week, p.team, pr.name AS project, sum(a.planned_hours) AS hours FROM allocations a JOIN people p ON p.person = a.person JOIN projects pr ON pr.project = a.project WHERE p.team = ANY(:team) GROUP BY a.week, p.team, pr.name ORDER BY a.week",
        },
        format: "number",
        options: { path: ["team", "project"], value: "hours", unit: "h", decimals: 0 },
        layout: { x: 6, y: 16, w: 6, h: 4 },
      },
      {
        id: "client-hours",
        title: "Hours by client and project",
        viz: "treemap",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: "SELECT a.week, pr.client, pr.name AS project, sum(a.planned_hours) AS hours FROM allocations a JOIN people p ON p.person = a.person JOIN projects pr ON pr.project = a.project WHERE p.team = ANY(:team) GROUP BY a.week, pr.client, pr.name ORDER BY a.week",
        },
        format: "number",
        options: { path: ["client", "project"], value: "hours", unit: "h", decimals: 0 },
        layout: { x: 0, y: 20, w: 5, h: 5 },
      },
      {
        id: "assignments",
        title: "Who is on what this week",
        viz: "table",
        timeRange: { from: "now-7d", to: "now" },
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          timeField: "week",
          sql: "SELECT a.week, p.name, p.team, p.role, string_agg(pr.name || ' (' || round(a.allocation_pct)::text || '%)', ', ' ORDER BY a.allocation_pct DESC) AS assignments, sum(a.allocation_pct) AS load FROM allocations a JOIN people p ON p.person = a.person JOIN projects pr ON pr.project = a.project WHERE p.team = ANY(:team) GROUP BY a.week, p.name, p.team, p.role ORDER BY load DESC, p.name",
        },
        options: {
          columns: [
            { name: "week", hidden: true },
            { name: "name", label: "Person" },
            { name: "team", label: "Team" },
            { name: "role", label: "Role" },
            { name: "assignments", label: "Assignments", width: 320 },
            {
              name: "load",
              label: "Load",
              format: "percent",
              decimals: 0,
              align: "right",
            },
          ],
        },
        layout: { x: 5, y: 20, w: 7, h: 5 },
      },
      {
        id: "budgets",
        title: "Project budgets",
        description:
          "Logged hours against each project's budget, over every week seeded. Not narrowed by team.",
        viz: "table",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          sql: "SELECT pr.name, pr.client, pr.status, sum(a.actual_hours) AS logged, pr.budget_hours AS budget, 100.0 * sum(a.actual_hours) / pr.budget_hours AS burned FROM projects pr JOIN allocations a ON a.project = pr.project WHERE pr.budget_hours IS NOT NULL GROUP BY pr.name, pr.client, pr.status, pr.budget_hours ORDER BY burned DESC",
        },
        options: {
          columns: [
            { name: "name", label: "Project" },
            { name: "client", label: "Client" },
            { name: "status", label: "Status" },
            { name: "logged", label: "Logged", unit: "h", decimals: 0, align: "right" },
            { name: "budget", label: "Budget", unit: "h", decimals: 0, align: "right" },
            {
              name: "burned",
              label: "Burned",
              format: "percent",
              decimals: 0,
              align: "right",
            },
          ],
        },
        layout: { x: 0, y: 25, w: 7, h: 4 },
      },
      {
        id: "plan-ahead",
        title: "The plan from this week on",
        description: "Weeks with no logged hours yet, by project.",
        viz: "table",
        query: {
          sourceId: ALLOCATIONS_SOURCE_ID,
          sql: "SELECT pr.name AS project, count(DISTINCT a.person) AS people, count(DISTINCT a.week) AS weeks, sum(a.planned_hours) AS hours FROM allocations a JOIN people p ON p.person = a.person JOIN projects pr ON pr.project = a.project WHERE a.actual_hours IS NULL AND p.team = ANY(:team) AND pr.project <> 'internal' GROUP BY pr.name ORDER BY hours DESC",
        },
        options: {
          columns: [
            { name: "project", label: "Project" },
            { name: "people", label: "People", align: "right" },
            { name: "weeks", label: "Weeks", align: "right" },
            { name: "hours", label: "Planned", unit: "h", decimals: 0, align: "right" },
          ],
        },
        layout: { x: 7, y: 25, w: 5, h: 4 },
      },
    ],
  };
}
