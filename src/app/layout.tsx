import type { Metadata } from "next";
import { Chakra_Petch, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";
import { NONCE_REQUEST_HEADER } from "@/lib/security-headers";

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
  return (
    <html
      lang="en"
      className={`h-full antialiased ${fontSans.variable} ${fontMono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        {/*
          Sets the theme before first paint so the page does not flash light
          then dark. It has to be inline and synchronous in <head> — next/script
          with beforeInteractive still runs after the first paint — and the
          content is a hard-coded literal with no interpolation, so there is no
          injection surface. The nonce is what lets it run under the
          Content-Security-Policy; without it the browser blocks the script
          and the page flashes. Browsers hide the nonce from the DOM (the
          attribute reads as "" after parsing), so React would report a
          mismatch on hydration; that is expected, not a bug.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal, must run before first paint
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var p=localStorage.getItem("theme");if(p!=="dark"&&p!=="light"&&p!=="system")p="dark";var t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){}})()',
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <NavBar />
        <main className="flex-1 px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
