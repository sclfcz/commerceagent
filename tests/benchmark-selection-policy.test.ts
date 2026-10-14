import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadCommittedSelectionPolicy,
  validateSelectionPolicy,
} from '../benchmarks/lib/selection-policy.js';

const confirmedPolicy = {
  schema_version: 1,
  status: 'confirmed',
  selection_object: 'candidate model',
  primary_metric: 'businessPass rate',
  constraints: ['verified identity', 'measurement ineligible rate <= 10%'],
  tie_break_rule: 'lower known cost per successful task, then lower p95',
  multiple_comparisons: { method: 'holm', primary_comparison: '' },
  confirmed_by: 'benchmark owner',
  confirmed_at: '2026-10-14',
};

describe('selection policy confirmation gate', () => {
  it('rejects the checked-in unconfirmed template', () => {
    expect(
      validateSelectionPolicy({ ...confirmedPolicy, status: 'template' }),
    ).toMatchObject({
      valid: false,
      reason: 'selection_policy_unconfirmed',
    });
  });

  it('accepts a complete confirmed policy using Holm correction', () => {
    expect(validateSelectionPolicy(confirmedPolicy)).toMatchObject({
      valid: true,
      reason: null,
    });
  });

  it('requires a named contrast when only one comparison is predeclared', () => {
    expect(
      validateSelectionPolicy({
        ...confirmedPolicy,
        multiple_comparisons: {
          method: 'single_primary',
          primary_comparison: '',
        },
      }),
    ).toMatchObject({
      valid: false,
      reason: 'selection_policy_multiplicity_invalid',
    });
  });

  it('blocks a confirmed but uncommitted policy and binds a committed policy to HEAD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-policy-'));
    const benchmarkDirectory = path.join(root, 'benchmarks');
    fs.mkdirSync(benchmarkDirectory);
    const policyPath = path.join(benchmarkDirectory, 'selection-policy.yaml');
    fs.writeFileSync(policyPath, JSON.stringify(confirmedPolicy));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'add',
        'benchmarks/selection-policy.yaml',
      ],
      { cwd: root },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'selection policy',
      ],
      { cwd: root },
    );
    expect(
      loadCommittedSelectionPolicy(benchmarkDirectory, root).policy.status,
    ).toBe('confirmed');
    fs.writeFileSync(
      policyPath,
      JSON.stringify({ ...confirmedPolicy, primary_metric: 'changed' }),
    );
    expect(() =>
      loadCommittedSelectionPolicy(benchmarkDirectory, root),
    ).toThrow('selection_policy_must_be_committed');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
