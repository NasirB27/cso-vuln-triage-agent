import { scanRecordToDocument } from '../../src/ingestion_graph/graph.js';
import { assertScanMetadata } from '../../src/ingestion_graph/state.js';

const baseRecord = {
  imageName: 'nginx',
  imageTag: '1.25.3',
  registryPath: 'registry1.dso.mil/ironbank/opensource/nginx/nginx',
  baseOS: 'RHEL 9 (UBI9)',
  lastScannedAt: '2026-09-01T00:00:00.000Z',
  findings: [
    {
      cveId: 'CVE-2024-10001',
      packageName: 'openssl',
      installedVersion: '3.0.1',
      fixedVersion: '3.0.5',
      cvssScore: 9.8,
      severity: 'CRITICAL' as const,
      description: 'Remote code execution via crafted input.',
    },
    {
      cveId: 'CVE-2024-10002',
      packageName: 'zlib',
      installedVersion: '1.2.11',
      fixedVersion: null,
      cvssScore: 5.3,
      severity: 'MEDIUM' as const,
      description: 'Denial of service under crafted input.',
    },
  ],
  overallSeverity: 'CRITICAL' as const,
  criticalCount: 1,
  highCount: 0,
  mediumCount: 1,
  lowCount: 0,
};

describe('scanRecordToDocument (ingestion)', () => {
  it('attaches all required structured severity/CVSS metadata fields', () => {
    const doc = scanRecordToDocument(baseRecord);

    expect(doc.metadata.imageName).toBe('nginx');
    expect(doc.metadata.imageTag).toBe('1.25.3');
    expect(doc.metadata.registryPath).toBe(baseRecord.registryPath);
    expect(doc.metadata.overallSeverity).toBe('CRITICAL');
    expect(doc.metadata.cvssMax).toBe(9.8);
    expect(doc.metadata.criticalCount).toBe(1);
    expect(doc.metadata.highCount).toBe(0);
    expect(doc.metadata.mediumCount).toBe(1);
    expect(doc.metadata.lowCount).toBe(0);
    expect(doc.metadata.lastScannedAt).toBe(baseRecord.lastScannedAt);
    expect(doc.metadata.topCveId).toBe('CVE-2024-10001');
  });

  it('does not rely on free-text parsing: metadata survives independent of pageContent', () => {
    const doc = scanRecordToDocument(baseRecord);

    // The severity data must be readable directly from metadata without
    // parsing pageContent, since that is what the ranking tool queries.
    expect(() => assertScanMetadata(doc.metadata, 'nginx')).not.toThrow();
    expect(doc.pageContent).toContain('nginx');
    expect(doc.pageContent).toContain('CVE-2024-10001');
  });

  it('computes cvssMax as the maximum finding score, not the first finding', () => {
    const record = {
      ...baseRecord,
      findings: [
        { ...baseRecord.findings[1] }, // 5.3, listed first
        { ...baseRecord.findings[0] }, // 9.8, listed second
      ],
    };
    const doc = scanRecordToDocument(record);
    expect(doc.metadata.cvssMax).toBe(9.8);
  });

  it('handles a clean image with zero findings', () => {
    const cleanRecord = {
      ...baseRecord,
      findings: [],
      overallSeverity: 'LOW' as const,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
    };
    const doc = scanRecordToDocument(cleanRecord);
    expect(doc.metadata.cvssMax).toBe(0);
    expect(doc.metadata.topCveId).toBeNull();
    expect(() => assertScanMetadata(doc.metadata, 'nginx')).not.toThrow();
  });

  it('throws via assertScanMetadata when a required field is missing', () => {
    expect(() =>
      assertScanMetadata({ imageName: 'nginx' }, 'nginx'),
    ).toThrow(/missing required field/i);
  });
});
