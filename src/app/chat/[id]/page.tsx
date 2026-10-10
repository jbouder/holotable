import { notFound } from "next/navigation";
import { getIdentity, HttpError } from "@/lib/auth/authorize";
import {
  conversationRetention,
  ownConversation,
  usableSources,
} from "@/lib/chat/conversations";
import { chatPageData } from "@/lib/chat/page-data";
import { readStoredChatMessage } from "@/lib/chat/persist";
import { pgConversationStore } from "@/lib/db/conversations";
import { getSourceById } from "@/lib/db/repo";
import { SignIn } from "@/components/sign-in";
import { ChatClient } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";

/**
 * One of this person's conversations (#416). Someone else's is a 404, like one
 * that never existed. A drawn panel's rows were never stored, so each panel on
 * the page runs again through the run route.
 */
export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  const { id } = await params;
  let conversation: Awaited<ReturnType<typeof ownConversation>>;
  try {
    conversation = await ownConversation(id, identity, pgConversationStore);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const [data, stored, usable] = await Promise.all([
    chatPageData(identity),
    pgConversationStore.messages(conversation.id, identity.sub, conversationRetention()),
    usableSources({ identity, conversation, getSource: getSourceById }),
  ]);
  return (
    <ChatClient
      {...data}
      initial={{
        conversation: {
          id: conversation.id,
          title: conversation.title,
          workspaceId: conversation.workspaceId,
          sourceIds: conversation.sourceIds,
          timeRange: conversation.timeRange,
        },
        messages: stored.map(readStoredChatMessage).filter((m) => m !== null),
        unavailableSourceIds: usable.unavailable,
      }}
    />
  );
}
