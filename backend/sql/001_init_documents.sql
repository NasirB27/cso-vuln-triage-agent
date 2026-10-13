-- One-time schema for the pgvector retriever provider (RDS PostgreSQL 15+).
-- Mirrors the Supabase `documents` shape so metadata (imageName,
-- overallSeverity, cvssMax, ...) round-trips as jsonb and stays filterable.
-- 1536 dimensions = OpenAI text-embedding-3-small. Changing the embedding
-- model means changing this and re-ingesting.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text,
  metadata jsonb,
  embedding vector(1536)
);

CREATE INDEX IF NOT EXISTS documents_embedding_hnsw
  ON documents USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS documents_metadata_gin
  ON documents USING gin (metadata jsonb_path_ops);

-- Lets the ingestion job replace an image's row instead of duplicating it.
CREATE INDEX IF NOT EXISTS documents_image_key
  ON documents ((metadata->>'imageName'), (metadata->>'imageTag'));
