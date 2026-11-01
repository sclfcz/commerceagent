import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewFailures } from '../lib/failure-review.js';

export async function runFailureReview(args = process.argv.slice(2)) {
  const [directory, flag, adjudicationsFile, ...extra] = args;
  if (
    !directory ||
    extra.length ||
    (flag !== undefined && (flag !== '--adjudications' || !adjudicationsFile))
  )
    throw new Error('failure_review_usage');
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const candidates = [
    path.resolve(repositoryRoot, directory),
    path.resolve(directory),
    path.resolve(repositoryRoot, 'benchmarks/results', directory),
  ];
  const runDirectory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!runDirectory) throw new Error('failure_review_run_not_found');
  return reviewFailures(runDirectory, { adjudicationsFile });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void runFailureReview()
    .then(({ file, report }) => {
      process.stdout.write(
        JSON.stringify({
          attempts: report.attempts,
          reviewedAttempts: report.reviewedAttempts,
          businessFailedAttempts: report.businessFailedAttempts,
          businessVerdictChangedAttempts: report.businessVerdictChangedAttempts,
          recordedCheckDisagreementAttempts:
            report.recordedCheckDisagreementAttempts,
          categories: report.categories,
          unresolvedAttempts: report.unresolvedAttempts,
          causalReviewComplete: report.causalReviewComplete,
          stage4ReviewPassed: report.stage4ReviewPassed,
          artifact: path.basename(file),
          modelCalls: 0,
        }) + '\n',
      );
    })
    .catch((error: unknown) => {
      const code =
        error instanceof Error && /^failure_review_[a-z_]+$/.test(error.message)
          ? error.message
          : 'failure_review_evidence_check_failed';
      process.stderr.write(
        `${code}: inspect the private evidence and adjudication template; no model requests were made.\n`,
      );
      process.exitCode = 1;
    });
