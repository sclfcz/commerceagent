import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import {
  assertBusinessCase,
  loadBusinessCases,
  parseFixtureVariant,
  evaluateOracle,
  resolveEvidence,
  parseBusinessOutput,
  type BusinessCase,
  type FixtureState,
  type FixtureVariant,
} from './cases.js';
import { executeReference, loadReferenceAnswers } from './reference-answers.js';
import { hash, type ToolCall } from './contracts.js';
import { definitionsForFixture } from '../mcp-fixture-server/server.js';
import { reassessPromptfoo } from './reassess-promptfoo.js';
import { validatePublicSummary } from './public-report.js';
import {
  diagnoseAttribution,
  diagnoseChecks,
  applyAdjudication,
  summarizeAttributions,
  type AttributionEvidence,
} from './failure-attribution.js';
import {
  readReviewArtifact,
  readAdjudications,
  writeImmutableReview,
  safeArtifactPath,
} from './failure-review-artifacts.js';
const shaFile = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function replayFixtureLedger(
  test: BusinessCase,
  ledger: ToolCall[],
  expectedState: FixtureState,
) {
  const fixture = parseFixtureVariant(test.fixture_variant);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'commerce-fixture-review-'),
  );
  const server = await startFixtureServer({
    data: fixture.data as Record<string, any> & { version: string | number },
    scenario: 'normal',
    variantConfig: fixture.config,
    includeWorkflowWrites: test.tags.includes('write-operation'),
    ledgerFile: path.join(directory, 'fixture.jsonl'),
  });
  try {
    for (const [index, call] of ledger.entries()) {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`,
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name: call.name, arguments: call.arguments },
        }),
      });
      if (!response.ok)
        return {
          matches: false,
          mismatchIndexes: [index + 1],
          stateMatches: false,
        };
      await response.json();
    }
    const mismatchIndexes = ledger.flatMap((call, index) => {
      const replay = server.ledger[index];
      return replay &&
        replay.name === call.name &&
        isDeepStrictEqual(replay.arguments, call.arguments) &&
        isDeepStrictEqual(replay.result, call.result) &&
        replay.success === call.success &&
        (call.isError === undefined || replay.isError === call.isError)
        ? []
        : [index + 1];
    });
    const stateMatches = isDeepStrictEqual(server.state, expectedState);
    return {
      matches: !mismatchIndexes.length && stateMatches,
      mismatchIndexes,
      stateMatches,
    };
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function businessFailureDetails(
  test: BusinessCase,
  output: string,
  ledger: ToolCall[],
  state: FixtureState,
  savedFixture?: FixtureVariant,
) {
  let response: Record<string, any> | null = null;
  response = parseBusinessOutput(output).answer;
  const fixture = savedFixture ?? parseFixtureVariant(test.fixture_variant);
  const actualFacts =
    response?.facts && typeof response.facts === 'object' ? response.facts : {};
  const factDifferences = Object.entries(test.expected.facts).flatMap(
    ([field, expectation]) => {
      const expected = evaluateOracle(expectation.oracle, fixture);
      const actual = actualFacts[field];
      const value =
        actual && typeof actual === 'object' ? actual.value : actual;
      const unit =
        expectation.unit ??
        (expectation.unit_from
          ? fixture.data[expectation.unit_from.collection]?.find(
              (row: Record<string, any>) =>
                row[expectation.unit_from!.key] ===
                expectation.unit_from!.value,
            )?.[expectation.unit_from.field]
          : undefined);
      const valueMatches =
        typeof expected === 'number'
          ? typeof value === 'number' &&
            Math.abs(value - expected) <= (expectation.tolerance ?? 0)
          : isDeepStrictEqual(expected, value);
      if (
        Object.hasOwn(actualFacts, field) &&
        valueMatches &&
        (unit === undefined
          ? !actual || typeof actual !== 'object' || !('unit' in actual)
          : actual?.unit === unit)
      )
        return [];
      return [
        {
          field,
          missing: !Object.hasOwn(actualFacts, field),
          expected,
          actual: actual ?? null,
          expectedUnit: unit ?? null,
        },
      ];
    },
  );
  const evidence = Array.isArray(response?.evidence) ? response.evidence : [];
  const expectedEvidence = test.expected.evidence_required.map((item) =>
    resolveEvidence(item, fixture),
  );
  return {
    jsonParsed: response !== null,
    status: {
      expected: test.expected.status,
      actual: response?.status ?? null,
    },
    factDifferences,
    missingEvidence: expectedEvidence.filter((id) => !evidence.includes(id)),
    actualEvidence: evidence,
    toolCalls: ledger.map((call) => ({
      name: call.name,
      arguments: call.arguments,
      acceptedArguments: call.success,
      isError:
        call.isError ??
        (!!call.result &&
          typeof call.result === 'object' &&
          'error' in call.result),
      resultSummary: summarizeToolResult(call.result),
    })),
    callLimit: { actual: ledger.length, maximum: test.tools.max_calls },
    answerLength: {
      actual:
        typeof response?.answer === 'string'
          ? Array.from(response.answer).length
          : 0,
      maximum: test.instructions.max_answer_chars ?? null,
    },
    finalState: state,
    expectedState: test.expected.state ?? { refund_requests: [], handoffs: [] },
  };
}

function summarizeToolResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return { type: result === null ? 'null' : typeof result };
  const value = result as Record<string, unknown>;
  if (typeof value.error === 'string')
    return { error: value.error, fields: Object.keys(value).sort() };
  const collections = Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => Array.isArray(child))
      .map(([key, rows]) => {
        const list = rows as Array<unknown>;
        const evidenceIds = new Set<string>();
        const collect = (item: unknown) => {
          if (Array.isArray(item)) item.forEach(collect);
          else if (item && typeof item === 'object')
            for (const [field, child] of Object.entries(item))
              if (field === 'evidence_id' && typeof child === 'string')
                evidenceIds.add(child);
              else collect(child);
        };
        collect(list);
        return [key, { rowCount: list.length, evidenceIds: [...evidenceIds] }];
      }),
  );
  return { fields: Object.keys(value).sort(), collections };
}

export interface FailureReviewOptions {
  /** Completed copy of the generated template, kept inside this private run. */
  adjudicationsFile?: string;
}

export function recordedBusinessChecks(result: Record<string, any> | null) {
  const values = ['business', 'businessChecks']
    .filter((key) => result && Object.hasOwn(result, key))
    .map((key) => result![key]);
  if (
    !values.length ||
    values.some(
      (value) =>
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some(
          (check) => check !== null && typeof check !== 'boolean',
        ),
    ) ||
    values.some((value) => !isDeepStrictEqual(value, values[0]))
  )
    return null;
  return values[0] as Record<string, boolean | null>;
}

interface FailureObservation extends Record<string, unknown> {
  candidate: string;
  caseId: string;
  executionIndex: number;
  observedBusinessPass: boolean | null;
  recordedBusinessVerdictMatches: boolean | null;
  recordedCheckStatesMatch: boolean | null;
  diagnostics: ReturnType<typeof diagnoseChecks>;
  evidence: AttributionEvidence;
  automatedDiagnosis: ReturnType<typeof diagnoseAttribution>;
}

export async function reviewFailures(
  runDirectory: string,
  options: FailureReviewOptions = {},
) {
  const summarySource = readReviewArtifact(runDirectory, 'summary.json');
  const summary = summarySource.data as Record<string, any> | null;
  if (summarySource.error || !summary || !Array.isArray(summary.results))
    throw new Error('failure_review_summary_invalid');
  // Reject before loading any case/reference sources or invoking reassessment.
  if (summary.split !== 'dev') throw new Error('failure_review_dev_only');
  const codeHashes = Object.fromEntries(
    [
      './failure-review.ts',
      './failure-attribution.ts',
      './failure-review-artifacts.ts',
      './cases.ts',
      './reference-answers.ts',
      './reassess-promptfoo.ts',
      '../mcp-fixture-server/server.ts',
    ].map((file) => [
      file,
      shaFile(fileURLToPath(new URL(file, import.meta.url))),
    ]),
  );
  const caseSource = readReviewArtifact(runDirectory, 'cases.used.json');
  const used = caseSource.data as BusinessCase[] | null;
  if (
    caseSource.error ||
    !Array.isArray(used) ||
    used.some(
      (test) => test?.split !== 'dev' || typeof test?.id !== 'string',
    ) ||
    new Set(used.map((test) => test.id)).size !== used.length
  )
    throw new Error('failure_review_cases_invalid');
  const indexes = new Set<number>();
  for (const row of summary.results) {
    if (
      !row ||
      !Number.isSafeInteger(row.executionIndex) ||
      row.executionIndex < 1 ||
      indexes.has(row.executionIndex) ||
      typeof row.candidate !== 'string' ||
      typeof row.caseId !== 'string'
    )
      throw new Error('failure_review_attempt_identity_invalid');
    indexes.add(row.executionIndex);
  }
  const selftestSource = readReviewArtifact(runDirectory, 'case-selftest.json');
  const candidatesSource = readReviewArtifact(runDirectory, 'candidates.json');
  const privateCandidates = candidatesSource.data as Array<{
    alias: string;
    model: string;
    baseUrl: string;
  }> | null;
  if (
    candidatesSource.error ||
    !Array.isArray(privateCandidates) ||
    privateCandidates.some(
      (candidate) =>
        !candidate ||
        ![candidate.alias, candidate.model, candidate.baseUrl].every(
          (field) => typeof field === 'string',
        ),
    )
  )
    throw new Error('failure_review_candidates_invalid');
  if (
    new Set(privateCandidates!.map((candidate) => candidate.alias)).size !==
    privateCandidates!.length
  )
    throw new Error('failure_review_candidates_invalid');

  let independent: ReturnType<typeof reassessPromptfoo> | null = null;
  try {
    // Read original evidence again, never trust summary.measurementValid and
    // never overwrite the historical reassessed.json as a side effect.
    independent = reassessPromptfoo(runDirectory, { persist: false });
  } catch {
    // Missing historical evidence blocks causal conclusions, not the entire report.
    independent = null;
  }
  const independentRows = new Map(
    (independent?.results ?? []).map((row) => [
      Number(row.executionIndex),
      row as Record<string, any>,
    ]),
  );
  if (
    independent &&
    (independentRows.size !== independent.results.length ||
      independent.results.some(
        (row) =>
          !Number.isSafeInteger(row.executionIndex) ||
          row.executionIndex < 1 ||
          typeof row.candidate !== 'string' ||
          typeof row.caseId !== 'string',
      ))
  )
    throw new Error('failure_review_independent_identity_invalid');
  const summaryCoverageVerified =
    independent !== null &&
    independentRows.size === indexes.size &&
    summary.results.every((row: Record<string, any>) => {
      const observed = independentRows.get(row.executionIndex);
      return (
        observed?.caseId === row.caseId &&
        observed?.candidate === row.candidate &&
        observed?.repetition === row.repetition
      );
    });
  // A truncated or edited summary must not hide a failed attempt from review.
  const subjects: Array<Record<string, any>> = [...summary.results];
  for (const row of independentRows.values())
    if (!indexes.has(row.executionIndex))
      subjects.push({
        candidate: row.candidate,
        caseId: row.caseId,
        executionIndex: row.executionIndex,
        repetition: row.repetition,
        businessPass: null,
        measurementValid: null,
        businessChecks: null,
      });
  const current = loadBusinessCases('dev');
  const references = loadReferenceAnswers('dev');
  const observations: FailureObservation[] = [];
  const allArtifactHashes = new Map<string, string | null>();
  for (const row of subjects.sort(
    (left, right) => left.executionIndex - right.executionIndex,
  )) {
    const recomputed = independentRows.get(row.executionIndex);
    const reassessedSubjectMatches =
      recomputed?.caseId === row.caseId &&
      recomputed?.candidate === row.candidate &&
      recomputed?.repetition === row.repetition;
    const unchangedPassingAttempt =
      row.businessPass === true &&
      row.measurementValid === true &&
      reassessedSubjectMatches &&
      recomputed?.businessPass === true &&
      recomputed?.measurementValid === true &&
      isDeepStrictEqual(recomputed.businessChecks, row.businessChecks);

    const prefix = `promptfoo-${String(row.executionIndex).padStart(4, '0')}`;
    const files = [
      'trace.json',
      'fixture.jsonl',
      'fixture-state.json',
      'fixture-snapshot.json',
      'result.json',
    ];
    const artifacts = Object.fromEntries(
      files.map((name) => [
        name,
        readReviewArtifact(runDirectory, `${prefix}/${name}`),
      ]),
    );
    for (const name of files)
      allArtifactHashes.set(`${prefix}/${name}`, artifacts[name].sha256);
    const trace = artifacts['trace.json'].data as Record<string, any> | null;
    const ledger = artifacts['fixture.jsonl'].data as ToolCall[] | null;
    const state = artifacts['fixture-state.json'].data as FixtureState | null;
    const snapshot = artifacts['fixture-snapshot.json']
      .data as FixtureVariant | null;
    const savedResult = artifacts['result.json'].data as Record<
      string,
      any
    > | null;
    const recordedChecks = recordedBusinessChecks(savedResult);
    const test = current.find((item) => item.id === row.caseId);
    const saved = used.find((item) => item.id === row.caseId);
    const reference = references.find((item) => item.caseId === row.caseId);
    const errors = files
      .filter((name) => artifacts[name].error)
      .map((name) => ({
        artifact: `${prefix}/${name}`,
        code: artifacts[name].error,
      }));
    let caseMatches: boolean | null = null;
    let referencePass: boolean | null = null;
    let replay: Awaited<ReturnType<typeof replayFixtureLedger>> | null = null;
    let business: ReturnType<typeof assertBusinessCase> | null = null;
    let details: ReturnType<typeof businessFailureDetails> | null = null;
    let currentContractDetails: ReturnType<
      typeof businessFailureDetails
    > | null = null;
    let visibleSchemaHash: string | null = null;
    let emptyQueryCall = false;
    const traceValid =
      !!trace &&
      typeof trace.output === 'string' &&
      Array.isArray(trace.tools) &&
      trace.tools.every((tool: any) => tool && typeof tool.name === 'string');
    const ledgerValid =
      Array.isArray(ledger) &&
      ledger.every(
        (call, index) =>
          call &&
          typeof call.name === 'string' &&
          call.sequence === index + 1 &&
          typeof call.success === 'boolean' &&
          Object.hasOwn(call, 'result') &&
          call.arguments &&
          typeof call.arguments === 'object' &&
          !Array.isArray(call.arguments),
      );
    const stateValid =
      !!state &&
      Array.isArray(state.refund_requests) &&
      Array.isArray(state.handoffs);
    const resultSourceMatches =
      !!savedResult &&
      savedResult.candidate === row.candidate &&
      savedResult.caseId === row.caseId &&
      savedResult.repetition === row.repetition &&
      savedResult.output === trace?.output &&
      savedResult.caseHash === hash(saved) &&
      savedResult.fixtureHash === hash(snapshot);
    const sourceComplete =
      files.every((name) => !artifacts[name].error) &&
      !selftestSource.error &&
      traceValid &&
      ledgerValid &&
      stateValid &&
      !!saved &&
      !!snapshot?.data &&
      recordedChecks !== null &&
      resultSourceMatches;
    if (savedResult && !resultSourceMatches)
      errors.push({
        artifact: `${prefix}/result.json`,
        code: 'recorded_result_binding_mismatch',
      });
    if (!sourceComplete)
      errors.push({
        artifact: prefix,
        code: 'required_evidence_or_subject_invalid',
      });
    try {
      if (test) {
        const fixture = parseFixtureVariant(test.fixture_variant);
        visibleSchemaHash = hash(
          definitionsForFixture(
            test.tags.includes('write-operation'),
            fixture.data,
          ),
        );
        caseMatches =
          !!saved &&
          hash(test) === hash(saved) &&
          hash(snapshot) === hash(fixture) &&
          selftestSource.data?.caseHashes?.[test.id] === hash(test) &&
          savedResult?.toolSchemaHash === visibleSchemaHash;
        referencePass =
          !!reference &&
          (await executeReference(test, reference)).business.pass;
        if (ledgerValid && stateValid)
          replay = await replayFixtureLedger(test, ledger!, state!);
      }
      if (traceValid && ledgerValid && stateValid && saved && snapshot?.data) {
        business = assertBusinessCase(
          trace!.output,
          saved,
          snapshot,
          ledger!,
          trace!.tools,
          state!,
        );
        details = businessFailureDetails(
          saved,
          trace!.output,
          ledger!,
          state!,
          snapshot,
        );
        if (test)
          currentContractDetails = businessFailureDetails(
            test,
            trace!.output,
            ledger!,
            state!,
            snapshot,
          );
        emptyQueryCall = ledger!.some((call) => {
          if (
            !['search_policy', 'list_products'].includes(call.name) ||
            !call.success
          )
            return false;
          const rows = (call.result as Record<string, unknown>)?.[
            call.name === 'search_policy' ? 'policies' : 'products'
          ];
          return Array.isArray(rows) && rows.length === 0;
        });
      }
    } catch {
      errors.push({
        artifact: prefix,
        code: 'local_evidence_check_incomplete',
      });
    }
    const currentChecks = reassessedSubjectMatches
      ? recomputed?.businessChecks
      : null;
    const checks = currentChecks ?? business?.checks ?? {};
    const currentPass =
      reassessedSubjectMatches && typeof recomputed?.businessPass === 'boolean'
        ? (recomputed.businessPass as boolean)
        : null;
    const diagnostics = diagnoseChecks(checks, {
      outputParsed:
        traceValid && parseBusinessOutput(trace!.output).answer !== null,
      injectionApplicable:
        (currentChecks ? test : saved)?.tags?.includes('injection') === true,
    });
    const recordedCheckStatesMatch =
      currentChecks != null && recordedChecks !== null
        ? isDeepStrictEqual(currentChecks, row.businessChecks) &&
          isDeepStrictEqual(currentChecks, recordedChecks)
        : null;
    const recordedBusinessVerdictMatches =
      currentPass !== null &&
      typeof row.businessPass === 'boolean' &&
      typeof savedResult?.businessPass === 'boolean'
        ? currentPass === row.businessPass &&
          currentPass === savedResult.businessPass
        : null;
    const checksMatch =
      recordedCheckStatesMatch === true &&
      recordedBusinessVerdictMatches === true &&
      (caseMatches !== true ||
        (business !== null &&
          isDeepStrictEqual(business.checks, currentChecks) &&
          business.pass === currentPass));
    const evidence: AttributionEvidence = {
      sourceComplete: sourceComplete && errors.length === 0,
      independentAssessmentAvailable: !!independent && reassessedSubjectMatches,
      runIntegrityVerified:
        independent?.invalidRun === false && summaryCoverageVerified,
      caseMatches,
      referencePass,
      fixtureReplayMatches: replay?.matches ?? null,
      measurementValid:
        reassessedSubjectMatches &&
        typeof recomputed?.measurementValid === 'boolean'
          ? recomputed.measurementValid
          : null,
      recordedMeasurementMatches:
        reassessedSubjectMatches &&
        typeof row.measurementValid === 'boolean' &&
        typeof savedResult?.measurementValid === 'boolean'
          ? row.measurementValid === recomputed!.measurementValid &&
            savedResult!.measurementValid === recomputed!.measurementValid
          : null,
      checksMatch,
      fixtureDiscoverabilityFailure:
        emptyQueryCall && savedResult?.toolSchemaHash !== visibleSchemaHash,
    };
    const automatedDiagnosis = diagnoseAttribution(evidence);
    // A global run problem still blocks the run gate, but a verified passing
    // row does not acquire a causal failure merely because another row drifted.
    if (
      unchangedPassingAttempt &&
      business?.pass === true &&
      diagnoseAttribution({ ...evidence, runIntegrityVerified: true })
        .agentAttributionAllowed
    )
      continue;
    observations.push({
      candidate: row.candidate,
      caseId: row.caseId,
      repetition: row.repetition ?? null,
      executionIndex: row.executionIndex,
      observedBusinessPass: currentPass,
      recordedBusinessVerdictMatches,
      recordedCheckStatesMatch,
      diagnosticsBasis: currentChecks
        ? 'independent_current_contract'
        : 'saved_contract_only',
      savedContractPass: business?.pass ?? null,
      savedContractDiagnostics: business
        ? diagnoseChecks(business.checks, {
            outputParsed:
              traceValid && parseBusinessOutput(trace!.output).answer !== null,
            injectionApplicable: saved?.tags?.includes('injection') === true,
          })
        : null,
      diagnostics,
      evidence,
      evidenceErrors: errors,
      measurementFailure: reassessedSubjectMatches
        ? (recomputed?.measurementFailure ?? null)
        : null,
      automatedDiagnosis,
      savedContractDetails: details,
      currentContractDetails,
      sourceHashes: Object.fromEntries(
        files.map((name) => [`${prefix}/${name}`, artifacts[name].sha256]),
      ),
      derivedHashes: {
        currentCase: test ? hash(test) : null,
        reference: reference ? hash(reference) : null,
        currentVisibleToolSchema: visibleSchemaHash,
        independentResult: recomputed ? hash(recomputed) : null,
        replay: replay ? hash(replay) : null,
      },
    });
  }
  const pinnedSources = new Map<string, string | null>([
    ['summary.json', summarySource.sha256],
    ['cases.used.json', caseSource.sha256],
    ['case-selftest.json', selftestSource.sha256],
    ['candidates.json', candidatesSource.sha256],
  ]);
  for (const row of independentRows.values())
    for (const [relative, digest] of Object.entries(row.sourceHashes ?? {})) {
      const prefix = `promptfoo-${String(row.executionIndex).padStart(4, '0')}`;
      pinnedSources.set(`${prefix}/${relative}`, digest as string);
    }
  for (const [relative, digest] of allArtifactHashes) {
    if (pinnedSources.has(relative) && pinnedSources.get(relative) !== digest)
      throw new Error('failure_review_source_changed');
    pinnedSources.set(relative, digest);
  }
  const independentFiles: Record<string, string> = {
    executionSequence: 'execution-sequence.jsonl',
    order: 'execution-order.json',
    promptfooResults: 'promptfoo/results.json',
    candidateMatrix: 'candidates.json',
    runMetadata: 'run-metadata.json',
    cases: 'cases.used.json',
  };
  for (const [key, relative] of Object.entries(independentFiles))
    if (independent?.sourceHashes && key in independent.sourceHashes) {
      const digest = (independent.sourceHashes as Record<string, unknown>)[key];
      if (pinnedSources.has(relative) && pinnedSources.get(relative) !== digest)
        throw new Error('failure_review_source_changed');
      pinnedSources.set(relative, digest as string | null);
    }
  for (const [relative, digest] of pinnedSources) {
    const file = safeArtifactPath(runDirectory, relative);
    if ((fs.existsSync(file) ? shaFile(file) : null) !== digest)
      throw new Error('failure_review_source_changed');
  }
  for (const [file, digest] of Object.entries(codeHashes))
    if (shaFile(fileURLToPath(new URL(file, import.meta.url))) !== digest)
      throw new Error('failure_review_source_changed');
  const sourceHashes = {
    summary: summarySource.sha256,
    cases: caseSource.sha256,
    caseSelfTest: selftestSource.sha256,
    candidates: candidatesSource.sha256,
    independentAssessment: independent ? hash(independent) : null,
    artifacts: Object.fromEntries(
      [...pinnedSources.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  const evidenceRevision = hash({ codeHashes, sourceHashes, observations });
  const adjudications = options.adjudicationsFile
    ? readAdjudications(
        runDirectory,
        options.adjudicationsFile,
        evidenceRevision,
        observations,
      )
    : null;
  const reviews = observations.map((row) => ({
    ...row,
    attribution: applyAdjudication(
      row.automatedDiagnosis,
      row.diagnostics.failedChecks,
      adjudications?.decisions.get(row.executionIndex),
    ),
  }));
  const counts = summarizeAttributions(reviews);
  const revision = hash({
    evidenceRevision,
    adjudicationsHash: adjudications?.sha256 ?? null,
  });
  const report = {
    schemaVersion: 2,
    runId: path.basename(runDirectory),
    revision,
    evidenceRevision,
    codeHashes,
    sourceHashes,
    responseOutputFieldCopied: false,
    privateEvidenceFragmentsIncluded: true,
    modelCalls: 0,
    attempts: subjects.length,
    summaryCoverageVerified,
    reviewedAttempts: reviews.length,
    businessFailedAttempts: reviews.filter(
      (row) => row.observedBusinessPass === false,
    ).length,
    measurementInvalidAttempts: reviews.filter(
      (row) => row.evidence.measurementValid === false,
    ).length,
    measurementUnknownAttempts: reviews.filter(
      (row) => row.evidence.measurementValid === null,
    ).length,
    businessNotEvaluableAttempts: reviews.filter(
      (row) => row.observedBusinessPass === null,
    ).length,
    businessVerdictChangedAttempts: reviews.filter(
      (row) => row.recordedBusinessVerdictMatches === false,
    ).length,
    measurementVerdictChangedAttempts: reviews.filter(
      (row) => row.evidence.recordedMeasurementMatches === false,
    ).length,
    recordedCheckDisagreementAttempts: reviews.filter(
      (row) => row.recordedCheckStatesMatch === false,
    ).length,
    independentAssessment: {
      available: independent !== null,
      validRun: independent?.invalidRun === false,
      measurementValidAttempts: independent?.measurementValidAttempts ?? null,
      businessPassedAttempts: independent?.businessPassedAttempts ?? null,
    },
    ...counts,
    causalReviewComplete:
      counts.unresolvedAttempts === 0 && summaryCoverageVerified,
    // Compatibility field: unlike v1 it cannot pass from evaluator self-tests alone.
    stage4ReviewPassed:
      independent?.invalidRun === false &&
      summaryCoverageVerified &&
      independent.measurementValidityGate.passed === true &&
      reviews.every(
        (row) =>
          row.attribution.status === 'human_confirmed' &&
          row.attribution.category === 'agent_error',
      ),
    interpretation: {
      firstFailureLayerIsRootCause: false,
      automaticAgentAttribution: false,
      changesQualityMetrics: false,
      reportScope: 'dev_deterministic_failures_and_measurement_disagreements',
    },
    reviews,
  };
  const file = path.join(
    runDirectory,
    `failure-review.${revision.slice(0, 12)}.json`,
  );
  const templateFile = path.join(
    runDirectory,
    `failure-adjudications.${evidenceRevision.slice(0, 12)}.template.json`,
  );
  const publicFile = path.join(
    runDirectory,
    `failure-review.${revision.slice(0, 12)}.public.md`,
  );
  const publicMarkdown = [
    '# Failure attribution review',
    '',
    'Observed failures and suspected causes are distinct. Automated checks never confirm an Agent root cause.',
    'This diagnostic report does not change task scores, quality denominators, or ranking.',
    '',
    `Reviewed attempts: ${reviews.length}; human-reviewed: ${counts.humanReviewedAttempts}; human-confirmed: ${counts.confirmedAttempts}; unresolved: ${counts.unresolvedAttempts}; unresolved evidence-blocked: ${counts.evidenceBlockedAttempts}.`,
    `Observed business failures: ${report.businessFailedAttempts}; business verdicts unavailable: ${report.businessNotEvaluableAttempts}; invalid measurements: ${report.measurementInvalidAttempts}; unknown measurements: ${report.measurementUnknownAttempts}; changed business verdicts: ${report.businessVerdictChangedAttempts}; changed measurement verdicts: ${report.measurementVerdictChangedAttempts}; check-state disagreements: ${report.recordedCheckDisagreementAttempts}. Reviewed attempts include disagreements and are not a failure-rate denominator.`,
    '',
    '| Attribution category (unresolved is not confirmed) | Attempts |',
    '|---|---:|',
    ...Object.entries(counts.categories).map(
      ([category, count]) => `| ${category} | ${count} |`,
    ),
    '',
    'First observed failure layers use a fixed display order; they are not causal conclusions. All checks, including safety, are retained.',
    '',
    '| First observed layer | Attempts |',
    '|---|---:|',
    ...Object.entries(counts.firstObservedFailureLayers).map(
      ([layer, count]) => `| ${layer} | ${count} |`,
    ),
    '',
  ].join('\n');
  if (!validatePublicSummary(publicMarkdown, privateCandidates!).valid)
    throw new Error('failure_review_public_identity_leak');
  writeImmutableReview(file, JSON.stringify(report, null, 2) + '\n');
  writeImmutableReview(
    templateFile,
    JSON.stringify(
      {
        schemaVersion: 1,
        evidenceRevision,
        reviews: observations.map((row) => ({
          executionIndex: row.executionIndex,
          candidate: row.candidate,
          caseId: row.caseId,
          category: null,
          reviewer: '',
          rationale: '',
          evidence: [],
        })),
      },
      null,
      2,
    ) + '\n',
  );
  writeImmutableReview(publicFile, publicMarkdown);
  return { file, publicFile, templateFile, report };
}
