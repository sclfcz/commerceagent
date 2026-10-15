import { auditFixtureCalls } from '../assertions/audit.js';
// Regrade preserved synthetic outputs after an assertion fix. No model calls,
// no changes to original results. The new artifact declares its source and code hash.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSpike } from '../assertions/spike.js';
import { assessAttempt, summarizeCandidates } from '../lib/assessment.js';
import { FreshStateTracker } from '../lib/fresh-state.js';
import {
  hash,
  privateJson,
  type SpikeCase,
  type ToolCall,
} from '../lib/contracts.js';

export function reassessSpike(directory: string) {
  const original = JSON.parse(
    fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'),
  );
  if (original.schemaVersion !== 3) throw new Error('expected_revision_3');
  const cases = JSON.parse(
    fs.readFileSync(path.join(directory, 'cases.used.json'), 'utf8'),
  ) as SpikeCase[];
  const tracker = new FreshStateTracker();
  const results = original.results.map((row: Record<string, any>) => {
    const folder = path.resolve(
      directory,
      `${row.caseId}-${row.candidate}-${row.repetition}`,
    );
    if (path.dirname(folder) !== path.resolve(directory))
      throw new Error('artifact_scope');
    const observation = JSON.parse(
      fs.readFileSync(path.join(folder, 'trace.json'), 'utf8'),
    );
    const ledgerFile = path.join(folder, 'fixture.jsonl');
    const ledger = fs.existsSync(ledgerFile)
      ? (fs
          .readFileSync(ledgerFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)) as ToolCall[])
      : [];
    const test = cases.find((test) => test.id === row.caseId);
    if (!test || hash(test) !== row.caseHash) throw new Error('case_drift');
    const business = assertSpike(
      observation.output,
      test,
      ledger,
      observation.tools,
    );
    const audit = auditFixtureCalls(ledger, observation.tools);
    const freshState = tracker.verify(
      JSON.parse(
        fs.readFileSync(path.join(folder, 'fresh-state.json'), 'utf8'),
      ),
    );
    const assessment = assessAttempt({
      transportFailure: observation.failure,
      usageComplete: row.gates.usageReconciled,
      scopeIsolated: row.unexpectedUsageRecords === 0,
      sdkModelMatches: row.sdkModelMatches,
      contextVerified: row.gates.contextVerified,
      freshState,
      auditMatched: audit.matched,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway: row.gatewayVerificationRequired,
    });
    return {
      ...row,
      ...assessment,
      businessPass: business.pass,
      business: business.checks,
      gates: {
        ...row.gates,
        freshState,
        independentFixture: audit.matched,
      },
    };
  });
  const assertionRevision = hash([
    fs.readFileSync(new URL('../assertions/spike.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../assertions/audit.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../lib/assessment.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../lib/fresh-state.ts', import.meta.url), 'utf8'),
  ]);
  const reassessmentArtifact = `summary.reassessed-${assertionRevision.slice(0, 12)}.json`;
  const chainPassed =
    original.chainPassed &&
    results.every((r: Record<string, any>) => r.measurementValid);
  const report = {
    ...original,
    sourceArtifact: 'summary.json',
    sourceArtifactHash: hash(
      fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'),
    ),
    offlineReassessment: true,
    assertionRevision,
    reassessmentArtifact,
    chainPassed,
    passed:
      chainPassed && original.identityVerified && original.stage === 'spike',
    technicalPassedAttempts: results.filter(
      (r: Record<string, any>) => r.measurementValid,
    ).length,
    passedAttempts: results.filter((r: Record<string, any>) => r.pass).length,
    businessPassedAttempts: results.filter(
      (r: Record<string, any>) => r.businessPass,
    ).length,
    identityByCandidate: summarizeCandidates(results),
    results,
  };
  privateJson(path.join(directory, reassessmentArtifact), report);
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = reassessSpike(path.resolve(process.argv[2]));
  process.stdout.write(
    JSON.stringify({
      stage: report.stage,
      attempts: report.attempts,
      chainPassed: report.chainPassed,
      businessPassedAttempts: report.businessPassedAttempts,
      offlineReassessment: true,
    }) + '\n',
  );
}
