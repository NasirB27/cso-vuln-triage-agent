import fs from 'fs';
import pg from 'pg';

type Env = Record<string, string | undefined>;

/**
 * Builds the node-postgres pool config from environment variables.
 *
 * Connection: either DATABASE_URL, or the standard PGHOST / PGPORT /
 * PGDATABASE / PGUSER / PGPASSWORD variables (node-postgres reads those
 * itself, which is what the ECS task definition injects from Secrets Manager).
 *
 * TLS is on by default with certificate verification. Set
 * PGSSLROOTCERT to a CA bundle (the Docker image ships the RDS global bundle)
 * or PGSSLMODE=disable for a local, non-TLS Postgres.
 */
export function buildPoolConfig(env: Env = process.env): pg.PoolConfig {
  if (!env.DATABASE_URL && !env.PGHOST) {
    throw new Error(
      'DATABASE_URL or PGHOST environment variable is not defined',
    );
  }

  const config: pg.PoolConfig = {
    max: 5,
    idleTimeoutMillis: 30_000,
    // Fail fast so the retrieval agent's guardrail answers promptly instead of
    // hanging when the database is unreachable.
    connectionTimeoutMillis: 5_000,
  };

  if (env.DATABASE_URL) {
    config.connectionString = env.DATABASE_URL;
  }

  if (env.PGSSLMODE === 'disable') {
    config.ssl = false;
  } else {
    config.ssl = {
      rejectUnauthorized: true,
      ...(env.PGSSLROOTCERT
        ? { ca: fs.readFileSync(env.PGSSLROOTCERT, 'utf-8') }
        : {}),
    };
  }

  return config;
}

let pool: pg.Pool | undefined;

/** Lazily-created process-wide pool shared by the retriever and direct reads. */
export function getPostgresPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool(buildPoolConfig());
    // Without a listener, an error on an idle client would crash the process.
    pool.on('error', (error) => {
      console.error('Unexpected Postgres pool error:', error.message);
    });
  }
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}
