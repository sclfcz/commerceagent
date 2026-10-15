import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewFailures } from '../lib/failure-review.js';
const directory = process.argv[2];
if (!directory) throw new Error('usage: bench:review RUN_DIRECTORY');
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const candidates = [
  path.resolve(repositoryRoot, directory),
  path.resolve(directory),
];
const runDirectory = candidates.find((candidate) => fs.existsSync(candidate));
if (!runDirectory) throw new Error('run_directory_not_found');
void reviewFailures(runDirectory)
  .then(({ file, report }) => {
    process.stdout.write(
      JSON.stringify({
        runId: report.runId,
        attempts: report.attempts,
        businessPassedAttempts: report.businessPassedAttempts,
        failedAttempts: report.failedAttempts,
        categories: report.categories,
        stage4ReviewPassed: report.stage4ReviewPassed,
        artifact: path.basename(file),
        modelCalls: 0,
      }) + '\n',
    );
  })
  .catch(() => {
    process.stderr.write(
      'Failure review could not establish evidence; inspect private run files\n',
    );
    process.exitCode = 1;
  });
