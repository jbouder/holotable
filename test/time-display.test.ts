import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { timeAxisLabels } from "@/components/charts/options";
import { formatClockTime, formatAge } from "@/lib/connection";
import {
  formatClock,
  formatDateTime,
  fromZonedInput,
  isValidTimeZone,
  LOCAL_TIME_DISPLAY,
  type TimeDisplay,
  toZonedInput,
  zoneBadge,
} from "@/lib/time-display";
import { describeRange, fromLocalInput, toLocalInput } from "@/lib/time-range";

const UTC: TimeDisplay = { timeZone: "UTC", clock: "24h" };
const BERLIN: TimeDisplay = { timeZone: "Europe/Berlin", clock: "24h" };
const NEW_YORK: TimeDisplay = { timeZone: "America/New_York", clock: "12h" };

const at = (iso: string) => new Date(iso);

test("zone names are validated by Intl", () => {
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("an instant is shown on the chosen zone's clock", () => {
  const instant = at("2026-09-22T14:05:09Z");
  assert.match(formatDateTime(instant, UTC), /14:05/);
  assert.match(formatDateTime(instant, BERLIN), /16:05/);
  assert.match(formatDateTime(instant, NEW_YORK), /10:05/);
  assert.match(formatDateTime(instant, NEW_YORK), /AM/i);
  assert.match(formatDateTime(instant, UTC, { seconds: true }), /14:05:09/);
});

test("the live clock stays zero-padded 24-hour on the locale clock and follows the zone", () => {
  const instant = at("2026-09-22T04:05:09Z");
  assert.equal(formatClock(instant, { timeZone: "UTC", clock: "locale" }), "04:05:09");
  assert.equal(formatClock(instant, { timeZone: "UTC", clock: "24h" }), "04:05:09");
  assert.match(
    formatClock(instant, { timeZone: "UTC", clock: "12h" }),
    /^4:05:09\s?AM$/i,
  );
  assert.equal(formatClockTime(instant.getTime(), BERLIN), "06:05:09");
  // The default is still the runtime's own clock, as before.
  const d = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(
    formatClockTime(instant.getTime()),
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  );
  assert.equal(
    formatAge(instant.getTime(), instant.getTime() + 600_000, UTC),
    "updated at 04:05:09",
  );
});

test("an absolute range is described on the chosen clock", () => {
  const range = { from: "2026-09-22T14:00:00Z", to: "2026-09-22T15:00:00Z" };
  assert.match(describeRange(range, new Date(), UTC), /14:00.*15:00/);
  assert.match(describeRange(range, new Date(), BERLIN), /16:00.*17:00/);
});

test("datetime-local values are read and written in the chosen zone", () => {
  const instant = at("2026-09-22T14:05:00Z");
  assert.equal(toZonedInput(instant, UTC), "2026-09-22T14:05");
  assert.equal(toZonedInput(instant, BERLIN), "2026-09-22T16:05");
  assert.equal(
    fromZonedInput("2026-09-22T16:05", BERLIN)?.toISOString(),
    "2026-09-22T14:05:00.000Z",
  );
  assert.equal(
    fromLocalInput("2026-09-22T14:05", UTC)?.toISOString(),
    "2026-09-22T14:05:00.000Z",
  );
  assert.equal(toLocalInput(instant, UTC), "2026-09-22T14:05");
  assert.equal(fromZonedInput("not a time", UTC), null);
});

test("an absolute range round-trips to the same UTC instants in any zone", () => {
  for (const display of [
    UTC,
    BERLIN,
    NEW_YORK,
    { timeZone: "Asia/Kolkata", clock: "24h" } as const,
  ]) {
    for (const iso of [
      "2026-01-15T08:30:00Z",
      "2026-07-04T23:59:00Z",
      "2026-12-31T00:00:00Z",
    ]) {
      const back = fromZonedInput(toZonedInput(at(iso), display), display);
      assert.equal(
        back?.toISOString(),
        at(iso).toISOString(),
        `${iso} in ${display.timeZone}`,
      );
    }
  }
});

test("DST: every minute either side of both 2026 Berlin transitions round-trips", () => {
  // 29 March 01:00 UTC (clocks jump 02:00 → 03:00) and 25 October 01:00 UTC
  // (03:00 → 02:00, so 02:00–02:59 happens twice).
  for (const change of ["2026-03-29T01:00:00Z", "2026-10-25T01:00:00Z"]) {
    const start = at(change).getTime() - 90 * 60_000;
    for (let t = start; t <= start + 180 * 60_000; t += 15 * 60_000) {
      const value = toZonedInput(new Date(t), BERLIN);
      const back = fromZonedInput(value, BERLIN);
      assert.ok(back, value);
      // In the repeated hour the earlier occurrence is chosen; either way the
      // reading on the clock is the same.
      assert.equal(
        toZonedInput(back, BERLIN),
        value,
        `${new Date(t).toISOString()} → ${value}`,
      );
    }
  }
});

test("DST: a reading in the spring-forward gap lands just past it, never throws", () => {
  const gap = fromZonedInput("2026-03-29T02:30", BERLIN);
  assert.ok(gap);
  assert.equal(gap.toISOString(), "2026-03-29T01:30:00.000Z");
  const repeated = fromZonedInput("2026-10-25T02:30", BERLIN);
  assert.equal(
    repeated?.toISOString(),
    "2026-10-25T00:30:00.000Z",
    "earlier of the two 02:30s",
  );
});

test("the zone badge names a zone only when it is not the browser's", () => {
  assert.equal(zoneBadge(LOCAL_TIME_DISPLAY, "Europe/Berlin"), null);
  assert.equal(zoneBadge(BERLIN, "Europe/Berlin"), null);
  assert.equal(zoneBadge(UTC, "Europe/Berlin"), "UTC");
  assert.equal(zoneBadge(NEW_YORK, "Europe/Berlin"), "America/New_York");
});

test("chart time labels follow the zone, and leave non-timestamps alone", () => {
  const labels = timeAxisLabels(["2026-09-22T14:05:00Z", "2026-09-22T14:06:00Z"], UTC);
  assert.match(labels[0], /14:05/);
  assert.doesNotMatch(labels[0], /14:05:00/, "no seconds when no row has any");
  assert.match(timeAxisLabels(["2026-09-22T14:05:30Z"], UTC)[0], /14:05:30/);
  assert.match(timeAxisLabels(["2026-09-22T14:05:00Z"], BERLIN)[0], /16:05/);
  assert.deepEqual(timeAxisLabels(["t0", 42, null], UTC), ["t0", "42", ""]);
});

/**
 * Every displayed timestamp goes through `src/lib/time-display.ts`, so the
 * preference reaches all of them. A date formatted anywhere else would quietly
 * ignore it; this is the guard. Numbers may still use `toLocaleString`, in the
 * files listed.
 */
test("no date is formatted outside the shared helper", () => {
  const NUMBER_FORMATTING = new Set(["src/lib/format.ts", "src/lib/query-plan.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const text = readFileSync(path, "utf8");
        const rel = path.replace(/\\/g, "/");
        if (/\.toLocale(Date|Time)String\(/.test(text)) offenders.push(rel);
        if (
          /\.toLocaleString\(/.test(text) &&
          rel !== "src/lib/time-display.ts" &&
          !NUMBER_FORMATTING.has(rel)
        ) {
          offenders.push(rel);
        }
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
