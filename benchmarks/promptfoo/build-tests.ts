import { rotateCandidates } from '../lib/assessment.js';
import {
  renderCasePrompt,
  type Candidate,
  type SpikeCase,
} from '../lib/contracts.js';

export interface BenchmarkTestRow {
  vars: {
    prompt: string;
    caseId: string;
    repetition: string;
    candidateAlias: string;
    expectedExecutionIndex: string;
  };
  metadata: {
    caseId: string;
    repetition: number;
    candidateAlias: string;
    expectedExecutionIndex: number;
  };
}

export function buildTests(
  cases: SpikeCase[],
  candidates: Candidate[],
  repetitions = 3,
): BenchmarkTestRow[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new Error('invalid_repetitions');
  if (!cases.length || !candidates.length) throw new Error('empty_matrix');
  const rows: BenchmarkTestRow[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const test = cases[caseIndex];
      for (const candidate of rotateCandidates(
        candidates,
        caseIndex,
        repetition,
      )) {
        const expectedExecutionIndex = rows.length + 1;
        rows.push({
          vars: {
            prompt: renderCasePrompt(test),
            caseId: test.id,
            repetition: String(repetition + 1),
            candidateAlias: candidate.alias,
            expectedExecutionIndex: String(expectedExecutionIndex),
          },
          metadata: {
            caseId: test.id,
            repetition: repetition + 1,
            candidateAlias: candidate.alias,
            expectedExecutionIndex,
          },
        });
      }
    }
  }
  return rows;
}

export interface ExecutionIdentity {
  caseId: string;
  repetition: number;
  candidateAlias: string;
  executionIndex: number;
}

export function validateExecutionOrder(
  expected: ExecutionIdentity[],
  actual: ExecutionIdentity[],
): { valid: boolean; mismatchIndex: number | null } {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (
      !left ||
      !right ||
      left.caseId !== right.caseId ||
      left.repetition !== right.repetition ||
      left.candidateAlias !== right.candidateAlias ||
      left.executionIndex !== right.executionIndex
    )
      return { valid: false, mismatchIndex: index + 1 };
  }
  return { valid: true, mismatchIndex: null };
}

export function validateAdapterParity(
  attempts: Array<Record<string, any>>,
  promptfooResults: Array<Record<string, any>>,
): { valid: boolean; mismatchIndex: number | null } {
  const fields = [
    'candidate',
    'caseId',
    'repetition',
    'measurementValid',
    'qualityEligible',
    'pass',
    'measurementFailure',
    'businessFailure',
    'failure',
    'businessPass',
    'gatewayVerificationRequired',
    'identityBasis',
    'gates',
  ];
  const length = Math.max(attempts.length, promptfooResults.length);
  for (let index = 0; index < length; index++) {
    const attempt = attempts[index];
    const provider = promptfooResults[index]?.response?.metadata;
    if (!attempt || !provider)
      return { valid: false, mismatchIndex: index + 1 };
    if (
      fields.some(
        (field) =>
          JSON.stringify(attempt[field] ?? null) !==
          JSON.stringify(provider[field] ?? null),
      )
    )
      return { valid: false, mismatchIndex: index + 1 };
  }
  return { valid: true, mismatchIndex: null };
}
