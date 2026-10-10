import { notFound } from "next/navigation";
import { getIdentity, HttpError } from "@/lib/auth/authorize";
import {
  conversationContext,
  conversationRetention,
  ownConversation,
} from "@/lib/chat/conversations";
import { chatPageData } from "@/lib/chat/page-data";
import { readStoredChatMessage } from "@/lib/chat/persist";
import { pgConversationStore } from "@/lib/db/conversations";
import { getDashboardById, getSourceById } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";
import { ChatClient } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";

/**
 * One of this person's conversations (#416). Someone else's is a 404, like one
 * that never existed. A drawn panel's rows were never stored, so each panel on
 * the page runs again through the run route.
 *
 * A conversation that continues a dashboard's chat names the dashboard and the
 * picks it was opened with; `?about=<panel id>` (from "Ask in Chat") starts
 * the next question about that panel.
 */
export default async function ConversationPage({
  params,
  searchParams,
}: PageProps<"/chat/[id]">) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const { id } = await params;
  const about = (await searchParams).about;
  let conversation: Awaited<ReturnType<typeof ownConversation>>;
  try {
    conversation = await ownConversation(id, identity, pgConversationStore);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const [data, stored, context] = await Promise.all([
    chatPageData(identity),
    pgConversationStore.messages(conversation.id, identity.sub, conversationRetention()),
    conversationContext({
      identity,
      conversation,
      getSource: getSourceById,
      getDashboard: getDashboardById,
    }),
  ]);
  const aboutPanel =
    typeof about === "string"
      ? context.dashboard?.spec.panels.find((p) => p.id === about)
      : undefined;
  return (
    <ChatClient
      {...data}
      initial={{
        conversation: {
          id: conversation.id,
          title: conversation.title,
          workspaceId: conversation.workspaceId,
          sourceIds: conversation.dashboardId
            ? context.sources.map((s) => s.id)
            : conversation.sourceIds,
          timeRange: conversation.timeRange,
        },
        messages: stored.map(readStoredChatMessage).filter((m) => m !== null),
        unavailableSourceIds: context.unavailable,
        ...(context.dashboard
          ? {
              dashboard: {
                id: context.dashboard.id,
                title: context.dashboard.title,
                picks: conversation.variables ?? {},
              },
            }
          : {}),
        ...(aboutPanel ? { draft: `About "${aboutPanel.title}": ` } : {}),
      }}
    />
  );
}
