import { z } from "zod";

/**
 * What every source kind reached over HTTP shares in its config (#385,
 * #562): where the endpoint is and how a request to it is authenticated.
 * Prometheus and Loki hold these the same way, so they are defined once.
 *
 * Neither ever leaves the server: a kind's listing and catalog name their
 * fields, and neither names these.
 */

/**
 * The endpoint's address: http(s), no credentials, no query or fragment. A
 * path is a prefix, for an API not at the root
 * (`https://vm.example/select/0/prometheus`). Whether the host may be reached
 * at all is the server's to say, against `SOURCE_URL_ALLOWLIST`.
 */
export const HttpSourceUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "must be an http(s) URL with no credentials, query or fragment");

/**
 * `none` is for an endpoint with no authentication, typically in the
 * cluster; such a source names no `secret_ref`. `basic` resolves
 * `<REF>_USERNAME`/`<REF>_PASSWORD`, `bearer` resolves `<REF>_TOKEN`.
 */
export const HttpSourceAuth = z.enum(["none", "basic", "bearer"]);
export type HttpSourceAuth = z.infer<typeof HttpSourceAuth>;

/** A Prometheus or Loki label name. */
export const LabelName = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a label name");
