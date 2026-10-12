import { rotateCandidates, summarizeCandidates } from '../lib/assessment.js';
import {
  importOpenCodeGoKey,
  openCodeGoCandidate,
} from '../lib/opencode-go.js';
import { importCandidateCredentials } from '../lib/local-credentials.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import {
  hash,
  parseCandidates,
  privateJson,
  type Candidate,
  type SpikeCase,
} from '../lib/contracts.js';
import { stopOwnedServices } from '../lib/service.js';
import {
  attempt,
  CollectionFailure,
  ContextFailure,
  createAttemptContext,
  runtimeSourceHash,
} from '../lib/attempt.js';
import { importExisting } from '../lib/existing.js';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const bench = path.join(repository, 'benchmarks');
const image =
  process.env.BENCH_CONTAINER_IMAGE || 'riba2534/happyclaw-agent:latest';
let pinnedImage = image;
let expectedRuntimeSourceHash: string | null = null;
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || 180000);

export async function preflight(runDirectory: string, selectedAlias?: string) {
  expectedRuntimeSourceHash = runtimeSourceHash(repository);
  let docker = false;
  let imagePresent = false;
  let imageHash: string | null = null;
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 15000,
    });
    docker = true;
  } catch {
    /* report only booleans */
  }
  if (docker)
    try {
      const result = await exec(
        'docker',
        ['image', 'inspect', image, '--format', '{{.Id}}'],
        { timeout: 15000 },
      );
      imageHash = result.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageHash))
        throw new Error('image_identity');
      pinnedImage = imageHash;
      imagePresent = true;
    } catch {
      /* never pull implicitly */
    }
  let candidates: Candidate[] = [];
  let configured = false;
  let credentials = false;
  try {
    if (process.argv.includes('--existing')) {
      candidates = await importExisting(repository, runDirectory);
      configured = true;
    } else if (process.env.BENCH_CANDIDATES_FILE) {
      candidates = parseCandidates(
        parse(fs.readFileSync(process.env.BENCH_CANDIDATES_FILE, 'utf8')),
      );
      configured = true;
    }
  } catch {
    /* don't print endpoint/config parse errors */
  }
  if (selectedAlias) {
    const selected = candidates.find(
      (candidate) => candidate.alias === selectedAlias,
    );
    if (!selected) throw new Error('benchmark_candidate_not_found');
    candidates = [selected];
  }
  importCandidateCredentials(repository, candidates);
  if (process.argv.includes('--with-opencode-go')) {
    importOpenCodeGoKey(repository);
    const go = openCodeGoCandidate(candidates);
    candidates = parseCandidates([...candidates, go]);
    privateJson(path.join(runDirectory, 'candidates.json'), candidates);
  }
  credentials =
    configured &&
    candidates.length > 0 &&
    candidates.every((candidate) => !!process.env[candidate.apiKeyEnv]?.trim());
  privateJson(path.join(runDirectory, 'candidates.json'), candidates);
  return {
    docker,
    imagePresent,
    imageHash,
    configured,
    credentials,
    candidates,
    runtimeSourceHash: expectedRuntimeSourceHash,
    timeoutValid:
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1000 &&
      timeoutMs <= 1800000,
  };
}

