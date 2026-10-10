"use client";

import * as React from "react";
import { chatViewFromSearch } from "@/lib/chat-history";
import { chatHref, dashboardConversation } from "@/lib/chat/client";

/**
 * How a panel's menu reaches the dashboard chat (#366). The grid and the chat
 * are siblings on the dashboard page, so the page wraps both in this provider:
 * "Ask about this panel" records a request, and the chat opens on it.
 *
 * Only the panel id travels, and the server looks the panel up in the stored
 * spec; nothing here carries SQL. Where there is no provider (an embed, the
 * editor's canvas, Chat) the menu item is simply not offered.
 */
export interface ChatRequest {
  panelId: string;
  /** Changes on every ask, so asking about the same panel twice reopens it. */
  nonce: number;
}

interface Bridge {
  request: ChatRequest | null;
  askAboutPanel: (panelId: string) => void;
  /** Continue on the Chat page about a panel (#416): the dashboard's conversation. */
  askInChat: (panelId: string) => void;
}

const ChatBridge = React.createContext<Bridge | null>(null);

export function DashboardChatProvider({
  dashboardId,
  children,
}: {
  dashboardId: string;
  children: React.ReactNode;
}) {
  const [request, setRequest] = React.useState<ChatRequest | null>(null);
  const askAboutPanel = React.useCallback((panelId: string) => {
    setRequest((prev) => ({ panelId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const askInChat = React.useCallback(
    (panelId: string) => {
      const view = chatViewFromSearch(window.location.search);
      void dashboardConversation(dashboardId, view.timeRange).then((made) => {
        // A failure (conversations not kept, say) falls back to the chat here.
        if (made.ok) window.location.assign(chatHref(made.value, panelId));
        else askAboutPanel(panelId);
      });
    },
    [dashboardId, askAboutPanel],
  );
  const value = React.useMemo(
    () => ({ request, askAboutPanel, askInChat }),
    [request, askAboutPanel, askInChat],
  );
  return <ChatBridge.Provider value={value}>{children}</ChatBridge.Provider>;
}

/** Open the chat about a panel, or undefined where there is no chat. */
export function useAskAboutPanel(): ((panelId: string) => void) | undefined {
  return React.useContext(ChatBridge)?.askAboutPanel;
}

/** Ask about a panel on the Chat page, or undefined where there is no chat. */
export function useAskInChat(): ((panelId: string) => void) | undefined {
  return React.useContext(ChatBridge)?.askInChat;
}

/** The latest "ask about this panel", for the chat to act on. */
export function useChatRequest(): ChatRequest | null {
  return React.useContext(ChatBridge)?.request ?? null;
}
