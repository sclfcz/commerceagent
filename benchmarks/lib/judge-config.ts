export const DEFAULT_JUDGE_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_JUDGE_MODEL = 'mimo-v2.6-flash';

export interface JudgeConfig {
  baseUrl: string;
  model: string;
}

export function resolveJudgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): JudgeConfig {
  const baseUrl =
    environment.BENCH_JUDGE_BASE_URL?.trim() || DEFAULT_JUDGE_BASE_URL;
  const model = environment.BENCH_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('judge_base_url_invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('judge_base_url_invalid');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
    throw new Error('judge_model_invalid');
  return { baseUrl: baseUrl.replace(/\/$/, ''), model };
}
