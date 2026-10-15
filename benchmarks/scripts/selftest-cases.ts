import { loadBusinessCases, loadAllBusinessCases } from '../lib/cases.js';
import { selfTestReferences } from '../lib/reference-answers.js';
const split = process.argv.includes('--all') ? 'all-offline' : 'dev';
void selfTestReferences(
  split === 'dev' ? loadBusinessCases('dev') : loadAllBusinessCases(),
)
  .then((summary) => {
    process.stdout.write(
      JSON.stringify({ split, ...summary, realModelCalls: 0 }) + '\n',
    );
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'case_selftest_failed'}\n`,
    );
    process.exitCode = 1;
  });
