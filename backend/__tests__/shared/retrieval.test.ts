import { Document } from '@langchain/core/documents';

import {
  deleteExistingScanRows,
  fetchAllScanDocuments,
  rowsToDocuments,
} from '../../src/shared/retrieval.js';

function doc(imageName: unknown, imageTag?: unknown): Document {
  return new Document({
    pageContent: 'summary',
    metadata: { imageName, imageTag },
  });
}

describe('rowsToDocuments', () => {
  it('maps content/metadata rows to Documents without altering metadata', () => {
    const metadata = { imageName: 'nginx', overallSeverity: 'HIGH', cvssMax: 8.1 };
    const [result] = rowsToDocuments([{ content: 'text', metadata }]);
    expect(result.pageContent).toBe('text');
    expect(result.metadata).toEqual(metadata);
  });
});

describe('deleteExistingScanRows', () => {
  it('deletes by imageName + imageTag using parameterized arrays', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 2 });

    const deleted = await deleteExistingScanRows({ query } as never, [
      doc('nginx', '1.27'),
      doc('postgres', '16'),
    ]);

    expect(deleted).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('DELETE FROM documents');
    expect(sql).toContain('$1::text[]');
    expect(params).toEqual([
      ['nginx', 'postgres'],
      ['1.27', '16'],
    ]);
  });

  it('never interpolates image names into the SQL string', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0 });
    const hostile = "x'; DROP TABLE documents; --";

    await deleteExistingScanRows({ query } as never, [doc(hostile, 'latest')]);

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('DROP TABLE');
    expect(params[0]).toEqual([hostile]);
  });

  it('skips documents with no imageName and treats a missing tag as empty', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });

    await deleteExistingScanRows({ query } as never, [
      doc(undefined, 'orphan'),
      doc('busybox'),
    ]);

    expect(query.mock.calls[0][1]).toEqual([['busybox'], ['']]);
  });

  it('does not touch the database when there is nothing to replace', async () => {
    const query = jest.fn();
    expect(await deleteExistingScanRows({ query } as never, [])).toBe(0);
    expect(await deleteExistingScanRows({ query } as never, [doc(null)])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports 0 when the driver gives no rowCount', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: null });
    expect(await deleteExistingScanRows({ query } as never, [doc('a', 'b')])).toBe(0);
  });
});

describe('fetchAllScanDocuments provider dispatch', () => {
  const saved = {
    PGHOST: process.env.PGHOST,
    DATABASE_URL: process.env.DATABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  beforeEach(() => {
    for (const key of Object.keys(saved)) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('routes pgvector to Postgres and fails clearly when it is not configured', async () => {
    await expect(
      fetchAllScanDocuments({ configurable: { retrieverProvider: 'pgvector' } }),
    ).rejects.toThrow(/DATABASE_URL or PGHOST/);
  });

  it('routes supabase to Supabase and fails clearly when it is not configured', async () => {
    await expect(
      fetchAllScanDocuments({ configurable: { retrieverProvider: 'supabase' } }),
    ).rejects.toThrow(/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/);
  });
});
