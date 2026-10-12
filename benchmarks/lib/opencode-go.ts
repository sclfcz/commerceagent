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
  // Only documented Messages API models; no protocol conversion or SDK bypass.
  const model = existing.some((c) => /minimax/i.test(c.model))
    ? 'qwen3.8-flash'
    : 'minimax-m2.7';
  return {
    alias: 'candidate-go',
    model,
    baseUrl: 'https://opencode.ai/zen/go',
    apiKeyEnv: 'BENCH_OPENCODE_GO_API_KEY',
    gateway: true,
  };
}
