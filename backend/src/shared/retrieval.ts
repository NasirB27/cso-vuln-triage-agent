import { VectorStoreRetriever } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import { OpenAIEmbeddings } from '@langchain/openai';
import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { createClient } from '@supabase/supabase-js';
import { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseConfigurationAnnotation,
  ensureBaseConfiguration,
} from './configuration.js';

export async function makeSupabaseRetriever(
  configuration: typeof BaseConfigurationAnnotation.State,
): Promise<VectorStoreRetriever> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables are not defined',
    );
  }
  const embeddings = new OpenAIEmbeddings({
    model: 'text-embedding-3-small',
  });
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
    tableName: 'documents',
    queryName: 'match_documents',
  });
  return vectorStore.asRetriever({
    k: configuration.k,
    filter: configuration.filterKwargs,
  });
}

/**
 * Reads every row directly from the Supabase `documents` table (full
 * metadata jsonb, not just the embedding), bypassing vector similarity
 * entirely. The queryHardenedImages tool uses this so severity/CVSS
 * filtering and ranking is an explicit, deterministic DB read rather than
 * whatever a similarity search happens to surface.
 */
export async function fetchAllScanDocuments(): Promise<Document[]> {
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
    .from('documents')
    .select('content, metadata');

  if (error) {
    throw new Error(`Failed to read scan documents from Supabase: ${error.message}`);
  }

  return (data ?? []).map(
    (row: { content: string; metadata: Record<string, unknown> }) =>
      new Document({ pageContent: row.content, metadata: row.metadata }),
  );
}

export async function makeRetriever(
  config: RunnableConfig,
): Promise<VectorStoreRetriever> {
  const configuration = ensureBaseConfiguration(config);
  switch (configuration.retrieverProvider) {
    case 'supabase':
      return makeSupabaseRetriever(configuration);
    default:
      throw new Error(
        `Unsupported retriever provider: ${configuration.retrieverProvider}`,
      );
  }
}
