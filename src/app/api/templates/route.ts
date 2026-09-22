import { requireIdentity, assertAuthorized, HttpError } from "@/lib/auth/authorize";
import { readJson, json, route } from "@/lib/http";
import {
  createTemplate,
  DuplicateTemplateName,
  getSourceById,
  listTemplates,
} from "@/lib/db/repo";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { buildBuiltinTemplates } from "@/lib/builtin-templates";
import { TemplateCreate, TemplateKind, templateValidationSpec } from "@/lib/templates";

export const runtime = "nodejs";

/**
 * Templates are authorized exactly as the dashboards they are made of.
 *
 * Deliberately no new {@link Action}: a template is a saved `Panel` or
 * `Dashboard` spec and carries no capability its dashboard did not — listing
 * one discloses what `dashboard:view` already discloses, saving one is
 * `dashboard:create`, and deleting one is gated like deleting a dashboard
 * (its author, or a workspace source-admin). Adding a parallel `template:*`
 * vocabulary to `can()` would widen the authorization surface without
 * widening what is actually decided.
 */

/**
 * List a workspace's templates.
 *
 * `sourceId` is what adds the built-ins. They are parameterized by a catalog,
 * so there is nothing to offer until a source is named, and they are built
 * here rather than in the browser so the catalog stays on this side of the
 * wire — the SQL in a built-in is derived from it, but the table and column
 * list itself never crosses.
 */
export const GET = route("templates.list", async (req: Request) => {
  const identity = await requireIdentity();
  const params = new URL(req.url).searchParams;
  const workspaceId = params.get("workspaceId");
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const kindParam = params.get("kind");
  const kind = kindParam ? TemplateKind.safeParse(kindParam) : undefined;
  if (kind && !kind.success) {
    throw new HttpError(400, `kind must be one of ${TemplateKind.options.join(", ")}`);
  }

  assertAuthorized(identity, "dashboard:view", { workspaceId });

  const templates = await listTemplates(workspaceId, kind?.data);

  const sourceId = params.get("sourceId");
  if (sourceId) {
    const source = await getSourceById(sourceId);
    // Scoped to the named workspace, so a source elsewhere reads exactly as
    // one that does not exist: naming it discloses nothing.
    if (source && !source.tombstonedAt && source.workspaceId === workspaceId) {
      templates.push(...buildBuiltinTemplates(source, kind?.data));
    }
  }

  return json({ templates });
});

/**
 * Save a template.
 *
 * The body is put through `resolveAndValidateDashboard` — the same call a
 * dashboard save makes — by wrapping a panel template in a one-panel
 * dashboard. That is what makes the acceptance criterion "IR-validated on
 * write" a property of the code path rather than a separate check: every
 * referenced source must exist, be untombstoned and belong to one workspace,
 * and every statement is re-guarded against that source's catalog. The
 * workspace the sources derive to must be the one the caller asked for, so a
 * template can never be filed against a workspace its panels cannot read.
 */
export const POST = route("templates.create", async (req: Request) => {
  const identity = await requireIdentity();
  const body = await readJson(req, TemplateCreate);

  assertAuthorized(identity, "dashboard:create", { workspaceId: body.workspaceId });

  const { workspaceId } = await resolveAndValidateDashboard(
    templateValidationSpec(body.body),
  );
  if (workspaceId !== body.workspaceId) {
    throw new HttpError(400, "panels reference a different workspace");
  }

  try {
    const template = await createTemplate({
      workspaceId,
      name: body.name,
      description: body.description,
      body: body.body,
      createdBy: identity.sub,
    });
    return json({ template }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateTemplateName) {
      throw new HttpError(
        409,
        `this workspace already has a template called "${body.name}" — pick another name`,
        {},
        "validation",
      );
    }
    throw err;
  }
});
