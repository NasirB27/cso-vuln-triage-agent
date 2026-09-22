import { tool } from '@langchain/core/tools';
import { Document } from '@langchain/core/documents';
import { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';

import { fetchAllScanDocuments, makeRetriever } from '../shared/retrieval.js';
import { Severity } from '../ingestion_graph/state.js';

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export const queryHardenedImagesSchema = z.object({
  minSeverity: z
    .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
    .optional()
    .describe(
      'Only return images whose overall severity is at least this severe (CRITICAL > HIGH > MEDIUM > LOW).',
    ),
  imageNamePattern: z
    .string()
    .optional()
    .describe(
      'Substring or regex to match against the image name, e.g. "nginx" or "postgres.*".',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .default(20)
    .describe('Maximum number of images to return.'),
  sortBy: z
    .enum(['severity', 'cvss', 'lastScannedAt'])
    .default('severity')
    .describe(
      'Primary sort key. "severity" ranks CRITICAL > HIGH > MEDIUM > LOW (ties broken by CVSS, descending). "cvss" sorts by max CVSS score. "lastScannedAt" sorts by most recently scanned first.',
    ),
});

export type QueryHardenedImagesInput = z.infer<typeof queryHardenedImagesSchema>;

export interface RankedImageResult {
  imageName: string;
  imageTag: string;
  registryPath: string;
  overallSeverity: Severity;
  cvssMax: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  topCveId: string | null;
  lastScannedAt: string;
}

function toRankedResult(doc: Document): RankedImageResult | null {
  const m = doc.metadata ?? {};
  if (!m.imageName || !m.overallSeverity || m.cvssMax === undefined) {
    return null;
  }
  return {
    imageName: String(m.imageName),
    imageTag: String(m.imageTag ?? ''),
    registryPath: String(m.registryPath ?? ''),
    overallSeverity: m.overallSeverity as Severity,
    cvssMax: Number(m.cvssMax),
    criticalCount: Number(m.criticalCount ?? 0),
    highCount: Number(m.highCount ?? 0),
    mediumCount: Number(m.mediumCount ?? 0),
    lowCount: Number(m.lowCount ?? 0),
    topCveId: (m.topCveId as string | null) ?? null,
    lastScannedAt: String(m.lastScannedAt ?? ''),
  };
}

/**
 * Explicit, deterministic filter + sort over ranked image results.
 * Kept as a pure function (no I/O) so it can be unit tested directly against
 * mock candidates without a vector store.
 */
export function filterAndRankImages(
  candidates: RankedImageResult[],
  input: QueryHardenedImagesInput,
): RankedImageResult[] {
  const minRank = input.minSeverity ? SEVERITY_RANK[input.minSeverity] : 0;

  let matcher: RegExp | null = null;
  if (input.imageNamePattern) {
    try {
      matcher = new RegExp(input.imageNamePattern, 'i');
    } catch {
      matcher = null;
    }
  }

  const filtered = candidates.filter((c) => {
    if (SEVERITY_RANK[c.overallSeverity] < minRank) return false;
    if (input.imageNamePattern) {
      const nameMatches = matcher
        ? matcher.test(c.imageName)
        : c.imageName.toLowerCase().includes(input.imageNamePattern.toLowerCase());
      if (!nameMatches) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (input.sortBy === 'cvss') {
      return b.cvssMax - a.cvssMax || SEVERITY_RANK[b.overallSeverity] - SEVERITY_RANK[a.overallSeverity];
    }
    if (input.sortBy === 'lastScannedAt') {
      return (
        new Date(b.lastScannedAt).getTime() - new Date(a.lastScannedAt).getTime()
      );
    }
    // Default: severity rank (primary), CVSS (secondary), both descending.
    return (
      SEVERITY_RANK[b.overallSeverity] - SEVERITY_RANK[a.overallSeverity] ||
      b.cvssMax - a.cvssMax
    );
  });

  return sorted.slice(0, input.limit);
}

/**
 * Pulls every ingested scan document. Prefers a direct metadata read against
 * Supabase (deterministic, no embedding call, no top-k truncation) and falls
 * back to the semantic retriever if that path is unavailable — either way,
 * ranking below never depends on similarity-search ordering.
 */
export async function getCandidateScanDocuments(
  config: RunnableConfig,
): Promise<Document[]> {
  try {
    return await fetchAllScanDocuments();
  } catch (directReadError) {
    try {
      const retriever = await makeRetriever(config);
      return await retriever.invoke('hardened image vulnerability scan');
    } catch (retrieverError) {
      throw new Error(
        `Unable to load hardened image scan data: ${
          (directReadError as Error).message
        }; fallback also failed: ${(retrieverError as Error).message}`,
      );
    }
  }
}

export function makeQueryHardenedImagesTool(config: RunnableConfig) {
  return tool(
    async (input: QueryHardenedImagesInput) => {
      const docs = await getCandidateScanDocuments(config);
      const candidates = docs
        .map(toRankedResult)
        .filter((r): r is RankedImageResult => r !== null);

      const ranked = filterAndRankImages(candidates, input);

      return JSON.stringify({
        count: ranked.length,
        images: ranked,
      });
    },
    {
      name: 'queryHardenedImages',
      description:
        'Filter and rank hardened container images by vulnerability severity. ' +
        'Always call this when the user asks about vulnerabilities, images, or triage priorities. ' +
        'Returns images sorted worst-to-best; an empty "images" array means no images matched.',
      schema: queryHardenedImagesSchema,
    },
  );
}

export { SEVERITY_RANK, SEVERITY_ORDER };
