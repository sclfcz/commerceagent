import type { Candidate } from './contracts.js';

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
