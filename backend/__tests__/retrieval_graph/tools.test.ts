import {
  filterAndRankImages,
  RankedImageResult,
  QueryHardenedImagesInput,
} from '../../src/retrieval_graph/tools.js';

function image(overrides: Partial<RankedImageResult>): RankedImageResult {
  return {
    imageName: 'unnamed',
    imageTag: '1.0.0',
    registryPath: 'registry1.dso.mil/ironbank/test/unnamed',
    overallSeverity: 'LOW',
    cvssMax: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    topCveId: null,
    lastScannedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function defaultInput(
  overrides: Partial<QueryHardenedImagesInput> = {},
): QueryHardenedImagesInput {
  return { limit: 20, sortBy: 'severity', ...overrides };
}

describe('filterAndRankImages', () => {
  // The core requirement: ranking is an explicit, deterministic in-code
  // sort — severity rank as the primary key, CVSS as the secondary key,
  // both descending — never left to the LLM to eyeball from retrieved text.
  it('ranks by severity rank first, then by CVSS score as a tiebreaker within the same severity', () => {
    const candidates = [
      image({ imageName: 'low-image', overallSeverity: 'LOW', cvssMax: 3.9 }),
      image({
        imageName: 'critical-low-cvss',
        overallSeverity: 'CRITICAL',
        cvssMax: 9.1,
      }),
      image({
        imageName: 'high-image',
        overallSeverity: 'HIGH',
        cvssMax: 8.5,
      }),
      image({
        imageName: 'critical-high-cvss',
        overallSeverity: 'CRITICAL',
        cvssMax: 9.9,
      }),
      image({
        imageName: 'medium-image',
        overallSeverity: 'MEDIUM',
        cvssMax: 6.0,
      }),
    ];

    const ranked = filterAndRankImages(candidates, defaultInput());

    expect(ranked.map((r) => r.imageName)).toEqual([
      'critical-high-cvss', // CRITICAL, 9.9
      'critical-low-cvss', // CRITICAL, 9.1 (tiebreak loser vs above)
      'high-image', // HIGH, 8.5
      'medium-image', // MEDIUM, 6.0
      'low-image', // LOW, 3.9
    ]);
  });

  it('never lets a high CVSS score in a lower severity bucket outrank a lower CVSS score in a higher severity bucket', () => {
    const candidates = [
      // A MEDIUM finding with an unusually high CVSS should still rank
      // below every HIGH, even one with a lower CVSS.
      image({ imageName: 'medium-high-cvss', overallSeverity: 'MEDIUM', cvssMax: 6.9 }),
      image({ imageName: 'high-low-cvss', overallSeverity: 'HIGH', cvssMax: 7.0 }),
    ];

    const ranked = filterAndRankImages(candidates, defaultInput());
    expect(ranked.map((r) => r.imageName)).toEqual([
      'high-low-cvss',
      'medium-high-cvss',
    ]);
  });

  it('filters out images below minSeverity', () => {
    const candidates = [
      image({ imageName: 'crit', overallSeverity: 'CRITICAL', cvssMax: 9.5 }),
      image({ imageName: 'high', overallSeverity: 'HIGH', cvssMax: 7.5 }),
      image({ imageName: 'med', overallSeverity: 'MEDIUM', cvssMax: 5.0 }),
      image({ imageName: 'low', overallSeverity: 'LOW', cvssMax: 1.0 }),
    ];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ minSeverity: 'HIGH' }),
    );

    expect(ranked.map((r) => r.imageName)).toEqual(['crit', 'high']);
  });

  it('filters by imageNamePattern as a case-insensitive substring/regex match', () => {
    const candidates = [
      image({ imageName: 'nginx', overallSeverity: 'HIGH', cvssMax: 7.0 }),
      image({ imageName: 'postgres15', overallSeverity: 'CRITICAL', cvssMax: 9.0 }),
      image({ imageName: 'Nginx-ingress', overallSeverity: 'LOW', cvssMax: 2.0 }),
    ];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ imageNamePattern: 'nginx' }),
    );

    expect(ranked.map((r) => r.imageName).sort()).toEqual(
      ['nginx', 'Nginx-ingress'].sort(),
    );
  });

  it('respects the limit parameter after sorting', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      image({
        imageName: `image-${i}`,
        overallSeverity: 'CRITICAL',
        cvssMax: 9.0 + i * 0.1,
      }),
    );

    const ranked = filterAndRankImages(candidates, defaultInput({ limit: 2 }));

    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.imageName)).toEqual(['image-4', 'image-3']);
  });

  it('supports sortBy "cvss" to sort purely by CVSS regardless of severity bucket', () => {
    const candidates = [
      image({ imageName: 'medium-9', overallSeverity: 'MEDIUM', cvssMax: 6.9 }),
      image({ imageName: 'high-7', overallSeverity: 'HIGH', cvssMax: 7.0 }),
      image({ imageName: 'critical-95', overallSeverity: 'CRITICAL', cvssMax: 9.5 }),
    ];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ sortBy: 'cvss' }),
    );

    expect(ranked.map((r) => r.imageName)).toEqual([
      'critical-95',
      'high-7',
      'medium-9',
    ]);
  });

  it('supports sortBy "lastScannedAt" to surface the most recently scanned images first', () => {
    const candidates = [
      image({ imageName: 'old', lastScannedAt: '2026-01-01T00:00:00.000Z' }),
      image({ imageName: 'newest', lastScannedAt: '2026-09-20T00:00:00.000Z' }),
      image({ imageName: 'middle', lastScannedAt: '2026-05-01T00:00:00.000Z' }),
    ];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ sortBy: 'lastScannedAt' }),
    );

    expect(ranked.map((r) => r.imageName)).toEqual(['newest', 'middle', 'old']);
  });

  it('returns an empty array (not a fabricated result) when nothing matches', () => {
    const candidates = [image({ imageName: 'only-low', overallSeverity: 'LOW', cvssMax: 1.0 })];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ minSeverity: 'CRITICAL' }),
    );

    expect(ranked).toEqual([]);
  });

  it('falls back to a literal substring match if imageNamePattern is not valid regex', () => {
    const candidates = [
      image({ imageName: 'weird(name', overallSeverity: 'HIGH', cvssMax: 7.5 }),
    ];

    const ranked = filterAndRankImages(
      candidates,
      defaultInput({ imageNamePattern: '(' }),
    );

    expect(ranked.map((r) => r.imageName)).toEqual(['weird(name']);
  });
});
