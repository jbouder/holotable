import type { Metadata } from "next";
import { Chakra_Petch, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { CommandPalette } from "@/components/command-palette";
import { getIdentity } from "@/lib/auth/authorize";
import { timeDisplayOf } from "@/lib/preferences";
import { requestPreferences } from "@/lib/preferences-server";
import { LOCAL_TIME_DISPLAY } from "@/lib/time-display";
import { TimeDisplayProvider } from "@/components/time-display";
import { NONCE_REQUEST_HEADER } from "@/lib/security-headers";
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
  const nonce = (await headers()).get(NONCE_REQUEST_HEADER) ?? undefined;
  // The palette searches an authenticated endpoint, so it is not mounted for a
  // signed-out visitor: a Cmd+K that could only ever answer 401 is worse than
  // no Cmd+K.
  const identity = await getIdentity();
  const signedIn = identity !== null;
  // Display-only fields for the header's account menu; nothing else about the
  // identity is handed to the client here.
  const account = identity
    ? { displayName: identity.displayName ?? null, email: identity.email ?? null }
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
        <TimeDisplayProvider value={timeDisplay}>
          <NavBar account={account} />
          <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
          {signedIn && <CommandPalette />}
        </TimeDisplayProvider>
      </body>
    </html>
  );
}
