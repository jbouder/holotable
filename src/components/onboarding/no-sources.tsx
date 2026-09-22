import Link from "next/link";
import { Database, ExternalLink } from "lucide-react";
import { FIRST_DASHBOARD_DOCS_URL, noSourceGuidance } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The empty state for a surface that needs a data source and has none —
 * Explore and the new-dashboard page.
 *
 * Both used to say "Create one under Data sources first", which is a dead end
 * for an editor without `source:manage`: they can build dashboards and cannot
 * add the source to build them from. {@link noSourceGuidance} owns that
 * distinction so the two surfaces cannot word it differently.
 */
export function NoSources({ canManageSources }: { canManageSources: boolean }) {
  const guidance = noSourceGuidance(canManageSources);
  return (
    <EmptyState
      icon={<Database className="h-6 w-6" />}
      title={guidance.title}
      description={
        <>
          {guidance.body}{" "}
          <a
            href={FIRST_DASHBOARD_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
          >
            The walkthrough <ExternalLink className="h-3 w-3" />
          </a>{" "}
          has the whole sequence.
        </>
      }
      action={
        guidance.action ? (
          <Link href={guidance.action.href}>
            <Button>{guidance.action.label}</Button>
          </Link>
        ) : undefined
      }
    />
  );
}
