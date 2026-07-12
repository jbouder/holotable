"use client";

import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Dialog({
  children,
  className,
  onOpenChange,
  open,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/60" />
        <BaseDialog.Popup
          className={cn(
            "fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[calc(100vh-2rem)] w-auto max-w-3xl -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-4 shadow-xl focus:outline-none sm:p-6",
            className,
          )}
        >
          <div className="mb-4 flex items-center justify-between gap-4">
            <BaseDialog.Title className="text-lg font-semibold">
              {title}
            </BaseDialog.Title>
            <BaseDialog.Close
              aria-label="Close dialog"
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X className="h-4 w-4" />
            </BaseDialog.Close>
          </div>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
