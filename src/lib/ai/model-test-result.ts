/** What "Test connection" answers (#331). Its own module so the browser can import the type. */
export type ModelTestResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; message: string };
