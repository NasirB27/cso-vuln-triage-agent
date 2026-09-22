/**
 * This "graph" exposes an endpoint for ingesting hardened-image vulnerability
 * scan records into the vector store, so the retrieval agent can filter/rank
 * hardened images by severity.
 */

import { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, END, START } from '@langchain/langgraph';
import { Document } from '@langchain/core/documents';
import fs from 'fs/promises';
import path from 'path';

import { IndexStateAnnotation, assertScanMetadata, Severity } from './state.js';
import { makeRetriever } from '../shared/retrieval.js';
import {
  ensureIndexConfiguration,
  IndexConfigurationAnnotation,
} from './configuration.js';
import { reduceDocs } from '../shared/state.js';

interface Finding {
  cveId: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  cvssScore: number;
  severity: Severity;
  description: string;
}

interface ScanRecord {
  imageName: string;
  imageTag: string;
  registryPath: string;
  baseOS: string;
  lastScannedAt: string;
  findings: Finding[];
  overallSeverity: Severity;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

/**
 * Turns one raw scan record into a LangChain Document: pageContent is a
 * human/LLM-readable summary for semantic search, metadata carries the
 * structured severity/CVSS fields the ranking tool relies on.
 */
export function scanRecordToDocument(record: ScanRecord): Document {
  const topFindings = [...record.findings]
    .sort((a, b) => b.cvssScore - a.cvssScore)
    .slice(0, 5);

  const cvssMax = record.findings.reduce(
    (max, f) => Math.max(max, f.cvssScore),
    0,
  );

  const topCveLines = topFindings
    .map(
      (f) =>
        `  - ${f.cveId} (${f.severity}, CVSS ${f.cvssScore}) in ${f.packageName}@${f.installedVersion}: ${f.description}`,
    )
    .join('\n');

  const pageContent = `Image: ${record.imageName}:${record.imageTag}
Registry: ${record.registryPath}
Base OS: ${record.baseOS}
Last scanned: ${record.lastScannedAt}
Overall severity: ${record.overallSeverity}
Findings: ${record.criticalCount} critical, ${record.highCount} high, ${record.mediumCount} medium, ${record.lowCount} low
Top findings:
${topCveLines || '  (none)'}`;

  const metadata = {
    imageName: record.imageName,
    imageTag: record.imageTag,
    registryPath: record.registryPath,
    baseOS: record.baseOS,
    lastScannedAt: record.lastScannedAt,
    overallSeverity: record.overallSeverity,
    cvssMax,
    criticalCount: record.criticalCount,
    highCount: record.highCount,
    mediumCount: record.mediumCount,
    lowCount: record.lowCount,
    topCveId: topFindings[0]?.cveId ?? null,
  };

  assertScanMetadata(metadata, record.imageName);

  return new Document({ pageContent, metadata });
}

async function loadScanRecords(scansDirectory: string): Promise<ScanRecord[]> {
  const entries = await fs.readdir(scansDirectory);
  const jsonFiles = entries.filter((f) => f.endsWith('.json'));

  const records = await Promise.all(
    jsonFiles.map(async (file) => {
      const raw = await fs.readFile(
        path.join(scansDirectory, file),
        'utf-8',
      );
      return JSON.parse(raw) as ScanRecord;
    }),
  );

  return records;
}

async function ingestDocs(
  state: typeof IndexStateAnnotation.State,
  config?: RunnableConfig,
): Promise<typeof IndexStateAnnotation.Update> {
  if (!config) {
    throw new Error('Configuration required to run ingestDocs.');
  }

  const configuration = ensureIndexConfiguration(config);
  let docs = state.docs;

  if (!docs || docs.length === 0) {
    if (configuration.useSampleScans) {
      const records = await loadScanRecords(configuration.scansDirectory);
      const scanDocs = records.map(scanRecordToDocument);
      docs = reduceDocs([], scanDocs);
    } else {
      throw new Error('No sample scans to index.');
    }
  } else {
    docs = reduceDocs([], docs);
  }

  const retriever = await makeRetriever(config);
  await retriever.addDocuments(docs);

  return { docs: 'delete' };
}

// Define the graph
const builder = new StateGraph(
  IndexStateAnnotation,
  IndexConfigurationAnnotation,
)
  .addNode('ingestDocs', ingestDocs)
  .addEdge(START, 'ingestDocs')
  .addEdge('ingestDocs', END);

// Compile into a graph object that you can invoke and deploy.
export const graph = builder
  .compile()
  .withConfig({ runName: 'IngestionGraph' });
