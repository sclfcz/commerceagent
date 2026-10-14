import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { hash } from './contracts.js';

export interface SelectionPolicy {
  schema_version: 1;
  status: 'template' | 'confirmed';
  selection_object: string;
  primary_metric: string;
  constraints: string[];
  tie_break_rule: string;
  multiple_comparisons: {
    method: 'holm' | 'single_primary';
    primary_comparison: string;
  };
  confirmed_by: string;
  confirmed_at: string;
}

export function validateSelectionPolicy(input: unknown): {
  valid: boolean;
  reason: string | null;
  policy?: SelectionPolicy;
} {
  if (!input || typeof input !== 'object')
    return { valid: false, reason: 'selection_policy_shape' };
  const policy = input as Partial<SelectionPolicy>;
  if (policy.schema_version !== 1)
    return { valid: false, reason: 'selection_policy_version' };
  if (policy.status !== 'confirmed')
    return { valid: false, reason: 'selection_policy_unconfirmed' };
  if (
    !policy.selection_object?.trim() ||
    !policy.primary_metric?.trim() ||
    !Array.isArray(policy.constraints) ||
    policy.constraints.length === 0 ||
    policy.constraints.some(
      (entry) => typeof entry !== 'string' || !entry.trim(),
    ) ||
    !policy.tie_break_rule?.trim()
  )
    return { valid: false, reason: 'selection_policy_fields_missing' };
  if (
    !policy.multiple_comparisons ||
    !['holm', 'single_primary'].includes(policy.multiple_comparisons.method) ||
    (policy.multiple_comparisons.method === 'single_primary' &&
      !policy.multiple_comparisons.primary_comparison?.trim())
  )
    return { valid: false, reason: 'selection_policy_multiplicity_invalid' };
  if (
    !policy.confirmed_by?.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(policy.confirmed_at || '') ||
    Number.isNaN(Date.parse(`${policy.confirmed_at}T00:00:00Z`))
  )
    return { valid: false, reason: 'selection_policy_confirmation_missing' };
  return { valid: true, reason: null, policy: policy as SelectionPolicy };
}

export function loadCommittedSelectionPolicy(
  benchmarkDirectory: string,
  repository = path.dirname(benchmarkDirectory),
  gitHead?: string,
) {
  const file = path.join(benchmarkDirectory, 'selection-policy.yaml');
  if (!fs.existsSync(file)) throw new Error('selection_policy_missing');
  const validation = validateSelectionPolicy(
    parse(fs.readFileSync(file, 'utf8')),
  );
  if (!validation.valid)
    throw new Error(validation.reason || 'selection_policy_invalid');
  try {
    execFileSync(
      'git',
      ['ls-files', '--error-unmatch', 'benchmarks/selection-policy.yaml'],
      {
        cwd: repository,
        stdio: 'ignore',
      },
    );
    execFileSync(
      'git',
      ['diff', '--quiet', 'HEAD', '--', 'benchmarks/selection-policy.yaml'],
      {
        cwd: repository,
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error('selection_policy_must_be_committed');
  }
  let commit = gitHead;
  if (!commit)
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  return {
    policy: validation.policy!,
    hash: hash(validation.policy),
    commit,
  };
}
