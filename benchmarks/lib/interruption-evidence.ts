import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateJson } from './contracts.js';

const evidenceFiles = [
  'trace.json',
  'context-evidence.json',
  'fresh-state.json',
  'service/data-eval/db/messages.db',
  'fixture.jsonl',
  'fixture-snapshot.json',
  'fixture-state.json',
] as const;

export type InterruptedFailure =
  | 'environment'
  | 'context_mismatch'
  | 'collection_incomplete';

export interface InterruptionEvidence {
  schemaVersion: 1;
  candidate: string;
  caseId: string;
  executionIndex: number | null;
  failure: InterruptedFailure;
  stage: string;
  turnObserved: boolean;
  errorName: string;
  errorCode: string | null;
  files: Record<string, string | null>;
}

const fileHash = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function executionIndexFor(directory: string): number | null {
  const match = /^promptfoo-(\d+)$/.exec(path.basename(directory));
  return match ? Number(match[1]) : null;
}

export function persistInterruptionEvidence(input: {
  directory: string;
  candidate: string;
  caseId: string;
  failure: InterruptedFailure;
  stage: string;
  turnObserved: boolean;
  error: unknown;
}): InterruptionEvidence {
  const error = input.error as { name?: unknown; code?: unknown } | null;
  const constructorName =
    input.error && typeof input.error === 'object'
      ? input.error.constructor?.name
      : undefined;
  const rawName =
    typeof error?.name === 'string' && error.name !== 'Error'
      ? error.name
      : (constructorName ?? error?.name);
  const safeName =
    typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(rawName)
      ? rawName
      : 'UnknownError';
  const safeCode =
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : null;
  const evidence: InterruptionEvidence = {
    schemaVersion: 1,
    candidate: input.candidate,
    caseId: input.caseId,
    executionIndex: executionIndexFor(input.directory),
    failure: input.failure,
    stage: input.stage,
    turnObserved: input.turnObserved,
    errorName: safeName,
    errorCode: safeCode,
    files: Object.fromEntries(
      evidenceFiles.map((relative) => {
        const file = path.join(input.directory, relative);
        return [relative, fs.existsSync(file) ? fileHash(file) : null];
      }),
    ),
  };
  privateJson(path.join(input.directory, 'interruption.json'), evidence);
  return evidence;
}

export function verifyInterruptionEvidence(input: {
  directory: string;
  candidate: string;
  caseId: string;
  executionIndex: number;
}): InterruptionEvidence | null {
  const file = path.join(input.directory, 'interruption.json');
  if (!fs.existsSync(file)) return null;
  let evidence: InterruptionEvidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.candidate !== input.candidate ||
    evidence.caseId !== input.caseId ||
    evidence.executionIndex !== input.executionIndex ||
    !['environment', 'context_mismatch', 'collection_incomplete'].includes(
      evidence.failure,
    ) ||
    typeof evidence.stage !== 'string' ||
    typeof evidence.turnObserved !== 'boolean' ||
    !evidence.files ||
    Object.keys(evidence.files).sort().join('|') !==
      [...evidenceFiles].sort().join('|')
  )
    return null;
  if (
    (evidence.failure === 'collection_incomplete' && !evidence.turnObserved) ||
    (evidence.failure === 'environment' && evidence.turnObserved) ||
    (evidence.failure === 'context_mismatch') !==
      (evidence.errorName === 'ContextFailure')
  )
    return null;
  for (const relative of evidenceFiles) {
    const current = path.join(input.directory, relative);
    const expectedHash = evidence.files[relative];
    if (expectedHash === null) {
      if (fs.existsSync(current)) return null;
    } else if (!fs.existsSync(current) || fileHash(current) !== expectedHash) {
      return null;
    }
  }
  return evidence;
}
