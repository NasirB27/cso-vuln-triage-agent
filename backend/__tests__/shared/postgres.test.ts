import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildPoolConfig } from '../../src/shared/postgres.js';

describe('buildPoolConfig', () => {
  it('throws a clear error when no database is configured', () => {
    expect(() => buildPoolConfig({})).toThrow(
      /DATABASE_URL or PGHOST environment variable is not defined/,
    );
  });

  it('uses DATABASE_URL as the connection string when provided', () => {
    const config = buildPoolConfig({
      DATABASE_URL: 'postgres://user:pass@db.internal:5432/cso',
    });
    expect(config.connectionString).toBe(
      'postgres://user:pass@db.internal:5432/cso',
    );
  });

  it('accepts the PG* variables without a connection string (what ECS injects)', () => {
    const config = buildPoolConfig({ PGHOST: 'db.internal' });
    expect(config.connectionString).toBeUndefined();
  });

  it('verifies TLS certificates by default', () => {
    const config = buildPoolConfig({ PGHOST: 'db.internal' });
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('adds the CA bundle from PGSSLROOTCERT', () => {
    const certPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pgcert-')),
      'ca.pem',
    );
    fs.writeFileSync(certPath, 'FAKE-CA-BUNDLE');

    const config = buildPoolConfig({
      PGHOST: 'db.internal',
      PGSSLROOTCERT: certPath,
    });
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: 'FAKE-CA-BUNDLE',
    });
  });

  it('only disables TLS when PGSSLMODE=disable is set explicitly', () => {
    expect(
      buildPoolConfig({ PGHOST: 'localhost', PGSSLMODE: 'disable' }).ssl,
    ).toBe(false);
    expect(
      buildPoolConfig({ PGHOST: 'localhost', PGSSLMODE: 'require' }).ssl,
    ).toEqual({ rejectUnauthorized: true });
  });

  it('fails fast on connect so the guardrail can answer promptly', () => {
    const config = buildPoolConfig({ PGHOST: 'db.internal' });
    expect(config.connectionTimeoutMillis).toBe(5000);
  });
});
