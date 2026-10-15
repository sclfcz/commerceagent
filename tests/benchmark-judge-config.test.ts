import { describe, expect, it } from 'vitest';
import { resolveJudgeConfig } from '../benchmarks/lib/judge-config.js';

describe('configurable Judge provider', () => {
  it('uses the documented OpenCode Go defaults', () => {
    expect(resolveJudgeConfig({})).toEqual({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'mimo-v2.6-flash',
    });
  });

  it('accepts an OpenAI-compatible HTTPS endpoint and model override', () => {
    expect(
      resolveJudgeConfig({
        BENCH_JUDGE_BASE_URL: 'https://judge.example/v1/',
        BENCH_JUDGE_MODEL: 'vendor/model-v3',
      }),
    ).toEqual({
      baseUrl: 'https://judge.example/v1',
      model: 'vendor/model-v3',
    });
  });

  it.each([
    'http://judge.example/v1',
    'https://user:password@judge.example/v1',
    'https://judge.example/v1?token=secret',
  ])('rejects unsafe Judge endpoints: %s', (baseUrl) => {
    expect(() => resolveJudgeConfig({ BENCH_JUDGE_BASE_URL: baseUrl })).toThrow(
      'judge_base_url_invalid',
    );
  });
});
