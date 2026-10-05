import type { Metadata } from "next";
import { Chakra_Petch, JetBrains_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { CommandPalette } from "@/components/command-palette";
import { DemoBanner } from "@/components/demo-banner";
import { SessionKeepalive } from "@/components/session-keepalive";
import { config } from "@/lib/config";
import { getIdentity } from "@/lib/auth/authorize";
import { tokenExpiry } from "@/lib/auth/session";
import { timeDisplayOf } from "@/lib/preferences";
import { requestPreferences } from "@/lib/preferences-server";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";
import { TimeDisplayProvider } from "@/components/time-display";
import { EMBED_REQUEST_HEADER, NONCE_REQUEST_HEADER } from "@/lib/security-headers";
import { BOOTSTRAP_SCRIPT } from "@/lib/bootstrap";

const fontSans = Chakra_Petch({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-chakra-petch",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Holotable",
  description: "Natural-language monitoring dashboards",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // src/proxy.ts mints a nonce per request and puts it in this header. Next
  // stamps its own scripts with it; the hand-written script below is ours to
  // stamp. Absent only when the proxy did not run for this request.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(NONCE_REQUEST_HEADER) ?? undefined;
  // A share link's embed page (#65): no navigation, account, banner or
  // palette, and no session read at all. The proxy sets this and strips it
  // from any request that sent it itself.
  const embed = requestHeaders.get(EMBED_REQUEST_HEADER) === "1";
  // The palette searches an authenticated endpoint, so it is not mounted for a
  // signed-out visitor: a Cmd+K that could only ever answer 401 is worse than
  // no Cmd+K.
  const identity = embed ? null : await getIdentity();
  const signedIn = identity !== null;
  // Display-only fields for the header's account menu; nothing else about the
  // identity is handed to the client here.
  const account = identity
    ? { displayName: identity.displayName ?? null, email: identity.email ?? null }
    : null;
  // When this session's token expires, so the browser can renew it first
  // (#27). Only for a realm session; a demo session has nothing to renew with.
  const sessionToken = (await cookies()).get(config.sessionCookieName)?.value;
  const sessionExpiresAt =
    identity && config.authMode !== "demo" && sessionToken
      ? tokenExpiry(sessionToken)
      : null;
  // How this person wants times shown (#214). Signed out it is browser-local;
  // a database that does not answer yields the same, never an error page.
  const timeDisplay = identity
    ? timeDisplayOf(await requestPreferences(identity))
    : LOCAL_TIME_DISPLAY;
  return (
    <html
      lang="en"
      className={`h-full antialiased ${fontSans.variable} ${fontMono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        {/*
          Sets the theme and the motion preference before first paint so the
          page does not flash light then dark, or animate once before the
          reduce setting lands (src/lib/bootstrap.ts). It has to be inline and synchronous in <head> — next/script
          with beforeInteractive still runs after the first paint — and the
          content is built from constants only, never from request data, so
          there is no injection surface. The nonce is what lets it run under the
          Content-Security-Policy; without it the browser blocks the script
          and the page flashes. Browsers hide the nonce from the DOM (the
          attribute reads as "" after parsing), so React would report a
          mismatch on hydration; that is expected, not a bug.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          // biome-ignore lint/security/noDangerouslySetInnerHtml: constant script, must run before first paint
          dangerouslySetInnerHTML={{ __html: BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        {embed ? (
          <TimeDisplayProvider value={timeDisplay}>
            <main className="flex-1 p-3 sm:p-4">{children}</main>
          </TimeDisplayProvider>
        ) : (
          <TimeDisplayProvider value={timeDisplay}>
            {/*
              The first stop for a keyboard (#77): past the navigation, straight
              to the page. Visible only while it has focus. `main` takes focus
              from it (tabIndex -1) so the next Tab continues from there.
            */}
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:outline-2 focus:outline-primary"
            >
              Skip to content
            </a>
            <NavBar account={account} />
            {config.authMode === "demo" && <DemoBanner />}
            {sessionExpiresAt !== null && (
              <SessionKeepalive expiresAt={sessionExpiresAt} />
            )}
            <main
              id="main"
              tabIndex={-1}
              className="flex-1 px-4 py-6 outline-none sm:px-6"
            >
              {children}
            </main>
            {signedIn && <CommandPalette />}
          </TimeDisplayProvider>
        )}
      </body>
    </html>
  );
}
