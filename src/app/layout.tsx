import type { Metadata } from "next";
import { Chakra_Petch, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";

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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased ${fontSans.variable} ${fontMono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        <script
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
