import {
  LINK_SET_MAX,
  type PanelLink,
  PanelLink as PanelLinkSchema,
  selfLinkProblems,
  VariableName,
} from "@/lib/ir";

/**
 * The panel inspector's link form (#374), as data: what the author is
 * editing, how it becomes a `PanelLink`, and what is wrong with it. Pure, so
 * the rules are tested without a render and the component only draws them.
 */

/**
 * Where one pick comes from: a literal, a result column, the clicked series,
 * or one label of the clicked PromQL series (#388).
 */
export type PickSource = "value" | "column" | "series" | "label";

export interface LinkSetRow {
  /** The target's variable. */
  name: string;
  source: PickSource;
  /** The literal, the column's name or the label's; unused for the series. */
  text: string;
}

export interface LinkForm {
  /**
   * The target dashboard, as the server listed it; null is this dashboard,
   * and an empty id is another one not picked yet.
   */
  target: { id: string; title: string } | null;
  title: string;
  carryTimeRange: boolean;
  carryVariables: boolean;
  set: LinkSetRow[];
  newTab: boolean;
}

/** A new link: to this dashboard, carrying everything, setting nothing yet. */
export function emptyLinkForm(): LinkForm {
  return {
    target: null,
    title: "",
    carryTimeRange: true,
    carryVariables: true,
    set: [],
    newTab: false,
  };
}

/** A link as the form edits it. `targetTitle` is the server's title for its target. */
export function formFromLink(link: PanelLink, targetTitle?: string): LinkForm {
  return {
    target:
      link.dashboard === undefined
        ? null
        : { id: link.dashboard, title: targetTitle ?? link.dashboard },
    title: link.title,
    carryTimeRange: link.carry?.timeRange ?? true,
    carryVariables: link.carry?.variables ?? true,
    set: Object.entries(link.set ?? {}).map(([name, v]) =>
      "value" in v
        ? { name, source: "value", text: v.value }
        : "column" in v
          ? { name, source: "column", text: v.column }
          : "label" in v
            ? { name, source: "label", text: v.label }
            : { name, source: "series", text: "" },
    ),
    newTab: link.newTab === true,
  };
}

/**
 * The link a form describes, or why it is not one yet. `otherTitles` are the
 * panel's other links (titles are unique within a panel); `ownVariables` are
 * this dashboard's, which a self link may set. Defaults are left out of the
 * link, so a link that changes nothing reads as short as the IR allows.
 */
export function linkFromForm(
  form: LinkForm,
  {
    otherTitles,
    ownVariables,
  }: { otherTitles: string[]; ownVariables: ReadonlySet<string> },
): { link: PanelLink | null; problems: string[] } {
  const problems: string[] = [];
  const title = form.title.trim();
  if (title === "") problems.push("Give the link a title.");
  else if (otherTitles.includes(title))
    problems.push(`Another link is already titled "${title}".`);

  if (form.target !== null && form.target.id === "") {
    problems.push("Choose the dashboard it leads to.");
  }

  const names = new Set<string>();
  for (const [i, row] of form.set.entries()) {
    const n = i + 1;
    if (row.name === "") problems.push(`Pick ${n}: choose a variable.`);
    else if (!VariableName.safeParse(row.name).success)
      problems.push(`Pick ${n}: "${row.name}" is not a variable name.`);
    else if (names.has(row.name)) problems.push(`"${row.name}" is set twice.`);
    names.add(row.name);
    if (row.source !== "series" && row.text.trim() === "") {
      problems.push(
        `Pick ${n}: ${row.source === "value" ? "enter a value" : row.source === "label" ? "name the label" : "choose a column"}.`,
      );
    }
  }
  if (form.set.length > LINK_SET_MAX) {
    problems.push(`A link sets at most ${LINK_SET_MAX} variables.`);
  }

  const candidate = {
    title,
    ...(form.target ? { dashboard: form.target.id } : {}),
    ...(form.carryTimeRange && form.carryVariables
      ? {}
      : {
          carry: {
            ...(form.carryTimeRange ? {} : { timeRange: false }),
            ...(form.carryVariables ? {} : { variables: false }),
          },
        }),
    ...(form.set.length > 0
      ? {
          set: Object.fromEntries(
            form.set.map((row) => [
              row.name,
              row.source === "value"
                ? { value: row.text }
                : row.source === "column"
                  ? { column: row.text.trim() }
                  : row.source === "label"
                    ? { label: row.text.trim() }
                    : { series: true },
            ]),
          ),
        }
      : {}),
    ...(form.newTab ? { newTab: true } : {}),
  };
  if (problems.length > 0) return { link: null, problems };

  const parsed = PanelLinkSchema.safeParse(candidate);
  if (!parsed.success) {
    return { link: null, problems: parsed.error.issues.map((i) => i.message) };
  }
  // The IR's own words for a self link that does nothing or sets a stranger.
  const self = selfLinkProblems(parsed.data, ownVariables).map((p) => p.message);
  return self.length > 0
    ? { link: null, problems: self }
    : { link: parsed.data, problems: [] };
}

/**
 * The picks a target does not declare. The target would ignore them on
 * arrival, which is never what the author meant, so the form flags them.
 * Unknown (`null`) while the target's variables are loading.
 */
export function undeclaredPicks(
  form: LinkForm,
  declared: readonly string[] | null,
): string[] {
  if (declared === null) return [];
  return form.set.map((r) => r.name).filter((n) => n !== "" && !declared.includes(n));
}

/** Move one link, for the list's reorder buttons. */
export function moveLink<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
