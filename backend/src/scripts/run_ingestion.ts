/**
 * One-shot ingestion runner for the scheduled ECS task (also usable locally).
 *
 * Scan source, in priority order:
 *   1. SCANS_S3_BUCKET (+ optional SCANS_S3_PREFIX): downloads *.json scan
 *      records from S3 first. Uses the task role's credentials.
 *   2. SCANS_DIRECTORY: a local folder of scan JSON.
 *   3. ./src/sample_scans (the synthetic demo data).
 *
 * The vector store comes from RETRIEVER_PROVIDER (set to "pgvector" on AWS).
 *
 * Run from the backend directory:  yarn ingest:run
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

import { ensureIndexConfiguration } from '../ingestion_graph/configuration.js';
import { graph } from '../ingestion_graph/graph.js';
import { closePostgresPool } from '../shared/postgres.js';

async function downloadScanDrop(
  bucket: string,
  prefix: string,
): Promise<string> {
  const s3 = new S3Client({});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scans-'));
  let continuationToken: string | undefined;
  let count = 0;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of page.Contents ?? []) {
      if (!object.Key?.endsWith('.json')) continue;
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
      const body = await response.Body?.transformToString();
      if (body === undefined) continue;
      // basename + counter: never trust a key as a filesystem path.
      await fs.writeFile(
        path.join(dir, `${count}-${path.basename(object.Key)}`),
        body,
      );
      count += 1;
    }

    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  if (count === 0) {
    throw new Error(`No .json scan files found at s3://${bucket}/${prefix}`);
  }
  console.log(`Downloaded ${count} scan file(s) from s3://${bucket}/${prefix}`);
  return dir;
}

async function main(): Promise<void> {
  const bucket = process.env.SCANS_S3_BUCKET;
  const scansDirectory = bucket
    ? await downloadScanDrop(bucket, process.env.SCANS_S3_PREFIX ?? '')
    : (process.env.SCANS_DIRECTORY ?? './src/sample_scans');

  // `useSampleScans` is the ingestion graph's "read scansDirectory" switch.
  // ensureIndexConfiguration fills in the provider (from RETRIEVER_PROVIDER),
  // k and filter defaults so the configurable is complete.
  const configurable = ensureIndexConfiguration({
    configurable: { useSampleScans: true, scansDirectory },
  });
  await graph.invoke({}, { configurable });
  console.log(`Ingestion complete from ${scansDirectory}`);
}

main()
  .catch((error) => {
    console.error('Ingestion failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool());
