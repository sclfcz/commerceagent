import type { Candidate } from './contracts.js';
import { importOneTimeApiKey } from './local-credentials.js';

export function importOpenCodeGoKey(repository: string): boolean {
  return importOneTimeApiKey(
    repository,
    'opencode-go.local.json',
    'BENCH_OPENCODE_GO_API_KEY',
  );
}

export function openCodeGoCandidate(existing: Candidate[]): Candidate {
  // Lowest estimated cost for the observed benchmark usage mix among Go's
  // documented Anthropic Messages models; no protocol conversion or SDK bypass.
  const model = 'claude-haiku-5-5';
  if (existing.some((candidate) => candidate.model === model))
    throw new Error('opencode_go_model_already_in_candidate_matrix');
  return {
    alias: 'candidate-go',
    model,
    baseUrl: 'https://opencode.ai/inference/go',
    apiKeyEnv: 'BENCH_OPENCODE_GO_API_KEY',
    gatewayDeclared: true,
    gateway: true,
    billingRegion: 'global',
  };
}