export async function main() {
  const runDir = path.join(
    bench,
    'results',
    `spike-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const checks = await preflight(runDir);
  const safePreflight = {
    runtimeSourceHash: checks.runtimeSourceHash,
    docker: checks.docker,
    imagePresent: checks.imagePresent,
    imageHash: checks.imageHash,
    candidateConfigured: checks.configured,
    credentialsPresent: checks.credentials,
    timeoutValid: checks.timeoutValid,
  };
  privateJson(path.join(runDir, 'preflight.json'), safePreflight);
  const ready =
    checks.docker &&
    checks.imagePresent &&
    checks.configured &&
    checks.credentials &&
    checks.timeoutValid;
  if (process.argv.includes('--preflight') || !ready) {
    process.stdout.write(
      JSON.stringify({ stage: 'preflight', ready, ...safePreflight }) + '\n',
    );
    if (!ready) process.exitCode = 1;
    return;
  }
  const allCases = parse(
    fs.readFileSync(path.join(bench, 'cases/spike.yaml'), 'utf8'),
  ) as SpikeCase[];
  privateJson(path.join(runDir, 'cases.used.json'), allCases);
  const smoke = process.argv.includes('--smoke');
  const cases = smoke
    ? allCases.slice(0, checks.candidates.length > 1 ? 2 : 1)
    : allCases;
  const repetitions = smoke ? 1 : 3;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void stopOwnedServices();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const results: Array<Record<string, any>> = [];
  const attemptContext = createAttemptContext({
    repository,
    pinnedImage,
    timeoutMs,
    expectedRuntimeSourceHash: checks.runtimeSourceHash!,
  });
  // Three independent repetitions. Rotate candidates per case/repetition.
  attempts: for (let repetition = 0; repetition < repetitions; repetition++)
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const rotated = rotateCandidates(
        checks.candidates,
        caseIndex,
        repetition,
      );
      for (const candidate of rotated) {
        if (cancelled) break attempts;
        const test = cases[caseIndex];
        const directory = path.join(
          runDir,
          `${test.id}-${candidate.alias}-${repetition + 1}`,
        );
        try {
          results.push(
            await attempt(
              candidate,
              test,
              directory,
              checks.candidates,
              attemptContext,
              repetition + 1,
            ),
          );
        } catch (error) {
          const result = {
            candidate: candidate.alias,
            caseId: test.id,
            repetition: repetition + 1,
            pass: false,
            failure:
              error instanceof ContextFailure
                ? 'context_mismatch'
                : error instanceof CollectionFailure
                  ? 'collection_incomplete'
                  : 'environment',
          };
          privateJson(path.join(directory, 'result.json'), result);
          results.push(result);
        }
        const latest = results.at(-1)!;
        process.stdout.write(
          JSON.stringify({
            caseId: latest.caseId,
            candidate: latest.candidate,
            repetition: latest.repetition,
            measurementValid: latest.measurementValid ?? false,
            businessPass: latest.businessPass ?? false,
            identityPending: latest.gatewayVerificationRequired ?? false,
            failure: latest.failure,
          }) + '\n',
        );
      }
    }
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  const fingerprints = results.map((result) =>
    result.contextFingerprint ? hash(result.contextFingerprint) : null,
  );
  const contextReproducible =
    fingerprints.every(Boolean) &&
    new Set(fingerprints).size === 1 &&
    results.every((result) => result.workspaceBaselineHash) &&
    new Set(results.map((result) => result.workspaceBaselineHash)).size === 1;
  const chainPassed =
    !cancelled &&
    results.length === cases.length * repetitions * checks.candidates.length &&
    results.every(
      (result) => result.measurementValid && result.gates?.freshState,
    ) &&
    contextReproducible;
  const identityVerified = results.every(
    (result) => result.gates?.modelIdentity,
  );
  const passed = chainPassed && identityVerified && !smoke;
  const report = {
    schemaVersion: 3,
    chainPassed,
    identityVerified,
    identityByCandidate: summarizeCandidates(results as any),
    stage: smoke ? 'smoke' : 'spike',
    cancelled,
    scope: 'synthetic-query-analysis',
    passed,
    contextReproducible,
    coldStartOnly: true,
    attempts: results.length,
    passedAttempts: results.filter((result) => result.pass).length,
    businessPassedAttempts: results.filter((result) => result.businessPass)
      .length,
    technicalPassedAttempts: results.filter((result) => result.measurementValid)
      .length,
    runtimeSourceHash: checks.runtimeSourceHash,
    results,
  };
  privateJson(path.join(runDir, 'summary.json'), report);
  process.stdout.write(
    JSON.stringify({
      stage: smoke ? 'smoke' : 'spike',
      passed,
      chainPassed,
      identityVerified,
      identityByCandidate: report.identityByCandidate,
      businessPassedAttempts: report.businessPassedAttempts,
      contextReproducible,
      attempts: report.attempts,
      passedAttempts: report.passedAttempts,
    }) + '\n',
  );
  if (!(smoke ? chainPassed : passed)) process.exitCode = cancelled ? 130 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      'benchmark spike failed; no provider diagnostics printed\n',
    );
    process.exitCode = 1;
  });
