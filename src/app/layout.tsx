import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/nav-bar";

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
      className="h-full antialiased"
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
