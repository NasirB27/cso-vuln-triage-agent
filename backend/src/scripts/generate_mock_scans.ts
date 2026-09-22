/**
 * Generates synthetic hardened-image vulnerability scan records for the
 * ingestion demo. This is NOT real scan output — CVE IDs, package versions,
 * and findings below are fabricated for demonstration purposes only and do
 * not represent any actual Iron Bank image or vulnerability.
 *
 * Each record is shaped like the output of a container scanner
 * (Anchore/Grype/Twistlock-style JSON) so the ingestion pipeline mirrors
 * what a real DoD hardened-image pipeline would consume.
 *
 * Usage: npx tsx src/scripts/generate_mock_scans.ts
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '..', 'sample_scans');

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

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

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const BASE_IMAGES = [
  'ironbank/redhat/ubi/ubi9',
  'ironbank/redhat/ubi/ubi8-minimal',
  'ironbank/opensource/nginx/nginx',
  'ironbank/opensource/postgres/postgres15',
  'ironbank/opensource/redis/redis7',
  'ironbank/opensource/traefik/traefik',
  'ironbank/opensource/keycloak/keycloak',
  'ironbank/opensource/elastic/elasticsearch8',
  'ironbank/opensource/grafana/grafana',
  'ironbank/opensource/prometheus/prometheus',
  'ironbank/opensource/istio/pilot',
  'ironbank/opensource/istio/proxyv2',
  'ironbank/opensource/vault/vault',
  'ironbank/opensource/consul/consul',
  'ironbank/opensource/rabbitmq/rabbitmq',
  'ironbank/opensource/minio/minio',
  'ironbank/opensource/argoproj/argocd',
  'ironbank/opensource/jenkins/jenkins',
  'ironbank/opensource/sonarqube/sonarqube',
  'ironbank/opensource/harbor/harbor-core',
  'ironbank/opensource/kong/kong',
  'ironbank/opensource/fluentbit/fluent-bit',
  'ironbank/opensource/cert-manager/controller',
  'ironbank/opensource/envoyproxy/envoy',
  'ironbank/opensource/nats/nats-server',
  'ironbank/opensource/etcd/etcd',
  'ironbank/opensource/mongodb/mongodb6',
  'ironbank/opensource/kafka/kafka',
  'ironbank/opensource/zookeeper/zookeeper',
  'ironbank/opensource/nodejs/node20',
  'ironbank/opensource/python/python311',
  'ironbank/opensource/golang/go122',
  'ironbank/opensource/openjdk/openjdk17',
  'ironbank/opensource/nifi/nifi',
  'ironbank/opensource/logstash/logstash8',
  'ironbank/opensource/kibana/kibana8',
  'ironbank/opensource/haproxy/haproxy',
  'ironbank/opensource/wordpress/wordpress',
  'ironbank/opensource/gitlab/gitlab-runner',
  'ironbank/opensource/apache/httpd',
  'ironbank/opensource/tomcat/tomcat10',
  'ironbank/opensource/alpine/alpine',
  'ironbank/opensource/busybox/busybox',
  'ironbank/opensource/distroless/static',
  'ironbank/opensource/opensearch/opensearch2',
  'ironbank/opensource/influxdb/influxdb2',
];

const BASE_OS_OPTIONS = [
  'RHEL 9 (UBI9)',
  'RHEL 8 (UBI8-minimal)',
  'Alpine 3.19',
  'Distroless (static)',
  'Debian 12 (bookworm-slim)',
];

const PACKAGE_POOL = [
  'openssl',
  'glibc',
  'zlib',
  'curl',
  'libxml2',
  'busybox',
  'openssh',
  'sqlite',
  'python3',
  'nodejs',
  'expat',
  'krb5-libs',
  'pcre2',
  'systemd-libs',
  'libcurl',
  'gnutls',
  'ncurses-libs',
  'coreutils',
  'bash',
  'tar',
  'gzip',
  'libxslt',
  'jackson-databind',
  'log4j-core',
  'netty-codec-http',
  'spring-core',
  'urllib3',
  'requests',
  'lodash',
  'axios',
  'protobuf-java',
];

const DESCRIPTION_TEMPLATES: Record<Severity, string[]> = {
  CRITICAL: [
    'Remote code execution via crafted input allows full container compromise.',
    'Unauthenticated privilege escalation permits root-level command execution.',
    'Deserialization of untrusted data leads to arbitrary code execution.',
    'Buffer overflow in the network-facing parser allows remote code execution.',
  ],
  HIGH: [
    'Authentication bypass allows unauthorized access to protected endpoints.',
    'Out-of-bounds write may allow denial of service or code execution.',
    'Improper certificate validation allows man-in-the-middle interception.',
    'SQL injection in a legacy query path allows data exfiltration.',
  ],
  MEDIUM: [
    'Denial of service via crafted request causes excessive resource consumption.',
    'Information disclosure of internal memory contents under specific conditions.',
    'Improper input validation may allow limited data corruption.',
    'Insecure default configuration weakens transport-layer protections.',
  ],
  LOW: [
    'Minor information disclosure with limited practical impact.',
    'Non-exploitable crash under unusual, attacker-uncontrolled conditions.',
    'Deprecated cryptographic primitive still accepted as a fallback.',
    'Verbose error message may reveal internal path information.',
  ],
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function severityForCvss(score: number): Severity {
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  return 'LOW';
}

function cvssForSeverity(severity: Severity): number {
  switch (severity) {
    case 'CRITICAL':
      return Math.round((9.0 + Math.random() * 1.0) * 10) / 10;
    case 'HIGH':
      return Math.round((7.0 + Math.random() * 1.9) * 10) / 10;
    case 'MEDIUM':
      return Math.round((4.0 + Math.random() * 2.9) * 10) / 10;
    case 'LOW':
      return Math.round((0.1 + Math.random() * 3.8) * 10) / 10;
  }
}

function randomCveId(): string {
  const year = pick(['2022', '2023', '2024', '2025']);
  const id = randInt(10000, 52000);
  return `CVE-${year}-${id}`;
}

function randomVersion(): string {
  return `${randInt(1, 9)}.${randInt(0, 20)}.${randInt(0, 40)}`;
}

function bumpVersion(installed: string): string {
  const parts = installed.split('.').map(Number);
  parts[parts.length - 1] += randInt(1, 5);
  return parts.join('.');
}

function generateFinding(forcedSeverity?: Severity): Finding {
  const severity =
    forcedSeverity ??
    pick<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'LOW', 'MEDIUM']);
  const cvssScore = cvssForSeverity(severity);
  const installedVersion = randomVersion();
  const hasFix = Math.random() > 0.15;

  return {
    cveId: randomCveId(),
    packageName: pick(PACKAGE_POOL),
    installedVersion,
    fixedVersion: hasFix ? bumpVersion(installedVersion) : null,
    cvssScore,
    severity: severityForCvss(cvssScore),
    description: pick(DESCRIPTION_TEMPLATES[severity]),
  };
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function buildRecord(imagePath: string): ScanRecord {
  const [, ...rest] = imagePath.split('/');
  const imageName = rest[rest.length - 1];
  const imageTag = pick(['1.0.0', '2.1.3', '3.0.0', 'latest', '8.5.2', '9.2.1']);

  // Weighted distribution: ~20% clean, ~25% low/medium only,
  // ~30% a handful of highs, ~25% has criticals.
  const profileRoll = Math.random();
  let findingCount: number;
  let severityPool: Severity[];

  if (profileRoll < 0.2) {
    findingCount = 0;
    severityPool = [];
  } else if (profileRoll < 0.45) {
    findingCount = randInt(1, 4);
    severityPool = ['LOW', 'MEDIUM'];
  } else if (profileRoll < 0.75) {
    findingCount = randInt(2, 8);
    severityPool = ['MEDIUM', 'HIGH', 'LOW'];
  } else {
    findingCount = randInt(3, 12);
    severityPool = ['CRITICAL', 'HIGH', 'MEDIUM'];
  }

  const findings: Finding[] = Array.from({ length: findingCount }, () =>
    generateFinding(severityPool.length ? pick(severityPool) : undefined),
  );

  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const highCount = findings.filter((f) => f.severity === 'HIGH').length;
  const mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length;
  const lowCount = findings.filter((f) => f.severity === 'LOW').length;

  let overallSeverity: Severity = 'LOW';
  if (criticalCount > 0) overallSeverity = 'CRITICAL';
  else if (highCount > 0) overallSeverity = 'HIGH';
  else if (mediumCount > 0) overallSeverity = 'MEDIUM';

  return {
    imageName,
    imageTag,
    registryPath: `registry1.dso.mil/${imagePath}`,
    baseOS: pick(BASE_OS_OPTIONS),
    lastScannedAt: daysAgoIso(randInt(0, 21)),
    findings: findings.sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.cvssScore - a.cvssScore,
    ),
    overallSeverity,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const records = BASE_IMAGES.map((imagePath) => buildRecord(imagePath));

  await Promise.all(
    records.map((record) => {
      const fileName = `${record.imageName}.json`;
      return fs.writeFile(
        path.join(OUTPUT_DIR, fileName),
        JSON.stringify(record, null, 2),
        'utf-8',
      );
    }),
  );

  const summary = records.reduce(
    (acc, r) => {
      acc[r.overallSeverity] += 1;
      return acc;
    },
    { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<Severity, number>,
  );

  console.log(`Generated ${records.length} mock scan records in ${OUTPUT_DIR}`);
  console.log('Overall severity breakdown:', summary);
}

main().catch((error) => {
  console.error('Failed to generate mock scans:', error);
  process.exit(1);
});
