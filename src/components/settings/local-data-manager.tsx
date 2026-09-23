"use client";

import * as React from "react";
import Link from "next/link";
import { HardDrive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { dismissHint } from "@/components/onboarding/actions";
import { type BrowserStorage, browserStorage } from "@/lib/browser-storage";
import { clearDraft, type DraftSummary, listDrafts } from "@/lib/editor/drafts";
import { formatBytes, formatSavedAt } from "@/lib/local-data-format";
import {
  clearAllLocalData,
  describeCount,
  LOCAL_COOKIES,
  LOCAL_STORES,
  type LocalStoreId,
} from "@/lib/local-data";

type Counts = Record<LocalStoreId, number>;

interface Snapshot {
  counts: Counts;
  drafts: DraftSummary[];
  now: number;
}

function snapshot(storage: BrowserStorage | null, userSub: string): Snapshot {
  const now = Date.now();
  const counts = Object.fromEntries(
    LOCAL_STORES.map((s) => [s.id, s.count(storage, { userSub, now })]),
  ) as Counts;
  return { counts, drafts: listDrafts(storage, userSub), now };
}

/**
 * The local-data settings section (#216): one row per thing this browser
 * remembers, with a count and a Clear, the drafts listed one by one, the setup
 * hints reset through the allowlisted dismissal action, and a confirmed
 * "clear everything". Reads storage after mount, never during render: there
 * is no `localStorage` on the server.
 */
export function LocalDataManager({
  userSub,
  setupDismissed,
}: {
  userSub: string;
  setupDismissed: boolean;
}) {
  const [storage, setStorage] = React.useState<BrowserStorage | null | undefined>(
    undefined,
  );
  const [state, setState] = React.useState<Snapshot | null>(null);
  const [hintsDismissed, setHintsDismissed] = React.useState(setupDismissed);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(
    (s: BrowserStorage | null) => setState(snapshot(s, userSub)),
    [userSub],
  );

  React.useEffect(() => {
    const s = browserStorage();
    setStorage(s);
    refresh(s);
  }, [refresh]);

  async function showHints(): Promise<boolean> {
    const ok = await dismissHint(LOCAL_COOKIES[0].name, false);
    if (ok) setHintsDismissed(false);
    return ok;
  }

  async function clearEverything() {
    setBusy(true);
    clearAllLocalData(storage ?? null, { userSub, now: Date.now() });
    const hintsOk = hintsDismissed ? await showHints() : true;
    refresh(storage ?? null);
    setBusy(false);
    setConfirming(false);
    setNotice(
      hintsOk
        ? "Everything on this device is cleared."
        : "Local data is cleared, but the setup hints could not be reset. Try again.",
    );
  }

  const loading = storage === undefined || state === null;
  const nothingStored =
    !hintsDismissed && (loading || LOCAL_STORES.every((s) => state.counts[s.id] === 0));

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        All of this lives in this browser only. It is never sent to the server and does
        not follow you to another device.
      </p>

      {!loading && storage === null && (
        <EmptyState
          icon={<HardDrive className="h-6 w-6" />}
          title="Storage is unavailable"
          description="This browser is not letting Holotable use local storage, for example in a private window or with site data blocked. Nothing is remembered, so there is nothing to clear."
        />
      )}

      {loading && (
        <p role="status" className="text-sm text-muted">
          Reading this browser's storage…
        </p>
      )}

      {!loading && storage !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Stored in this browser</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {LOCAL_STORES.map((store) => {
                const n = state.counts[store.id];
                return (
                  <li
                    key={store.id}
                    className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{store.label}</p>
                      <p className="text-xs text-muted">{store.description}</p>
                      {store.id === "drafts" && state.drafts.length > 0 && (
                        <ul className="mt-2 flex flex-col gap-1" aria-label="Your drafts">
                          {state.drafts.map((d) => (
                            <li
                              key={d.key}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                            >
                              <span className="font-medium text-foreground">
                                {d.title}
                              </span>
                              <span className="text-muted">
                                {formatSavedAt(d.savedAt, state.now)} ·{" "}
                                {formatBytes(d.bytes)}
                              </span>
                              <Link
                                href={`/dashboards/${encodeURIComponent(d.dashboardId)}/edit`}
                                className="tap-target text-primary hover:underline"
                              >
                                Open
                              </Link>
                              <button
                                type="button"
                                className="tap-target cursor-pointer text-danger hover:underline"
                                onClick={() => {
                                  clearDraft(storage, d.key);
                                  refresh(storage);
                                }}
                              >
                                Discard
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted">
                        {describeCount(store, n)}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={n === 0}
                        aria-label={`Clear ${store.label.toLowerCase()}`}
                        onClick={() => {
                          store.clear(storage, { userSub, now: Date.now() });
                          refresh(storage);
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{LOCAL_COOKIES[0].label}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-xs text-muted">
            {LOCAL_COOKIES[0].description}{" "}
            {hintsDismissed ? "You have dismissed them." : "They are showing."}
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={!hintsDismissed}
            onClick={() =>
              void showHints().then((ok) =>
                setNotice(
                  ok
                    ? "The setup hints will show again."
                    : "Could not reset the setup hints.",
                ),
              )
            }
          >
            Show setup hints again
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="danger"
          disabled={nothingStored}
          onClick={() => setConfirming(true)}
        >
          Clear everything on this device
        </Button>
        <span role="status" className="text-sm text-muted">
          {notice ?? ""}
        </span>
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!busy) setConfirming(next);
        }}
        title="Clear everything on this device?"
        className="max-w-md"
      >
        <p className="text-sm text-muted">
          This discards your unsaved editor drafts, recent prompts, recently viewed
          dashboards and command palette history, and shows the setup hints again. Saved
          dashboards, favourites and other people's drafts on this browser are not
          affected. It cannot be undone.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void clearEverything()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Clear everything
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
