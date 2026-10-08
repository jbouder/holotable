"use client";

import * as React from "react";

/**
 * How a panel's menu reaches the dashboard chat (#366). The grid and the chat
 * are siblings on the dashboard page, so the page wraps both in this provider:
 * "Ask about this panel" records a request, and the chat opens on it.
 *
 * Only the panel id travels, and the server looks the panel up in the stored
 * spec; nothing here carries SQL. Where there is no provider (an embed, the
 * editor's canvas, Explore) the menu item is simply not offered.
 */
export interface ChatRequest {
  panelId: string;
  /** Changes on every ask, so asking about the same panel twice reopens it. */
  nonce: number;
}

interface Bridge {
  request: ChatRequest | null;
  askAboutPanel: (panelId: string) => void;
}

const ChatBridge = React.createContext<Bridge | null>(null);

export function DashboardChatProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<ChatRequest | null>(null);
  const askAboutPanel = React.useCallback((panelId: string) => {
    setRequest((prev) => ({ panelId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const value = React.useMemo(
    () => ({ request, askAboutPanel }),
    [request, askAboutPanel],
  );
  return <ChatBridge.Provider value={value}>{children}</ChatBridge.Provider>;
}

/** Open the chat about a panel, or undefined where there is no chat. */
export function useAskAboutPanel(): ((panelId: string) => void) | undefined {
  return React.useContext(ChatBridge)?.askAboutPanel;
}

/** The latest "ask about this panel", for the chat to act on. */
export function useChatRequest(): ChatRequest | null {
  return React.useContext(ChatBridge)?.request ?? null;
}
