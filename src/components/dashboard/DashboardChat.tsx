"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { MessageSquare } from "lucide-react";
import type { Panel } from "@/lib/ir";
import { Button } from "@/components/ui/button";
import { useChatRequest } from "@/components/dashboard/chat-bridge";
import { useShortcuts } from "@/lib/editor/use-shortcuts";
import { CHAT_OPEN_SHORTCUT } from "@/lib/shortcuts";

/**
 * What the chat needs to know about a panel: enough to cite it, to name it in
 * "Ask about this panel", and to suggest questions about it. All of it is
 * already client-visible, the same spec the grid renders.
 */
export type ChatPanel = Pick<Panel, "id" | "title" | "viz" | "query">;

const loadPanel = () => import("@/components/dashboard/DashboardChatPanel");

/** The chat body, with the AI SDK, fetched only when someone opens it (#493). */
const DashboardChatPanel = dynamic(loadPanel, { ssr: false });

/**
 * The dashboard chat's launcher, and the chat once it has been opened.
 *
 * Most people viewing a dashboard never open the chat, so the body
 * (`DashboardChatPanel.tsx`, which carries the AI SDK) is loaded on the first
 * open, and fetched early when the pointer or focus reaches the launcher.
 * Once loaded it stays mounted, so closing and opening again keeps the
 * conversation, and the panel's own exit plays before the launcher returns.
 */
export function DashboardChat(props: {
  dashboardId: string;
  /** The dashboard's workspace: whose models the chip lists (#442). */
  workspaceId: string;
  dashboardTitle: string;
  /**
   * The dashboard's panels, for citations. Already client-visible — this is the
   * same spec the grid renders — and carries no connection detail.
   */
  panels: ChatPanel[];
  /** Derived from the spec on the server; no model call produced them. */
  suggestions: string[];
  /**
   * Why no model can answer on this server, or null. Decided on the server,
   * which is the only side with the env; the chat then says so instead of
   * sending a question that can only fail.
   */
  aiUnavailable: string | null;
  /**
   * Draw the launcher (#642): the viewer's `dashboardChatButton` preference.
   * Without it the chat still opens from its shortcut and from a panel's
   * "Ask about this panel".
   */
  showLauncher: boolean;
}) {
  const { showLauncher, ...chat } = props;
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  if (open && !loaded) setLoaded(true);
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  // Closing the chat gives focus back to the launcher, or with no launcher
  // to the page's main region, never to `body`.
  const focusAfterClose = React.useCallback(() => {
    (launcherRef.current ?? document.getElementById("main"))?.focus();
  }, []);

  useShortcuts([{ ...CHAT_OPEN_SHORTCUT, run: () => setOpen(true), disabled: open }]);

  // "Ask about this panel" from a panel's menu opens the chat; the body,
  // once loaded, reads the same request and puts the panel in context.
  const request = useChatRequest();
  React.useEffect(() => {
    if (request) setOpen(true);
  }, [request]);

  const preload = React.useCallback(() => {
    void loadPanel();
  }, []);

  return (
    <>
      {!open && showLauncher && (
        <Button
          ref={launcherRef}
          variant="primary"
          size="icon"
          aria-label="Ask about this dashboard"
          aria-keyshortcuts={CHAT_OPEN_SHORTCUT.key}
          title={`Ask about this dashboard (${CHAT_OPEN_SHORTCUT.key.toUpperCase()})`}
          onClick={() => setOpen(true)}
          onPointerEnter={preload}
          onFocus={preload}
          className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg transition-[opacity,scale,background-color,color,border-color] duration-(--duration-base) ease-emphasized starting:scale-75 starting:opacity-0"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
      )}
      {loaded && (
        <DashboardChatPanel
          {...chat}
          open={open}
          setOpen={setOpen}
          focusAfterClose={focusAfterClose}
        />
      )}
    </>
  );
}
