import { Annotation } from '@langchain/langgraph';
import { Document } from '@langchain/core/documents';
import { reduceDocs } from '../shared/state.js';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * The structured metadata every ingested scan document must carry.
 *
 * Severity and CVSS data live here, not just in the free-text summary, so the
 * retrieval agent can filter/sort on them deterministically instead of
 * relying on the LLM to infer severity from prose at query time.
 */
export interface ScanDocumentMetadata {
  uuid: string;
  imageName: string;
  imageTag: string;
  registryPath: string;
  baseOS: string;
  lastScannedAt: string;
  overallSeverity: Severity;
  cvssMax: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  topCveId: string | null;
  [key: string]: unknown;
}

const REQUIRED_SCAN_METADATA_FIELDS: (keyof ScanDocumentMetadata)[] = [
  'imageName',
  'overallSeverity',
  'cvssMax',
  'criticalCount',
  'lastScannedAt',
];

/**
 * Validates that a document's metadata carries the required structured scan
 * fields, throwing rather than silently ingesting a document the ranking
 * tool couldn't filter/sort correctly.
 */
export function assertScanMetadata(
  metadata: Record<string, unknown> | undefined,
  context: string,
): asserts metadata is ScanDocumentMetadata {
  if (!metadata) {
    throw new Error(`Missing metadata on scan document: ${context}`);
  }
  const missing = REQUIRED_SCAN_METADATA_FIELDS.filter(
    (field) => metadata[field] === undefined || metadata[field] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Scan document metadata missing required field(s) [${missing.join(', ')}] for ${context}`,
    );
  }
}

/**
 * Represents the state for document indexing and retrieval.
 *
 * This interface defines the structure of the index state, which includes
 * the documents to be indexed and the retriever used for searching
 * these documents.
 */
export const IndexStateAnnotation = Annotation.Root({
  /**
   * A list of documents that the agent can index.
   */
  docs: Annotation<
    Document[],
    Document[] | { [key: string]: any }[] | string[] | string | 'delete'
  >({
    default: () => [],
    reducer: reduceDocs,
  }),
});

export type IndexStateType = typeof IndexStateAnnotation.State;
