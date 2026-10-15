import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  persistInterruptionEvidence,
  verifyInterruptionEvidence,
} from '../benchmarks/lib/interruption-evidence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-interruption-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('verifies a minimal environment interruption without copying error text', () => {
  const directory = path.join(root, 'promptfoo-0041');
  fs.mkdirSync(path.join(directory, 'service/data-eval/db'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(directory, 'fixture.jsonl'), '');
  fs.writeFileSync(path.join(directory, 'fixture-snapshot.json'), '{}');
  fs.writeFileSync(path.join(directory, 'fixture-state.json'), '{}');
  fs.writeFileSync(
    path.join(directory, 'service/data-eval/db/messages.db'),
    'synthetic-db',
  );
  const evidence = persistInterruptionEvidence({
    directory,
    candidate: 'candidate-a',
    caseId: 'cp-action-07',
    failure: 'environment',
    stage: 'workspace_baseline',
    turnObserved: false,
    error: Object.assign(new Error('sensitive message'), { code: 'EIO' }),
  });
  expect(evidence.executionIndex).toBe(41);
  expect(evidence.errorCode).toBe('EIO');
  expect(JSON.stringify(evidence)).not.toContain('sensitive message');
  expect(
    verifyInterruptionEvidence({
      directory,
      candidate: 'candidate-a',
      caseId: 'cp-action-07',
      executionIndex: 41,
    }),
  ).toEqual(evidence);
  fs.writeFileSync(path.join(directory, 'trace.json'), '{}');
  expect(
    verifyInterruptionEvidence({
      directory,
      candidate: 'candidate-a',
      caseId: 'cp-action-07',
      executionIndex: 41,
    }),
  ).toBeNull();
});

test('only labels observed turns as collection interruptions', () => {
  const directory = path.join(root, 'promptfoo-0042');
  fs.mkdirSync(directory, { recursive: true });
  const evidence = persistInterruptionEvidence({
    directory,
    candidate: 'candidate-a',
    caseId: 'cp-action-08',
    failure: 'collection_incomplete',
    stage: 'post_turn_context',
    turnObserved: true,
    error: new Error('late response'),
  });
  expect(
    verifyInterruptionEvidence({
      directory,
      candidate: 'candidate-a',
      caseId: 'cp-action-08',
      executionIndex: 42,
    }),
  ).toEqual(evidence);
  expect(
    verifyInterruptionEvidence({
      directory,
      candidate: 'candidate-b',
      caseId: 'cp-action-08',
      executionIndex: 42,
    }),
  ).toBeNull();
});
