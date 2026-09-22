import { Pool, type PoolClient } from "pg";

/**
 * Shared PostgreSQL connection pool for the config store.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/**
 * Close the shared pool. Graceful shutdown (#47) only: `end()` waits for every
 * checked-out client to be released, which is what makes in-flight config-store
 * work finish before the process exits. The next `getPool()` would build a new
 * pool, which nothing does after a drain.
 */
export async function closePool(): Promise<void> {
  const current = pool;
  if (!current) return;
  pool = null;
  await current.end();
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
