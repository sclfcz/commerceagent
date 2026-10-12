import { requiresGatewayAudit } from './identity.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Failure =
  | 'audit_mismatch'
  | 'state_not_fresh'
  | 'tool_policy_violation'
  | 'business_assertion'
  | 'upstream_error'
  | 'queue_timeout'
  | 'run_timeout'
  | 'stream_disconnected'
  | 'runner_exit'
  | 'stopped'
  | 'released'
  | 'collection_incomplete'
  | 'model_identity'
  | 'context_mismatch'
  | 'environment';
export interface Candidate {
  alias: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  gatewayDeclared: boolean;
  gateway: boolean;
  credentialKind?: 'apiKey' | 'authToken';
}
export interface ToolCall {
  sequence: number;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
}
export interface SpikeCase {
  id: string;
  scenario: 'normal' | 'empty' | 'conflict' | 'injection';
  prompt: string;
  expected: {
    status: string;
    facts: Record<string, unknown>;
    evidence: string[];
  };
  requiredTools: Array<{ name: string; arguments: Record<string, unknown> }>;
  maxCalls: number;
}
export function renderCasePrompt(test: SpikeCase): string {
  return `${test.prompt}\n本次任务工具调用总上限：${test.maxCalls} 次。evidence 数组使用工具结果中的完整 evidence_id。`;
}
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  durationMs: number;
  eventCount: number;
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function privateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function workspaceBaseline(directory: string): string {
  const files: Array<{ path: string; hash: string }> = [];
  const visit = (folder: string) => {
    for (const entry of fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('workspace_symlink');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        files.push({
          path: path.relative(directory, file),
          hash: hash(fs.readFileSync(file, 'utf8')),
        });
    }
  };
  visit(directory);
  return hash(files);
}

export function candidateEnvironment(
  candidate: Candidate,
): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: candidate.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: candidate.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: candidate.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: candidate.model,
    ANTHROPIC_SMALL_FAST_MODEL: candidate.model,
    CLAUDE_CODE_SUBAGENT_MODEL: candidate.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
  };
}

export function parseCandidates(input: unknown): Candidate[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error('candidate_config');
  const aliases = new Set<string>();
  return input.map((raw: Record<string, unknown>) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.alias !== 'string' ||
      !/^candidate-[a-z0-9]+$/.test(raw.alias) ||
      aliases.has(raw.alias)
    )
      throw new Error('candidate_config');
    if (
      typeof raw.model !== 'string' ||
      !raw.model.trim() ||
      typeof raw.baseUrl !== 'string' ||
      typeof raw.apiKeyEnv !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(raw.apiKeyEnv) ||
      typeof raw.gateway !== 'boolean'
    )
      throw new Error('candidate_config');
    const url = new URL(raw.baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('candidate_config');
    aliases.add(raw.alias);
    if (
      raw.credentialKind !== undefined &&
      raw.credentialKind !== 'apiKey' &&
      raw.credentialKind !== 'authToken'
    )
      throw new Error('candidate_config');
    return {
      alias: raw.alias,
      model: raw.model,
      baseUrl: raw.baseUrl,
      apiKeyEnv: raw.apiKeyEnv,
      gatewayDeclared:
        typeof raw.gatewayDeclared === 'boolean'
          ? raw.gatewayDeclared
          : raw.gateway,
      gateway: requiresGatewayAudit(
        raw.baseUrl,
        typeof raw.gatewayDeclared === 'boolean'
          ? raw.gatewayDeclared
          : raw.gateway,
        raw.model,
      ),
      ...(raw.credentialKind ? { credentialKind: raw.credentialKind } : {}),
    };
  });
}
