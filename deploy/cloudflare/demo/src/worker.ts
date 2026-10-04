import { Container, getContainer } from "@cloudflare/containers";
import {
  bucketFor,
  clientKey,
  demoLimits,
  forContainer,
  limitedResponse,
  startingResponse,
} from "./policy.ts";

/**
 * The public Holotable demo (#254): this Worker is the only public surface,
 * and it fronts exactly one Cloudflare Container running the quick-start image
 * from #253 (TimescaleDB, the server and the demo jobs, in AUTH_MODE=demo).
 *
 *   browser ──▶ Worker (per-IP limits) ──▶ HolotableDemo (Durable Object) ──▶ container :3000
 *
 * The container sleeps after `sleepAfter` without a request and its disk is
 * ephemeral, so a wake is a fresh, freshly backfilled demo. That is intended,
 * and the app's demo banner says so.
 */

/** Roughly how long a cold boot takes, for the starting page's copy. */
const BOOT_SECONDS = 30;

export class HolotableDemo extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";
  /**
   * How the library decides the port is ready: it fetches
   * `http://<pingEndpoint>`. The default, `/`, is a page, and a page without
   * a session redirects to demo sign-in and back, a loop a cookie-less fetch
   * never leaves, so the container would never count as started. The
   * liveness endpoint answers 200 directly.
   */
  pingEndpoint = "container/api/health";

  /** In-memory, per Durable Object instance: one start at a time. */
  private starting: Promise<void> | null = null;

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    const optional = (value: string | undefined) => (value ? value : undefined);
    this.envVars = Object.fromEntries(
      Object.entries({
        // Sessions survive a wake when this is a stable secret; the image
        // generates one per boot when it is not.
        SESSION_SECRET: optional(env.SESSION_SECRET),
        // The visitor reaches the app over HTTPS through this Worker.
        SESSION_COOKIE_SECURE: "true",
        AI_MODEL: optional(env.AI_MODEL),
        OPENAI_API_KEY: optional(env.OPENAI_API_KEY),
        OPENAI_BASE_URL: optional(env.OPENAI_BASE_URL),
        OPENAI_API: optional(env.OPENAI_API),
        ...demoLimits(env),
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const { status } = await this.getState();
    if (status === "healthy") return super.fetch(forContainer(request));
    // Not serving yet. Start it without making this request wait, and tell
    // the visitor; the starting page refreshes until the port answers. The
    // image opens its port only after Postgres, migrations and the server
    // are up, so "healthy" here means the app can answer.
    this.ensureStarting();
    return startingResponse(request, BOOT_SECONDS);
  }

  private ensureStarting(): void {
    if (this.starting) return;
    this.starting = this.startAndWaitForPorts({
      cancellationOptions: {
        // A first start pulls a ~1 GB image; the library defaults (8 s to get
        // an instance, 20 s for the port) are written for small images.
        instanceGetTimeoutMS: 120_000,
        portReadyTimeoutMS: 300_000,
      },
    })
      .catch((err: unknown) => {
        console.error("demo container failed to start:", err);
      })
      .finally(() => {
        this.starting = null;
      });
    this.ctx.waitUntil(this.starting);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const bucket = bucketFor(request);
    const limiter = bucket === "write" ? env.WRITE_LIMITER : env.READ_LIMITER;
    const { success } = await limiter.limit({ key: clientKey(request) });
    if (!success) return limitedResponse(request, bucket);

    return getContainer(env.HOLOTABLE, "demo").fetch(request);
  },
} satisfies ExportedHandler<Env>;
