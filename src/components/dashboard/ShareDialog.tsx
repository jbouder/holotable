"use client";

import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { useTimeDisplay } from "@/components/time-display";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ThemePreview } from "@/components/settings/theme-preview";
import { withEmbedAppearance } from "@/lib/embed-appearance";
import {
  DEFAULT_PALETTE_ATTRIBUTE,
  isPalette,
  isTheme,
  type Palette,
  paletteInfo,
  THEMES,
} from "@/lib/theme";
import { type ApiError, apiErrorFromThrown, readApiError } from "@/lib/errors";
import type { TimeRange } from "@/lib/ir";
import { describeIssue } from "@/lib/panel-options";
import { SHARE_MAX_DAYS, ShareRequest, type ShareView } from "@/lib/share-view";
import { describeRange, formatInstant } from "@/lib/time-range";

const EXPIRY_OPTIONS = [1, 7, 30, SHARE_MAX_DAYS].map((d) => ({
  value: String(d),
  label: d === 1 ? "1 day" : `${d} days`,
}));

const SCHEME_LABELS = {
  dark: "Dark",
  light: "Light",
  system: "The viewer's system",
} as const;

/**
 * The server's default theme, which a link with no theme gets, for the
 * preview of "Default". The root layout writes it on `<html>`; the page's own
 * `data-palette` is this editor's choice, not what a viewer will see.
 */
function defaultPalette(): Palette {
  if (typeof document === "undefined") return paletteInfo()[0].name;
  const value = document.documentElement.getAttribute(DEFAULT_PALETTE_ATTRIBUTE);
  return isPalette(value) ? value : paletteInfo()[0].name;
}

/**
 * Create, list and revoke a dashboard's read-only share links (#65). A new
 * link's URL is shown once, here: the server keeps only its hash.
 */

