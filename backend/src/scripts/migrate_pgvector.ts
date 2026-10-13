/**
 * Applies backend/sql/*.sql to the Postgres database, in filename order.
 * All statements are idempotent (IF NOT EXISTS), so re-running is safe.
 *
 * Run from the backend directory:  yarn migrate:pgvector
 * Override the folder with MIGRATIONS_DIR.
 */
import fs from 'fs/promises';
import path from 'path';

import { closePostgresPool, getPostgresPool } from '../shared/postgres.js';

async function main(): Promise<void> {
  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'sql');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    throw new Error(`No .sql files found in ${dir}`);
  }

  const pool = getPostgresPool();
  for (const file of files) {
    const sql = await fs.readFile(path.join(dir, file), 'utf-8');
    await pool.query(sql);
    console.log(`Applied ${file}`);
  }
}

main()
  .catch((error) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool());
