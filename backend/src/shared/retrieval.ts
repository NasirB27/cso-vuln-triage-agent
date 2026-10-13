import { VectorStoreRetriever } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { createClient } from '@supabase/supabase-js';
import { RunnableConfig } from '@langchain/core/runnables';
import type pg from 'pg';
import {
  BaseConfigurationAnnotation,
  ensureBaseConfiguration,
} from './configuration.js';
import { getPostgresPool } from './postgres.js';

const DOCUMENTS_TABLE = 'documents';

function makeEmbeddings(): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    model: 'text-embedding-3-small',
  });
}

interface ScanRow {
  content: string;
  metadata: Record<string, unknown>;
}

export function rowsToDocuments(rows: ScanRow[]): Document[] {
  return rows.map(
    (row) => new Document({ pageContent: row.content, metadata: row.metadata }),
  );
}

export async function makeSupabaseRetriever(
  configuration: typeof BaseConfigurationAnnotation.State,
): Promise<VectorStoreRetriever> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables are not defined',
    );
  }
  const embeddings = makeEmbeddings();
  const supabaseClient = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );
  // SupabaseVectorStore stores the full `metadata` jsonb column by default
  // (see `match_documents` in the Supabase setup SQL) — it is not stripped
  // to a text field, so `imageName`/`overallSeverity`/`cvssMax`/etc. survive
  // the round trip and remain filterable, not just semantically searchable.
  const vectorStore = new SupabaseVectorStore(embeddings, {
    client: supabaseClient,
    tableName: DOCUMENTS_TABLE,
    queryName: 'match_documents',
  });
  return vectorStore.asRetriever({
    k: configuration.k,
    filter: configuration.filterKwargs,
  });
}

/**
 * pgvector on RDS/Aurora PostgreSQL. Uses the same table shape as the
 * Supabase provider (see backend/sql/001_init_documents.sql), so metadata
 * round-trips as jsonb. The table is created by the migration script, not at
 * request time, so the runtime database role needs no DDL privileges.
 */
export async function makePgVectorRetriever(
  configuration: typeof BaseConfigurationAnnotation.State,
): Promise<VectorStoreRetriever> {
  // Pool first: a missing/invalid database config should surface before any
  // embeddings client is constructed.
  const pool = getPostgresPool();
  const vectorStore = new PGVectorStore(makeEmbeddings(), {
    pool,
    tableName: DOCUMENTS_TABLE,
    columns: {
      idColumnName: 'id',
      vectorColumnName: 'embedding',
      contentColumnName: 'content',
      metadataColumnName: 'metadata',
    },
    distanceStrategy: 'cosine',
  });
  return vectorStore.asRetriever({
    k: configuration.k,
    filter: configuration.filterKwargs,
  });
}

async function fetchAllScanDocumentsFromSupabase(): Promise<Document[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables are not defined',
    );
  }
  const supabaseClient = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );

  const { data, error } = await supabaseClient
    .from(DOCUMENTS_TABLE)
    .select('content, metadata');

  if (error) {
    throw new Error(`Failed to read scan documents from Supabase: ${error.message}`);
  }

  return rowsToDocuments((data ?? []) as ScanRow[]);
}

async function fetchAllScanDocumentsFromPostgres(
  pool: Pick<pg.Pool, 'query'> = getPostgresPool(),
): Promise<Document[]> {
  const { rows } = await pool.query<ScanRow>(
    `SELECT content, metadata FROM ${DOCUMENTS_TABLE}`,
  );
  return rowsToDocuments(rows);
}

/**
 * Reads every row directly from the `documents` table of the configured
 * provider (full metadata jsonb, not just the embedding), bypassing vector
 * similarity entirely. The queryHardenedImages tool uses this so
 * severity/CVSS filtering and ranking is an explicit, deterministic DB read
 * rather than whatever a similarity search happens to surface.
 */
export async function fetchAllScanDocuments(
  config?: RunnableConfig,
): Promise<Document[]> {
  const { retrieverProvider } = ensureBaseConfiguration(config ?? {});
  switch (retrieverProvider) {
    case 'pgvector':
      return fetchAllScanDocumentsFromPostgres();
    case 'supabase':
      return fetchAllScanDocumentsFromSupabase();
    default:
      throw new Error(`Unsupported retriever provider: ${retrieverProvider}`);
  }
}

/**
 * Removes any existing rows for the images in `docs` so a re-run of ingestion
 * replaces them instead of duplicating them (a duplicate would show up twice
 * in the triage ranking). Matches on imageName + imageTag. Returns the number
 * of rows deleted.
 */
export async function deleteExistingScanRows(
  pool: Pick<pg.Pool, 'query'>,
  docs: Document[],
): Promise<number> {
  const names: string[] = [];
  const tags: string[] = [];
  for (const doc of docs) {
    const { imageName, imageTag } = doc.metadata ?? {};
    if (imageName === undefined || imageName === null) continue;
    names.push(String(imageName));
    tags.push(imageTag === undefined || imageTag === null ? '' : String(imageTag));
  }
  if (names.length === 0) return 0;

  const result = await pool.query(
    `DELETE FROM ${DOCUMENTS_TABLE}
     WHERE (metadata->>'imageName', metadata->>'imageTag') IN (
       SELECT name, tag FROM unnest($1::text[], $2::text[]) AS t(name, tag)
     )`,
    [names, tags],
  );
  return result.rowCount ?? 0;
}

export async function makeRetriever(
  config: RunnableConfig,
): Promise<VectorStoreRetriever> {
  const configuration = ensureBaseConfiguration(config);
  switch (configuration.retrieverProvider) {
    case 'supabase':
      return makeSupabaseRetriever(configuration);
    case 'pgvector':
      return makePgVectorRetriever(configuration);
    default:
      throw new Error(
        `Unsupported retriever provider: ${configuration.retrieverProvider}`,
      );
  }
}
