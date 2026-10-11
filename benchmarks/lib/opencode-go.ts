import type { Candidate } from './contracts.js';
import fs from 'node:fs';
import path from 'node:path';

export function importOpenCodeGoKey(repository: string): boolean {
  if (process.env.BENCH_OPENCODE_GO_API_KEY?.trim()) return true;
  const file = path.join(repository, 'benchmarks/opencode-go.local.json');
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    apiKey?: unknown;
  };
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim()) return false;
  process.env.BENCH_OPENCODE_GO_API_KEY = parsed.apiKey;
  fs.rmSync(file, { force: true });
  return true;
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
