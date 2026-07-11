"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutDashboard, Database, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export function NavBar() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/dashboards");
    router.refresh();
  }

  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
      <nav className="flex items-center gap-6">
        <Link href="/dashboards" className="flex items-center gap-2 font-semibold">
          <LayoutDashboard className="h-5 w-5 text-primary" />
          Holotable
        </Link>
        <Link
          href="/dashboards"
          className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
        >
          <LayoutDashboard className="h-4 w-4" /> Dashboards
        </Link>
        <Link
          href="/data-sources"
          className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
        >
          <Database className="h-4 w-4" /> Data sources
        </Link>
      </nav>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </header>
  );
}
