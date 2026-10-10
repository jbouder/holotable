import { getIdentity } from "@/lib/auth/authorize";
import { chatPageData } from "@/lib/chat/page-data";
import { SignIn } from "@/components/sign-in";
import { ChatClient } from "@/components/chat/chat-client";

export const dynamic = "force-dynamic";

/** A new conversation (#416): the first question creates it. */
export default async function ChatPage() {
  const identity = await getIdentity();
  if (!identity) return <SignIn />;
  return <ChatClient {...(await chatPageData(identity))} />;
}
