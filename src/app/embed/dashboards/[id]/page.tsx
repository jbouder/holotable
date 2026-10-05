import type { Metadata } from "next";
import { LiveDashboard } from "@/components/dashboard/LiveDashboard";
import { can } from "@/lib/auth/authorize";
import { resolveShare } from "@/lib/auth/share-access";
import { config } from "@/lib/config";
import { getDashboardById } from "@/lib/db/repo";
import { sharedSpec } from "@/lib/share-view";

export const dynamic = "force-dynamic";

/** A share link is for whoever was sent it, not for a search index. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * A dashboard through a read-only share link (#65): live, and nothing else.
 * No navigation, editing, chat, SQL or account; the root layout leaves the
 * chrome out for this path. The token is checked against its row here and
 * again by the stream, which is what actually runs the queries.
 */
export default async function EmbedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  const shared = typeof token === "string" ? await resolveShare(token, id) : null;
  const dashboard = shared ? await getDashboardById(id) : null;
  if (
    !shared ||
    !dashboard ||
    !can(shared.identity, "dashboard:view", {
      workspaceId: dashboard.workspaceId,
      dashboardId: id,
    })
  ) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">This link is not available</h1>
          <p className="mt-1 text-sm text-muted">
            It may have expired or been revoked. Ask whoever shared it for a new one.
          </p>
        </div>
      </div>
    );
  }
  const spec = sharedSpec(dashboard.spec, shared.share.timeRange);
  return (
    <LiveDashboard
      dashboardId={id}
      spec={spec}
      maxWindowPoints={config.maxWindowPoints}
      shareToken={token as string}
      header={<h1 className="text-lg font-semibold">{spec.title}</h1>}
    />
  );
}
