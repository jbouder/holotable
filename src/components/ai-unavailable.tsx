import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shown where a prompt box would send a model request that cannot succeed
 * because no model is configured (#251). The message comes from the server
 * (`aiUnavailable()` in `src/lib/ai/configured.ts`); this only presents it.
 * Everything that needs no model (seeded dashboards, the viewer, the SQL
 * editor) keeps working around it.
 */
export function AiUnavailable({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2 border border-border bg-surface px-3 py-2 text-sm text-muted",
        className,
      )}
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{message}</p>
    </div>
  );
}
