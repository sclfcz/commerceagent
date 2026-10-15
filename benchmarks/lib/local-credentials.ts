import fs from 'node:fs';
import path from 'node:path';

export function importOneTimeApiKey(
  repository: string,
  fileName: string,
  environmentName: string,
): boolean {
  if (process.env[environmentName]?.trim()) return true;
  const file = path.join(repository, 'benchmarks', fileName);
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    return false;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    apiKey?: unknown;
  };
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim()) return false;
  process.env[environmentName] = parsed.apiKey;
  fs.rmSync(file, { force: true });
  return true;
}

export function importCandidateCredentials(
  repository: string,
  candidates: Array<{ apiKeyEnv: string }>,
): void {
  for (const candidate of candidates) {
    if (candidate.apiKeyEnv === 'BENCH_QWEN_API_KEY')
      importOneTimeApiKey(repository, 'qwen.local.json', candidate.apiKeyEnv);
    if (candidate.apiKeyEnv === 'BENCH_OPENCODE_GO_API_KEY')
      importOneTimeApiKey(
        repository,
        'opencode-go.local.json',
        candidate.apiKeyEnv,
      );
  }
}