export function ShareDialog({
  dashboardId,
  open,
  onOpenChange,
  timeRange,
}: {
  dashboardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dashboard's window, offered as the link's fixed one. */
  timeRange: TimeRange;
}) {
  const display = useTimeDisplay();
  const [shares, setShares] = React.useState<ShareView[] | null>(null);
  // The theme the link carries (#509); "default" writes nothing into it.
  const [linkPalette, setLinkPalette] = React.useState("default");
  const [linkScheme, setLinkScheme] = React.useState("default");
  const appearance = {
    palette: isPalette(linkPalette) ? linkPalette : null,
    scheme: isTheme(linkScheme) ? linkScheme : null,
  };
  const [error, setError] = React.useState<ApiError | null>(null);
  const [label, setLabel] = React.useState("");
  const [days, setDays] = React.useState("30");
  const [origins, setOrigins] = React.useState("");
  const [fixRange, setFixRange] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState<string | null>(null);
  const link = created ? withEmbedAppearance(created, appearance) : null;
  const [copied, setCopied] = React.useState(false);
  const base = `/api/dashboards/${encodeURIComponent(dashboardId)}/shares`;

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setShares(((await res.json()) as { shares: ShareView[] }).shares);
    } catch (err) {
      setError(apiErrorFromThrown(err));
    }
  }, [base]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    const parsed = ShareRequest.safeParse({
      ...(label.trim() ? { label: label.trim() } : {}),
      expiresInDays: Number(days),
      allowedOrigins: origins
        .split(/[\s,]+/)
        .map((o) => o.trim().replace(/\/$/, ""))
        .filter(Boolean),
      ...(fixRange ? { timeRange } : {}),
    });
    if (!parsed.success) {
      setProblem(describeIssue(parsed.error.issues[0]));
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        setProblem((await readApiError(res)).error);
        return;
      }
      setCreated(((await res.json()) as { url: string }).url);
      setCopied(false);
      setLabel("");
      await load();
    } catch (err) {
      setProblem(apiErrorFromThrown(err).error);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) setError(await readApiError(res));
      await load();
    } catch (err) {
      setError(apiErrorFromThrown(err));
    }
  }

  const active = (shares ?? []).filter(
    (s) => s.revokedAt === null && Date.parse(s.expiresAt) > Date.now(),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCreated(null);
        onOpenChange(next);
      }}
      title="Share read-only"
      className="max-w-xl"
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">
          Anyone with the link sees this dashboard live, and nothing else: no editing, no
          chat, no SQL, no other dashboards. Revoking a link stops it at once.
        </p>

        {created && (
          <div className="space-y-2 border border-success/40 tinted bg-tint-success/(--tint-10) p-3">
            <p className="font-medium">Copy the link now; it will not be shown again.</p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={link ?? ""}
                aria-label="Share link"
                className="font-mono text-xs"
              />
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(link ?? created)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted">
              To embed it, use it as an iframe&rsquo;s <code>src</code> on one of the
              origins you allowed.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="share-label">Label</Label>
            <Input
              id="share-label"
              maxLength={100}
              placeholder="e.g. NOC wall display"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="share-expiry">Expires after</Label>
            <Select
              id="share-expiry"
              className="w-full"
              value={days}
              onValueChange={setDays}
              options={EXPIRY_OPTIONS}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="share-origins">Sites that may embed it (optional)</Label>
          <Textarea
            id="share-origins"
            rows={2}
            className="font-mono text-xs"
            placeholder="https://wiki.example.com"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            One origin per line. With none, the link opens on its own and cannot be
            framed.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="share-theme">Theme</Label>
            <Select
              id="share-theme"
              className="w-full"
              value={linkPalette}
              onValueChange={(v) => {
                setLinkPalette(v);
                setCopied(false);
              }}
              aria-describedby="share-appearance-hint"
              options={[
                { value: "default", label: "Default" },
                ...paletteInfo().map((p) => ({ value: p.name, label: p.label })),
              ]}
            />
          </div>
          <div>
            <Label htmlFor="share-scheme">Color scheme</Label>
            <Select
              id="share-scheme"
              className="w-full"
              value={linkScheme}
              onValueChange={(v) => {
                setLinkScheme(v);
                setCopied(false);
              }}
              aria-describedby="share-appearance-hint"
              options={[
                { value: "default", label: "Default" },
                ...THEMES.map((t) => ({ value: t, label: SCHEME_LABELS[t] })),
              ]}
            />
          </div>
        </div>
        <span aria-hidden className="block w-56 max-w-full">
          <ThemePreview
            palette={appearance.palette ?? defaultPalette()}
            scheme={appearance.scheme ?? "dark"}
          />
        </span>
        <p id="share-appearance-hint" className="-mt-1 text-xs text-muted">
          An embed cannot read the viewer&rsquo;s settings, so the link carries its look.
          {created && " Changing these changes the link above."}
        </p>
        <Checkbox
          checked={fixRange}
          label={`Always show ${describeRange(timeRange, new Date(), display)}`}
          onCheckedChange={setFixRange}
        />
        {problem && <p className="text-xs text-danger">{problem}</p>}
        <div className="flex justify-end">
          {/*
            Focusable while busy: a disabled button drops its focus to the
            page behind the modal, and the next Tab walks the page (#540).
          */}
          <Button onClick={() => void create()} disabled={busy} focusableWhenDisabled>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Create link
          </Button>
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="font-medium">Active links</h3>
          {error && <ErrorDisplay error={error} />}
          {shares === null ? (
            <p className="text-muted">Loading…</p>
          ) : active.length === 0 ? (
            <p className="text-muted">None.</p>
          ) : (
            <ul className="space-y-2">
              {active.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.label ?? "Untitled link"}</p>
                    <p className="text-xs text-muted">
                      Expires {formatInstant(new Date(s.expiresAt), display)}
                      {s.lastUsedAt
                        ? ` · last used ${formatInstant(new Date(s.lastUsedAt), display)}`
                        : " · not used yet"}
                      {s.allowedOrigins.length > 0 &&
                        ` · embeds on ${s.allowedOrigins.join(", ")}`}
                      {s.timeRange &&
                        ` · ${describeRange(s.timeRange, new Date(), display)}`}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void revoke(s.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
