import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertBusinessCase, loadBusinessCases } from '../lib/cases.js';
import { hash } from '../lib/contracts.js';
const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('run_directory_required');
const sha = (p: string) =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const summaryFile = path.join(directory, 'summary.json');
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
const cases = loadBusinessCases('dev');
const used = JSON.parse(
  fs.readFileSync(path.join(directory, 'cases.used.json'), 'utf8'),
);
const codeFiles = [
  '../lib/cases.ts',
  '../lib/date-range.ts',
  '../lib/contracts.ts',
];
const codeHash = hash(
  codeFiles.map((p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')),
);
const rows = [];
for (const row of summary.results) {
  const test = cases.find((c) => c.id === row.caseId);
  if (!test) continue;
  const dir = path.join(
    directory,
    `promptfoo-${String(row.executionIndex).padStart(4, '0')}`,
  );
  const tf = path.join(dir, 'trace.json'),
    lf = path.join(dir, 'fixture.jsonl'),
    ff = path.join(dir, 'fixture-snapshot.json'),
    sf = path.join(dir, 'fixture-state.json');
  const trace = JSON.parse(fs.readFileSync(tf, 'utf8'));
  const ledger = fs
    .readFileSync(lf, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const fixture = JSON.parse(fs.readFileSync(ff, 'utf8'));
  const state = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const result = assertBusinessCase(
    trace.output,
    test,
    fixture,
    ledger,
    trace.tools,
    state,
  );
  rows.push({
    caseId: test.id,
    executionIndex: row.executionIndex,
    contractChanged:
      hash(test) !== hash(used.find((c: any) => c.id === test.id)),
    oldBusinessPass: row.businessPass,
    newBusinessPass: result.pass,
    oldChecks: row.businessChecks,
    newChecks: result.checks,
    sourceHashes: {
      trace: sha(tf),
      ledger: sha(lf),
      fixture: sha(ff),
      state: sha(sf),
      originalResult: sha(path.join(dir, 'result.json')),
    },
  });
}
const report = {
  schemaVersion: 1,
  runId: path.basename(directory),
  scope:
    'diagnostic assertion regrade; revised task was not shown to historical candidate; never use for ranking or model failure attribution',
  modelCalls: 0,
  originalSummaryHash: sha(summaryFile),
  assertionCodeHash: codeHash,
  currentCaseHashes: Object.fromEntries(cases.map((c) => [c.id, hash(c)])),
  oldPassed: rows.filter((x) => x.oldBusinessPass).length,
  regradedPassed: rows.filter((x) => x.newBusinessPass).length,
  rows,
};
const out = path.join(
  directory,
  `business.regraded.${codeHash.slice(0, 12)}.json`,
);
if (!fs.existsSync(out))
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
console.log(
  JSON.stringify({
    runId: report.runId,
    oldPassed: report.oldPassed,
    regradedPassed: report.regradedPassed,
    modelCalls: 0,
    diagnosticOnly: true,
    artifact: path.basename(out),
  }),
);
